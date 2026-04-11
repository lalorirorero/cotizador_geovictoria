const crypto = require("crypto");
const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { getRecord, toText } = require("../_shared/zoho-crm");
const { sendVerificationCodeEmail, validateEmail } = require("../_shared/verification-mailer");
const {
  signVerificationPayload,
  normalizeEmail,
  hashOtpCode,
} = require("../_shared/verification-token");
const resendThrottle = new Map();

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  let bodyValue;
  try {
    bodyValue = req?.body;
  } catch (_error) {
    bodyValue = undefined;
  }

  if (bodyValue && typeof bodyValue === "object") return bodyValue;
  if (typeof bodyValue === "string") {
    try {
      return JSON.parse(bodyValue || "{}");
    } catch (_error) {
      return {};
    }
  }

  if (!req || typeof req.on !== "function") return {};

  const chunks = [];
  await new Promise((resolve) => {
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", resolve);
    req.on("error", resolve);
  });

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function randomCode6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function maskEmail(email) {
  const value = normalizeEmail(email);
  if (!value || !value.includes("@")) return "";
  const [local, domain] = value.split("@");
  const safeLocal =
    local.length <= 2
      ? `${local.slice(0, 1)}*`
      : `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}`;
  return `${safeLocal}@${domain}`;
}

function getCooldownSeconds() {
  const raw = Number(process.env.QUOTE_ACCEPTANCE_RESEND_COOLDOWN_SECONDS || 60);
  if (!Number.isFinite(raw)) return 60;
  return Math.min(600, Math.max(15, Math.floor(raw)));
}

function pruneThrottle(nowMs) {
  // Keep memory bounded in long-lived lambdas.
  if (resendThrottle.size < 600) return;
  const tenMinutesMs = 10 * 60 * 1000;
  for (const [key, value] of resendThrottle.entries()) {
    if (!value || nowMs - value > tenMinutesMs) {
      resendThrottle.delete(key);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  const config = getAcceptanceConfig(req);
  const supportSuffix = config.supportContactEmail
    ? ` Si el problema persiste, contacta a ${config.supportContactLabel} al correo ${config.supportContactEmail}.`
    : "";
  let stage = "init";

  try {
    stage = "parse_body";
    const body = await parseBody(req);
    const token = toText(body?.token);
    const recipientName = toText(body?.recipientName);

    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }

    stage = "verify_acceptance_token";
    const acceptancePayload = verifyAcceptanceToken(token);
    stage = "read_quote";
    const quote = await getRecord(config.quoteModule, acceptancePayload.quoteId);
    stage = "resolve_contact_email";
    const contactEmail = normalizeEmail(quote?.[config.contactEmailField]);
    if (!contactEmail || !validateEmail(contactEmail)) {
      sendJson(res, 400, {
        success: false,
        error: `No hay un correo de contacto valido configurado en la cotizacion.${supportSuffix}`,
      });
      return;
    }

    stage = "resend_cooldown";
    const cooldownSeconds = getCooldownSeconds();
    const cooldownMs = cooldownSeconds * 1000;
    const throttleKey = `${acceptancePayload.quoteId}:${contactEmail}`;
    const nowMs = Date.now();
    pruneThrottle(nowMs);
    const lastSentAtMs = Number(resendThrottle.get(throttleKey) || 0);
    const remainingMs = cooldownMs - (nowMs - lastSentAtMs);
    if (remainingMs > 0) {
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      sendJson(res, 429, {
        success: false,
        error: `Ya enviamos un codigo hace instantes. Espera ${remainingSeconds} segundos para reenviar.`,
        remainingSeconds,
      });
      return;
    }

    stage = "build_challenge";
    const ttlMinutes = Math.max(3, Number(config.verificationCodeTtlMinutes || 10));
    const code = randomCode6();
    const nonce = crypto.randomBytes(12).toString("hex");
    const exp = Date.now() + ttlMinutes * 60 * 1000;

    const otpHash = hashOtpCode({
      quoteId: acceptancePayload.quoteId,
      email: contactEmail,
      nonce,
      code,
    });
    const challengeToken = signVerificationPayload(
      {
        quoteId: acceptancePayload.quoteId,
        dealId: acceptancePayload.dealId,
        email: contactEmail,
        nonce,
        otpHash,
        iat: Date.now(),
        exp,
        v: 1,
      },
      "quote_email_challenge"
    );

    stage = "send_email";
    await sendVerificationCodeEmail({
      quoteModule: config.quoteModule,
      quoteId: acceptancePayload.quoteId,
      quoteDealLookupField: config.quoteDealLookupField,
      toEmail: contactEmail,
      toName: recipientName,
      code,
      ttlMinutes,
      supportLabel: config.supportContactLabel,
      supportEmail: config.supportContactEmail,
    });
    resendThrottle.set(throttleKey, Date.now());

    stage = "response_ok";
    sendJson(res, 200, {
      success: true,
      challengeToken,
      expiresAt: new Date(exp).toISOString(),
      maskedEmail: maskEmail(contactEmail),
      ttlMinutes,
      resendCooldownSeconds: cooldownSeconds,
      message: "Codigo enviado correctamente.",
    });
  } catch (error) {
    const detailMessage = `${stage}: ${toText(error?.message || error)}`;
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 502, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : `No se pudo enviar el codigo de verificacion.${supportSuffix}`,
      detail: detailMessage,
    });
  }
}

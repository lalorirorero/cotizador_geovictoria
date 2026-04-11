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

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (_error) {
      return {};
    }
  }
  if (typeof req.body === "object") return req.body;
  return {};
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  const config = getAcceptanceConfig(req);
  const supportSuffix = config.supportContactEmail
    ? ` Si el problema persiste, contacta a ${config.supportContactLabel} al correo ${config.supportContactEmail}.`
    : "";

  try {
    const body = parseBody(req);
    const token = toText(body?.token);
    const recipientName = toText(body?.recipientName);

    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }

    const acceptancePayload = verifyAcceptanceToken(token);
    const quote = await getRecord(config.quoteModule, acceptancePayload.quoteId);
    const billingEmail = normalizeEmail(quote?.[config.billingEmailField]);
    if (!billingEmail || !validateEmail(billingEmail)) {
      sendJson(res, 400, {
        success: false,
        error: `No hay un correo de facturacion valido configurado en la cotizacion.${supportSuffix}`,
      });
      return;
    }

    const ttlMinutes = Math.max(3, Number(config.verificationCodeTtlMinutes || 10));
    const code = randomCode6();
    const nonce = crypto.randomBytes(12).toString("hex");
    const exp = Date.now() + ttlMinutes * 60 * 1000;

    const otpHash = hashOtpCode({
      quoteId: acceptancePayload.quoteId,
      email: billingEmail,
      nonce,
      code,
    });
    const challengeToken = signVerificationPayload(
      {
        quoteId: acceptancePayload.quoteId,
        dealId: acceptancePayload.dealId,
        email: billingEmail,
        nonce,
        otpHash,
        iat: Date.now(),
        exp,
        v: 1,
      },
      "quote_email_challenge"
    );

    await sendVerificationCodeEmail({
      quoteModule: config.quoteModule,
      quoteId: acceptancePayload.quoteId,
      quoteDealLookupField: config.quoteDealLookupField,
      toEmail: billingEmail,
      toName: recipientName,
      code,
      ttlMinutes,
      supportLabel: config.supportContactLabel,
      supportEmail: config.supportContactEmail,
    });

    sendJson(res, 200, {
      success: true,
      challengeToken,
      expiresAt: new Date(exp).toISOString(),
      maskedEmail: maskEmail(billingEmail),
      ttlMinutes,
      message: "Codigo enviado correctamente.",
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 502, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : `No se pudo enviar el codigo de verificacion.${supportSuffix}`,
      detail: toText(error?.message || error),
    });
  }
}

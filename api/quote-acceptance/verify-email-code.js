const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { toText } = require("../_shared/zoho-crm");
const {
  verifyVerificationToken,
  signVerificationPayload,
  normalizeEmail,
  hashOtpCode,
} = require("../_shared/verification-token");

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = await parseBody(req);
    const token = toText(body?.token);
    const challengeToken = toText(body?.challengeToken);
    const code = toText(body?.code).replace(/\s+/g, "");

    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }
    if (!challengeToken) {
      sendJson(res, 400, { success: false, error: "Falta challengeToken." });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      sendJson(res, 400, {
        success: false,
        error: "Ingresa el codigo de 6 digitos enviado a tu correo.",
      });
      return;
    }

    const acceptancePayload = verifyAcceptanceToken(token);
    const challenge = verifyVerificationToken(challengeToken, "quote_email_challenge");

    if (toText(challenge?.quoteId) !== toText(acceptancePayload?.quoteId)) {
      sendJson(res, 400, { success: false, error: "La verificacion no coincide con la cotizacion." });
      return;
    }
    if (toText(challenge?.dealId) !== toText(acceptancePayload?.dealId)) {
      sendJson(res, 400, { success: false, error: "La verificacion no coincide con el Deal." });
      return;
    }

    const challengeEmail = normalizeEmail(challenge?.email);
    if (!challengeEmail) {
      sendJson(res, 400, {
        success: false,
        error: "No se encontró correo de contacto asociado al desafío de verificación.",
      });
      return;
    }

    const expectedHash = hashOtpCode({
      quoteId: challenge?.quoteId,
      email: challengeEmail,
      nonce: challenge?.nonce,
      code,
    });
    if (toText(challenge?.otpHash) !== expectedHash) {
      sendJson(res, 400, {
        success: false,
        error: "Codigo incorrecto. Revisa el correo e intenta nuevamente.",
      });
      return;
    }

    const config = getAcceptanceConfig(req);
    const proofMinutes = Math.max(10, Number(config.verificationProofTtlMinutes || 60));
    const verifiedAt = Date.now();
    const proofToken = signVerificationPayload(
      {
        quoteId: acceptancePayload.quoteId,
        dealId: acceptancePayload.dealId,
        email: challengeEmail,
        verifiedAt,
        iat: verifiedAt,
        exp: verifiedAt + proofMinutes * 60 * 1000,
        v: 1,
      },
      "quote_email_verified"
    );

    sendJson(res, 200, {
      success: true,
      verificationToken: proofToken,
      verifiedAt: new Date(verifiedAt).toISOString(),
      verifiedEmail: challengeEmail,
      message: "Correo verificado correctamente.",
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 400, {
      success: false,
      error: isExpired
        ? "El codigo expiro. Solicita uno nuevo."
        : "No se pudo validar el codigo de verificacion.",
      detail: toText(error?.message || error),
    });
  }
}

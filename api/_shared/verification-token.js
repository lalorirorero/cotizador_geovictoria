const crypto = require("crypto");
const { toText } = require("./zoho-crm");

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getVerificationSecret() {
  const secret = toText(process.env.QUOTE_VERIFICATION_SECRET || process.env.QUOTE_ACCEPTANCE_SECRET);
  if (!secret) {
    throw new Error("Missing QUOTE_VERIFICATION_SECRET or QUOTE_ACCEPTANCE_SECRET");
  }
  return secret;
}

function normalizeEmail(value) {
  return toText(value).toLowerCase();
}

function signVerificationPayload(payload, purpose) {
  const cleanPurpose = toText(purpose);
  if (!cleanPurpose) {
    throw new Error("purpose requerido para signVerificationPayload");
  }
  const secret = getVerificationSecret();
  const safePayload =
    payload && typeof payload === "object"
      ? { ...payload, purpose: cleanPurpose }
      : { purpose: cleanPurpose };
  const body = base64UrlEncode(JSON.stringify(safePayload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${cleanPurpose}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${body}.${signature}`;
}

function verifyVerificationToken(token, purpose) {
  const cleanPurpose = toText(purpose);
  if (!cleanPurpose) {
    throw new Error("purpose requerido para verifyVerificationToken");
  }

  const secret = getVerificationSecret();
  const raw = toText(token);
  const parts = raw.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid verification token format");
  }

  const [body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${cleanPurpose}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (
    expectedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    throw new Error("Invalid verification token signature");
  }

  let payload = {};
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (_error) {
    throw new Error("Invalid verification token payload");
  }

  if (toText(payload?.purpose) !== cleanPurpose) {
    throw new Error("Verification token purpose mismatch");
  }

  const exp = Number(payload?.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    throw new Error("Verification token missing exp");
  }
  if (Date.now() >= exp) {
    const expired = new Error("Verification token expired");
    expired.code = "TOKEN_EXPIRED";
    throw expired;
  }

  return payload;
}

function hashOtpCode({ quoteId, email, nonce, code }) {
  const secret = getVerificationSecret();
  const normalizedCode = toText(code);
  const normalizedQuoteId = toText(quoteId);
  const normalizedNonce = toText(nonce);
  const normalizedEmail = normalizeEmail(email);
  return crypto
    .createHash("sha256")
    .update(`${secret}|${normalizedQuoteId}|${normalizedEmail}|${normalizedNonce}|${normalizedCode}`)
    .digest("hex");
}

module.exports = {
  signVerificationPayload,
  verifyVerificationToken,
  normalizeEmail,
  hashOtpCode,
};

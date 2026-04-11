const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { getRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

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

function getExpirationMs(quoteDateRaw, validityDays) {
  const quoteDate = new Date(toText(quoteDateRaw));
  if (!Number.isFinite(quoteDate.getTime())) {
    return Date.now() + validityDays * 24 * 60 * 60 * 1000;
  }
  return quoteDate.getTime() + validityDays * 24 * 60 * 60 * 1000;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      sendJson(res, 400, { success: false, error: "Falta quoteId." });
      return;
    }

    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    if (!dealId) {
      sendJson(res, 400, {
        success: false,
        error: "La cotizacion no tiene Deal asociado.",
      });
      return;
    }

    const expMs = getExpirationMs(quote?.[config.quoteDateField], config.validityDays);
    const payload = {
      quoteId,
      dealId,
      iat: Date.now(),
      exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    };
    const token = signAcceptancePayload(payload);
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    const updateMap = {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
    };
    if (config.quoteStatusField) {
      const currentStatus = toText(quote?.[config.quoteStatusField]);
      if (!/Aceptada/i.test(currentStatus)) {
        updateMap[config.quoteStatusField] = "Enviada";
      }
    }
    await updateRecord(config.quoteModule, quoteId, updateMap, true);

    sendJson(res, 200, {
      success: true,
      quoteId,
      dealId,
      acceptanceUrl,
      expiresAt: new Date(expMs).toISOString(),
      validityDays: config.validityDays,
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "No se pudo generar link de aceptacion.",
      detail: String(error?.message || error),
    });
  }
}


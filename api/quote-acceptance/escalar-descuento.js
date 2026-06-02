const { getRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

// Escalada de descuento sobre el RECURRENTE de una cotización.
// SEGURIDAD: Vicky NO envía el porcentaje. El servidor mantiene el nivel por
// cotización y lo sube de a PASO hasta TOPE. La única acción de Vicky es pedir
// "sube un escalón" (sin número), de modo que no pueda alucinar ni fijar montos.
const PASO = 5;
const TOPE = 30;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

// Normaliza cualquier valor previo a 0..TOPE en múltiplos de PASO (defensa en
// profundidad: aunque el campo en Zoho tuviera un valor raro, lo saneamos).
function clampPct(value) {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(TOPE, Math.round(n / PASO) * PASO));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }

  // Auth: mismo patrón que create-from-vicky.
  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }

    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    const actual = clampPct(quote?.[config.quoteDiscountPctField]);
    const nuevo = Math.min(actual + PASO, TOPE);

    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteDiscountPctField]: nuevo,
      [config.quoteDiscountUnlockedField]: true,
    });

    return sendJson(res, 200, {
      ok: true,
      descuento_pct: nuevo,
      sube_desde: actual,
      tope_alcanzado: nuevo >= TOPE,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo escalar el descuento.",
      detail: String(error?.message || error),
    });
  }
}

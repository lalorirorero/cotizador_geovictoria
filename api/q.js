/**
 * GET /q/<quoteId>-<firma> — link corto de aceptación, para los botones de URL
 * dinámica de las plantillas de WhatsApp (el link real lleva un token JWT
 * demasiado largo para una variable de plantilla de Meta).
 *
 * La firma es HMAC-SHA256(quoteId, VICKY_COTIZADORA_SECRET) truncado a 10 hex:
 * el quoteId solo no basta para redirigir (no se puede enumerar cotizaciones),
 * y sin almacenar nada — la firma se recalcula en cada visita.
 *
 * Redirige 302 a URL_Aceptacion_Web de la cotización (el mismo link de
 * siempre: la página sigue leyendo los datos en vivo).
 */

const crypto = require("crypto");
const { getRecord, toText } = require("./_shared/zoho-crm");
const { getAcceptanceConfig } = require("./_shared/quote-acceptance-config");

module.exports = async function handler(req, res) {
  try {
    const code = String((req.query && req.query.c) || "").trim();
    const m = code.match(/^(\d{5,25})-([0-9a-f]{10})$/i);
    const secret = toText(process.env.VICKY_COTIZADORA_SECRET);
    if (!m || !secret) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const quoteId = m[1];
    const firma = m[2].toLowerCase();
    const esperada = crypto
      .createHmac("sha256", secret)
      .update(quoteId)
      .digest("hex")
      .slice(0, 10);
    if (firma !== esperada) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    const url = toText(quote && quote.URL_Aceptacion_Web);
    if (!url) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.statusCode = 302;
    res.setHeader("Location", url);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
};

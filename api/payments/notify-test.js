/**
 * Endpoint ADMIN de prueba: envía el correo interno de "Cotización PAGADA"
 * (incluida la sección Comprobante Mercado Pago con datos REALES) a UN solo
 * destinatario, sin notificar al equipo. Para validar el formato del correo.
 *
 * GET /api/payments/notify-test?quoteId=<id>&to=<email>
 * Auth: Authorization: Bearer ${CRON_SECRET} o x-vicky-secret.
 */
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { detallePagosMP, buildHtml } = require("../_shared/quote-internal-notify");

const QUOTE_MODULE = toText(process.env.ZOHO_QUOTE_MODULE) || "Cotizaciones_GeoVictoria";
const NOTIFY_FROM = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
  const quoteId = toText(req?.query?.quoteId);
  const to = toText(req?.query?.to);
  if (!quoteId || !to || !to.includes("@")) {
    return sendJson(res, 400, { ok: false, error: "quoteId y to (email) requeridos" });
  }
  try {
    const quote = await getRecordWithFields(QUOTE_MODULE, quoteId, [
      "Numero_Cotizacion",
      "Email_Contacto",
      "RUT_Cliente",
      "Cuenta_Asociada",
      "Deal_Asociado",
      "Name",
    ]);
    const numero = toText(quote?.Numero_Cotizacion);
    const empresa =
      toText(quote?.Cuenta_Asociada?.name) ||
      toText(quote?.Name).replace(/^\s*Cotización\s*/i, "").replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, "");
    const dealId = toText(quote?.Deal_Asociado?.id || quote?.Deal_Asociado);
    const pagosMp = await detallePagosMP(quoteId);
    const htmlBody = buildHtml({
      evento: "pagada",
      empresa,
      numero,
      clientEmail: toText(quote?.Email_Contacto),
      rut: toText(quote?.RUT_Cliente),
      montoClp: "",
      dealId,
      pagosMp,
    });
    const path = `/crm/v3/${encodeURIComponent(QUOTE_MODULE)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
    const response = await zohoApiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            from: { email: NOTIFY_FROM },
            to: [{ email: to }],
            subject: `[PRUEBA] Cotización ${numero} PAGADA — ${empresa} (comprobante MP)`,
            content: htmlBody,
            mail_format: "html",
          },
        ],
      }),
    });
    const text = await response.text().catch(() => "");
    return sendJson(res, response.ok ? 200 : 502, {
      ok: response.ok,
      to,
      numero,
      pagosEncontrados: pagosMp.length,
      pagos: pagosMp,
      zoho: text.slice(0, 200),
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: toText(e?.message || e).slice(0, 300) });
  }
};

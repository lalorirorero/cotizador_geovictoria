/**
 * Endpoint TEMPORAL de preview del correo de cotización.
 *
 * Reusa EXACTAMENTE el buildEmailHtml de producción (create-from-vicky), así que
 * lo que se ve aquí es idéntico al correo real. Envía solo a egomez@ (sin CC a
 * Anderson, para no spammear en pruebas). SE BORRA tras validar el diseño.
 */

const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getRecord, toText } = require("../_shared/zoho-crm");
const { buildEmailHtml } = require("../quote-acceptance/create-from-vicky");

const PREVIEW_TOKEN = "gv-preview-7h3k9q2";
const FIXED_RECIPIENT = "egomez@geovictoria.com";
const FROM_EMAIL = String(process.env.VICKY_FROM_EMAIL || "").trim() || "vicky@geovictoria.com";
const CONTEXT_MODULE = "Cotizaciones_GeoVictoria";
const CONTEXT_QUOTE_ID = "3525045000633953269";

async function urlCotizacionPdf() {
  const quote = await getRecord(CONTEXT_MODULE, CONTEXT_QUOTE_ID);
  return toText(quote && quote.PDF_URL) || "#";
}

async function enviar(html) {
  const path2 = `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/actions/send_mail`;
  const body = {
    data: [
      {
        from: { email: FROM_EMAIL },
        to: [{ user_name: "Eduardo Gómez", email: FIXED_RECIPIENT }],
        subject: "Tu cotización GeoVictoria — Prueba Brian (PREVIEW)",
        content: html,
        mail_format: "html",
      },
    ],
  };
  const resp = await zohoApiFetch(path2, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`send_mail ${resp.status}: ${text.slice(0, 250)}`);
  return text.slice(0, 120);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const token = (req.query && req.query.token) || "";
  if (token !== PREVIEW_TOKEN) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "token inválido" }));
    return;
  }
  try {
    const cotizacionUrl = await urlCotizacionPdf();
    const html = buildEmailHtml({
      contacto: "Brayan Camacho",
      empresa: "Prueba Brian",
      pdfUrl: cotizacionUrl,
      tieneReloj: true,
    });
    const detail = await enviar(html);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sentTo: FIXED_RECIPIENT, detail }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 350) }));
  }
};

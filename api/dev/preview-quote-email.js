/**
 * Endpoint TEMPORAL de preview del correo de cotización (v3: botones hosteados).
 *
 * Arquitectura "crear una vez, solo traspasar datos":
 *   - Los 3 PDFs estáticos (certificación, ficha, presentación) se suben a
 *     Supabase una vez (idempotente, upsert) → URLs permanentes.
 *   - El PDF de la cotización ya está hosteado (se referencia su URL).
 *   - El correo es una plantilla a la que solo se le inyectan datos + URLs.
 *   - Envío vía Zoho send_mail (sin adjuntos binarios → rápido, sin scope extra).
 *
 * SE BORRA tras validar el diseño.
 */

const fs = require("fs");
const path = require("path");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getRecord, toText } = require("../_shared/zoho-crm");

const PREVIEW_TOKEN = "gv-preview-7h3k9q2";
const FIXED_RECIPIENT = "egomez@geovictoria.com";
const FROM_EMAIL = String(process.env.VICKY_FROM_EMAIL || "").trim() || "vicky@geovictoria.com";
const CONTEXT_MODULE = "Cotizaciones_GeoVictoria";
const CONTEXT_QUOTE_ID = "3525045000633953269";
const PUBLIC_BASE = "https://cotizacion.geovictoria.com";
const ASSET_DIR = path.join(__dirname, "..", "_shared", "assets");

// Sube un PDF a una ruta FIJA del bucket (upsert: idempotente). Devuelve la URL
// pública servida por el rewrite /pdf/ de Vercel.
async function subirEstatico(buffer, objectPath) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const bucket = String(process.env.QUOTES_PDF_BUCKET || "cotizaciones-pdf").trim();
  if (!supabaseUrl || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
      "Cache-Control": "public, max-age=31536000",
    },
    body: buffer,
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Supabase upload ${objectPath} (${resp.status}): ${detail.slice(0, 200)}`);
  }
  return `${PUBLIC_BASE}/pdf/${objectPath}`;
}

async function urlCotizacionPdf() {
  const quote = await getRecord(CONTEXT_MODULE, CONTEXT_QUOTE_ID);
  return toText(quote && quote.PDF_URL) || "#";
}

function boton(href, texto, bg, color) {
  return `<a href="${href}" style="display:inline-block;background:${bg};color:${color};padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${texto}</a>`;
}

function fila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

function buildEmailHtml({ cotizacionUrl, certUrl, fichaUrl, presUrl }) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
    <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
      <table role="presentation" width="100%"><tr><td style="color:#ffffff;font-size:22px;font-weight:700;">GeoVictoria</td><td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">Hola Brayan 👋</p>
      <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">Prueba Brian</span> está lista</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia con el descuento que conversamos. Ábrela en el PDF y, desde ahí mismo, puedes aceptarla en línea cuando quieras.</p>
    </td></tr>
    <tr><td style="padding:24px 32px 0 32px;">
      <table role="presentation" width="100%" style="background:#f1f6ff;border:1px solid #d6e4ff;border-radius:10px;"><tr><td style="padding:18px 22px;">
        <table role="presentation" width="100%">
          <tr><td style="font-size:13px;color:#718096;padding-bottom:2px;">Plan mensual (IVA incluido)</td><td align="right" style="font-size:13px;color:#718096;padding-bottom:2px;">Pago inicial</td></tr>
          <tr><td style="font-size:22px;font-weight:700;color:#0d47a1;">$79.796/mes</td><td align="right" style="font-size:22px;font-weight:700;color:#0d47a1;">$130.408</td></tr>
          <tr><td colspan="2" style="font-size:12px;color:#8a94a6;padding-top:6px;">30% de descuento en el plan mensual · 50% en instalación · 25 usuarios · 1 reloj en Las Condes</td></tr>
        </table>
      </td></tr></table>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      ${boton(cotizacionUrl, "📄 Ver tu cotización (PDF)", "#1a73e8", "#ffffff")}
      <p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">Dentro del PDF encuentras el botón para aceptarla en línea.</p>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Abres el PDF y revisas tu cotización.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Desde el mismo PDF la aceptas en línea y pagas el primer mes de forma segura.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Coordinamos la instalación e iniciamos tu onboarding en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Documentos para ti 📎</h3>
      <table role="presentation" width="100%">
        ${fila(certUrl, "📄 Certificación Dirección del Trabajo", "")}
        ${fila(fichaUrl, "🕐 Ficha Técnica del Reloj", "(tu cotización lleva reloj)")}
        ${fila(presUrl, "📊 Presentación Comercial GeoVictoria", "")}
      </table>
    </td></tr>
    <tr><td style="padding:24px 32px 0 32px;">
      <table role="presentation" width="100%" style="border-top:1px solid #edf2f7;"><tr><td style="padding-top:20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">Anderson Díaz</p>
        <p style="margin:0 0 2px 0;font-size:13px;color:#718096;">Ejecutivo Comercial · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">✉️ <a href="mailto:adiazg@geovictoria.com" style="color:#1a73e8;text-decoration:none;">adiazg@geovictoria.com</a> &nbsp;·&nbsp; 📱 <a href="https://wa.me/56939372058" style="color:#1a73e8;text-decoration:none;">+56 9 3937 2058</a></p>
        <p style="margin:10px 0 0 0;font-size:13px;color:#4a5568;">Cualquier duda, respóndeme este correo o escríbeme por WhatsApp. Estoy para ayudarte. 😊</p>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 30px 32px;">
      <p style="margin:0;font-size:11px;color:#a0aec0;line-height:1.5;">GeoVictoria — Especialistas en Control de Asistencia y Accesos, presentes en 40+ países.<br><a href="https://geovictoria.com" style="color:#a0aec0;">geovictoria.com</a></p>
    </td></tr>
  </table>
  <p style="font-size:11px;color:#b8c0cc;margin:16px 0 0 0;">Este es un correo automático de tu cotización. Si no la solicitaste, ignóralo.</p>
</td></tr></table>
</body></html>`;
}

async function enviar(html) {
  const path2 = `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/actions/send_mail`;
  const body = {
    data: [
      {
        from: { email: FROM_EMAIL },
        to: [{ user_name: "Eduardo Gómez", email: FIXED_RECIPIENT }],
        subject: "Tu cotización GeoVictoria — Prueba Brian (PREVIEW v3)",
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
    const certBuf = await fs.promises.readFile(path.join(ASSET_DIR, "certificacion-dt.pdf"));
    const fichaBuf = await fs.promises.readFile(path.join(ASSET_DIR, "ficha-reloj-senseface.pdf"));
    const presBuf = await fs.promises.readFile(path.join(ASSET_DIR, "presentacion-comercial.pdf"));

    const [certUrl, fichaUrl, presUrl, cotizacionUrl] = await Promise.all([
      subirEstatico(certBuf, "assets/certificacion-dt.pdf"),
      subirEstatico(fichaBuf, "assets/ficha-reloj-senseface.pdf"),
      subirEstatico(presBuf, "assets/presentacion-comercial.pdf"),
      urlCotizacionPdf(),
    ]);

    const detail = await enviar(buildEmailHtml({ cotizacionUrl, certUrl, fichaUrl, presUrl }));
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sentTo: FIXED_RECIPIENT, urls: { certUrl, fichaUrl, presUrl, cotizacionUrl }, detail }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 350) }));
  }
};

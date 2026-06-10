/**
 * Endpoint TEMPORAL de preview del correo de cotización (v2: con adjuntos + PDF).
 *
 * Envía a egomez@geovictoria.com el correo propuesto con:
 *   - La cotización en PDF (generada fresca, datos de ejemplo) como adjunto.
 *   - Certificación DT (adjunto).
 *   - Ficha técnica del reloj (adjunto, porque el ejemplo lleva reloj).
 *   - Presentación comercial (adjunto).
 *   - SIN botón de "aceptación online" en el cuerpo: la cotización va en PDF y
 *     desde ahí se llega a la aceptación.
 *
 * Mecanismo: sube cada PDF al registro de una cotización de contexto en Zoho
 * (Attachments) y los referencia en send_mail. Usa el mismo canal que los
 * correos reales (Zoho), sin variables nuevas. SE BORRA tras validar el diseño.
 */

const fs = require("fs");
const path = require("path");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");

const PREVIEW_TOKEN = "gv-preview-7h3k9q2";
const FIXED_RECIPIENT = "egomez@geovictoria.com";
const FROM_EMAIL = String(process.env.VICKY_FROM_EMAIL || "").trim() || "vicky@geovictoria.com";
const CONTEXT_MODULE = "Cotizaciones_GeoVictoria";
const CONTEXT_QUOTE_ID = "3525045000633953269";
const CONTEXT_DEAL_ID = "3525045000633963241";

const ASSET_DIR = path.join(__dirname, "..", "_shared", "assets");

async function getUFActualSafe() {
  try {
    const res = await fetch("https://mindicador.cl/api/uf", { cache: "no-store" });
    if (!res.ok) return 40763;
    const data = await res.json();
    return data?.serie?.[0]?.valor || 40763;
  } catch {
    return 40763;
  }
}

// Cotización de ejemplo: 25 usuarios + 1 reloj + instalación Las Condes (RM),
// con 30% en el plan y 50% en instalación. Mismo shape que usa el builder real.
function sampleItems() {
  return [
    { tipo: "modulo", id: "asistencia", nombre: "Control de Asistencia", modalidad: "Por usuario", cantidad: 25, precioUnitarioUF: 0.08, subtotalUF: 2, zonaTarifa: "" },
    { tipo: "hardware", id: "senseface_2a", nombre: "Reloj control físico", modalidad: "Arriendo mensual", cantidad: 1, precioUnitarioUF: 0.35, subtotalUF: 0.35, zonaTarifa: "" },
    { tipo: "servicio", id: "instalacion_reloj", nombre: "Instalación de reloj (Las Condes)", modalidad: "Cobro único", cantidad: 1, precioUnitarioUF: 2, subtotalUF: 2, zonaTarifa: "RM" },
  ];
}

async function generarCotizacionPdf() {
  const ufActual = await getUFActualSafe();
  const expMs = Date.now() + 15 * 24 * 60 * 60 * 1000;
  const acceptanceToken = signAcceptancePayload({
    quoteId: CONTEXT_QUOTE_ID,
    dealId: CONTEXT_DEAL_ID,
    iat: Date.now(),
    exp: expMs,
    nonce: "preview000000000",
    v: 1,
  });
  const acceptanceUrl = `https://cotizacion.geovictoria.com/quote-acceptance.html?token=${encodeURIComponent(acceptanceToken)}`;
  const html = buildProposalHtml({
    cliente: {
      empresa: "Prueba Brian",
      contacto: "Brayan Camacho",
      contactoEmail: FIXED_RECIPIENT,
      rutEmpresa: "26.126.891-4",
      ejecutivo: "Anderson Díaz",
      ejecutivoEmail: "adiazg@geovictoria.com",
      ejecutivoTelefono: "+56 9 3937 2058",
    },
    cotizacion: { items: sampleItems(), ufActual },
    acceptanceUrl,
    cotizacionId: CONTEXT_QUOTE_ID.slice(-8).toUpperCase(),
    validezHasta: new Date(expMs).toISOString(),
    version: 1,
    descuentos: { recurrentePct: 30, instalacionRMPct: 50, instalacionRegionPct: 0 },
    condicionDiscursiva: "Este descuento aplica si aceptas y pagas dentro de las próximas 12 horas.",
  });
  return htmlToPdfBuffer(html, { format: "Letter", margin: "0" });
}

// Sube un buffer PDF como Attachment al registro de contexto. Devuelve el id.
async function subirAdjunto(buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
  const resp = await zohoApiFetch(
    `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/Attachments`,
    { method: "POST", body: form }
  );
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Attachment ${filename} ${resp.status}: ${text.slice(0, 200)}`);
  let json = {};
  try { json = JSON.parse(text); } catch { /* noop */ }
  const id = json?.data?.[0]?.details?.id;
  if (!id) throw new Error(`Attachment ${filename}: sin id (${text.slice(0, 150)})`);
  return id;
}

async function borrarAdjunto(attId) {
  try {
    await zohoApiFetch(
      `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/Attachments/${encodeURIComponent(attId)}`,
      { method: "DELETE" }
    );
  } catch { /* best-effort */ }
}

function buildEmailHtml() {
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
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia con el descuento que conversamos. <strong>Te la dejo adjunta en PDF</strong> 📄 — ábrela para revisar el detalle y, desde ahí mismo, aceptarla en línea cuando quieras.</p>
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
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
      <table role="presentation" width="100%">
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Abres el PDF adjunto y revisas tu cotización.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Desde el mismo PDF la aceptas en línea y pagas el primer mes de forma segura.</td></tr>
        <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Coordinamos la instalación e iniciamos tu onboarding en 24 horas hábiles.</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">En este correo te adjunto 📎</h3>
      <table role="presentation" width="100%">
        <tr><td style="padding:9px 14px;background:#eef5ff;border:1px solid #cfe0ff;border-radius:8px;font-size:14px;color:#0d47a1;font-weight:600;">📄 &nbsp;Tu cotización (PDF)</td></tr>
        <tr><td style="height:8px;"></td></tr>
        <tr><td style="padding:9px 14px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#2d3748;">📄 &nbsp;Certificación Dirección del Trabajo</td></tr>
        <tr><td style="height:8px;"></td></tr>
        <tr><td style="padding:9px 14px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#2d3748;">🕐 &nbsp;Ficha Técnica del Reloj <span style="color:#a0aec0;font-size:12px;">(porque tu cotización lleva reloj)</span></td></tr>
        <tr><td style="height:8px;"></td></tr>
        <tr><td style="padding:9px 14px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#2d3748;">📊 &nbsp;Presentación Comercial GeoVictoria</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:30px 32px 0 32px;">
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

async function enviarConAdjuntos({ html, attachmentIds }) {
  const path2 = `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/actions/send_mail`;
  const body = {
    data: [
      {
        from: { email: FROM_EMAIL },
        to: [{ user_name: "Eduardo Gómez", email: FIXED_RECIPIENT }],
        subject: "Tu cotización GeoVictoria — Prueba Brian (PREVIEW v2)",
        content: html,
        mail_format: "html",
        attachments: attachmentIds.map((id) => ({ id })),
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
  return text.slice(0, 150);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const token = (req.query && req.query.token) || "";
  if (token !== PREVIEW_TOKEN) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "token inválido" }));
    return;
  }
  const subidos = [];
  try {
    // 1. PDF de la cotización (fresco) + los 3 PDFs estáticos.
    const cotizacionPdf = await generarCotizacionPdf();
    const certPdf = fs.readFileSync(path.join(ASSET_DIR, "certificacion-dt.pdf"));
    const fichaPdf = fs.readFileSync(path.join(ASSET_DIR, "ficha-reloj-senseface.pdf"));
    const presPdf = fs.readFileSync(path.join(ASSET_DIR, "presentacion-comercial.pdf"));

    // 2. Subir como adjuntos al registro de contexto.
    subidos.push(await subirAdjunto(cotizacionPdf, "Cotización GeoVictoria.pdf"));
    subidos.push(await subirAdjunto(certPdf, "Certificación Dirección del Trabajo.pdf"));
    subidos.push(await subirAdjunto(fichaPdf, "Ficha Técnica Reloj.pdf"));
    subidos.push(await subirAdjunto(presPdf, "Presentación Comercial GeoVictoria.pdf"));

    // 3. Enviar.
    const detail = await enviarConAdjuntos({ html: buildEmailHtml(), attachmentIds: subidos });

    // 4. Limpiar adjuntos del registro de contexto (no ensuciar la cotización).
    for (const id of subidos) await borrarAdjunto(id);

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sentTo: FIXED_RECIPIENT, adjuntos: subidos.length, detail }));
  } catch (err) {
    for (const id of subidos) await borrarAdjunto(id);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 350) }));
  }
};

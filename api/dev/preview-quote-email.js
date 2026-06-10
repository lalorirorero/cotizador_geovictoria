/**
 * Endpoint TEMPORAL de preview: envía la propuesta del correo de cotización a
 * egomez@geovictoria.com para validar el render en un cliente real (Gmail/Outlook).
 *
 * - Destinatario HARDCODEADO (solo egomez@geovictoria.com): no acepta otro `to`.
 * - Protegido por token en query (?token=...).
 * - Usa el mismo proveedor que el flujo de verificación (Resend, con la llave de
 *   Vercel). No toca Zoho ni ninguna cotización.
 *
 * SE BORRA después de validar el diseño. No forma parte del flujo de producción.
 */

const { zohoApiFetch } = require("../_shared/zoho-auth");

const PREVIEW_TOKEN = "gv-preview-7h3k9q2";
const FIXED_RECIPIENT = "egomez@geovictoria.com";
const FROM_EMAIL = String(process.env.VICKY_FROM_EMAIL || "").trim() || "vicky@geovictoria.com";
// Cotización existente usada SOLO como contexto del send_mail de Zoho (el correo
// se envía a FIXED_RECIPIENT, no al contacto de esta cotización).
const CONTEXT_MODULE = "Cotizaciones_GeoVictoria";
const CONTEXT_QUOTE_ID = "3525045000633953269";

// Envío vía Zoho send_mail, el mismo mecanismo que usan los correos reales de
// cotización (no requiere variables nuevas).
async function sendViaZoho({ toEmail, subject, html }) {
  const path = `/crm/v3/${encodeURIComponent(CONTEXT_MODULE)}/${encodeURIComponent(CONTEXT_QUOTE_ID)}/actions/send_mail`;
  const body = {
    data: [
      {
        from: { email: FROM_EMAIL },
        to: [{ user_name: "Eduardo Gómez", email: toEmail }],
        subject,
        content: html,
        mail_format: "html",
      },
    ],
  };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zoho send_mail ${response.status}: ${text.slice(0, 250)}`);
  }
  return { provider: "zoho", detail: text.slice(0, 120) };
}

function buildPreviewHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
      <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
        <table role="presentation" width="100%"><tr>
          <td style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:.3px;">GeoVictoria</td>
          <td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:36px 32px 8px 32px;">
        <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">Hola Brayan 👋</p>
        <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">Prueba Brian</span> está lista</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia con el descuento que conversamos. Puedes revisarla, aceptarla y dejar tu servicio andando desde cualquier dispositivo.</p>
      </td></tr>
      <tr><td style="padding:24px 32px 0 32px;">
        <table role="presentation" width="100%" style="background:#f1f6ff;border:1px solid #d6e4ff;border-radius:10px;"><tr><td style="padding:18px 22px;">
          <table role="presentation" width="100%">
            <tr><td style="font-size:13px;color:#718096;padding-bottom:2px;">Plan mensual (IVA incluido)</td><td align="right" style="font-size:13px;color:#718096;padding-bottom:2px;">Pago inicial</td></tr>
            <tr><td style="font-size:22px;font-weight:700;color:#0d47a1;">$79.796/mes</td><td align="right" style="font-size:22px;font-weight:700;color:#0d47a1;">$130.408</td></tr>
            <tr><td colspan="2" style="font-size:12px;color:#8a94a6;padding-top:6px;">Incluye 30% de descuento en el plan mensual · 50% en instalación · 25 usuarios · 1 reloj en Las Condes</td></tr>
          </table>
        </td></tr></table>
      </td></tr>
      <tr><td align="center" style="padding:28px 32px 8px 32px;">
        <a href="#" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:15px 40px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">Revisar y aceptar cotización</a>
        <p style="margin:12px 0 0 0;font-size:12px;color:#a0aec0;">o <a href="#" style="color:#1a73e8;">descarga el PDF de la cotización</a></p>
      </td></tr>
      <tr><td style="padding:28px 32px 0 32px;">
        <h3 style="margin:0 0 14px 0;font-size:15px;color:#1a202c;">Cómo seguimos 🚀</h3>
        <table role="presentation" width="100%">
          <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">1.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Aceptas la cotización en línea (toma menos de 2 minutos).</td></tr>
          <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">2.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;padding-bottom:10px;">Pagas el primer mes de forma segura y activamos tu cuenta.</td></tr>
          <tr><td width="32" valign="top" style="font-size:15px;font-weight:700;color:#1a73e8;">3.</td><td style="font-size:14px;color:#4a5568;line-height:1.55;">Coordinamos la instalación e iniciamos tu onboarding en 24 horas hábiles.</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:28px 32px 0 32px;">
        <h3 style="margin:0 0 12px 0;font-size:15px;color:#1a202c;">Te dejo también 📎</h3>
        <p style="margin:0 0 14px 0;font-size:13px;color:#718096;">Adjuntos en este correo:</p>
        <table role="presentation" width="100%">
          <tr><td style="padding:9px 14px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#2d3748;">📄 &nbsp;Certificación Dirección del Trabajo</td></tr>
          <tr><td style="height:8px;"></td></tr>
          <tr><td style="padding:9px 14px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#2d3748;">🕐 &nbsp;Ficha Técnica del Reloj <span style="color:#a0aec0;font-size:12px;">(incluido porque tu cotización lleva reloj)</span></td></tr>
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
  </td></tr>
</table>
</body></html>`;
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
    const result = await sendViaZoho({
      toEmail: FIXED_RECIPIENT,
      subject: "Tu cotización GeoVictoria — Prueba Brian (PREVIEW v1)",
      html: buildPreviewHtml(),
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, sentTo: FIXED_RECIPIENT, provider: result.provider }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err).slice(0, 300) }));
  }
};

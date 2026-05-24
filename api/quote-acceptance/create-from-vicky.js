const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { createRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");

const VICKY_OWNER_EMAIL = toText(process.env.VICKY_OWNER_EMAIL) || "egomez@geovictoria.com";
const VICKY_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "Propuesta Enviada";
const VICKY_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "Vicky WhatsApp";
const VICKY_EJECUTIVO_NAME = toText(process.env.VICKY_EJECUTIVO_NAME) || "Eddyluz Mujica";

// ── CORS ──
function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_UPLOAD_ORIGINS || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  const allowedByRule =
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) ||
    origin === "https://cotizacion.geovictoria.com" ||
    origin === "http://localhost:3000";
  const allowed = !origin || allowedByRule || allowedList.includes(origin);
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
  return allowed;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" ? req.body : {};
}

function splitFullName(fullName) {
  const clean = (fullName || "").trim();
  if (!clean) return { firstName: "", lastName: "Cliente" };
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  };
}

// ── Helper: enviar email via Zoho CRM send_mail (asociado al Quote) ──
async function sendQuoteEmailViaZoho({
  quoteModule, quoteId, fromEmail, toEmail, toName, subject, htmlBody,
}) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
  const body = {
    data: [{
      from: { email: fromEmail },
      to: [{ user_name: toName || toEmail, email: toEmail }],
      subject,
      content: htmlBody,
      mail_format: "html",
    }],
  };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zoho send_mail failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return text;
}

function buildEmailHtml({ contacto, empresa, acceptanceUrl, pdfUrl, ejecutivo }) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2d3748;">
  <h2 style="color:#0d47a1;">Hola ${contacto},</h2>
  <p>Te dejamos lista tu cotización personalizada para <strong>${empresa}</strong>.</p>
  <p>Podés revisarla y aceptarla desde cualquier dispositivo haciendo clic en el botón:</p>
  <p style="text-align:center;margin:30px 0;">
    <a href="${acceptanceUrl}"
       style="display:inline-block;background:#1a73e8;color:#fff;padding:14px 28px;
              text-decoration:none;border-radius:6px;font-weight:bold;">
      Revisar y aceptar cotización
    </a>
  </p>
  <p style="font-size:13px;color:#718096;">
    También podés descargar el PDF directamente:<br>
    <a href="${pdfUrl}" style="color:#1a73e8;">${pdfUrl}</a>
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:30px 0;">
  <p style="font-size:13px;color:#718096;">
    Tu ejecutivo asignado es <strong>${ejecutivo}</strong>. Cualquier consulta, respondé a este correo.
  </p>
  <p style="font-size:13px;color:#a0aec0;">GeoVictoria — geovictoria.com</p>
</body></html>`;
}

// ── Handler principal ──
module.exports = async function handler(req, res) {
  const corsAllowed = setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = corsAllowed ? 204 : 403; res.end(); return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Método no permitido" });
  }

  // Auth shared secret
  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const body = parseBody(req);
    const cliente = body.cliente || {};
    const cotizacion = body.cotizacion || {};

    // Validaciones
    if (!cliente.empresa || !cliente.contacto || !cliente.contactoEmail || !cliente.rutEmpresa) {
      return sendJson(res, 400, {
        ok: false,
        error: "Faltan campos en cliente: empresa, contacto, contactoEmail, rutEmpresa",
      });
    }
    if (!cotizacion.items || !Array.isArray(cotizacion.items) || cotizacion.items.length === 0) {
      return sendJson(res, 400, { ok: false, error: "cotizacion.items requerido (no vacío)" });
    }
    if (typeof cotizacion.totalUF !== "number") {
      return sendJson(res, 400, { ok: false, error: "cotizacion.totalUF requerido" });
    }

    const config = getAcceptanceConfig(req);

    // 1) Account
    stage = "create_account";
    const accountResult = await createRecord("Accounts", {
      Account_Name: cliente.empresa,
      Phone: cliente.contactoTelefono || undefined,
      Description: `Cuenta creada por Vicky (WhatsApp). RUT: ${cliente.rutEmpresa}`,
    }, true);
    const accountId = toText(accountResult?.id);
    if (!accountId) throw new Error("No se obtuvo accountId");

    // 2) Contact
    stage = "create_contact";
    const { firstName, lastName } = splitFullName(cliente.contacto);
    const contactResult = await createRecord("Contacts", {
      First_Name: firstName || undefined,
      Last_Name: lastName,
      Email: cliente.contactoEmail,
      Phone: cliente.contactoTelefono || undefined,
      Account_Name: { id: accountId },
      Lead_Source: VICKY_LEAD_SOURCE,
    }, true);
    const contactId = toText(contactResult?.id);
    if (!contactId) throw new Error("No se obtuvo contactId");

    // 3) Deal
    stage = "create_deal";
    const dealResult = await createRecord("Deals", {
      Deal_Name: `${cliente.empresa} - Cotización Vicky`,
      Account_Name: { id: accountId },
      Contact_Name: { id: contactId },
      Stage: VICKY_DEAL_STAGE,
      Lead_Source: VICKY_LEAD_SOURCE,
      Amount: cotizacion.totalCLP || undefined,
      Description: `Deal creado por Vicky para cotización WhatsApp.\nUsuarios: ${cliente.userCount}\nTotal: ${cotizacion.totalUF} UF / ${cotizacion.totalCLP} CLP`,
    }, true);
    const dealId = toText(dealResult?.id);
    if (!dealId) throw new Error("No se obtuvo dealId");

    // 4) Quote (Cotización)
    stage = "create_quote";
    const quoteFields = {
      Name: `Cotización ${cliente.empresa} - ${new Date().toISOString().slice(0, 10)}`,
      [config.quoteDealLookupField]: { id: dealId },
      [config.quoteContactLookupField]: { id: contactId },
      [config.quoteDateField]: new Date().toISOString().slice(0, 10),
      [config.quoteStatusField]: "Borrador",
      [config.contactEmailField]: cliente.contactoEmail,
      [config.contactPhoneField]: cliente.contactoTelefono || undefined,
      [config.companyRutField]: cliente.rutEmpresa,
    };
    const quoteResult = await createRecord(config.quoteModule, quoteFields, true);
    const quoteId = toText(quoteResult?.id);
    if (!quoteId) throw new Error("No se obtuvo quoteId");

    // 5) acceptanceUrl
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId,
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    // 6) Generar PDF con PDFShift
    stage = "render_pdf";
    const html = buildProposalHtml({
      cliente: { ...cliente, ejecutivo: VICKY_EJECUTIVO_NAME },
      cotizacion,
      acceptanceUrl,
      cotizacionId: quoteId.slice(-8).toUpperCase(),
    });
    const pdfBuffer = await htmlToPdfBuffer(html, {
      format: "Letter",
      margin: "0",
    });

    // 7) Subir PDF a Supabase
    stage = "upload_pdf";
    const { pdfUrl } = await uploadPdfToSupabase({
      pdfBuffer,
      quoteId,
      empresa: cliente.empresa,
    });

    // 8) Update Quote con URLs
    stage = "update_quote_urls";
    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
      [config.quotePdfUrlField]: pdfUrl,
      [config.quoteStatusField]: "Enviada",
    }, true);

    // 9) Enviar email (no bloqueante: si falla, sigue)
    stage = "send_email";
    try {
      await sendQuoteEmailViaZoho({
        quoteModule: config.quoteModule,
        quoteId,
        fromEmail: VICKY_OWNER_EMAIL,
        toEmail: cliente.contactoEmail,
        toName: cliente.contacto,
        subject: `Tu cotización GeoVictoria — ${cliente.empresa}`,
        htmlBody: buildEmailHtml({
          contacto: cliente.contacto,
          empresa: cliente.empresa,
          acceptanceUrl,
          pdfUrl,
          ejecutivo: VICKY_EJECUTIVO_NAME,
        }),
      });
    } catch (emailErr) {
      console.error("[create-from-vicky] Email failed (no bloqueante):", emailErr.message);
    }

    return sendJson(res, 200, {
      ok: true,
      quoteId, dealId, accountId, contactId,
      acceptanceUrl,
      pdfUrl,
      expiresAt: new Date(expMs).toISOString(),
    });

  } catch (error) {
    console.error(`[create-from-vicky] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: `Falla en stage='${stage}'`,
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

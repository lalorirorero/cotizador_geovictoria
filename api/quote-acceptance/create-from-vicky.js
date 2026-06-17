const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { createRecord, updateRecord, getRecord, getRecordWithFields, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");
const { descuentosHasta } = require("../_shared/discount-engine");

const VICKY_OWNER_EMAIL = toText(process.env.VICKY_OWNER_EMAIL) || "egomez@geovictoria.com";
const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";
const VICKY_REPLY_TO_EMAIL = toText(process.env.VICKY_REPLY_TO_EMAIL) || "egomez@geovictoria.com";
const VICKY_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_EJECUTIVO_NAME = toText(process.env.VICKY_EJECUTIVO_NAME) || "Anderson Díaz";
const VICKY_TERRITORIO = toText(process.env.VICKY_TERRITORIO) || "Chile";
const VICKY_MONEDA = toText(process.env.VICKY_MONEDA) || "UF";
const VICKY_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_PRODUCTO_DEFAULT = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_SECTOR_FALLBACK = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_EXPANSION_REGIONAL = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";

// ── Ejecutivo comercial asignado a las cotizaciones de Vicky ──
// Aparece en el correo y en el PDF, es el reply-to/CC del correo, y queda como
// Owner de los registros (Account/Contact/Deal/Quote) en Zoho. Verificado:
// usuario activo id 3525045000426432190.
const EJEC_NOMBRE = "Anderson Díaz";
const EJEC_CARGO = "Ejecutivo Comercial";
const EJEC_EMAIL = "adiazg@geovictoria.com";
const EJEC_TELEFONO = "+56 9 3937 2058";
const EJEC_WHATSAPP = "56939372058";
const EJEC_OWNER_ID = "3525045000426432190";
const EJEC_OWNER = { id: EJEC_OWNER_ID };

// Documentos hosteados (URLs permanentes en Supabase) que van como botones de
// descarga en el correo de la cotización.
const DOC_CERTIFICACION = "https://cotizacion.geovictoria.com/pdf/assets/certificacion-dt.pdf";
const DOC_FICHA_RELOJ = "https://cotizacion.geovictoria.com/pdf/assets/ficha-reloj-senseface.pdf";
const DOC_PRESENTACION = "https://cotizacion.geovictoria.com/pdf/assets/presentacion-comercial.pdf";

const SECTORES_VALIDOS = new Set([
  "1. Agrícola", "2. Condominio", "3. Construcción", "4. Inmobilaria",
  "5. Consultoria", "6. Banca y Finanzas", "7. Educación", "8. Municipio",
  "9. Gobierno", "10. Mineria", "11. Naviera", "12. Outsourcing Seguridad",
  "12. Outsourcing General", "13. Outsourcing Retail", "14. Planta Productiva",
  "15. Logistica", "16. Retail Enterprise", "17. Retail SMB", "18. Salud",
  "19. Servicios", "20. Transporte", "21. Turismo, Hotelería y Gastronomía",
]);

function validarSector(valorRecibido) {
  const v = toText(valorRecibido);
  if (v && SECTORES_VALIDOS.has(v)) return v;
  return VICKY_SECTOR_FALLBACK;
}

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
  if (!clean) return { firstName: "Cliente", lastName: "Vicky" };
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  };
}

// ── Helper: convertir Lead → Account+Contact+Deal ──
async function convertLead(leadId, dealData) {
  const path = `/crm/v3/Leads/${encodeURIComponent(leadId)}/actions/convert`;
  const body = {
    data: [{
      overwrite: true,
      notify_lead_owner: true,
      notify_new_entity_owner: true,
      Deals: dealData,
    }],
  };
  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zoho convert Lead failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  const result = parsed?.data?.[0];
  if (!result) throw new Error("Respuesta de convert Lead sin data");
  return {
    accountId: toText(result.Accounts),
    contactId: toText(result.Contacts),
    dealId: toText(result.Deals),
  };
}

// ── Helper: enviar email via Zoho CRM send_mail ──
async function sendQuoteEmailViaZoho({
  quoteModule, quoteId, fromEmail, replyToEmail, toEmail, toName, subject, htmlBody, ccEmail, ccEmails,
}) {
  const path = `/crm/v3/${encodeURIComponent(quoteModule)}/${encodeURIComponent(quoteId)}/actions/send_mail`;
  const dataPayload = {
    from: { email: fromEmail },
    to: [{ user_name: toName || toEmail, email: toEmail }],
    subject,
    content: htmlBody,
    mail_format: "html",
  };
  if (replyToEmail && replyToEmail !== fromEmail) {
    dataPayload.reply_to = { email: replyToEmail };
  }
  // CC: combina ccEmail (legado, 1 correo) + ccEmails (lista). Normaliza,
  // excluye el destinatario principal y deduplica (case-insensitive).
  const toLower = String(toEmail || "").trim().toLowerCase();
  const seen = new Set();
  const ccList = [];
  for (const raw of [ccEmail, ...(Array.isArray(ccEmails) ? ccEmails : [])]) {
    const email = String(raw || "").trim();
    const low = email.toLowerCase();
    if (!email || low === toLower || seen.has(low)) continue;
    seen.add(low);
    ccList.push(email);
  }
  if (ccList.length) {
    dataPayload.cc = ccList.map((email) => ({ email }));
  }
  const body = { data: [dataPayload] };
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

// Número de cotización a mostrar en el PDF: el correlativo de Zoho
// (Numero_Cotizacion, ej. "COT151") SIN el prefijo "COT" → "151". Si por algún
// motivo no está disponible, cae a los últimos 8 dígitos del id interno.
function numeroParaPdf(numeroCotizacion, quoteId) {
  const sinPrefijo = String(numeroCotizacion || "").replace(/^\s*COT[\s_-]*/i, "").trim();
  if (sinPrefijo) return sinPrefijo;
  return String(quoteId || "").slice(-8).toUpperCase();
}

function buildDocFila(href, label, nota) {
  const notaHtml = nota ? ` <span style="color:#a0aec0;font-size:12px;">${nota}</span>` : "";
  return `<tr><td style="padding:11px 16px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;">
    <a href="${href}" style="color:#1a73e8;text-decoration:none;font-size:14px;font-weight:600;">${label}</a>${notaHtml}
  </td></tr><tr><td style="height:8px;"></td></tr>`;
}

// Correo de la cotización (estilo cálido/comercial). El botón principal va al
// PDF de la cotización (desde ahí se llega a la aceptación online); los
// documentos van como botones de descarga a archivos hosteados. La ficha del
// reloj solo se incluye si la cotización tiene hardware.
function buildEmailHtml({ contacto, empresa, pdfUrl, tieneReloj }) {
  const primerNombre = String(contacto || "").trim().split(/\s+/)[0] || "";
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : "Hola 👋";
  const fichaFila = tieneReloj
    ? buildDocFila(DOC_FICHA_RELOJ, "🕐 Ficha Técnica del Reloj", "(tu cotización lleva reloj)")
    : "";
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Tu cotización GeoVictoria</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#2d3748;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(13,71,161,0.08);">
    <tr><td style="background:linear-gradient(135deg,#0d47a1 0%,#1a73e8 100%);padding:28px 32px;">
      <table role="presentation" width="100%"><tr><td style="color:#ffffff;font-size:22px;font-weight:700;">GeoVictoria</td><td align="right" style="color:#bbdefb;font-size:12px;">Control de Asistencia</td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 32px 8px 32px;">
      <p style="margin:0 0 6px 0;font-size:14px;color:#1a73e8;font-weight:600;">${saludo}</p>
      <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#1a202c;">Tu cotización para <span style="color:#0d47a1;">${empresa}</span> está lista</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#4a5568;">Preparé tu propuesta de Control de Asistencia. Ábrela en el PDF y, desde ahí mismo, puedes aceptarla en línea cuando quieras.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 32px 8px 32px;">
      <a href="${pdfUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">📄 Ver tu cotización (PDF)</a>
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
        ${buildDocFila(DOC_CERTIFICACION, "📄 Certificación Dirección del Trabajo", "")}
        ${fichaFila}
        ${buildDocFila(DOC_PRESENTACION, "📊 Presentación Comercial GeoVictoria", "")}
      </table>
    </td></tr>
    <tr><td style="padding:28px 32px 0 32px;">
      <h3 style="margin:0 0 8px 0;font-size:15px;color:#1a202c;">Te presento a tu ejecutivo 🤝</h3>
      <p style="margin:0 0 16px 0;font-size:14px;color:#4a5568;line-height:1.6;">De aquí en adelante, <strong>${EJEC_NOMBRE}</strong> te acompaña en todo el proceso. Cualquier duda o ajuste que necesites, <strong>responde este correo</strong> o escríbele directo por WhatsApp — está para ayudarte. 😊</p>
      <table role="presentation" width="100%" style="background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;"><tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px 0;font-size:14px;color:#1a202c;font-weight:600;">${EJEC_NOMBRE}</p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#718096;">${EJEC_CARGO} · GeoVictoria</p>
        <p style="margin:0;font-size:13px;color:#718096;">✉️ <a href="mailto:${EJEC_EMAIL}" style="color:#1a73e8;text-decoration:none;">${EJEC_EMAIL}</a> &nbsp;·&nbsp; 📱 <a href="https://wa.me/${EJEC_WHATSAPP}" style="color:#1a73e8;text-decoration:none;">${EJEC_TELEFONO}</a></p>
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

// ── Constructores de payloads de update ──
//
// IMPORTANTE: Cuando reusamos un Account/Contact existente (porque buscar_prospect
// encontró match), aplicamos "update conservador": NO sobrescribimos campos que
// ya tienen valor en Zoho. Solo llenamos campos null/vacíos.
//
// Razón: un Account consolidado (sobre todo si match fue por RUT máxima) tiene
// datos legítimos del equipo comercial. Que Vicky cambie el RUT a un formato
// diferente, o el Industry, o el Account_Name, es destructivo.
//
// El payload completo se construye igual que antes; el filtrado se hace en
// `applyConservativeUpdate()` que consulta el registro actual y omite los
// campos donde Zoho ya tiene valor.

function buildAccountFullPayload(cliente, sectorParaZoho) {
  return {
    Phone: cliente.contactoTelefono || undefined,
    Industry: sectorParaZoho,
    Territorio: VICKY_TERRITORIO,
    N_Empleados_dependientes: cliente.userCount,
    Tiene_potencial_de_expansi_n_Regional: VICKY_EXPANSION_REGIONAL,
    RUT_Empresa: cliente.rutEmpresa,
    Billing_Street: cliente.direccionEmpresa || undefined,
    Billing_City: cliente.comunaEmpresa || undefined,
    Billing_State: cliente.regionEmpresa || undefined,
  };
}

function buildContactFullPayload(cliente) {
  const { firstName, lastName } = splitFullName(cliente.contacto);
  return {
    First_Name: firstName,
    Last_Name: lastName,
    Email: cliente.contactoEmail,
    Phone: cliente.contactoTelefono || undefined,
    Lead_Source: VICKY_LEAD_SOURCE,
    Territorio: VICKY_TERRITORIO,
  };
}

/**
 * Aplica update conservador: solo sobrescribe campos que están vacíos/null
 * en el registro existente. Mantiene intactos los campos ya consolidados.
 */
function buildConservativePayload(fullPayload, existingRecord) {
  if (!existingRecord) return fullPayload;
  const conservative = {};
  for (const [key, newValue] of Object.entries(fullPayload)) {
    if (newValue === undefined || newValue === null) continue;
    const currentValue = existingRecord[key];
    const isEmpty = currentValue === null || currentValue === undefined || currentValue === "";
    if (isEmpty) {
      conservative[key] = newValue;
    }
  }
  return conservative;
}

/**
 * Detecta si un error de Zoho es por ID inválido. Esos errores deberían
 * ser tratados como "no existe" en lugar de errores fatales, para hacer
 * fallback a crear un registro nuevo.
 */
function isInvalidIdError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("id given seems to be invalid") ||
    message.includes("invalid_data") ||
    message.includes("invalid id") ||
    message.includes("the id is invalid")
  );
}

/**
 * Detecta si un error de Zoho es por "duplicate data". Esto pasa cuando el
 * createRecord falla porque ya existe un registro con un campo único
 * (típicamente RUT_Empresa en Accounts).
 *
 * Cuando esto ocurre, intentamos encontrar el registro existente y reusarlo
 * con update conservador (Capa 3).
 *
 * Nota sobre "multiple errors": cuando un Account nuevo tiene 2+ campos
 * UNIQUE duplicados a la vez (típicamente Account_Name + RUT_Empresa
 * para el mismo cliente que ya cotizó antes), Zoho agrupa los errores y
 * devuelve "Multiple errors in the request" en lugar de "duplicate data".
 * Lo tratamos igual: intentamos dedup por RUT y, si no encontramos match,
 * el código aguas abajo lanza un error claro.
 */
function isDuplicateDataError(error) {
  if (!error) return false;
  const message = String(error.message || error || "").toLowerCase();
  return (
    message.includes("duplicate data") ||
    message.includes("duplicate_data") ||
    message.includes("multiple errors")
  );
}

// ── Generador de variantes RUT (espejo de lib/zoho-search.ts en Vicky) ──
//
// Para "18.435.922-7" genera: ["18.435.922-7", "184359227", "18435922-7"].
// Necesitamos múltiples variantes porque distintos registros en Zoho pueden
// tener distintos formatos del mismo RUT.
function getRutVariants(rut) {
  if (!rut) return [];
  const raw = String(rut).trim();
  if (!raw) return [];
  const compact = raw.replace(/[.\s-]/g, "").toUpperCase();
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const variantes = [
    raw,
    compact,
    `${cuerpo}-${dv}`,
    `${cuerpoConPuntos}-${dv}`,
  ];
  // DV "K": agrega variantes en minúscula por si quedó guardado como "k".
  if (dv === "K") {
    variantes.push(`${cuerpo}k`, `${cuerpo}-k`, `${cuerpoConPuntos}-k`);
  }
  return Array.from(new Set(variantes)).filter(Boolean);
}

// ── Búsqueda en Zoho (sólo para Capa 3, no para flujo normal) ──
async function executeCoqlQuery(selectQuery) {
  try {
    const response = await zohoApiFetch("/crm/v3/coql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ select_query: selectQuery }),
    });
    if (response.status === 204) return [];
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[executeCoqlQuery] error ${response.status}: ${text.slice(0, 150)}`);
      return [];
    }
    const parsed = JSON.parse(text);
    return parsed?.data || [];
  } catch (err) {
    console.warn(`[executeCoqlQuery] excepción: ${err.message?.slice(0, 150)}`);
    return [];
  }
}

async function findAccountIdByRut(rutEmpresa, empresaName) {
  const variants = getRutVariants(rutEmpresa);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const query = `select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`;
  const rows = await executeCoqlQuery(query);
  if (!rows.length) return null;
  // Si el RUT está en varias cuentas (dato sucio / colisión), preferimos la que
  // coincide con el nombre cotizado, para no asociar a otra empresa distinta.
  if (empresaName) {
    const norm = (s) => String(s || "").trim().toLowerCase();
    const target = norm(empresaName);
    const byName = rows.find((r) => norm(r.Account_Name) === target);
    if (byName) return toText(byName.id);
  }
  return toText(rows[0]?.id) || null;
}

async function findContactIdByEmail(email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  if (!emailNorm) return null;
  const query = `select id from Contacts where Email = '${emailNorm.replace(/'/g, "''")}' limit 1`;
  const rows = await executeCoqlQuery(query);
  return toText(rows[0]?.id) || null;
}

// ── Mapeos para el subform Detalle_Items_Cotizacion ──
//
// El picklist Modalidad en Zoho tiene `display_value` distinto del `reference_value`
// que espera la API. Mapeamos lo que Vicky envía a lo que Zoho acepta.
//
// Vicky envía:                   Zoho espera (reference_value):
//   "Por usuario"           →     "Recurrente"   (display "Por usuario")
//   "Fijo"                  →     "Único"        (display "Fijo")
//   "Arriendo mensual"      →     "Arriendo"
//   "Venta única"           →     "Venta"
//   "Cobro único"           →     "Venta"        (instalación y otros servicios no recurrentes)
//
// IMPORTANTE sobre el picklist "Único" en Zoho: NO significa "pago único". Es el
// reference_value que corresponde al display "Fijo" (tarifa fija mensual). Por
// eso los servicios de pago único (como instalación) van a "Venta", que es el
// único picklist no recurrente disponible.
function mapModalidadToZoho(modalidadVicky) {
  const m = String(modalidadVicky || "").toLowerCase().trim();
  if (m.startsWith("por usuario")) return "Recurrente";
  if (m.startsWith("fijo")) return "Único";
  if (m.startsWith("arriendo")) return "Arriendo";
  if (m.startsWith("venta")) return "Venta";
  // Cualquier variante de pago único (cobro único, pago único, etc.) que no
  // sea explícitamente una venta de equipos: mapea a "Venta" para que quede
  // clasificada como no recurrente.
  if (m.includes("único") || m.includes("unico") || m.includes("única") || m.includes("unica")) {
    return "Venta";
  }
  return "Recurrente"; // fallback razonable para módulos
}

function isItemRecurrente(modalidadZoho) {
  // "Único" es el reference_value del display "Fijo" (tarifa fija MENSUAL), por
  // eso cuenta como recurrente. Los pagos únicos reales van a "Venta".
  return (
    modalidadZoho === "Recurrente" ||
    modalidadZoho === "Arriendo" ||
    modalidadZoho === "Único"
  );
}

// Mapea tipo + id del item al picklist Categoria_Item
function mapCategoriaToZoho(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  const id = String(item.id || "").toLowerCase();
  if (tipo === "hardware") return "Equipos Biometricos";
  if (id === "asistencia") return "Plataforma Asistencia";
  // Resto de módulos (vacaciones, banco_horas, alertas, etc.)
  if (tipo === "modulo") return "Modulos Adicionales";
  return "Otro";
}

// Mapea modalidad al picklist Unidad
function mapUnidadToZoho(modalidadZoho, tipo) {
  if (tipo === "hardware") return "Dispositivo";
  if (modalidadZoho === "Recurrente") return "Usuario";
  if (modalidadZoho === "Único") return "Servicio";
  return "Unidad";
}

// Mapeo de id de hardware (catálogo de Vicky) → modelo real para mostrar
// en el PDF de la cotización formal.
//
// El catálogo de Vicky usa nombres genéricos ("Reloj control físico") para no
// exponer marcas/modelos en la conversación. Pero el PDF formal sí debe
// reflejar el modelo concreto. Este diccionario traduce el `id` del item de
// hardware al string que se escribe en el campo `Descripcion_Item` del
// subform Detalle_Items_Cotizacion.
//
// Cuando se agregue un hardware nuevo al catálogo de Vicky, agregarlo también
// aquí. Si falta el mapeo, `Descripcion_Item` queda vacío para ese item.
const HARDWARE_ID_TO_DESCRIPCION = {
  senseface_2a: "Sense Face 2A",
  armorpad: "ARMORPAD",
  ct58: "CT58",
  in01a_4glan: "IN01-A (4G/LAN)",
  in01a_lan: "IN01-A (LAN)",
  in01a_lanwifi: "IN01-A (LAN/WIFI)",
  mb10vl: "MB10-VL",
  mb560vl: "MB560-vl",
  s922: "S922",
  senseface_3a: "Sense Face 3A",
  senseface_4a: "Sense Face 4A",
  senseface_7a: "Sense Face 7A",
  speedface_v4l: "SpeedFace V4L",
  speedface_v5l: "SpeedFace V5L",
  uru4500: "URU4500",
  x628c: "X628-C",
};

// Resuelve el contenido de Descripcion_Item para un item del subform.
// - hardware: modelo real desde el diccionario (vacío si no está mapeado).
// - módulo:   vacío (el PDF ya muestra Nombre_Item).
function resolveDescripcionItem(item) {
  const tipo = String(item.tipo || "").toLowerCase();
  if (tipo !== "hardware") return "";
  const id = String(item.id || "").toLowerCase();
  return HARDWARE_ID_TO_DESCRIPCION[id] || "";
}

/**
 * Convierte los items que recibimos de Vicky en el formato que espera el
 * subform Detalle_Items_Cotizacion de Zoho.
 *
 * Cada item de Vicky tiene: {tipo, id, nombre, modalidad, cantidad, precioUnitarioUF, subtotalUF}
 *
 * El subform de Zoho espera campos: Nombre_Item, Cantidad, Precio_Unitario_UF,
 * Precio_Unitario_CLP, Subtotal_UF, Subtotal_CLP, Modalidad, Es_Recurrente,
 * Afecto_IVA, Orden, Codigo_Item, Categoria_Item, Unidad.
 */
function buildSubformItems(items, ufActual, config) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item, index) => {
    const modalidadZoho = mapModalidadToZoho(item.modalidad);
    const tipo = String(item.tipo || "").toLowerCase();
    const precioUnitarioUF = Number(item.precioUnitarioUF || 0);
    const subtotalUF = Number(item.subtotalUF || 0);
    const precioUnitarioCLP = ufActual > 0 ? Math.round(precioUnitarioUF * ufActual) : 0;
    const subtotalCLP = ufActual > 0 ? Math.round(subtotalUF * ufActual) : 0;
    // Zona tarifa: solo para items de servicio que la traen explícita. Se usa
    // server-side para decidir descuentos de instalación.
    const zonaRaw = String(item.zonaTarifa || "").toLowerCase().trim();
    const zonaTarifa = zonaRaw === "rm" ? "RM" : zonaRaw === "regiones" ? "regiones" : "";
    const row = {
      Nombre_Item: String(item.nombre || ""),
      Descripcion_Item: resolveDescripcionItem(item),
      Codigo_Item: String(item.id || ""),
      Cantidad: Number(item.cantidad || 0),
      Precio_Unitario_UF: precioUnitarioUF,
      Precio_Unitario_CLP: precioUnitarioCLP,
      Subtotal_UF: subtotalUF,
      Subtotal_CLP: subtotalCLP,
      Modalidad: modalidadZoho,
      Es_Recurrente: isItemRecurrente(modalidadZoho),
      Afecto_IVA: true,
      Orden: index + 1,
      Categoria_Item: mapCategoriaToZoho(item),
      Unidad: mapUnidadToZoho(modalidadZoho, tipo),
    };
    if (zonaTarifa && config?.quoteItemZonaTarifaField) {
      row[config.quoteItemZonaTarifaField] = zonaTarifa;
    }
    return row;
  });
}

/**
 * Intenta reusar un Account/Contact existente con update conservador.
 * Si el ID resulta inválido (transcripción errónea, registro borrado, etc.),
 * retorna { ok: false, invalidId: true } para que el caller haga fallback
 * a crear un registro nuevo. Cualquier otro error se propaga.
 */
async function tryReuseRecord(module, recordId, fullPayload) {
  try {
    const existing = await getRecord(module, recordId);
    if (!existing) {
      console.warn(`[create-from-vicky] ${module}/${recordId} no existe, fallback a crear nuevo`);
      return { ok: false, invalidId: true };
    }
    const conservativePayload = buildConservativePayload(fullPayload, existing);
    // Si no hay nada que actualizar, no llamamos updateRecord (evita PUT vacío)
    if (Object.keys(conservativePayload).length > 0) {
      await updateRecord(module, recordId, conservativePayload, true);
    }
    return { ok: true, recordId };
  } catch (error) {
    if (isInvalidIdError(error)) {
      console.warn(
        `[create-from-vicky] ${module}/${recordId} reportado como inválido por Zoho, fallback a crear nuevo. Detalle: ${error.message?.slice(0, 150)}`
      );
      return { ok: false, invalidId: true };
    }
    // Errores no relacionados a ID inválido sí se propagan
    throw error;
  }
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

  // Auth
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
    const existing = body.existing || {};
    // Descuento negociado en el preform (forma "siguiente índice" = escalón+1).
    // 0 = sin descuento. Si > 0, la cotización nace ya con ese descuento y el
    // PDF v1 refleja el precio acordado (un solo PDF, sin regenerar).
    const escalonDescuento = Math.max(0, Number(body.escalonDescuento || 0));
    // Modo Borrador: crea/actualiza la cotización en estado "Borrador" con el
    // escalón negociado y se detiene ANTES de generar PDF, subirlo y enviar el
    // correo. Lo usa consultar_descuento_referencial para que el escalón viva en
    // Zoho (con quote_id) durante la negociación del preform. La finalización
    // (PDF + correo + "Enviada") ocurre después, al llamar sin draft reusando
    // existing.quoteId/existing.dealId.
    const draft = body.draft === true;

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

    // Validación lógica: leadId no compatible con accountId/contactId
    if (existing.leadId && (existing.accountId || existing.contactId)) {
      return sendJson(res, 400, {
        ok: false,
        error: "existing.leadId no puede venir junto con existing.accountId o existing.contactId",
      });
    }

    const config = getAcceptanceConfig(req);
    const sectorParaZoho = validarSector(cliente.sectorEmpresa);

    let accountId, contactId, dealId;
    const reuse = {
      accountReused: false,
      contactReused: false,
      leadConverted: false,
      dealReused: false,
      quoteReused: false,
    };

    // ── CAMINO A: Convertir Lead existente ──
    if (existing.leadId) {
      stage = "convert_lead";
      const dealDataForConvert = {
        Deal_Name: `${cliente.empresa} - Cotización Vicky`,
        Stage: VICKY_DEAL_STAGE,
        Pipeline: "Standard (Standard)",
        Closing_Date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        Amount: cotizacion.totalCLP || undefined,
      };
      const convertResult = await convertLead(existing.leadId, dealDataForConvert);
      accountId = convertResult.accountId;
      contactId = convertResult.contactId;
      dealId = convertResult.dealId;
      reuse.leadConverted = true;

      if (!accountId || !contactId || !dealId) {
        throw new Error("Conversión de Lead no devolvió todos los IDs");
      }

      // Datos nuevos ganan: actualizar Account, Contact y Deal con los datos del prospect.
      // En este camino (conversión de Lead) sí queremos que los datos nuevos ganen
      // porque el Lead era una primera intención desactualizada.
      stage = "update_account_after_convert";
      await updateRecord("Accounts", accountId, buildAccountFullPayload(cliente, sectorParaZoho), true);

      stage = "update_contact_after_convert";
      await updateRecord("Contacts", contactId, buildContactFullPayload(cliente), true);

      stage = "update_deal_after_convert";
      await updateRecord("Deals", dealId, {
        Territorio: VICKY_TERRITORIO,
        Tombola: VICKY_TOMBOLA,
        Monda_del_trato: VICKY_MONEDA,
        Sector: sectorParaZoho,
        N_Empleados_que_marcan: cliente.userCount,
        Producto_Soluci_n: VICKY_PRODUCTO_DEFAULT,
        Lead_Source: VICKY_LEAD_SOURCE,
        Description: `Deal creado por Vicky desde Lead convertido.\nUsuarios: ${cliente.userCount}\nTotal: ${cotizacion.totalUF} UF / ${cotizacion.totalCLP} CLP\nSector: ${sectorParaZoho}`,
      }, true);

    } else {
      // ── CAMINO B: Crear Account o reusar existente ──
      let needCreateAccount = !existing.accountId;

      if (existing.accountId) {
        stage = "update_existing_account";
        const accountPayload = buildAccountFullPayload(cliente, sectorParaZoho);
        const reuseResult = await tryReuseRecord("Accounts", existing.accountId, accountPayload);
        if (reuseResult.ok) {
          accountId = reuseResult.recordId;
          reuse.accountReused = true;
        } else if (reuseResult.invalidId) {
          // Fallback: el ID no era válido (transcripción errónea o registro borrado).
          // Creamos un Account nuevo como si no hubiera venido existing.accountId.
          needCreateAccount = true;
        }
      }

      if (needCreateAccount) {
        stage = "create_account";
        const createAccountPayload = {
          Account_Name: cliente.empresa,
          RUT_Empresa: cliente.rutEmpresa,
          Phone: cliente.contactoTelefono || undefined,
          Billing_Street: cliente.direccionEmpresa || undefined,
          Billing_City: cliente.comunaEmpresa || undefined,
          Billing_State: cliente.regionEmpresa || undefined,
          Description: `Cuenta creada por Vicky (WhatsApp). RUT: ${cliente.rutEmpresa}`,
          Industry: sectorParaZoho,
          Territorio: VICKY_TERRITORIO,
          N_Empleados_dependientes: cliente.userCount,
          Tiene_potencial_de_expansi_n_Regional: VICKY_EXPANSION_REGIONAL,
          Owner: EJEC_OWNER,
        };
        try {
          const accountResult = await createRecord("Accounts", createAccountPayload, true);
          accountId = toText(accountResult?.id);
          if (!accountId) throw new Error("No se obtuvo accountId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          // ── Capa 3: dedupe por RUT ──
          // El LLM olvidó pasar accountId, pero el Account ya existe en Zoho.
          // Buscamos por RUT y reusamos con update conservador.
          console.warn(
            `[create-from-vicky] Capa 3 Account: createRecord falló por duplicate data. Buscando Account existente con RUT="${cliente.rutEmpresa}"...`,
          );
          stage = "dedupe_account_by_rut";
          const existingAccountId = await findAccountIdByRut(cliente.rutEmpresa, cliente.empresa);
          if (!existingAccountId) {
            throw new Error(
              `Zoho reportó duplicate data pero no se encontró Account con RUT ${cliente.rutEmpresa} (posible inconsistencia o validación distinta)`,
            );
          }
          console.warn(
            `[create-from-vicky] Capa 3 Account: encontrado existente id=${existingAccountId}. Aplicando update conservador.`,
          );
          const fullPayload = buildAccountFullPayload(cliente, sectorParaZoho);
          const reuseResult = await tryReuseRecord("Accounts", existingAccountId, fullPayload);
          if (!reuseResult.ok) {
            // No tirar 500: ya tenemos un accountId válido por RUT. Seguimos sin
            // el update conservador (solo se omiten campos; la cuenta es correcta).
            console.warn(
              `[create-from-vicky] Capa 3 Account: tryReuseRecord falló para id=${existingAccountId}; se usa la cuenta sin actualizar campos.`,
            );
          }
          accountId = existingAccountId;
          reuse.accountReused = true;
        }
      }

      // Crear Contact o reusar existente
      let needCreateContact = !existing.contactId;

      if (existing.contactId) {
        stage = "update_existing_contact";
        const contactPayload = buildContactFullPayload(cliente);
        const reuseResult = await tryReuseRecord("Contacts", existing.contactId, contactPayload);
        if (reuseResult.ok) {
          contactId = reuseResult.recordId;
          reuse.contactReused = true;
        } else if (reuseResult.invalidId) {
          needCreateContact = true;
        }
      }

      if (needCreateContact) {
        stage = "create_contact";
        const { firstName, lastName } = splitFullName(cliente.contacto);
        const createContactPayload = {
          First_Name: firstName,
          Last_Name: lastName,
          Email: cliente.contactoEmail,
          Phone: cliente.contactoTelefono || undefined,
          Account_Name: { id: accountId },
          Lead_Source: VICKY_LEAD_SOURCE,
          Territorio: VICKY_TERRITORIO,
          Owner: EJEC_OWNER,
        };
        try {
          const contactResult = await createRecord("Contacts", createContactPayload, true);
          contactId = toText(contactResult?.id);
          if (!contactId) throw new Error("No se obtuvo contactId");
        } catch (createError) {
          if (!isDuplicateDataError(createError)) throw createError;
          // ── Capa 3: dedupe por Email ──
          console.warn(
            `[create-from-vicky] Capa 3 Contact: createRecord falló por duplicate data. Buscando Contact existente con Email="${cliente.contactoEmail}"...`,
          );
          stage = "dedupe_contact_by_email";
          const existingContactId = await findContactIdByEmail(cliente.contactoEmail);
          if (!existingContactId) {
            throw new Error(
              `Zoho reportó duplicate data pero no se encontró Contact con Email ${cliente.contactoEmail}`,
            );
          }
          console.warn(
            `[create-from-vicky] Capa 3 Contact: encontrado existente id=${existingContactId}. Aplicando update conservador.`,
          );
          const fullPayload = buildContactFullPayload(cliente);
          const reuseResult = await tryReuseRecord("Contacts", existingContactId, fullPayload);
          if (!reuseResult.ok) {
            console.warn(
              `[create-from-vicky] Capa 3 Contact: tryReuseRecord falló para id=${existingContactId}; se usa el contacto sin actualizar campos.`,
            );
          }
          contactId = existingContactId;
          reuse.contactReused = true;
        }
      }

      // Deal: reusar el del Borrador en curso (negociación del preform) si ya
      // existe, o crear uno nuevo. Así un mismo Borrador conserva su Deal entre
      // turnos, en vez de generar un Deal por cada actualización del escalón.
      // Si el id resulta inválido, tryReuseRecord cae a crear uno nuevo.
      if (existing.dealId) {
        stage = "reuse_existing_deal";
        const reuseDeal = await tryReuseRecord("Deals", existing.dealId, {});
        if (reuseDeal.ok) {
          dealId = reuseDeal.recordId;
          reuse.dealReused = true;
        }
      }

      if (!dealId) {
        stage = "create_deal";
        const dealResult = await createRecord("Deals", {
          Deal_Name: `${cliente.empresa} - Cotización Vicky`,
          Account_Name: { id: accountId },
          Contact_Name: { id: contactId },
          Stage: VICKY_DEAL_STAGE,
          Pipeline: "Standard (Standard)",
          Lead_Source: VICKY_LEAD_SOURCE,
          Amount: cotizacion.totalCLP || undefined,
          Description: `Deal creado por Vicky para cotización WhatsApp.\nUsuarios: ${cliente.userCount}\nTotal: ${cotizacion.totalUF} UF / ${cotizacion.totalCLP} CLP\nSector: ${sectorParaZoho}`,
          Territorio: VICKY_TERRITORIO,
          Tombola: VICKY_TOMBOLA,
          Monda_del_trato: VICKY_MONEDA,
          Sector: sectorParaZoho,
          N_Empleados_que_marcan: cliente.userCount,
          Producto_Soluci_n: VICKY_PRODUCTO_DEFAULT,
          Owner: EJEC_OWNER,
        }, true);
        dealId = toText(dealResult?.id);
        if (!dealId) throw new Error("No se obtuvo dealId");
      }
    }

    // ── Cotización: crear nueva o reusar el Borrador en curso ──
    const ufActual = Number(cotizacion.ufActual || 0);
    const subformItems = buildSubformItems(cotizacion.items, ufActual, config);

    // Si la cotización nace con descuento negociado en el preform, calculamos
    // el descuento acumulado con el MISMO motor que usa el commit (mismos ítems
    // → mismos números). El PDF v1 ya sale con el precio acordado.
    let descIniciales = { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 };
    let condicionDiscursivaInicial = null;
    if (escalonDescuento > 0) {
      const pseudoQuote = { [config.quoteItemsSubformField]: subformItems };
      const acum = descuentosHasta(pseudoQuote, config, escalonDescuento - 1);
      descIniciales = acum.descuentos;
      condicionDiscursivaInicial = acum.lastEscalon ? acum.lastEscalon.condicionDiscursiva : null;
    }

    // Campos del escalón/descuento. Son los únicos que cambian entre turnos de
    // la negociación, así que en el reuse del Borrador actualizamos SOLO esto
    // (no el subform: los ítems no cambian y reenviarlos duplicaría las filas).
    const quoteDiscountFields = {
      [config.quoteEscalonField]: escalonDescuento,
      [config.quoteEscalonNegociacionField]: escalonDescuento,
      [config.quoteDiscountUnlockedField]: escalonDescuento > 0,
      [config.quoteDiscountPctField]: descIniciales.recurrentePct,
      [config.quoteDiscountInstRMPctField]: descIniciales.instalacionRMPct,
      [config.quoteDiscountInstRegionPctField]: descIniciales.instalacionRegionPct,
    };

    let quoteId;
    if (existing.quoteId) {
      // Reusar el Borrador negociado: actualizamos el escalón en sitio. Si el id
      // resultó inválido (transcripción/registro borrado), caemos a crear nuevo.
      stage = "update_existing_quote";
      try {
        const existingQuote = await getRecord(config.quoteModule, existing.quoteId);
        if (existingQuote) {
          // Monotonicidad: el escalón del Borrador NUNCA retrocede. Si esta
          // llamada llega con un escalón menor al ya guardado (modelo reiniciado
          // tras un loop), conservamos el mayor — así un 30% aceptado no queda
          // pisado por un 20% viejo.
          const escalonExistente = Math.max(0, Number(existingQuote[config.quoteEscalonField] || 0));
          let fieldsToUpdate = quoteDiscountFields;
          if (escalonExistente > escalonDescuento) {
            const pseudoQuote = { [config.quoteItemsSubformField]: subformItems };
            const acum = descuentosHasta(pseudoQuote, config, escalonExistente - 1);
            fieldsToUpdate = {
              [config.quoteEscalonField]: escalonExistente,
              [config.quoteEscalonNegociacionField]: escalonExistente,
              [config.quoteDiscountUnlockedField]: escalonExistente > 0,
              [config.quoteDiscountPctField]: acum.descuentos.recurrentePct,
              [config.quoteDiscountInstRMPctField]: acum.descuentos.instalacionRMPct,
              [config.quoteDiscountInstRegionPctField]: acum.descuentos.instalacionRegionPct,
            };
            console.warn(
              `[create-from-vicky] Monotonicidad escalón: Borrador ${existing.quoteId} ya estaba en ${escalonExistente}, llegó ${escalonDescuento}; se conserva ${escalonExistente}.`,
            );
          }
          await updateRecord(config.quoteModule, existing.quoteId, fieldsToUpdate, true);
          quoteId = existing.quoteId;
          reuse.quoteReused = true;
        }
      } catch (quoteErr) {
        if (!isInvalidIdError(quoteErr)) throw quoteErr;
        console.warn(
          `[create-from-vicky] Borrador ${existing.quoteId} inválido, se crea cotización nueva. Detalle: ${quoteErr.message?.slice(0, 150)}`,
        );
      }
    }

    if (!quoteId) {
      stage = "create_quote";
      const quoteFields = {
        Name: `Cotización ${cliente.empresa} - ${new Date().toISOString().slice(0, 10)}`,
        Owner: EJEC_OWNER,
        [config.quoteDealLookupField]: { id: dealId },
        [config.quoteContactLookupField]: { id: contactId },
        Cuenta_Asociada: { id: accountId },
        [config.quoteDateField]: new Date().toISOString().slice(0, 10),
        [config.quoteStatusField]: "Borrador",
        [config.contactEmailField]: cliente.contactoEmail,
        [config.contactPhoneField]: cliente.contactoTelefono || undefined,
        [config.companyRutField]: cliente.rutEmpresa,
        // Subform con el detalle de items. La página de aceptación (session.js)
        // lee de aquí y calcula los totales en runtime. Si está vacío, todos los
        // valores se muestran como "-".
        [config.quoteItemsSubformField]: subformItems,
        // Estado inicial de descuentos y versionado (aplicar_siguiente_descuento
        // los actualiza después).
        [config.quoteVersionPdfField]: 1,
        ...quoteDiscountFields,
      };
      const quoteResult = await createRecord(config.quoteModule, quoteFields, true);
      quoteId = toText(quoteResult?.id);
      if (!quoteId) throw new Error("No se obtuvo quoteId");
    }

    // ── Modo Borrador: detenerse aquí (sin PDF/correo) ──
    // El escalón ya quedó en Zoho con su quote_id. La finalización ocurre
    // después, en la llamada de generar_link_cotizadora (sin draft), reusando
    // este quoteId/dealId.
    if (draft) {
      return sendJson(res, 200, {
        ok: true,
        draft: true,
        quoteId, dealId, accountId, contactId,
        sectorAplicado: sectorParaZoho,
        reuse,
      });
    }

    // ── acceptanceUrl ──
    stage = "build_acceptance_url";
    const expMs = Date.now() + config.validityDays * 24 * 60 * 60 * 1000;
    const token = signAcceptancePayload({
      quoteId, dealId,
      iat: Date.now(), exp: expMs,
      nonce: crypto.randomBytes(8).toString("hex"),
      v: 1,
    });
    const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;

    // ── PDF ──
    stage = "render_pdf";
    // El correlativo Numero_Cotizacion (auto-número de Zoho) se genera al crear
    // el registro; lo leemos para mostrarlo en el PDF (sin el prefijo "COT").
    const numeroCotizacion = await getRecordWithFields(config.quoteModule, quoteId, ["Numero_Cotizacion"])
      .then((r) => toText(r?.Numero_Cotizacion))
      .catch(() => "");
    const html = buildProposalHtml({
      cliente: {
        ...cliente,
        ejecutivo: EJEC_NOMBRE,
        ejecutivoEmail: EJEC_EMAIL,
        ejecutivoTelefono: EJEC_TELEFONO,
      },
      cotizacion,
      acceptanceUrl,
      cotizacionId: numeroParaPdf(numeroCotizacion, quoteId),
      validezHasta: new Date(expMs).toISOString(),
      descuentos: descIniciales,
      condicionDiscursiva: condicionDiscursivaInicial,
    });
    const pdfBuffer = await htmlToPdfBuffer(html, {
      format: "Letter",
      margin: "0",
    });

    stage = "upload_pdf";
    const { pdfUrl } = await uploadPdfToSupabase({
      pdfBuffer,
      quoteId,
      empresa: cliente.empresa,
    });

    stage = "update_quote_urls";
    await updateRecord(config.quoteModule, quoteId, {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
      [config.quotePdfUrlField]: pdfUrl,
      [config.quoteStatusField]: "Enviada",
    }, true);

    // Email (no bloqueante)
    stage = "send_email";
    try {
      const tieneReloj = (cotizacion.items || []).some(
        (it) => it && it.tipo === "hardware",
      );
      await sendQuoteEmailViaZoho({
        quoteModule: config.quoteModule,
        quoteId,
        fromEmail: VICKY_FROM_EMAIL,
        replyToEmail: EJEC_EMAIL,
        ccEmail: EJEC_EMAIL,
        // Copias adicionales opcionales que vengan en el payload (body.cc).
        ccEmails: Array.isArray(body.cc) ? body.cc : [],
        toEmail: cliente.contactoEmail,
        toName: cliente.contacto,
        subject: `Tu cotización GeoVictoria — ${cliente.empresa}`,
        htmlBody: buildEmailHtml({
          contacto: cliente.contacto,
          empresa: cliente.empresa,
          pdfUrl,
          tieneReloj,
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
      sectorAplicado: sectorParaZoho,
      reuse,
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

// Exponemos buildSubformItems para que consultar-descuento-referencial reuse la
// MISMA construcción de subform (así el preview del preform y la cotización
// formal usan idéntica conversión de modalidad/zona → mismos números).
module.exports.buildSubformItems = buildSubformItems;

// Exponemos buildEmailHtml para que el preview reuse EXACTAMENTE el mismo correo
// que producción (sin mantener dos copias del diseño).
module.exports.buildEmailHtml = buildEmailHtml;

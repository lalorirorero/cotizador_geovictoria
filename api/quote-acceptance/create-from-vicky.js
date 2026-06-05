const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { createRecord, updateRecord, getRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { htmlToPdfBuffer } = require("../_shared/pdfshift-client");
const { uploadPdfToSupabase } = require("../_shared/supabase-pdf-upload");
const { buildProposalHtml } = require("../_shared/proposal-html-builder");

const VICKY_OWNER_EMAIL = toText(process.env.VICKY_OWNER_EMAIL) || "egomez@geovictoria.com";
const VICKY_FROM_EMAIL = toText(process.env.VICKY_FROM_EMAIL) || "vicky@geovictoria.com";
const VICKY_REPLY_TO_EMAIL = toText(process.env.VICKY_REPLY_TO_EMAIL) || "egomez@geovictoria.com";
const VICKY_DEAL_STAGE = toText(process.env.VICKY_DEAL_STAGE_INICIAL) || "4. Propuesta Enviada / En Negociación";
const VICKY_LEAD_SOURCE = toText(process.env.VICKY_LEAD_SOURCE) || "SEO";
const VICKY_EJECUTIVO_NAME = toText(process.env.VICKY_EJECUTIVO_NAME) || "Eddyluz Mujica";
const VICKY_TERRITORIO = toText(process.env.VICKY_TERRITORIO) || "Chile";
const VICKY_MONEDA = toText(process.env.VICKY_MONEDA) || "UF";
const VICKY_TOMBOLA = toText(process.env.VICKY_TOMBOLA) || "Mantener propietario";
const VICKY_PRODUCTO_DEFAULT = toText(process.env.VICKY_PRODUCTO_DEFAULT) || "Control de Asistencia";
const VICKY_SECTOR_FALLBACK = toText(process.env.VICKY_SECTOR_FALLBACK) || "19. Servicios";
const VICKY_EXPANSION_REGIONAL = toText(process.env.VICKY_EXPANSION_REGIONAL) || "No";

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
  quoteModule, quoteId, fromEmail, replyToEmail, toEmail, toName, subject, htmlBody,
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

function buildEmailHtml({ contacto, empresa, acceptanceUrl, pdfUrl, ejecutivo }) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2d3748;">
  <h2 style="color:#0d47a1;">Hola ${contacto},</h2>
  <p>Te dejamos lista tu cotización personalizada para <strong>${empresa}</strong>.</p>
  <p>Puedes revisarla y aceptarla desde cualquier dispositivo haciendo clic en el botón:</p>
  <p style="text-align:center;margin:30px 0;">
    <a href="${acceptanceUrl}"
       style="display:inline-block;background:#1a73e8;color:#fff;padding:14px 28px;
              text-decoration:none;border-radius:6px;font-weight:bold;">
      Revisar y aceptar cotización
    </a>
  </p>
  <p style="font-size:13px;color:#718096;">
    También puedes descargar el PDF directamente:<br>
    <a href="${pdfUrl}" style="color:#1a73e8;">${pdfUrl}</a>
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:30px 0;">
  <p style="font-size:13px;color:#718096;">
    Tu ejecutivo asignado es <strong>${ejecutivo}</strong>. Cualquier consulta, responde a este correo.
  </p>
  <p style="font-size:13px;color:#a0aec0;">GeoVictoria — geovictoria.com</p>
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
  return Array.from(new Set([
    raw,
    compact,
    `${cuerpo}-${dv}`,
    `${cuerpoConPuntos}-${dv}`,
  ])).filter(Boolean);
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

async function findAccountIdByRut(rutEmpresa) {
  const variants = getRutVariants(rutEmpresa);
  if (variants.length === 0) return null;
  const escaped = variants.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const query = `select id from Accounts where RUT_Empresa in (${escaped}) limit 1`;
  const rows = await executeCoqlQuery(query);
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
  return modalidadZoho === "Recurrente" || modalidadZoho === "Arriendo";
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
    const reuse = { accountReused: false, contactReused: false, leadConverted: false };

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
          Description: `Cuenta creada por Vicky (WhatsApp). RUT: ${cliente.rutEmpresa}`,
          Industry: sectorParaZoho,
          Territorio: VICKY_TERRITORIO,
          N_Empleados_dependientes: cliente.userCount,
          Tiene_potencial_de_expansi_n_Regional: VICKY_EXPANSION_REGIONAL,
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
          const existingAccountId = await findAccountIdByRut(cliente.rutEmpresa);
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
            throw new Error(
              `Capa 3: Account duplicado encontrado (id=${existingAccountId}) pero tryReuseRecord falló`,
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
            throw new Error(
              `Capa 3: Contact duplicado encontrado (id=${existingContactId}) pero tryReuseRecord falló`,
            );
          }
          contactId = existingContactId;
          reuse.contactReused = true;
        }
      }

      // Deal SIEMPRE se crea nuevo (cada cotización es un Deal distinto)
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
      }, true);
      dealId = toText(dealResult?.id);
      if (!dealId) throw new Error("No se obtuvo dealId");
    }

    // ── Cotización (siempre nueva) ──
    stage = "create_quote";
    const ufActual = Number(cotizacion.ufActual || 0);
    const subformItems = buildSubformItems(cotizacion.items, ufActual, config);

    const quoteFields = {
      Name: `Cotización ${cliente.empresa} - ${new Date().toISOString().slice(0, 10)}`,
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
      [config.quoteEscalonField]: 0,
      [config.quoteEscalonNegociacionField]: 0,
      [config.quoteDiscountPctField]: 0,
      [config.quoteDiscountInstRMPctField]: 0,
      [config.quoteDiscountInstRegionPctField]: 0,
    };
    const quoteResult = await createRecord(config.quoteModule, quoteFields, true);
    const quoteId = toText(quoteResult?.id);
    if (!quoteId) throw new Error("No se obtuvo quoteId");

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
    const html = buildProposalHtml({
      cliente: { ...cliente, ejecutivo: VICKY_EJECUTIVO_NAME },
      cotizacion,
      acceptanceUrl,
      cotizacionId: quoteId.slice(-8).toUpperCase(),
      validezHasta: new Date(expMs).toISOString(),
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
      await sendQuoteEmailViaZoho({
        quoteModule: config.quoteModule,
        quoteId,
        fromEmail: VICKY_FROM_EMAIL,
        replyToEmail: VICKY_REPLY_TO_EMAIL,
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

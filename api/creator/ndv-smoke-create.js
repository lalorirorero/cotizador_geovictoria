const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readResponseAsJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isSmokeEnabled() {
  return String(process.env.CREATOR_SMOKE_ENABLED || "").trim().toLowerCase() === "true";
}

function buildDefaultRecord(input) {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const fallbackId = `NDV-SMOKE-${ts}`;

  return {
    Formulario: "Nota de Venta",
    ID_NDV: toNonEmptyString(input?.ID_NDV) || fallbackId,
    Nombre_del_documento: toNonEmptyString(input?.Nombre_del_documento) || `SMOKE NDV ${ts}`,
    STATUS: toNonEmptyString(input?.STATUS) || "BORRADOR",
    FORM_STATUS: toNonEmptyString(input?.FORM_STATUS) || "CREATED",
    ESTADO_COT: toNonEmptyString(input?.ESTADO_COT) || "Vigente",
    Linea_de_Negocio: toNonEmptyString(input?.Linea_de_Negocio) || "Telemarketing",
    Pa_s_Facturaci_n: toNonEmptyString(input?.Pa_s_Facturaci_n) || "Chile",
    Moneda: toNonEmptyString(input?.Moneda) || "UF",
    Identificador_Tributario_Empresa: toNonEmptyString(input?.Identificador_Tributario_Empresa) || "11111111-1",
    CRM_Account: toNonEmptyString(input?.CRM_Account),
    Contacto_CRM: toNonEmptyString(input?.Contacto_CRM),
    Contact_Name: toNonEmptyString(input?.Contact_Name),
    Email: toNonEmptyString(input?.Email),
    Tel_fono: toNonEmptyString(input?.Tel_fono),
    Servicios_Recurrentes: Array.isArray(input?.Servicios_Recurrentes) && input.Servicios_Recurrentes.length > 0
      ? input.Servicios_Recurrentes
      : ["Control de Asistencia"],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Método no permitido." });
    return;
  }

  if (!isSmokeEnabled()) {
    sendJson(res, 403, {
      success: false,
      error: "CREATOR_SMOKE_ENABLED no está habilitado.",
      hint: "Define CREATOR_SMOKE_ENABLED=true en Vercel para habilitar este endpoint de prueba.",
    });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const confirmed = body.confirmed === true;
    if (!confirmed) {
      sendJson(res, 400, {
        success: false,
        error: "Falta confirmación explícita.",
        hint: "Envía { \"confirmed\": true } para ejecutar creación de NDV de prueba.",
      });
      return;
    }

    const config = getCreatorConfig();
    if (config.missing.length > 0) {
      sendJson(res, 500, {
        success: false,
        error: "Faltan variables de entorno de Zoho Creator.",
        missing: config.missing,
      });
      return;
    }

    const incomingRecord = body.record && typeof body.record === "object" ? body.record : {};
    const record = buildDefaultRecord(incomingRecord);

    const path = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(config.formLinkName)}`;
    const response = await creatorApiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: record,
      }),
    });
    const payload = await readResponseAsJsonSafe(response);

    if (!response.ok) {
      sendJson(res, 502, {
        success: false,
        error: "Creator rechazó la creación NDV.",
        creatorStatus: response.status,
        creatorPayload: payload,
        attemptedPath: path,
        attemptedRecord: record,
      });
      return;
    }

    const creatorId = payload?.data?.ID || payload?.data?.id || null;
    sendJson(res, 200, {
      success: true,
      message: "NDV smoke creada en Zoho Creator.",
      creatorStatus: response.status,
      creatorRecordId: creatorId,
      creatorPayload: payload,
      attemptedPath: path,
      attemptedRecord: record,
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Error creando NDV smoke en Creator.",
      detail: String(error?.message || error),
    });
  }
}

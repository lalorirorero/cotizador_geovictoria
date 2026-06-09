/**
 * Crea los sub-formularios de Creator (Servicio_Recurrente + Finalizar_Formulario)
 * para un NDV recién creado via API, replicando el flujo manual del wizard.
 *
 * Flujo:
 *  1. Por cada servicio recurrente → POST Servicio_Recurrente
 *     (Creator auto-dispara UpdatePdfJson1 → construye JsonPdf en el registro)
 *  2. PATCH NDV.Form_Order con las filas de servicios + placeholder Ultimo Paso
 *  3. POST Finalizar_Formulario
 *     (Creator auto-dispara GeneratePDF → llama RegeneratePdfJson → llama PDF API → guarda PDF_STRING)
 *  4. PATCH NDV.Form_Order para actualizar fila Ultimo Paso con ID real
 */

const { getCreatorConfig, creatorApiFetch } = require("./zoho-creator-auth");
const { toText } = require("./zoho-crm");

// Services where Telemarketing billing milestone = "Adelantado"
const ADELANTADO_SERVICES = new Set([
  "Control de Asistencia",
  "Control de Acceso",
  "Servicio de Comedor",
  "Dashboard BI",
  "Vacaciones",
  "Gestión Documental",
  "Calendario Inteligente",
  "SSO",
  "Alertas",
  "Arriendo de Equipos Asistencia",
  "Arriendo de Chip de Datos",
  "Venta de Equipos Asistencia",
  "Venta de Kit de Acceso",
  "Venta de Equipos Comedor",
]);

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatCreatorDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { raw: text };
  }
}

function isCreatorError(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error && typeof payload.error === "object" && Object.keys(payload.error).length > 0) return true;
  const code = Number.parseInt(toText(payload.code), 10);
  if (Number.isFinite(code) && code !== 3000) return true;
  return false;
}

function resolveCreatedId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = toText(payload?.data?.ID || payload?.data?.id || payload?.ID || payload?.id);
  if (direct) return direct;
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const id = toText(row?.ID || row?.id || row?.details?.ID || row?.details?.id);
    if (id) return id;
  }
  return "";
}

function buildFormPath(config, formLinkName) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(formLinkName)}`;
}

function buildRecordPath(config, reportLinkName, recordId) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(reportLinkName)}/${encodeURIComponent(String(recordId))}`;
}

async function createSubformRecord(creatorConfig, formLinkName, record) {
  const path = buildFormPath(creatorConfig, formLinkName);
  const response = await creatorApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: record }),
  });
  const payload = await readJsonSafe(response);
  if (!response.ok || isCreatorError(payload)) {
    const detail = JSON.stringify(payload).slice(0, 300);
    throw new Error(`Creator ${formLinkName} create failed (${response.status}): ${detail}`);
  }
  return resolveCreatedId(payload);
}

async function patchNdvRecord(creatorConfig, ndvId, fields) {
  const path = buildRecordPath(creatorConfig, "ALL_DATA", ndvId);
  const response = await creatorApiFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: fields }),
  });
  const payload = await readJsonSafe(response);
  if (!response.ok || isCreatorError(payload)) {
    const detail = JSON.stringify(payload).slice(0, 300);
    throw new Error(`Creator PATCH NDV failed (${response.status}): ${detail}`);
  }
  return payload;
}

function buildServicioRecurrenteRecord({ ndvId, serviceName, ndvRecord }) {
  const employees = toNumber(ndvRecord.N_Empleados_Compometidos) || 1;
  const hito = ADELANTADO_SERVICES.has(serviceName) ? "Adelantado" : "Otro";
  const chargeTable = Array.isArray(ndvRecord.Tabla_de_Cobro) ? ndvRecord.Tabla_de_Cobro : [];

  return {
    ID_Formulario: ndvId,
    Servicio_Recurrente: serviceName,
    N_Empleados_Compometidos: employees,
    Cantidad_de_Usuarios: employees,
    Cantidad_de_Usuarios_PDF: employees,
    Tabla_de_Cobro: chargeTable,
    Moneda: toText(ndvRecord.Moneda) || "UF",
    Periodicidad_de_Servicio: "Mensual",
    Hito_de_Facturaci_n: hito,
    Plantilla_Tabla_de_Cobro: "Sin Plantilla",
    Descuento_Ejecutivo: 0,
    Fecha_de_Inicio: formatCreatorDate(),
    Linea_de_Negocio: "Telemarketing",
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    CAN_UPDATE_FIELDS: true,
    isSimpleService: false,
    FORM_STATUS: "BEING EDITED",
    NDV_STATUS: toText(ndvRecord.STATUS) || "BORRADOR",
  };
}

function buildFinalizarFormularioRecord({ ndvId, ndvRecord }) {
  return {
    ID_Formulario: ndvId,
    Empresa: "Creada en Plataforma",
    Identificador_Tributario_Empresa: toText(ndvRecord.Identificador_Tributario_Empresa),
    country: toText(ndvRecord.Pa_s_Facturaci_n) || "Chile",
    CAN_UPDATE_FIELDS: true,
    FORM_STATUS: "BEING EDITED",
    NDV_STATUS: toText(ndvRecord.STATUS) || "BORRADOR",
    Notas_PDF: "",
    Solicitar_datos_de_Facturaci_n_al_Cliente: false,
    BillingDataRequested: false,
    BillingDataReceived: false,
    hasAttendance: (ndvRecord.Servicios_Recurrentes || []).includes("Control de Asistencia"),
    hasServices: (ndvRecord.Servicios_Recurrentes || []).length > 0,
  };
}

function buildFormOrderRow({ productType, productName, formId, ndvId }) {
  return {
    Number: 0,
    Product_Type: productType,
    Product_Name: productName,
    Form_ID: formId,
    Selected: true,
    Form_ID_NDV: formId,
    FormName: productType === "Ultimo Paso" ? "Finalizar_Formulario" : "Servicio_Recurrente",
    DuplicationIdReference: 0,
  };
}

/**
 * Orquesta la creación de sub-formularios para un NDV recién creado.
 *
 * @param {string} ndvId  - ID numérico del registro ALL_DATA en Creator
 * @param {object} ndvRecord - El objeto enviado a Creator al crear el NDV (buildNdvRecord output)
 * @returns {{ serviceCount, finalizarId, errors }}
 */
async function runNdvSubformSetup({ ndvId, ndvRecord }) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator para sub-formularios: ${creatorConfig.missing.join(", ")}`);
  }

  const errors = [];
  const recurringServices = (Array.isArray(ndvRecord.Servicios_Recurrentes)
    ? ndvRecord.Servicios_Recurrentes
    : []
  ).filter(Boolean);

  console.log(`[ndv-subforms] ndvId=${ndvId} servicios=${JSON.stringify(recurringServices)}`);

  // 1. Crear un Servicio_Recurrente por cada servicio recurrente
  //    Creator dispara UpdatePdfJson1 automáticamente → construye JsonPdf
  const serviceRows = [];
  for (const serviceName of recurringServices) {
    try {
      const record = buildServicioRecurrenteRecord({ ndvId, serviceName, ndvRecord });
      const serviceId = await createSubformRecord(creatorConfig, "Servicio_Recurrente", record);
      console.log(`[ndv-subforms] Servicio_Recurrente(${serviceName}) → id=${serviceId}`);
      if (serviceId) {
        serviceRows.push(
          buildFormOrderRow({ productType: "Recurrente", productName: serviceName, formId: serviceId, ndvId })
        );
      }
    } catch (err) {
      console.warn(`[ndv-subforms] Servicio_Recurrente(${serviceName}) ERROR: ${err.message}`);
      errors.push(`Servicio_Recurrente(${serviceName}): ${err.message}`);
    }
  }

  // Fila placeholder para Ultimo Paso (sin ID todavía)
  const ultimoPasoPlaceholder = buildFormOrderRow({
    productType: "Ultimo Paso",
    productName: "Ultimo Paso",
    formId: 0,
    ndvId,
  });
  const formOrderWithPlaceholder = [...serviceRows, ultimoPasoPlaceholder];

  // 2. PATCH Form_Order en el NDV ANTES de crear Finalizar_Formulario
  //    Así cuando GeneratePDF dispare, Form_Order ya tiene los servicios
  try {
    await patchNdvRecord(creatorConfig, ndvId, { Form_Order: formOrderWithPlaceholder });
    console.log(`[ndv-subforms] Form_Order PATCH (pre-finalizar) OK, rows=${formOrderWithPlaceholder.length}`);
  } catch (err) {
    console.warn(`[ndv-subforms] Form_Order PATCH (pre-finalizar) ERROR: ${err.message}`);
    errors.push(`Form_Order patch (pre-finalizar): ${err.message}`);
  }

  // 3. Crear Finalizar_Formulario
  //    Creator dispara GeneratePDF → RegeneratePdfJson → PDF API → guarda PDF_STRING en el NDV
  let finalizarId = "";
  try {
    const finalizarRecord = buildFinalizarFormularioRecord({ ndvId, ndvRecord });
    finalizarId = await createSubformRecord(creatorConfig, "Finalizar_Formulario", finalizarRecord);
    console.log(`[ndv-subforms] Finalizar_Formulario → id=${finalizarId}`);
  } catch (err) {
    console.warn(`[ndv-subforms] Finalizar_Formulario ERROR: ${err.message}`);
    errors.push(`Finalizar_Formulario: ${err.message}`);
  }

  // 4. Actualizar Form_Order con el ID real de Finalizar_Formulario
  if (finalizarId) {
    try {
      const finalRows = [
        ...serviceRows,
        buildFormOrderRow({ productType: "Ultimo Paso", productName: "Ultimo Paso", formId: finalizarId, ndvId }),
      ];
      await patchNdvRecord(creatorConfig, ndvId, { Form_Order: finalRows });
      console.log(`[ndv-subforms] Form_Order PATCH (post-finalizar) OK`);
    } catch (err) {
      console.warn(`[ndv-subforms] Form_Order PATCH (post-finalizar) ERROR: ${err.message}`);
      errors.push(`Form_Order patch (post-finalizar): ${err.message}`);
    }
  }

  console.log(`[ndv-subforms] done serviceCount=${serviceRows.length} finalizarId=${finalizarId} errors=${JSON.stringify(errors)}`);
  return {
    serviceCount: serviceRows.length,
    finalizarId,
    errors,
  };
}

module.exports = { runNdvSubformSetup };

const {
  getRecord,
  createRecord,
  updateRecordBestEffort,
  searchRecords,
  getUserById,
  toText,
} = require("./zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("./zoho-creator-auth");

function toNumberOrNull(value) {
  const n = Number.parseInt(toText(value), 10);
  return Number.isFinite(n) ? n : null;
}

function toSafeCreatorNumber(value) {
  const text = toText(value);
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return undefined;
  // Evita precision loss en IDs largos de Zoho (19 digitos).
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(value) {
  return toText(value).toLowerCase();
}

function normalizeItemName(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// NDV dictionary mapping (cotizadora -> Creator) lives in this module.

const CREATOR_SERVICIOS_RECURRENTES_ALLOWED = new Set([
  "Control de Asistencia",
  "Control de Acceso",
  "Servicio de Comedor",
  "Dashboard BI",
  "Vacaciones",
  "Gesti\u00f3n Documental",
  "Integraciones Victoria Connect",
  "Reporte a Medida",
  "Calendario Inteligente",
  "SSO",
  "Alertas",
  "Bolsa de Horas de Desarrollo",
]);

const CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED = new Set([
  ...Array.from(CREATOR_SERVICIOS_RECURRENTES_ALLOWED),
  "Arriendo de Equipos",
  "Arriendo de Equipos Asistencia",
  "Arriendo de Chip de Datos",
]);

const CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED = new Set([
  "Venta de Equipos Asistencia",
  "Venta de Equipos Comedor",
  "Venta de Kit de Acceso",
  "Repuestos",
  "Presupuesto Estimativo de Desarrollo",
  "Desarrollo",
  "Visitas y Servicios T\u00e9cnicos",
  "Enrolamiento en Terreno",
]);

const CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED = new Set([
  ...Array.from(CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED),
  "Visita T\u00e9cnica",
  "Compatibilidad y Homologaci\u00f3n",
  "Capacitaciones",
  "Recursos Adicionales",
  "Consultor\u00eda TI",
]);

function addAllowed(targetSet, label, allowedSet) {
  const text = toText(label);
  if (text && allowedSet.has(text)) targetSet.add(text);
}

function inferServiciosCreator(quote, config) {
  const rows = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const recurrentes = new Set();
  const recurrentesConfigurados = new Set();
  const noRecurrentes = new Set();
  const noRecurrentesConfigurados = new Set();

  const addRecurrente = (label) => {
    addAllowed(recurrentes, label, CREATOR_SERVICIOS_RECURRENTES_ALLOWED);
    addAllowed(recurrentesConfigurados, label, CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED);
  };
  const addRecurrenteConfigurado = (label) =>
    addAllowed(recurrentesConfigurados, label, CREATOR_SERVICIO_RECURRENTE_CONFIG_ALLOWED);
  const addNoRecurrente = (label) => {
    addAllowed(noRecurrentes, label, CREATOR_SERVICIOS_NO_RECURRENTES_ALLOWED);
    addAllowed(noRecurrentesConfigurados, label, CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED);
  };
  const addNoRecurrenteConfigurado = (label) =>
    addAllowed(noRecurrentesConfigurados, label, CREATOR_SERVICIO_NO_RECURRENTE_CONFIG_ALLOWED);

  for (const row of rows) {
    const qty = Number(row?.Cantidad || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeItemName(row?.Nombre_Item);
    const modalidad = normalizeItemName(row?.Modalidad);
    if (!name) continue;

    if (name.includes("asistencia")) addRecurrente("Control de Asistencia");
    else if (name.includes("alert")) addRecurrente("Alertas");
    else if (name.includes("banco de horas")) addRecurrente("Bolsa de Horas de Desarrollo");
    else if (name.includes("documental")) addRecurrente("Gesti\u00f3n Documental");
    else if (name.includes("vacaciones") || name.includes("permiso")) addRecurrente("Vacaciones");
    else if (name.includes("calendario") || name.includes("planificador")) addRecurrente("Calendario Inteligente");
    else if (name.includes("connect")) addRecurrente("Integraciones Victoria Connect");
    else if (name.includes("dashboard")) addRecurrente("Dashboard BI");
    else if (name.includes("sso")) addRecurrente("SSO");
    else if (name.includes("casino") || name.includes("comedor")) addRecurrente("Servicio de Comedor");
    else if (name.includes("reporte a medida")) addRecurrente("Reporte a Medida");

    if (modalidad.includes("arriendo")) {
      addRecurrenteConfigurado("Arriendo de Equipos");
      addRecurrenteConfigurado("Arriendo de Equipos Asistencia");
    } else if (modalidad.includes("venta")) {
      addNoRecurrente("Venta de Equipos Asistencia");
    }

    if (
      name.includes("enrol") ||
      name.includes("instal") ||
      name.includes("visita") ||
      name.includes("tecnic")
    ) {
      addNoRecurrente("Visitas y Servicios T\u00e9cnicos");
      if (name.includes("enrol")) addNoRecurrente("Enrolamiento en Terreno");
    }

    if (name.includes("capacit")) addNoRecurrenteConfigurado("Capacitaciones");
    if (name.includes("consultor")) addNoRecurrenteConfigurado("Consultor\u00eda TI");
    if (name.includes("homolog")) addNoRecurrenteConfigurado("Compatibilidad y Homologaci\u00f3n");
    if (name.includes("desarrollo")) {
      addNoRecurrente("Desarrollo");
      addNoRecurrente("Presupuesto Estimativo de Desarrollo");
    }
  }

  if (recurrentes.size === 0) {
    addRecurrente("Control de Asistencia");
  }

  return {
    serviciosRecurrentes: Array.from(recurrentes),
    servicioRecurrenteConfigurado: Array.from(recurrentesConfigurados),
    serviciosNoRecurrentes: Array.from(noRecurrentes),
    servicioNoRecurrenteConfigurado: Array.from(noRecurrentesConfigurados),
  };
}

function inferServiciosRecurrentes(quote, config) {
  const rows = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const selected = new Set();
  const allowed = new Set([
    "Control de Asistencia",
    "Control de Acceso",
    "Servicio de Comedor",
    "Dashboard BI",
    "Vacaciones",
    "Gestión Documental",
    "Integraciones Victoria Connect",
    "Reporte a Medida",
    "Calendario Inteligente",
    "SSO",
    "Alertas",
    "Bolsa de Horas de Desarrollo",
  ]);

  const pushLabel = (label) => {
    const text = toText(label);
    if (text && allowed.has(text)) selected.add(text);
  };

  for (const row of rows) {
    const qty = Number(row?.Cantidad || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeItemName(row?.Nombre_Item);
    if (!name) continue;

    if (name.includes("asistencia")) pushLabel("Control de Asistencia");
    else if (name.includes("alert")) pushLabel("Alertas");
    else if (name.includes("banco de horas")) pushLabel("Bolsa de Horas de Desarrollo");
    else if (name.includes("documental")) pushLabel("Gestión Documental");
    else if (name.includes("vacaciones") || name.includes("permiso")) pushLabel("Vacaciones");
    else if (name.includes("calendario") || name.includes("planificador")) pushLabel("Calendario Inteligente");
    else if (name.includes("connect")) pushLabel("Integraciones Victoria Connect");
    else if (name.includes("dashboard")) pushLabel("Dashboard BI");
    else if (name.includes("sso")) pushLabel("SSO");
    else if (name.includes("casino") || name.includes("comedor")) pushLabel("Servicio de Comedor");
    else if (name.includes("reporte a medida")) pushLabel("Reporte a Medida");
  }

  if (selected.size === 0) {
    // Fallback para cumplir validación mínima de Creator.
    pushLabel("Control de Asistencia");
  }

  return Array.from(selected);
}

function formatCreatorDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

function resolveCreatedCreatorId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = toText(payload?.data?.ID || payload?.data?.id || payload?.ID || payload?.id);
  if (direct) return direct;
  for (const row of safeArray(payload?.data)) {
    const id = toText(row?.ID || row?.id || row?.details?.ID || row?.details?.id);
    if (id) return id;
  }
  return "";
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function isCreatorBusinessError(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error && typeof payload.error === "object" && Object.keys(payload.error).length > 0) {
    return true;
  }
  const code = Number.parseInt(toText(payload.code), 10);
  if (Number.isFinite(code) && code !== 3000) {
    return true;
  }
  return false;
}

function creatorErrorMessage(payload, fallback) {
  const normalizeErrorValue = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return toText(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeErrorValue(item))
        .filter(Boolean)
        .join(" / ");
    }
    if (typeof value === "object") {
      const parts = Object.entries(value)
        .map(([k, v]) => `${toText(k)}=${normalizeErrorValue(v)}`)
        .filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    }
    return toText(value);
  };

  if (!payload || typeof payload !== "object") return fallback;
  if (payload.error && typeof payload.error === "object") {
    const entries = Object.entries(payload.error)
      .map(([k, v]) => `${k}: ${normalizeErrorValue(v)}`)
      .filter(Boolean);
    if (entries.length > 0) return entries.join(" | ");
  }
  return toText(payload.message || payload.code || payload.raw || fallback);
}

function buildCreatorPath(config) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(config.formLinkName)}`;
}

function buildCreatorUpdatePath(config, recordId) {
  return `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(config.reportLinkName)}/${encodeURIComponent(toText(recordId))}`;
}

function candidateFormLinkNames(config) {
  const seen = new Set();
  const push = (value) => {
    const text = toText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
  };
  push(config?.formLinkName);
  push("Formulario");
  push("Nota_de_Venta");
  return Array.from(seen);
}

async function createNdvWithFormFallback({ creatorConfig, ndvRecord }) {
  let lastResponse = null;
  let lastPayload = {};
  const attemptedForms = [];

  for (const formLinkName of candidateFormLinkNames(creatorConfig)) {
    attemptedForms.push(formLinkName);
    const scopedConfig = { ...creatorConfig, formLinkName };
    const createPath = buildCreatorPath(scopedConfig);
    const createResp = await creatorApiFetch(createPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: ndvRecord }),
    });
    const createPayload = await readJsonSafe(createResp);

    lastResponse = createResp;
    lastPayload = createPayload;

    if (createResp.ok && !isCreatorBusinessError(createPayload)) {
      return {
        ok: true,
        response: createResp,
        payload: createPayload,
        usedFormLinkName: formLinkName,
        attemptedForms,
      };
    }
  }

  return {
    ok: false,
    response: lastResponse,
    payload: lastPayload,
    usedFormLinkName: "",
    attemptedForms,
  };
}

async function ensureBillingContactId({
  accountId,
  billingEmail,
  billingPhone,
  accountName,
  quoteContactName,
  quoteContactEmail,
}) {
  const normalizedBillingEmail = normalizeEmail(billingEmail);
  if (!normalizedBillingEmail) return "";

  const candidates = await searchRecords("Contacts", `(Email:equals:${normalizedBillingEmail})`, [
    "id",
    "Account_Name",
    "Email",
  ]);
  const accountMatch = safeArray(candidates).find(
    (row) => toText(row?.Account_Name?.id) && toText(row?.Account_Name?.id) === toText(accountId)
  );
  const first = accountMatch || safeArray(candidates)[0];
  if (first?.id) {
    return toText(first.id);
  }

  const labelBase = toText(quoteContactName) || toText(accountName) || "Contacto";
  const clean = labelBase.replace(/\s+/g, " ").trim();
  const pieces = clean.split(" ");
  const firstName = pieces.length > 1 ? pieces.slice(0, -1).join(" ") : "";
  const lastName = pieces.length > 0 ? pieces[pieces.length - 1] : "Facturacion";

  const createMap = {
    First_Name: firstName || undefined,
    Last_Name: lastName || "Facturacion",
    Email: normalizedBillingEmail,
    Phone: toText(billingPhone),
    Mobile: toText(billingPhone),
    Account_Name: accountId ? { id: accountId } : undefined,
    Description: "Creado automaticamente desde aceptacion digital de cotizacion.",
  };
  const created = await createRecord("Contacts", createMap, true);
  const createdId = toText(created?.id);
  if (!createdId) return "";

  // Intenta mantener consistencia del contacto con datos comerciales cuando existan.
  const patchMap = {
    Full_Name: toText(quoteContactName),
    Email_Alt: normalizeEmail(quoteContactEmail) || undefined,
  };
  try {
    await updateRecordBestEffort("Contacts", createdId, patchMap, true);
  } catch (_error) {
    // Best effort.
  }
  return createdId;
}

function buildNdvRecord({
  config,
  quote,
  deal,
  account,
  contact,
  ownerUser,
  billingContactId,
  acceptanceData,
  overrides,
}) {
  const creatorOverrides = overrides && typeof overrides === "object" ? overrides : {};
  const creatorFormulario = toText(creatorOverrides.formulario) || "Nota de Venta";
  const creatorStatus =
    toText(creatorOverrides.status) || config.ndvCreatorStatusPending || "PENDIENTE";
  const creatorFormStatus =
    toText(creatorOverrides.formStatus) || config.ndvCreatorFormStatusPending || "CREATED";
  const creatorEstadoCot =
    toText(creatorOverrides.estadoCot) || toText(config.ndvCreatorEstadoCotAccepted);

  const accountId = toText(account?.id || quote?.CRM_Account?.id || deal?.Account_Name?.id);
  const contactId = toText(contact?.id || quote?.CONTACT_ID || quote?.[config.quoteContactLookupField]?.id);
  const dealName = toText(deal?.Deal_Name || quote?.CRM_Deal);
  const accountName = toText(account?.Account_Name || quote?.CRM_ACCOUNT_NAME || deal?.Account_Name?.name);
  const contactName = toText(contact?.Full_Name || quote?.Contact_Name || quote?.Contacto_CRM);
  const contactEmail = normalizeEmail(
    quote?.[config.contactEmailField] || contact?.Email || acceptanceData?.contactEmail
  );
  const contactPhone = toText(quote?.[config.contactPhoneField] || contact?.Phone || contact?.Mobile);
  const sellerEmail = normalizeEmail(
    quote?.Correo_Vendedor ||
      quote?.Email_Ejecutivo ||
      deal?.Correo_Vendedor ||
      ownerUser?.email ||
      ownerUser?.Email
  );
  const servicios = inferServiciosCreator(quote, config);
  const firstServicio = toText(servicios.serviciosRecurrentes[0]) || "Control de Asistencia";
  const dealsAsociados =
    toText(quote?.Deals_Asociados) ||
    toText(deal?.Deal_Name) ||
    (toText(accountName) ? `${toText(accountName)} (${firstServicio})` : "");

  return {
    Formulario: creatorFormulario,
    STATUS: creatorStatus,
    FORM_STATUS: creatorFormStatus,
    ...(creatorEstadoCot ? { ESTADO_COT: creatorEstadoCot } : {}),
    Nombre_del_documento: `${accountName || "Cuenta"} / ${new Date().toISOString().slice(0, 10)}`,
    CRM_Account: accountId || undefined,
    ID_CRM_ACCOUNT: toSafeCreatorNumber(accountId),
    CRM_ACCOUNT_NAME: accountName || undefined,
    Contact_Name: contactName || undefined,
    CONTACT_ID: toSafeCreatorNumber(contactId),
    Email: contactEmail || undefined,
    Tel_fono: contactPhone || undefined,
    Correo_Vendedor: sellerEmail || undefined,
    CRM_Deal: dealName || undefined,
    Deals_Asociados: dealsAsociados || undefined,
    CRM_REFERENCE_ID: toSafeCreatorNumber(quote?.id),
    Moneda: toText(quote?.Moneda) || "UF",
    Pa_s_Facturaci_n: toText(quote?.Pa_s_Facturaci_n) || "Chile",
    Identificador_Tributario_Empresa:
      toText(acceptanceData?.companyRut || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa) ||
      undefined,
    Linea_de_Negocio: toText(quote?.Linea_de_Negocio) || "Telemarketing",
    Servicios_Recurrentes: servicios.serviciosRecurrentes,
    Servicio_Recurrente_Configurado: servicios.servicioRecurrenteConfigurado,
    ...(servicios.serviciosNoRecurrentes.length > 0
      ? { Servicios_No_Recurrentes: servicios.serviciosNoRecurrentes }
      : {}),
    ...(servicios.servicioNoRecurrenteConfigurado.length > 0
      ? { Servicio_No_Recurrente_Configurado: servicios.servicioNoRecurrenteConfigurado }
      : {}),
    Fecha_de_creaci_n: formatCreatorDate(),
    Email_de_Facturacion:
      normalizeEmail(acceptanceData?.billingEmail || quote?.Email_Facturacion || quote?.Email_de_Facturacion) ||
      undefined,
    Tel_fono_de_Facturaci_n:
      toText(acceptanceData?.billingPhone || quote?.Telefono_Facturacion || quote?.Tel_fono_de_Facturaci_n) ||
      undefined,
  };
}

function pickFromLookup(value) {
  if (value && typeof value === "object") return value.id || value.ID || "";
  return value || "";
}

async function runNdvHandoff({ config, quoteId, dealId, acceptanceData }) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator: ${creatorConfig.missing.join(", ")}`);
  }

  const quote = await getRecord(config.quoteModule, quoteId);
  const resolvedDealId = toText(
    dealId || pickFromLookup(quote?.[config.quoteDealLookupField]) || quote?.CRM_Deal_ID
  );
  if (!resolvedDealId) {
    throw new Error("No se pudo resolver Deal asociado para handoff NDV.");
  }
  const deal = await getRecord("Deals", resolvedDealId);

  const accountId = toText(
    pickFromLookup(deal?.Account_Name) ||
      pickFromLookup(quote?.CRM_Account) ||
      pickFromLookup(quote?.[config.onboardingAccountLookupField])
  );
  if (!accountId) {
    throw new Error("No se pudo resolver Account para handoff NDV.");
  }
  const account = await getRecord("Accounts", accountId);

  const contactId = toText(
    pickFromLookup(deal?.Contact_Name) ||
      pickFromLookup(quote?.[config.quoteContactLookupField]) ||
      toText(quote?.CONTACT_ID)
  );
  const contact = contactId ? await getRecord("Contacts", contactId) : null;
  const ownerId = toText(pickFromLookup(deal?.Owner));
  const ownerUser = ownerId ? await getUserById(ownerId).catch(() => null) : null;

  const billingContactId = await ensureBillingContactId({
    accountId,
    billingEmail: acceptanceData?.billingEmail || quote?.[config.billingEmailField],
    billingPhone: acceptanceData?.billingPhone || quote?.[config.billingPhoneField],
    accountName: account?.Account_Name,
    quoteContactName: toText(contact?.Full_Name || quote?.Contact_Name || quote?.Contacto_CRM),
    quoteContactEmail: toText(contact?.Email || quote?.[config.contactEmailField]),
  });

  if (config.quoteBillingContactLookupField && billingContactId) {
    await updateRecordBestEffort(
      config.quoteModule,
      quoteId,
      { [config.quoteBillingContactLookupField]: { id: billingContactId } },
      true
    );
  }

  const ndvRecord = buildNdvRecord({
    config,
    quote,
    deal,
    account,
    contact,
    ownerUser,
    billingContactId,
    acceptanceData: acceptanceData || {},
  });

  if (!toText(ndvRecord.CRM_Account)) {
    throw new Error("No se pudo resolver Cuenta CRM (CRM_Account) para crear NDV.");
  }
  if (!toText(ndvRecord.Correo_Vendedor)) {
    throw new Error("No se pudo resolver Correo_Vendedor desde Owner del Deal.");
  }

  const createAttempt = await createNdvWithFormFallback({ creatorConfig, ndvRecord });
  const createResp = createAttempt.response;
  const createPayload = createAttempt.payload;
  if (!createAttempt.ok) {
    throw new Error(
      `Creator create NDV failed (${createResp?.status || 0}) [forms=${createAttempt.attemptedForms.join(", ")}]: ${creatorErrorMessage(
        createPayload,
        "respuesta invalida"
      )}`
    );
  }

  const ndvCreatorId = resolveCreatedCreatorId(createPayload);
  if (!ndvCreatorId) {
    return {
      ndvCreated: true,
      ndvId: "",
      reconciled: false,
      createPayload,
      message: "NDV creada sin ID devuelto por Creator.",
    };
  }

  const reconcileMap = {
    CRM_Account: ndvRecord.CRM_Account,
    ID_CRM_ACCOUNT: ndvRecord.ID_CRM_ACCOUNT,
    CRM_Deal: ndvRecord.CRM_Deal,
    Deals_Asociados: ndvRecord.Deals_Asociados,
    CRM_REFERENCE_ID: ndvRecord.CRM_REFERENCE_ID,
  };

  const updatePath = buildCreatorUpdatePath(creatorConfig, ndvCreatorId);
  const updateResp = await creatorApiFetch(updatePath, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: reconcileMap }),
  });
  const updatePayload = await readJsonSafe(updateResp);
  const reconciled = updateResp.ok && !isCreatorBusinessError(updatePayload);

  return {
    ndvCreated: true,
    ndvId: toText(ndvCreatorId),
    reconciled,
    createPayload,
    updatePayload,
    usedIds: {
      accountId: toText(ndvRecord.CRM_Account),
      contactId: toText(contactId),
      billingContactId: toText(billingContactId),
      dealName: toText(ndvRecord.CRM_Deal),
      quoteId: toText(quoteId),
    },
  };
}

function proposalDataToQuoteRows(proposalData) {
  const toRows = (items) =>
    safeArray(items).map((item) => ({
      Nombre_Item: toText(item?.nombre),
      Cantidad: Number(item?.cantidad || 0),
      Modalidad: toText(item?.tipo || "Por usuario"),
    }));

  return [
    ...toRows(proposalData?.servicios),
    ...toRows(proposalData?.equipos),
    ...toRows(proposalData?.accesorios),
    ...toRows(proposalData?.serviciosAsoc),
  ].filter((row) => row.Nombre_Item && Number(row.Cantidad) > 0);
}

async function runNdvHandoffFromDraft({
  config,
  dealId,
  proposalData,
  contactEmail,
  contactPhone,
}) {
  const creatorConfig = getCreatorConfig();
  if (creatorConfig.missing.length > 0) {
    throw new Error(`Faltan variables de Zoho Creator: ${creatorConfig.missing.join(", ")}`);
  }

  const resolvedDealId = toText(dealId);
  if (!resolvedDealId) {
    throw new Error("Falta dealId para crear NDV desde cotizadora.");
  }

  const deal = await getRecord("Deals", resolvedDealId);
  const accountId = toText(pickFromLookup(deal?.Account_Name));
  if (!accountId) {
    throw new Error("No se pudo resolver Account desde el Deal.");
  }
  const account = await getRecord("Accounts", accountId);

  const contactId = toText(pickFromLookup(deal?.Contact_Name));
  const contact = contactId ? await getRecord("Contacts", contactId) : null;
  const ownerId = toText(pickFromLookup(deal?.Owner));
  const ownerUser = ownerId ? await getUserById(ownerId).catch(() => null) : null;

  const rows = proposalDataToQuoteRows(proposalData);
  if (!rows.length) {
    throw new Error("No hay items validos en la cotizacion para crear NDV.");
  }

  const pseudoQuote = {
    [config.quoteItemsSubformField]: rows,
    Contact_Name: toText(contact?.Full_Name || proposalData?.contacto || ""),
    [config.contactEmailField]: normalizeEmail(contactEmail || contact?.Email || ""),
    [config.contactPhoneField]: toText(contactPhone || contact?.Phone || contact?.Mobile || ""),
    Moneda: "UF",
    Pa_s_Facturaci_n: "Chile",
    RUT_Cliente: toText(
      proposalData?.rutEmpresa ||
        deal?.RUT_Empresa ||
        deal?.RUT_Cliente ||
        deal?.RUT ||
        deal?.Rut ||
        deal?.Identificador_Tributario_Empresa ||
        account?.RUT_Empresa ||
        account?.RUT_Cliente ||
        account?.RUT ||
        account?.Rut ||
        account?.Identificador_Tributario_Empresa ||
        ""
    ),
    Linea_de_Negocio: "Telemarketing",
  };

  const ndvRecord = buildNdvRecord({
    config,
    quote: pseudoQuote,
    deal,
    account,
    contact,
    ownerUser,
    billingContactId: "",
    acceptanceData: {},
    overrides: {
      // Desde el botón de cotizadora en CRM debe nacer como Cotización.
      formulario: "Cotización",
      status: "BORRADOR",
      formStatus: "CREATED",
      estadoCot: "Vigente",
    },
  });

  const createAttempt = await createNdvWithFormFallback({ creatorConfig, ndvRecord });
  const createResp = createAttempt.response;
  const createPayload = createAttempt.payload;
  if (!createAttempt.ok) {
    throw new Error(
      `Creator create NDV failed (${createResp?.status || 0}) [forms=${createAttempt.attemptedForms.join(", ")}]: ${creatorErrorMessage(
        createPayload,
        "respuesta invalida"
      )}`
    );
  }

  const ndvCreatorId = resolveCreatedCreatorId(createPayload);
  if (!ndvCreatorId) {
    return {
      ndvCreated: true,
      ndvId: "",
      reconciled: false,
      createPayload,
      message: "NDV creada sin ID devuelto por Creator.",
    };
  }

  return {
    ndvCreated: true,
    ndvId: toText(ndvCreatorId),
    reconciled: true,
    createPayload,
  };
}

module.exports = {
  runNdvHandoff,
  runNdvHandoffFromDraft,
};

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

function inferServiciosRecurrentes(quote, config) {
  const rows = Array.isArray(quote?.[config.quoteItemsSubformField]) ? quote[config.quoteItemsSubformField] : [];
  const selected = new Set();

  const pushLabel = (label) => {
    const text = toText(label);
    if (text) selected.add(text);
  };

  for (const row of rows) {
    const qty = Number(row?.Cantidad || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const name = normalizeItemName(row?.Nombre_Item);
    if (!name) continue;

    if (name.includes("asistencia")) pushLabel("Control de Asistencia");
    else if (name.includes("alert")) pushLabel("Alertas");
    else if (name.includes("banco de horas")) pushLabel("Banco de Horas");
    else if (name.includes("documental")) pushLabel("Gestor Documental");
    else if (name.includes("vacaciones") || name.includes("permiso")) pushLabel("Permisos y Vacaciones");
    else if (name.includes("calendario") || name.includes("planificador")) pushLabel("Planificador Inteligente");
    else if (name.includes("connect")) pushLabel("Victoria Connect");
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
}) {
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
  const serviciosRecurrentes = inferServiciosRecurrentes(quote, config);

  return {
    Formulario: "Nota de Venta",
    STATUS: config.ndvCreatorStatusPending || "PENDIENTE",
    FORM_STATUS: config.ndvCreatorFormStatusPending || "CREATED",
    ...(toText(config.ndvCreatorEstadoCotAccepted)
      ? { ESTADO_COT: toText(config.ndvCreatorEstadoCotAccepted) }
      : {}),
    Nombre_del_documento: `${accountName || "Cuenta"} / ${new Date().toISOString().slice(0, 10)}`,
    CRM_Account: accountId || undefined,
    ID_CRM_ACCOUNT: toNumberOrNull(accountId) || undefined,
    CRM_ACCOUNT_NAME: accountName || undefined,
    Contact_Name: contactName || undefined,
    Email: contactEmail || undefined,
    Tel_fono: contactPhone || undefined,
    Correo_Vendedor: sellerEmail || undefined,
    CRM_Deal: dealName || undefined,
    Deals_Asociados: dealName || undefined,
    CRM_REFERENCE_ID: toNumberOrNull(quote?.id) || undefined,
    Moneda: toText(quote?.Moneda) || "UF",
    Pa_s_Facturaci_n: toText(quote?.Pa_s_Facturaci_n) || "Chile",
    Identificador_Tributario_Empresa:
      toText(acceptanceData?.companyRut || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa) ||
      undefined,
    Linea_de_Negocio: toText(quote?.Linea_de_Negocio) || "Telemarketing",
    Servicios_Recurrentes: serviciosRecurrentes,
    Servicio_Recurrente_Configurado: serviciosRecurrentes,
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

  const createPath = buildCreatorPath(creatorConfig);
  const createResp = await creatorApiFetch(createPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: ndvRecord }),
  });
  const createPayload = await readJsonSafe(createResp);
  if (!createResp.ok || isCreatorBusinessError(createPayload)) {
    throw new Error(
      `Creator create NDV failed (${createResp.status}): ${creatorErrorMessage(
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

module.exports = {
  runNdvHandoff,
};

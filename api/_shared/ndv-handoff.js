const {
  getRecord,
  createRecord,
  updateRecordBestEffort,
  searchRecords,
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

  return {
    Formulario: "Nota de Venta",
    STATUS: config.ndvCreatorStatusPending || "PENDIENTE",
    FORM_STATUS: config.ndvCreatorFormStatusPending || "CREATED",
    ESTADO_COT: config.ndvCreatorEstadoCotAccepted || "Aceptada",
    Nombre_del_documento: `${accountName || "Cuenta"} / ${new Date().toISOString().slice(0, 10)}`,
    CRM_Account: accountId || undefined,
    ID_CRM_ACCOUNT: toNumberOrNull(accountId) || undefined,
    CRM_ACCOUNT_NAME: accountName || undefined,
    Contacto_CRM: contactName || undefined,
    Contact_Name: contactName || undefined,
    CONTACT_ID: toNumberOrNull(contactId) || undefined,
    Email: contactEmail || undefined,
    Tel_fono: contactPhone || undefined,
    BILLING_CONTACT_ID: toNumberOrNull(billingContactId) || undefined,
    CRM_Deal: dealName || undefined,
    Deals_Asociados: dealName || undefined,
    CRM_REFERENCE_ID: toNumberOrNull(quote?.id) || undefined,
    Moneda: toText(quote?.Moneda) || "UF",
    Pa_s_Facturaci_n: toText(quote?.Pa_s_Facturaci_n) || "Chile",
    Identificador_Tributario_Empresa:
      toText(acceptanceData?.companyRut || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa) ||
      undefined,
    Linea_de_Negocio: toText(quote?.Linea_de_Negocio) || "Telemarketing",
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
    billingContactId,
    acceptanceData: acceptanceData || {},
  });

  const createPath = buildCreatorPath(creatorConfig);
  const createResp = await creatorApiFetch(createPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: ndvRecord }),
  });
  const createPayload = await readJsonSafe(createResp);
  if (!createResp.ok) {
    throw new Error(
      `Creator create NDV failed (${createResp.status}): ${toText(
        createPayload?.message || createPayload?.code || createPayload?.raw
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
    CONTACT_ID: ndvRecord.CONTACT_ID,
    BILLING_CONTACT_ID: ndvRecord.BILLING_CONTACT_ID,
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
  const reconciled = updateResp.ok;

  return {
    ndvCreated: true,
    ndvId: toText(ndvCreatorId),
    reconciled,
    createPayload,
    updatePayload,
    usedIds: {
      accountId: toText(ndvRecord.CRM_Account),
      contactId: toText(ndvRecord.CONTACT_ID),
      billingContactId: toText(ndvRecord.BILLING_CONTACT_ID),
      dealName: toText(ndvRecord.CRM_Deal),
      quoteId: toText(quoteId),
    },
  };
}

module.exports = {
  runNdvHandoff,
};


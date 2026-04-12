const {
  getRecordWithFields,
  getRecord,
  createRecord,
  updateRecordBestEffort,
  getUserById,
  searchRecords,
  toText,
} = require("./zoho-crm");

const MODULOS_PERMITIDOS = [
  "Dashboard BI",
  "Gestor Documental",
  "Planificador Inteligente",
  "Modulo de Alertas",
  "Permisos y Vacaciones",
];

const SISTEMA_MAP = {
  "Relojes Biométricos": "GeoVictoria BOX",
  "Relojes Biometricos": "GeoVictoria BOX",
  "Marcaje por Llamada": "GeoVictoria CALL",
  "Aplicación Móvil": "GeoVictoria APP",
  "Aplicacion Movil": "GeoVictoria APP",
  "Lector USB Biométrico": "GeoVictoria USB",
  "Lector USB Biometrico": "GeoVictoria USB",
  "Portal Web": "GeoVictoria WEB",
};

const emptyString = "";

function uniqueStrings(values) {
  const set = new Set();
  for (const value of values || []) {
    const text = toText(value);
    if (text) set.add(text);
  }
  return Array.from(set);
}

function toZohoDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+00:00`;
}

function pickNonEmpty(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return emptyString;
}

function normalizeSistemas(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return uniqueStrings(
    list.map((item) => {
      const text = toText(item);
      if (!text) return emptyString;
      if (text.startsWith("GeoVictoria ")) return text;
      return SISTEMA_MAP[text] || emptyString;
    })
  );
}

function normalizeModulos(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = uniqueStrings(
    list.map((item) => {
      const text = toText(item);
      if (text === "Dasboard BI") return "Dashboard BI";
      return text;
    })
  );
  return normalized.filter((value) => MODULOS_PERMITIDOS.includes(value));
}

function buildOnboardingName(quote, deal, account, contact) {
  const empresa = pickNonEmpty(
    account?.Account_Name,
    quote?.Nombre_Fantasia,
    quote?.Razon_Social,
    quote?.Name,
    deal?.Deal_Name,
    "Empresa"
  );
  const contacto = pickNonEmpty(
    contact?.Full_Name,
    quote?.Contacto_Cliente,
    deal?.Contact_Name?.name,
    deal?.Owner?.name,
    "Contacto"
  );
  return `Auto Onboarding ${empresa} - ${contacto}`.slice(0, 120);
}

function buildGenerateLinkPayload({
  onboardingId,
  empresa,
  ejecutivoNombre,
  ejecutivoTelefono,
  sistemas,
  modulosAdicionales,
}) {
  return {
    id_zoho: onboardingId,
    empresa: {
      razonSocial: empresa.razonSocial || emptyString,
      nombreFantasia: empresa.nombreFantasia || emptyString,
      rut: empresa.rut || emptyString,
      giro: empresa.giro || emptyString,
      direccion: empresa.direccion || emptyString,
      comuna: empresa.comuna || emptyString,
      emailFacturacion: empresa.emailFacturacion || emptyString,
      telefonoContacto: empresa.telefonoContacto || emptyString,
      ejecutivoTelefono: ejecutivoTelefono || emptyString,
      ejecutivoNombre: ejecutivoNombre || emptyString,
      sistema: sistemas || [],
      modulosAdicionales: modulosAdicionales || [],
      modulosAdicionalesOtro: emptyString,
      rubro: empresa.rubro || emptyString,
    },
  };
}

async function fetchDealContext(config, dealId) {
  const deal = await getRecordWithFields("Deals", dealId, [
    "id",
    "Deal_Name",
    "Owner",
    "Account_Name",
    "Contact_Name",
    "M_todo_de_Marcaje",
    "Modulos_adicionales",
    "Rut_ID_Account",
    "Rubro",
    "Rubro_Account",
    "Contact_Email",
    "Contact_Phone",
  ]);

  const accountId = toText(deal?.Account_Name?.id);
  const contactId = toText(deal?.Contact_Name?.id);
  const ownerId = toText(deal?.Owner?.id);

  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, [
        "id",
        "Account_Name",
        "RUT_Empresa",
        "Comuna",
        "Rubro_econ_mico",
      ])
    : null;

  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, [
        "id",
        "Full_Name",
        "Email",
        "Phone",
        "Mailing_City",
        "Mailing_Street",
      ])
    : null;

  const owner = ownerId ? await getUserById(ownerId) : null;

  return {
    deal,
    account,
    contact,
    owner,
  };
}

function buildOnboardingDraft({
  config,
  quote,
  dealContext,
  acceptanceData,
}) {
  const { deal, account, contact, owner } = dealContext;

  const empresa = {
    razonSocial: pickNonEmpty(account?.Account_Name, quote?.Razon_Social, quote?.Name),
    nombreFantasia: pickNonEmpty(account?.Account_Name, quote?.Razon_Social, quote?.Name),
    rut: pickNonEmpty(
      acceptanceData?.companyRut,
      quote?.RUT_Cliente,
      deal?.Rut_ID_Account,
      account?.RUT_Empresa
    ),
    giro: pickNonEmpty(acceptanceData?.companyGiro, quote?.Giro, account?.Rubro_econ_mico),
    direccion: pickNonEmpty(acceptanceData?.companyAddress, quote?.Direccion, contact?.Mailing_Street),
    comuna: pickNonEmpty(acceptanceData?.companyComuna, quote?.Comuna, account?.Comuna, contact?.Mailing_City),
    emailFacturacion: pickNonEmpty(
      acceptanceData?.billingEmail,
      quote?.[config.billingEmailField],
      contact?.Email,
      deal?.Contact_Email
    ),
    telefonoContacto: pickNonEmpty(
      acceptanceData?.billingPhone,
      quote?.[config.billingPhoneField],
      contact?.Phone,
      deal?.Contact_Phone
    ),
    rubro: pickNonEmpty(quote?.Rubro, deal?.Rubro, account?.Rubro_econ_mico),
  };

  const ejecutivoNombre = pickNonEmpty(owner?.full_name, owner?.name, deal?.Owner?.name);
  const ejecutivoTelefono = pickNonEmpty(owner?.phone, owner?.mobile);
  const sistemas = normalizeSistemas(deal?.M_todo_de_Marcaje);
  const modulosAdicionales = normalizeModulos(deal?.Modulos_adicionales);

  return {
    onboardingName: buildOnboardingName(quote, deal, account, contact),
    accountId: pickNonEmpty(account?.id, deal?.Account_Name?.id),
    executorContactId: pickNonEmpty(contact?.id, deal?.Contact_Name?.id),
    empresa,
    ejecutivoNombre,
    ejecutivoTelefono,
    sistemas,
    modulosAdicionales,
  };
}

async function getOrCreateOnboardingRecord({ config, quoteId, dealId, quote, draft }) {
  const currentLookupId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
  if (currentLookupId) {
    return { onboardingId: currentLookupId, created: false };
  }

  const byOrigin = await searchRecords(
    config.onboardingModule,
    `(Origen_Aceptacion_Id:equals:${quoteId})`,
    ["id"]
  );
  if (Array.isArray(byOrigin) && byOrigin.length > 0) {
    const existingId = toText(byOrigin[0]?.id);
    if (existingId) return { onboardingId: existingId, created: false };
  }

  const createMap = {
    [config.onboardingNameField]: draft.onboardingName,
    [config.onboardingDealLookupField]: { id: dealId },
    [config.onboardingQuoteLookupField]: { id: quoteId },
    [config.onboardingOriginAcceptanceIdField]: quoteId,
    [config.onboardingChannelField]: config.onboardingChannelValue,
    [config.onboardingHandoffStatusField]: "link_generation",
    [config.onboardingHandoffErrorField]: "",
    [config.onboardingRazonSocialField]: draft.empresa.razonSocial,
    [config.onboardingNombreFantasiaField]: draft.empresa.nombreFantasia,
    [config.onboardingRutField]: draft.empresa.rut,
    [config.onboardingGiroField]: draft.empresa.giro,
    [config.onboardingDireccionField]: draft.empresa.direccion,
    [config.onboardingComunaField]: draft.empresa.comuna,
    [config.onboardingEmailFacturacionField]: draft.empresa.emailFacturacion,
    [config.onboardingTelefonoContactoField]: draft.empresa.telefonoContacto,
    [config.onboardingRubroField]: draft.empresa.rubro,
    [config.onboardingSistemasField]: draft.sistemas,
    [config.onboardingModulosField]: draft.modulosAdicionales,
  };
  if (config.onboardingAccountLookupField && draft.accountId) {
    createMap[config.onboardingAccountLookupField] = { id: draft.accountId };
  }
  if (config.onboardingExecutorContactLookupField && draft.executorContactId) {
    createMap[config.onboardingExecutorContactLookupField] = { id: draft.executorContactId };
  }

  const createResult = await createRecord(config.onboardingModule, createMap, true);
  return { onboardingId: createResult.id, created: true };
}

async function updateOnboardingReady({ config, onboardingId, link, token }) {
  const now = toZohoDateTime();
  const map = {
    [config.onboardingUrlField]: link,
    [config.onboardingTokenField]: token,
    [config.onboardingTokenActiveField]: true,
    [config.onboardingTokenDateField]: now,
    [config.onboardingHandoffStatusField]: "ready",
    [config.onboardingHandoffErrorField]: "",
  };
  await updateRecordBestEffort(config.onboardingModule, onboardingId, map, true);
}

async function updateOnboardingError({ config, onboardingId, errorMessage }) {
  const map = {
    [config.onboardingHandoffStatusField]: "error",
    [config.onboardingHandoffErrorField]: toText(errorMessage).slice(0, 255),
  };
  await updateRecordBestEffort(config.onboardingModule, onboardingId, map, true);
}

async function updateQuoteHandoffSuccess({ config, quoteId, onboardingId, link, token }) {
  const map = {
    [config.quoteOnboardingLookupField]: onboardingId ? { id: onboardingId } : undefined,
    [config.quoteOnboardingUrlField]: link,
    [config.quoteOnboardingTokenField]: token,
    [config.quoteHandoffStatusField]: config.quoteOnboardingStatusReady || "Cerrada",
  };
  await updateRecordBestEffort(config.quoteModule, quoteId, map, true);
}

async function updateQuoteHandoffError({ config, quoteId, errorMessage, onboardingId }) {
  const map = {
    [config.quoteOnboardingLookupField]: onboardingId ? { id: onboardingId } : undefined,
    [config.quoteHandoffStatusField]: config.quoteOnboardingStatusError || "Error",
    [config.quoteHandoffErrorField]: toText(errorMessage).slice(0, 255),
  };
  await updateRecordBestEffort(config.quoteModule, quoteId, map, true);
}

async function requestOnboardingLink(config, payload) {
  const endpoint = toText(config.onboardingGenerateLinkUrl);
  if (!endpoint) {
    throw new Error("ONBOARDING_GENERATE_LINK_URL no configurado.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch (_error) {
    parsed = { raw: text || "" };
  }

  if (!response.ok || parsed?.success !== true) {
    const message = toText(parsed?.error || parsed?.message || parsed?.raw) || `HTTP ${response.status}`;
    throw new Error(`generate-link onboarding fallo: ${message}`);
  }

  const link = toText(parsed?.link);
  const token = toText(parsed?.token);
  if (!link || !token) {
    throw new Error("generate-link onboarding respondio sin link/token.");
  }
  return { link, token, raw: parsed };
}

async function runOnboardingHandoff({ config, quoteId, dealId, acceptanceData }) {
  const quote = await getRecord(config.quoteModule, quoteId);
  const realDealId = toText(quote?.[config.quoteDealLookupField]?.id || dealId);
  if (!realDealId) {
    throw new Error("La cotizacion no tiene Deal asociado.");
  }

  const existingOnboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
  const existingToken = toText(quote?.[config.quoteOnboardingTokenField]);
  const existingOnboardingId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
  if (existingOnboardingUrl && existingToken && existingOnboardingId) {
    return {
      onboardingId: existingOnboardingId,
      onboardingUrl: existingOnboardingUrl,
      token: existingToken,
      reused: true,
      linkCreated: false,
    };
  }

  const context = await fetchDealContext(config, realDealId);
  const draft = buildOnboardingDraft({
    config,
    quote,
    dealContext: context,
    acceptanceData: acceptanceData || {},
  });
  const onboardingRow = await getOrCreateOnboardingRecord({
    config,
    quoteId,
    dealId: realDealId,
    quote,
    draft,
  });

  await updateRecordBestEffort(
    config.quoteModule,
    quoteId,
    {
      [config.quoteOnboardingLookupField]: { id: onboardingRow.onboardingId },
      [config.quoteHandoffStatusField]: config.quoteOnboardingStatusPending || "En Curso",
      [config.quoteHandoffErrorField]: "",
    },
    true
  );

  try {
    const linkResult = await requestOnboardingLink(
      config,
      buildGenerateLinkPayload({
        onboardingId: onboardingRow.onboardingId,
        empresa: draft.empresa,
        ejecutivoNombre: draft.ejecutivoNombre,
        ejecutivoTelefono: draft.ejecutivoTelefono,
        sistemas: draft.sistemas,
        modulosAdicionales: draft.modulosAdicionales,
      })
    );

    await updateOnboardingReady({
      config,
      onboardingId: onboardingRow.onboardingId,
      link: linkResult.link,
      token: linkResult.token,
    });
    await updateQuoteHandoffSuccess({
      config,
      quoteId,
      onboardingId: onboardingRow.onboardingId,
      link: linkResult.link,
      token: linkResult.token,
    });

    return {
      onboardingId: onboardingRow.onboardingId,
      onboardingUrl: linkResult.link,
      token: linkResult.token,
      reused: false,
      linkCreated: true,
      onboardingCreated: onboardingRow.created,
    };
  } catch (error) {
    const message = toText(error?.message || error) || "Error desconocido en handoff.";
    await updateOnboardingError({
      config,
      onboardingId: onboardingRow.onboardingId,
      errorMessage: message,
    });
    await updateQuoteHandoffError({
      config,
      quoteId,
      onboardingId: onboardingRow.onboardingId,
      errorMessage: message,
    });
    throw error;
  }
}

module.exports = {
  runOnboardingHandoff,
};

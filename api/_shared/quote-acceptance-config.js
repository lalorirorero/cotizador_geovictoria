const { toText } = require("./zoho-crm");

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBaseUrl(req) {
  const envBase = toText(process.env.QUOTE_ACCEPT_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/+$/, "");

  const host = toText(req?.headers?.host);
  const proto = toText(req?.headers?.["x-forwarded-proto"]) || "https";
  if (!host) {
    return "https://cotizador-geovictoria.vercel.app";
  }
  return `${proto}://${host}`;
}

function getAcceptanceConfig(req) {
  return {
    baseUrl: getBaseUrl(req),
    quoteModule: toText(process.env.ZOHO_QUOTE_MODULE || "Cotizaciones_GeoVictoria"),
    quoteDateField: toText(process.env.QUOTE_DATE_FIELD || "Fecha_Cotizacion"),
    quoteStatusField: toText(process.env.QUOTE_STATUS_FIELD || "Estado_Cotizacion"),
    quoteDealLookupField: toText(process.env.QUOTE_DEAL_LOOKUP_FIELD || "Deal_Asociado"),
    quotePdfUrlField: toText(process.env.QUOTE_PDF_URL_FIELD || "PDF_URL"),
    quoteItemsSubformField: toText(process.env.QUOTE_ITEMS_SUBFORM_FIELD || "Detalle_Items_Cotizacion"),
    quoteAcceptanceUrlField: toText(process.env.QUOTE_ACCEPTANCE_URL_FIELD || "URL_Aceptacion_Web"),
    quoteAcceptanceAtField: toText(process.env.QUOTE_ACCEPTED_AT_FIELD || "Fecha_Aceptacion_Web"),
    quoteTermsAcceptedField: toText(process.env.QUOTE_TERMS_ACCEPTED_FIELD || "TyC_Aceptados_Web"),
    quoteTermsVersionField: toText(process.env.QUOTE_TERMS_VERSION_FIELD || "Version_TyC_Web"),
    quoteHandoffStatusField: toText(process.env.QUOTE_HANDOFF_STATUS_FIELD || "Estado_Handoff"),
    quoteHandoffErrorField: toText(process.env.QUOTE_HANDOFF_ERROR_FIELD || "Error_Handoff"),
    billingEmailField: toText(process.env.QUOTE_BILLING_EMAIL_FIELD || "Email_Facturacion"),
    billingPhoneField: toText(process.env.QUOTE_BILLING_PHONE_FIELD || "Telefono_Facturacion"),
    companyRutField: toText(process.env.QUOTE_COMPANY_RUT_FIELD || "RUT_Empresa"),
    companyGiroField: toText(process.env.QUOTE_COMPANY_GIRO_FIELD || "Giro"),
    companyComunaField: toText(process.env.QUOTE_COMPANY_COMUNA_FIELD || "Comuna"),
    companyAddressField: toText(process.env.QUOTE_COMPANY_ADDRESS_FIELD || "Direccion"),
    termsVersion: toText(process.env.QUOTE_TERMS_VERSION || "TYC-CL-2026-04"),
    validityDays: toInt(process.env.QUOTE_ACCEPTANCE_VALIDITY_DAYS, 30),
    handoffWebhookUrl: toText(process.env.QUOTE_HANDOFF_WEBHOOK_URL),
  };
}

module.exports = {
  getAcceptanceConfig,
};


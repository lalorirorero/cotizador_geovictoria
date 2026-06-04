/**
 * Resuelve el contexto de una sesion de pago a partir del token firmado que
 * genera `confirm.js` (purpose "payment_session").
 *
 * Carga la cotizacion, valida coherencia del token vs. el Deal de la
 * cotizacion y calcula los montos a cobrar (one-shot y recurrente) usando la
 * configuracion de Mercado Pago (IVA segun `MP_CHARGE_INCLUDE_IVA`).
 */

const { getRecord, toText } = require("./zoho-crm");
const { getAcceptanceConfig } = require("./quote-acceptance-config");
const { getMercadoPagoConfig } = require("./mercadopago-config");
const { verifyVerificationToken, normalizeEmail } = require("./verification-token");
const { sanitizeItems, clampDescuentoPct, computePaymentAmounts } = require("./quote-pricing");

const PAYMENT_SESSION_PURPOSE = "payment_session";

async function resolvePaymentSession(req, token) {
  const acceptanceConfig = getAcceptanceConfig(req);
  const mpConfig = getMercadoPagoConfig(req);

  const payload = verifyVerificationToken(token, PAYMENT_SESSION_PURPOSE);
  const quoteId = toText(payload?.quoteId);
  if (!quoteId) {
    throw new Error("Token de pago sin cotizacion.");
  }

  const quote = await getRecord(acceptanceConfig.quoteModule, quoteId);
  if (!quote) {
    throw new Error("No se encontro la cotizacion.");
  }

  const quoteDealId = toText(
    quote?.[acceptanceConfig.quoteDealLookupField]?.id ||
      quote?.[acceptanceConfig.quoteDealLookupField]
  );
  const tokenDealId = toText(payload?.dealId);
  if (tokenDealId && quoteDealId && tokenDealId !== quoteDealId) {
    throw new Error("El token de pago no corresponde a esta cotizacion.");
  }

  const items = sanitizeItems(quote?.[acceptanceConfig.quoteItemsSubformField]);
  const descuentoPct = clampDescuentoPct(quote?.[acceptanceConfig.quoteDiscountPctField]);
  const amounts = computePaymentAmounts(items, descuentoPct, {
    includeIva: mpConfig.includeIva,
  });

  const billingEmail =
    normalizeEmail(payload?.billingEmail) ||
    normalizeEmail(quote?.[acceptanceConfig.billingEmailField]) ||
    normalizeEmail(quote?.[acceptanceConfig.contactEmailField]);

  return {
    acceptanceConfig,
    mpConfig,
    quote,
    quoteId,
    dealId: quoteDealId || tokenDealId,
    billingEmail,
    billingPhone: toText(quote?.[acceptanceConfig.billingPhoneField]),
    companyRut: toText(quote?.[acceptanceConfig.companyRutField]),
    quoteName: toText(quote?.Name),
    amounts,
    token,
  };
}

module.exports = {
  PAYMENT_SESSION_PURPOSE,
  resolvePaymentSession,
};

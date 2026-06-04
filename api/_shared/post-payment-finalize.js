/**
 * Finalizacion del journey luego de que el pago unico + la suscripcion quedaron
 * confirmados en Mercado Pago.
 *
 * Reune los handoffs que en el flujo SIN pago hace `confirm.js`:
 *   1. Onboarding handoff (genera/recupera el link de auto-onboarding).
 *   2. NDV handoff (nota de venta en Zoho Creator), best-effort.
 *
 * Es IDEMPOTENTE: `runOnboardingHandoff` reutiliza el onboarding existente, por
 * lo que puede invocarse tanto desde el webhook como desde el endpoint de estado
 * sin duplicar registros.
 */

const { getRecord, updateRecordBestEffort, toText } = require("./zoho-crm");
const { runOnboardingHandoff } = require("./onboarding-handoff");
const { runNdvHandoff } = require("./ndv-handoff");
const { normalizeEmail } = require("./verification-token");
const { sanitizeItems, clampDescuentoPct, computePaymentAmounts } = require("./quote-pricing");
const {
  searchPaymentsByExternalReference,
  searchPreapprovalByExternalReference,
  buildExternalReference,
  hasApprovedPayment,
  isPreapprovalActive,
} = require("./mercadopago-client");

function buildAcceptanceDataFromQuote(config, quote) {
  return {
    billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
    billingPhone: toText(quote?.[config.billingPhoneField]),
    companyGiro: toText(quote?.[config.companyGiroField]),
    companyRut: toText(quote?.[config.companyRutField]),
    companyComuna: toText(quote?.[config.companyComunaField]),
    companyAddress: toText(quote?.[config.companyAddressField]),
  };
}

async function persistNdvReferences(config, quoteId, ndvId) {
  const normalizedNdvId = toText(ndvId);
  if (!normalizedNdvId) return;

  if (config.quoteNvdIdTextField) {
    try {
      await updateRecordBestEffort(
        config.quoteModule,
        quoteId,
        { [config.quoteNvdIdTextField]: normalizedNdvId },
        true
      );
    } catch (_error) {
      // best effort
    }
  }

  if (config.quoteNvdLookupField) {
    try {
      await updateRecordBestEffort(
        config.quoteModule,
        quoteId,
        { [config.quoteNvdLookupField]: { id: normalizedNdvId } },
        true
      );
    } catch (_firstError) {
      try {
        await updateRecordBestEffort(
          config.quoteModule,
          quoteId,
          { [config.quoteNvdLookupField]: normalizedNdvId },
          true
        );
      } catch (_secondError) {
        // best effort
      }
    }
  }
}

/**
 * @returns {Promise<{ onboardingUrl: string, onboardingId: string, ndv: object, reused: boolean }>}
 */
async function finalizeAfterPayment({ config, quoteId, dealId }) {
  const quote = await getRecord(config.quoteModule, quoteId);
  const resolvedDealId = toText(
    dealId || quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
  );
  const acceptanceData = buildAcceptanceDataFromQuote(config, quote);

  const handoffResult = await runOnboardingHandoff({
    config,
    quoteId,
    dealId: resolvedDealId,
    acceptanceData,
  });

  const onboardingUrl = toText(handoffResult?.onboardingUrl);
  if (!onboardingUrl) {
    throw new Error("No se obtuvo onboardingUrl al finalizar el pago.");
  }

  // NDV best-effort: no debe bloquear la entrega del onboarding tras un pago OK.
  let ndv = { status: "skipped", reason: "disabled" };
  if (config.ndvHandoffEnabled) {
    try {
      const ndvResult = await runNdvHandoff({
        config,
        quoteId,
        dealId: resolvedDealId,
        acceptanceData,
      });
      const ndvId = toText(ndvResult?.ndvId);
      if (ndvId) {
        await persistNdvReferences(config, quoteId, ndvId);
      }
      ndv = { status: "ok", ndvId, reconciled: ndvResult?.reconciled === true };
    } catch (error) {
      ndv = { status: "error", error: toText(error?.message || error) };
    }
  }

  return {
    onboardingUrl,
    onboardingId: toText(handoffResult?.onboardingId),
    reused: handoffResult?.reused === true,
    ndv,
  };
}

/**
 * Carga la cotizacion, calcula los montos requeridos, consulta el estado real
 * en Mercado Pago (pago unico + suscripcion) y, si ambos flujos estan
 * completos y el onboarding aun no existe, lo finaliza.
 *
 * Pensado para el webhook (no recibe token; resuelve todo a partir del quoteId).
 *
 * @returns {Promise<{ paymentsComplete: boolean, onboardingUrl: string,
 *   oneShotApproved: boolean, subscriptionAuthorized: boolean, finalized: boolean }>}
 */
async function maybeFinalizeQuote({ mpConfig, acceptanceConfig, quoteId, dealId }) {
  const quote = await getRecord(acceptanceConfig.quoteModule, quoteId);
  if (!quote) {
    throw new Error(`No se encontro la cotizacion ${quoteId}.`);
  }

  const items = sanitizeItems(quote?.[acceptanceConfig.quoteItemsSubformField]);
  const descuentoPct = clampDescuentoPct(quote?.[acceptanceConfig.quoteDiscountPctField]);
  const amounts = computePaymentAmounts(items, descuentoPct, { includeIva: mpConfig.includeIva });

  const hasOneShot = amounts.oneShotClp > 0;
  // La suscripcion recurrente esta desactivada hasta integrar usuarios activos/mes.
  const hasSubscription = mpConfig.subscriptionEnabled && amounts.recurringClp > 0;

  let oneShotApproved = !hasOneShot;
  if (hasOneShot) {
    const payments = await searchPaymentsByExternalReference(
      mpConfig,
      buildExternalReference(quoteId, "oneshot")
    );
    oneShotApproved = hasApprovedPayment(payments);
  }

  let subscriptionAuthorized = !hasSubscription;
  if (hasSubscription) {
    const preapprovals = await searchPreapprovalByExternalReference(
      mpConfig,
      buildExternalReference(quoteId, "sub")
    );
    subscriptionAuthorized = (preapprovals || []).some(isPreapprovalActive);
  }

  const paymentsComplete = oneShotApproved && subscriptionAuthorized;
  let onboardingUrl = toText(quote?.[acceptanceConfig.quoteOnboardingUrlField]);
  let finalized = false;

  if (paymentsComplete && !onboardingUrl) {
    const result = await finalizeAfterPayment({
      config: acceptanceConfig,
      quoteId,
      dealId: dealId || toText(quote?.[acceptanceConfig.quoteDealLookupField]?.id),
    });
    onboardingUrl = toText(result?.onboardingUrl);
    finalized = true;
  }

  return { paymentsComplete, onboardingUrl, oneShotApproved, subscriptionAuthorized, finalized };
}

module.exports = {
  finalizeAfterPayment,
  maybeFinalizeQuote,
  buildAcceptanceDataFromQuote,
};

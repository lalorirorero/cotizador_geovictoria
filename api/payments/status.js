const { toText } = require("../_shared/zoho-crm");
const { resolvePaymentSession } = require("../_shared/payment-session");
const {
  searchPaymentsByExternalReference,
  searchPreapprovalByExternalReference,
  buildExternalReference,
  hasApprovedPayment,
  isPreapprovalActive,
} = require("../_shared/mercadopago-client");
const { finalizeAfterPayment } = require("../_shared/post-payment-finalize");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const token = toText(req?.query?.token);
    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }

    const session = await resolvePaymentSession(req, token);
    const { mpConfig, acceptanceConfig, quote, quoteId, dealId, amounts, quoteName } = session;

    if (!mpConfig.enabled) {
      sendJson(res, 409, { success: false, error: "Pagos con Mercado Pago no habilitados." });
      return;
    }

    const hasOneShot = amounts.oneShotClp > 0;
    const hasSubscription = amounts.recurringClp > 0;

    let oneShotApproved = !hasOneShot;
    let oneShotStatus = hasOneShot ? "pending" : "not_required";
    let subscriptionAuthorized = !hasSubscription;
    let subscriptionStatus = hasSubscription ? "pending" : "not_required";

    if (hasOneShot) {
      try {
        const payments = await searchPaymentsByExternalReference(
          mpConfig,
          buildExternalReference(quoteId, "oneshot")
        );
        oneShotApproved = hasApprovedPayment(payments);
        oneShotStatus = oneShotApproved
          ? "approved"
          : toText(payments?.[0]?.status) || "pending";
      } catch (_error) {
        oneShotStatus = "unknown";
      }
    }

    if (hasSubscription) {
      try {
        const preapprovals = await searchPreapprovalByExternalReference(
          mpConfig,
          buildExternalReference(quoteId, "sub")
        );
        const preapproval = preapprovals?.[0];
        subscriptionAuthorized = isPreapprovalActive(preapproval);
        subscriptionStatus = toText(preapproval?.status) || "pending";
      } catch (_error) {
        subscriptionStatus = "unknown";
      }
    }

    const paymentsComplete = oneShotApproved && subscriptionAuthorized;

    let onboardingUrl = toText(quote?.[acceptanceConfig.quoteOnboardingUrlField]);
    let finalizeError = "";

    if (paymentsComplete && !onboardingUrl) {
      try {
        const result = await finalizeAfterPayment({ config: acceptanceConfig, quoteId, dealId });
        onboardingUrl = toText(result?.onboardingUrl);
      } catch (error) {
        finalizeError = toText(error?.message || error);
      }
    }

    sendJson(res, 200, {
      success: true,
      quote: { id: quoteId, name: quoteName },
      currencyId: mpConfig.currencyId,
      includeIva: amounts.includeIva,
      amounts: {
        oneShotClp: amounts.oneShotClp,
        recurringClp: amounts.recurringClp,
        breakdown: amounts.breakdown,
      },
      oneShot: { required: hasOneShot, approved: oneShotApproved, status: oneShotStatus },
      subscription: {
        required: hasSubscription,
        authorized: subscriptionAuthorized,
        status: subscriptionStatus,
      },
      paymentsComplete,
      onboarding: { ready: Boolean(onboardingUrl), url: onboardingUrl },
      finalizeError: finalizeError || undefined,
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "La sesion de pago expiro. Solicita un nuevo enlace a tu ejecutivo comercial."
        : "No se pudo obtener el estado del pago.",
      detail: toText(error?.message || error),
    });
  }
}

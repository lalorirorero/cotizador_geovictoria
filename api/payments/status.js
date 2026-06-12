const { toText, getUserById } = require("../_shared/zoho-crm");
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

function normalizeWhatsappPhone(value) {
  const digits = toText(value).replace(/[^\d]/g, "");
  return digits || "";
}

// Datos para el CTA de transferencia en pago.html (best-effort: nunca rompe el
// estado de pago). El ejecutivo y el N° de cotizacion permiten al cliente
// enviar el comprobante por WhatsApp, igual que en la pagina de aceptacion.
async function buildTransferInfo(quote) {
  try {
    const ownerId = toText(quote?.Owner?.id);
    const owner = ownerId ? await getUserById(ownerId).catch(() => null) : null;
    return {
      executiveName: toText(owner?.full_name || owner?.name || quote?.Owner?.name),
      whatsappPhone: normalizeWhatsappPhone(owner?.phone || owner?.mobile),
      quoteNumber: toText(quote?.Numero_Cotizacion),
    };
  } catch (_error) {
    return { executiveName: "", whatsappPhone: "", quoteNumber: "" };
  }
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
    // La suscripcion recurrente esta desactivada hasta integrar usuarios activos/mes.
    const hasSubscription = mpConfig.subscriptionEnabled && amounts.recurringClp > 0;

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
        // Puede haber mas de un preapproval para la misma cotizacion (reintentos):
        // basta con que ALGUNO este autorizado.
        const activePreapproval = (preapprovals || []).find(isPreapprovalActive);
        subscriptionAuthorized = Boolean(activePreapproval);
        subscriptionStatus =
          toText(activePreapproval?.status || preapprovals?.[0]?.status) || "pending";
      } catch (_error) {
        subscriptionStatus = "unknown";
      }
    }

    const paymentsComplete = oneShotApproved && subscriptionAuthorized;

    // Solo se necesita el bloque de transferencia cuando el cliente aun debe
    // pagar (es el estado en que pago.html muestra el selector de metodo). En
    // los demas estados se omite el fetch del ejecutivo para no recargar el poll.
    const transfer =
      hasOneShot && !oneShotApproved
        ? await buildTransferInfo(quote)
        : { executiveName: "", whatsappPhone: "", quoteNumber: "" };

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
        oneShotItemsClp: amounts.oneShotItemsClp,
        firstMonthClp: amounts.firstMonthClp,
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
      transfer,
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

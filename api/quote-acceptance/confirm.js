const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { getRecord, updateRecordBestEffort, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const { runOnboardingHandoff } = require("../_shared/onboarding-handoff");
const { verifyVerificationToken, normalizeEmail } = require("../_shared/verification-token");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  let bodyValue;
  try {
    bodyValue = req?.body;
  } catch (_error) {
    bodyValue = undefined;
  }

  if (bodyValue && typeof bodyValue === "object") return bodyValue;
  if (typeof bodyValue === "string") {
    try {
      return JSON.parse(bodyValue || "{}");
    } catch (_error) {
      return {};
    }
  }

  if (!req || typeof req.on !== "function") return {};

  const chunks = [];
  await new Promise((resolve) => {
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", resolve);
    req.on("error", resolve);
  });

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

function validateRequiredInput(fields) {
  const required = [
    ["billingEmail", "correo de facturacion"],
    ["billingPhone", "telefono de facturacion"],
    ["companyGiro", "giro"],
    ["companyRut", "RUT de empresa"],
    ["companyComuna", "comuna"],
    ["companyAddress", "direccion"],
  ];
  const missing = required
    .filter(([key]) => !toText(fields?.[key]))
    .map(([, label]) => label);
  return missing;
}

function toZohoDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+00:00`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toText(value).toLowerCase());
}

async function triggerHandoff(config, payload) {
  if (!config.handoffWebhookUrl) {
    const result = await runOnboardingHandoff({
      config,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptanceData: payload.acceptanceData || {},
    });
    return {
      status: "OK",
      message: "handoff interno completado",
      onboardingUrl: toText(result?.onboardingUrl),
      onboardingId: toText(result?.onboardingId),
      response: result,
    };
  }

  const fallbackToInternal = async (reason) => {
    const result = await runOnboardingHandoff({
      config,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptanceData: payload.acceptanceData || {},
    });
    return {
      status: "OK",
      message: `handoff interno completado (${reason})`,
      onboardingUrl: toText(result?.onboardingUrl),
      onboardingId: toText(result?.onboardingId),
      response: result,
    };
  };

  try {
    const response = await fetch(config.handoffWebhookUrl, {
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

    if (!response.ok) {
      throw new Error(
        `handoff webhook HTTP ${response.status}: ${toText(parsed?.message || parsed?.error || parsed?.raw)}`
      );
    }

    const onboardingUrl = toText(parsed?.onboardingUrl || parsed?.link || parsed?.url);
    const onboardingId = toText(parsed?.onboardingId || parsed?.id || parsed?.onboarding_id);
    if (onboardingUrl) {
      return {
        status: "OK",
        message: "handoff enviado",
        onboardingUrl,
        onboardingId,
        response: parsed,
      };
    }

    return await fallbackToInternal("webhook_sin_onboarding_url");
  } catch (_webhookError) {
    return await fallbackToInternal("webhook_error");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const body = await parseBody(req);
    const token = toText(body?.token);
    const verificationToken = toText(body?.verificationToken);
    const termsAccepted = body?.termsAccepted === true;
    const acceptanceData = body?.acceptanceData || {};

    if (!token) {
      sendJson(res, 400, { success: false, error: "Falta token." });
      return;
    }
    if (!termsAccepted) {
      sendJson(res, 400, { success: false, error: "Debes aceptar terminos y condiciones." });
      return;
    }

    const config = getAcceptanceConfig(req);
    const payload = verifyAcceptanceToken(token);
    const quote = await getRecord(config.quoteModule, payload.quoteId);
    const currentOnboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
    const currentOnboardingLookup = toText(quote?.[config.quoteOnboardingLookupField]?.id);
    const authoritativeContactEmail = normalizeEmail(quote?.[config.contactEmailField]);
    const billingEmailFromForm = normalizeEmail(acceptanceData?.billingEmail);

    const currentStatus = toText(quote?.[config.quoteStatusField]);
    const alreadyAccepted = /Aceptada/i.test(currentStatus);
    const existingAcceptedAt = toText(quote?.[config.quoteAcceptanceAtField]);
    const acceptedAtIso = existingAcceptedAt || toZohoDateTime();

    if (alreadyAccepted && currentOnboardingUrl) {
      sendJson(res, 200, {
        success: true,
        alreadyAccepted: true,
        quoteId: payload.quoteId,
        onboardingUrl: currentOnboardingUrl,
        onboardingId: currentOnboardingLookup,
        acceptedAt: acceptedAtIso,
        message: "La cotizacion ya estaba aceptada.",
      });
      return;
    }
    if (alreadyAccepted) {
      try {
        const handoffResult = await triggerHandoff(config, {
          eventType: "quote.accepted.recover",
          quoteId: payload.quoteId,
          dealId: payload.dealId,
          acceptedAt: acceptedAtIso,
          termsVersion: toText(quote?.[config.quoteTermsVersionField]) || config.termsVersion,
          acceptanceData: {
            billingEmail: normalizeEmail(quote?.[config.billingEmailField]),
            billingPhone: toText(quote?.[config.billingPhoneField]),
            companyGiro: toText(quote?.[config.companyGiroField]),
            companyRut: toText(quote?.[config.companyRutField]),
            companyComuna: toText(quote?.[config.companyComunaField]),
            companyAddress: toText(quote?.[config.companyAddressField]),
          },
        });
        const recoveredOnboardingUrl = toText(handoffResult?.onboardingUrl);
        if (!recoveredOnboardingUrl) {
          throw new Error("No se pudo recuperar el enlace de onboarding para cotizacion aceptada.");
        }
        sendJson(res, 200, {
          success: true,
          alreadyAccepted: true,
          quoteId: payload.quoteId,
          onboardingUrl: recoveredOnboardingUrl,
          onboardingId: toText(handoffResult?.onboardingId || currentOnboardingLookup),
          acceptedAt: acceptedAtIso,
          message: "La cotizacion ya estaba aceptada.",
        });
        return;
      } catch (recoveryError) {
        sendJson(res, 409, {
          success: false,
          alreadyAccepted: true,
          quoteId: payload.quoteId,
          acceptedAt: acceptedAtIso,
          error:
            "Esta cotizacion ya fue aceptada y no se pudo recuperar el enlace de onboarding. Contacta a tu ejecutivo comercial.",
          detail: toText(recoveryError?.message || recoveryError),
        });
        return;
      }
    }

    const missing = validateRequiredInput(acceptanceData);
    if (missing.length > 0) {
      sendJson(res, 400, {
        success: false,
        error: `Faltan datos requeridos: ${missing.join(", ")}.`,
      });
      return;
    }

    if (!isValidEmail(authoritativeContactEmail)) {
      sendJson(res, 400, {
        success: false,
        error:
          "No hay correo de contacto valido en la cotizacion. Solicita a tu ejecutivo comercial actualizar la cotizacion antes de continuar.",
      });
      return;
    }

    if (!isValidEmail(billingEmailFromForm)) {
      sendJson(res, 400, {
        success: false,
        error: "Debes ingresar un correo de facturacion valido para continuar.",
      });
      return;
    }

    if (!alreadyAccepted) {
      if (!verificationToken) {
        sendJson(res, 400, {
          success: false,
          error: "Debes verificar el correo de contacto antes de aceptar la cotizacion.",
        });
        return;
      }
      let verificationPayload = null;
      try {
        verificationPayload = verifyVerificationToken(verificationToken, "quote_email_verified");
      } catch (_error) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no es valida o expiro. Solicita un nuevo codigo.",
        });
        return;
      }

      if (toText(verificationPayload?.quoteId) !== toText(payload?.quoteId)) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no corresponde a esta cotizacion.",
        });
        return;
      }
      if (toText(verificationPayload?.dealId) !== toText(payload?.dealId)) {
        sendJson(res, 400, {
          success: false,
          error: "La verificacion de correo no corresponde al Deal de esta cotizacion.",
        });
        return;
      }
      if (normalizeEmail(verificationPayload?.email) !== authoritativeContactEmail) {
        sendJson(res, 400, {
          success: false,
          error: "El correo verificado no coincide con el correo de contacto de la cotizacion.",
        });
        return;
      }
    }

    if (!alreadyAccepted) {
      const updateMap = {
        [config.quoteStatusField]: "Aceptada",
        [config.quoteAcceptanceAtField]: acceptedAtIso,
        [config.quoteTermsAcceptedField]: true,
        [config.quoteTermsVersionField]: config.termsVersion,
        [config.billingEmailField]: billingEmailFromForm,
        [config.billingPhoneField]: toText(acceptanceData.billingPhone),
        [config.companyGiroField]: toText(acceptanceData.companyGiro),
        [config.companyRutField]: toText(acceptanceData.companyRut),
        [config.companyComunaField]: toText(acceptanceData.companyComuna),
        [config.companyAddressField]: toText(acceptanceData.companyAddress),
        [config.quoteHandoffStatusField]: config.quoteOnboardingStatusPending || "En Curso",
        [config.quoteHandoffErrorField]: "",
      };
      if (config.quoteEmailVerifiedField) {
        updateMap[config.quoteEmailVerifiedField] = true;
      }
      if (config.quoteEmailVerifiedAtField) {
        updateMap[config.quoteEmailVerifiedAtField] = acceptedAtIso;
      }
      await updateRecordBestEffort(config.quoteModule, payload.quoteId, updateMap, true);
    }

    let handoffResult = null;
    try {
      handoffResult = await triggerHandoff(config, {
        eventType: "quote.accepted",
        quoteId: payload.quoteId,
        dealId: payload.dealId,
        acceptedAt: acceptedAtIso,
        termsVersion: config.termsVersion,
        acceptanceData: {
          billingEmail: billingEmailFromForm,
          billingPhone: toText(acceptanceData.billingPhone),
          companyGiro: toText(acceptanceData.companyGiro),
          companyRut: toText(acceptanceData.companyRut),
          companyComuna: toText(acceptanceData.companyComuna),
          companyAddress: toText(acceptanceData.companyAddress),
        },
      });

      const onboardingUrl = toText(handoffResult?.onboardingUrl);
      if (!onboardingUrl) {
        throw new Error("No se obtuvo onboardingUrl durante handoff.");
      }
    } catch (handoffError) {
      const handoffMessage = toText(handoffError?.message || handoffError).slice(0, 255);
      await updateRecordBestEffort(
        config.quoteModule,
        payload.quoteId,
        {
          [config.quoteHandoffStatusField]: config.quoteOnboardingStatusError || "Error",
          [config.quoteHandoffErrorField]: handoffMessage,
        },
        true
      );

      sendJson(res, 502, {
        success: false,
        error:
          "La cotizacion fue aceptada, pero fallo el enlace hacia onboarding. Contacta a tu ejecutivo comercial.",
        detail: handoffMessage,
      });
      return;
    }

    sendJson(res, 200, {
      success: true,
      quoteId: payload.quoteId,
      dealId: payload.dealId,
      acceptedAt: acceptedAtIso,
      onboardingUrl: toText(handoffResult?.onboardingUrl),
      onboardingId: toText(handoffResult?.onboardingId),
      message: "Cotizacion aceptada correctamente.",
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : "No se pudo confirmar la aceptacion.",
      detail: String(error?.message || error),
    });
  }
}

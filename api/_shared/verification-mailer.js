const { zohoApiFetch } = require("./zoho-auth");
const { getRecordWithFields, getUserById, readJsonSafe, toText } = require("./zoho-crm");

function validateEmail(email) {
  const value = toText(email).toLowerCase();
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function buildVerificationEmailHtml({ code, quoteId, ttlMinutes, supportLabel, supportEmail }) {
  const supportLine = supportEmail
    ? `${supportLabel}: ${supportEmail}`
    : `${supportLabel}: no disponible`;
  return (
    `<div style="font-family:Arial,sans-serif;line-height:1.45;color:#0f172a">` +
    `<h2 style="margin:0 0 12px 0;color:#0f172a">Validacion de correo - Cotizacion GeoVictoria</h2>` +
    `<p style="margin:0 0 8px 0">Tu codigo de verificacion es:</p>` +
    `<p style="margin:0 0 14px 0;font-size:28px;font-weight:700;letter-spacing:2px;color:#0284c7">${code}</p>` +
    `<p style="margin:0 0 8px 0">Este codigo vence en ${ttlMinutes} minutos.</p>` +
    `<p style="margin:0 0 8px 0">Cotizacion: <strong>${toText(quoteId) || "-"}</strong></p>` +
    `<p style="margin:0;color:#334155">Si no solicitaste este codigo, ignora este correo.</p>` +
    `<p style="margin:14px 0 0 0;color:#334155">${supportLine}</p>` +
    `</div>`
  );
}

function buildVerificationEmailText({ code, quoteId, ttlMinutes, supportLabel, supportEmail }) {
  return [
    "Validacion de correo - Cotizacion GeoVictoria",
    "",
    `Codigo de verificacion: ${code}`,
    `Vence en ${ttlMinutes} minutos.`,
    `Cotizacion: ${toText(quoteId) || "-"}`,
    "",
    "Si no solicitaste este codigo, ignora este correo.",
    `${supportLabel}: ${supportEmail || "no disponible"}`,
  ].join("\n");
}

async function sendViaResend({ toEmail, subject, html, text }) {
  const apiKey = toText(process.env.RESEND_API_KEY);
  if (!apiKey) return null;

  const fromEmail = toText(process.env.RESEND_FROM_EMAIL);
  if (!fromEmail) {
    throw new Error("Falta RESEND_FROM_EMAIL para enviar verificacion por correo.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject,
      html,
      text,
    }),
  });

  const payload = await readJsonSafe(response);
  if (!response.ok) {
    const message =
      toText(payload?.message) || toText(payload?.error) || toText(payload?.raw) || `HTTP ${response.status}`;
    throw new Error(`Resend fallo: ${message}`);
  }
  return {
    provider: "resend",
    id: toText(payload?.id),
  };
}

async function getCurrentZohoUser() {
  const response = await zohoApiFetch("/crm/v3/users?type=CurrentUser", {
    method: "GET",
  });
  const payload = await readJsonSafe(response);
  const user = Array.isArray(payload?.users) ? payload.users[0] : null;
  if (!response.ok || !user) {
    const message =
      toText(payload?.message) || toText(payload?.code) || toText(payload?.raw) || `HTTP ${response.status}`;
    throw new Error(`No se pudo leer CurrentUser en Zoho: ${message}`);
  }
  return user;
}

async function resolveZohoSender({ quoteModule, quoteId, quoteDealLookupField }) {
  const senderEmailEnv = toText(process.env.ZOHO_VERIFICATION_FROM_EMAIL);
  let dealId = "";
  try {
    const quote = await getRecordWithFields(quoteModule, quoteId, [quoteDealLookupField]);
    dealId = toText(quote?.[quoteDealLookupField]?.id || quote?.[quoteDealLookupField]);
  } catch (_error) {
    dealId = "";
  }

  if (senderEmailEnv) {
    return {
      email: senderEmailEnv,
      name: toText(process.env.ZOHO_VERIFICATION_FROM_NAME) || senderEmailEnv,
      dealId,
    };
  }

  // First preference: OAuth current user, which Zoho allows reliably as sender.
  const currentUser = await getCurrentZohoUser().catch(() => null);
  const currentEmail = toText(currentUser?.email);
  if (currentEmail) {
    return {
      email: currentEmail,
      name: toText(currentUser?.full_name || currentUser?.name) || currentEmail,
      dealId,
    };
  }

  // Fallback only if current user cannot be resolved.
  let deal = null;
  try {
    deal = dealId ? await getRecordWithFields("Deals", dealId, ["Owner"]) : null;
  } catch (_error) {
    deal = null;
  }
  const ownerId = toText(deal?.Owner?.id);
  const owner = ownerId ? await getUserById(ownerId).catch(() => null) : null;
  const ownerEmail = toText(owner?.email);
  if (ownerEmail) {
    return {
      email: ownerEmail,
      name: toText(owner?.full_name || owner?.name) || ownerEmail,
      dealId,
    };
  }

  throw new Error("No se encontro email remitente permitido en Zoho.");
}

async function sendViaZohoCrm({ quoteModule, quoteId, quoteDealLookupField, toEmail, toName, subject, html }) {
  const sender = await resolveZohoSender({ quoteModule, quoteId, quoteDealLookupField });
  const baseModule = sender?.dealId ? "Deals" : quoteModule;
  const baseRecordId = sender?.dealId || quoteId;
  const path = `/crm/v3/${encodeURIComponent(baseModule)}/${encodeURIComponent(
    baseRecordId
  )}/actions/send_mail`;
  const payload = {
    data: [
      {
        from: {
          email: sender.email,
        },
        to: [
          {
            email: toEmail,
          },
        ],
        org_email: true,
        subject,
        content: html,
        mail_format: "html",
      },
    ],
  };

  const response = await zohoApiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafe(response);
  const row = Array.isArray(result?.data) ? result.data[0] : null;
  const ok = response.ok && row && /SUCCESS/i.test(toText(row?.code || row?.status));
  if (!ok) {
    const message =
      toText(row?.message) ||
      toText(result?.message) ||
      toText(result?.code) ||
      toText(result?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho send_mail fallo: ${message}`);
  }

  return {
    provider: "zoho_crm",
    id: toText(row?.details?.message_id || row?.details?.id),
  };
}

async function sendVerificationCodeEmail({
  quoteModule,
  quoteId,
  quoteDealLookupField,
  toEmail,
  toName,
  code,
  ttlMinutes,
  supportLabel,
  supportEmail,
}) {
  const normalizedTo = toText(toEmail).toLowerCase();
  if (!validateEmail(normalizedTo)) {
    throw new Error("Correo de destino invalido para verificacion.");
  }

  const subject = "Codigo de verificacion - Cotizacion GeoVictoria";
  const html = buildVerificationEmailHtml({
    code,
    quoteId,
    ttlMinutes,
    supportLabel,
    supportEmail,
  });
  const text = buildVerificationEmailText({
    code,
    quoteId,
    ttlMinutes,
    supportLabel,
    supportEmail,
  });

  const resendResult = await sendViaResend({
    toEmail: normalizedTo,
    subject,
    html,
    text,
  });
  if (resendResult) return resendResult;

  return sendViaZohoCrm({
    quoteModule,
    quoteId,
    quoteDealLookupField,
    toEmail: normalizedTo,
    toName: toText(toName) || normalizedTo,
    subject,
    html,
  });
}

module.exports = {
  sendVerificationCodeEmail,
  validateEmail,
};

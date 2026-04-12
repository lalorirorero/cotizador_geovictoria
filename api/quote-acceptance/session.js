const { verifyAcceptanceToken } = require("../_shared/acceptance-token");
const { getRecord, getRecordWithFields, getUserById, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sanitizeItems(items, fieldMap) {
  if (!Array.isArray(items)) return [];
  return items.map((row) => ({
    nombre: toText(row?.[fieldMap.itemName]),
    cantidad: Number(row?.[fieldMap.qty] || 0),
    precioUnitarioUf: Number(row?.[fieldMap.unitUF] || 0),
    precioUnitarioClp: Number(row?.[fieldMap.unitCLP] || 0),
    subtotalUf: Number(row?.[fieldMap.subtotalUF] || 0),
    subtotalClp: Number(row?.[fieldMap.subtotalCLP] || 0),
    modalidad: toText(row?.[fieldMap.modalidad]),
    afectoIva: row?.[fieldMap.afectoIva] === true,
  }));
}

function sumBy(items, key) {
  return (items || []).reduce((acc, row) => acc + Number(row?.[key] || 0), 0);
}

function isRecurrentModalidad(value) {
  const modalidad = toText(value).toLowerCase();
  if (!modalidad) return true;
  if (modalidad.includes("venta")) return false;
  if (modalidad.includes("no recurrente")) return false;
  return true;
}

function computeTotals(items) {
  const rows = Array.isArray(items) ? items : [];
  const subtotalUf = sumBy(rows, "subtotalUf");
  const subtotalClp = sumBy(rows, "subtotalClp");

  let recurrenteUf = 0;
  let recurrenteClp = 0;
  let noRecurrenteUf = 0;
  let noRecurrenteClp = 0;
  let ivaUf = 0;
  let ivaClp = 0;

  rows.forEach((row) => {
    const subtotalRowUf = Number(row?.subtotalUf || 0);
    const subtotalRowClp = Number(row?.subtotalClp || 0);
    if (isRecurrentModalidad(row?.modalidad)) {
      recurrenteUf += subtotalRowUf;
      recurrenteClp += subtotalRowClp;
    } else {
      noRecurrenteUf += subtotalRowUf;
      noRecurrenteClp += subtotalRowClp;
    }

    const afectoIva = row?.afectoIva !== false;
    if (afectoIva) {
      ivaUf += subtotalRowUf * 0.19;
      ivaClp += subtotalRowClp * 0.19;
    }
  });

  return {
    subtotalUf: Number(subtotalUf.toFixed(3)),
    subtotalClp: Math.round(subtotalClp),
    ivaUf: Number(ivaUf.toFixed(3)),
    ivaClp: Math.round(ivaClp),
    totalUf: Number((subtotalUf + ivaUf).toFixed(3)),
    totalClp: Math.round(subtotalClp + ivaClp),
    recurrenteUf: Number(recurrenteUf.toFixed(3)),
    recurrenteClp: Math.round(recurrenteClp),
    noRecurrenteUf: Number(noRecurrenteUf.toFixed(3)),
    noRecurrenteClp: Math.round(noRecurrenteClp),
  };
}

async function getFallbackData(dealId) {
  const cleanDealId = toText(dealId);
  if (!cleanDealId) {
    return { deal: null, account: null, contact: null, owner: null };
  }

  const deal = await getRecordWithFields("Deals", cleanDealId, [
    "id",
    "Owner",
    "Account_Name",
    "Contact_Name",
    "Contact_Email",
    "Contact_Phone",
    "Rut_ID_Account",
  ]);

  const accountId = toText(deal?.Account_Name?.id);
  const contactId = toText(deal?.Contact_Name?.id);
  const ownerId = toText(deal?.Owner?.id);

  const account = accountId
    ? await getRecordWithFields("Accounts", accountId, [
        "id",
        "RUT_Empresa",
        "Comuna",
      ])
    : null;

  const contact = contactId
    ? await getRecordWithFields("Contacts", contactId, [
        "id",
        "Email",
        "Phone",
        "Mailing_City",
        "Mailing_Street",
      ])
    : null;

  const owner = ownerId
    ? await getUserById(ownerId).catch(() => null)
    : null;

  return { deal, account, contact, owner };
}

function pickFirst(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function normalizeWhatsappPhone(value) {
  const raw = toText(value);
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits;
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

    const config = getAcceptanceConfig(req);
    const payload = verifyAcceptanceToken(token);
    const quote = await getRecord(config.quoteModule, payload.quoteId);
    const status = toText(quote?.[config.quoteStatusField]);
    const isAcceptedLocked = /Aceptada/i.test(status);
    const acceptedAt = toText(quote?.[config.quoteAcceptanceAtField]);
    const onboardingUrl = toText(quote?.[config.quoteOnboardingUrlField]);
    const onboardingToken = toText(quote?.[config.quoteOnboardingTokenField]);
    const onboardingId = toText(quote?.[config.quoteOnboardingLookupField]?.id);
    const pdfUrl = toText(quote?.[config.quotePdfUrlField]);
    const dealId = toText(quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]);
    const fallback = await getFallbackData(dealId);

    if (dealId && dealId !== payload.dealId) {
      sendJson(res, 400, {
        success: false,
        error: "Token invalido para esta cotizacion.",
      });
      return;
    }

    const fieldMap = {
      itemName: "Nombre_Item",
      qty: "Cantidad",
      unitUF: "Precio_Unitario_UF",
      unitCLP: "Precio_Unitario_CLP",
      subtotalUF: "Subtotal_UF",
      subtotalCLP: "Subtotal_CLP",
      modalidad: "Modalidad",
      afectoIva: "Afecto_IVA",
    };
    const items = sanitizeItems(quote?.[config.quoteItemsSubformField], fieldMap);

    sendJson(res, 200, {
      success: true,
      quote: {
        id: payload.quoteId,
        dealId: payload.dealId,
        name: toText(quote?.Name),
        status,
        isAcceptedLocked,
        acceptedAt,
        onboardingUrl,
        onboardingId,
        onboardingReady: Boolean(isAcceptedLocked && onboardingUrl && onboardingToken),
        quoteDate: toText(quote?.[config.quoteDateField]),
        pdfUrl,
        termsVersion: config.termsVersion,
        expiresAt: new Date(payload.exp).toISOString(),
        isExpired: Date.now() >= Number(payload.exp),
        contactEmail: pickFirst(
          quote?.[config.contactEmailField],
          fallback?.contact?.Email,
          fallback?.deal?.Contact_Email
        ),
        contactPhone: pickFirst(
          quote?.[config.contactPhoneField],
          fallback?.contact?.Phone,
          fallback?.deal?.Contact_Phone
        ),
        billingEmail: pickFirst(quote?.[config.billingEmailField]),
        billingPhone: pickFirst(quote?.[config.billingPhoneField]),
        companyRut: pickFirst(
          quote?.[config.companyRutField],
          fallback?.deal?.Rut_ID_Account,
          fallback?.account?.RUT_Empresa
        ),
        companyGiro: pickFirst(quote?.[config.companyGiroField]),
        companyComuna: pickFirst(
          quote?.[config.companyComunaField],
          fallback?.account?.Comuna,
          fallback?.contact?.Mailing_City
        ),
        companyAddress: pickFirst(
          quote?.[config.companyAddressField],
          fallback?.contact?.Mailing_Street
        ),
      },
      support: {
        executiveName: pickFirst(
          fallback?.owner?.full_name,
          fallback?.owner?.name,
          fallback?.deal?.Owner?.name,
          config.supportContactLabel
        ),
        executivePhone: normalizeWhatsappPhone(
          pickFirst(fallback?.owner?.phone, fallback?.owner?.mobile)
        ),
        supportEmail: config.supportContactEmail,
      },
      items,
      totals: computeTotals(items),
    });
  } catch (error) {
    const isExpired = toText(error?.code) === "TOKEN_EXPIRED";
    sendJson(res, isExpired ? 410 : 500, {
      success: false,
      error: isExpired
        ? "Esta cotizacion ya expiro. Contacta a tu ejecutivo comercial para actualizarla."
        : "No se pudo cargar la sesion de aceptacion.",
      detail: String(error?.message || error),
    });
  }
}

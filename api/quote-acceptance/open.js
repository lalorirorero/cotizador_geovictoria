const crypto = require("crypto");
const { signAcceptancePayload } = require("../_shared/acceptance-token");
const { getRecord, searchRecords, updateRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function getExpirationMs(quoteDateRaw, validityDays) {
  const quoteDate = new Date(toText(quoteDateRaw));
  if (!Number.isFinite(quoteDate.getTime())) {
    return Date.now() + validityDays * 24 * 60 * 60 * 1000;
  }
  return quoteDate.getTime() + validityDays * 24 * 60 * 60 * 1000;
}

function parseDateMs(value) {
  const dt = new Date(toText(value));
  return Number.isFinite(dt.getTime()) ? dt.getTime() : 0;
}

function pickLatestQuote(rows, acceptanceField) {
  const withUrl = rows.filter((row) => toText(row?.[acceptanceField]));
  const source = withUrl.length > 0 ? withUrl : rows;
  if (source.length === 0) return null;
  return source
    .slice()
    .sort((a, b) => {
      const aTime = Math.max(parseDateMs(a?.Modified_Time), parseDateMs(a?.Created_Time));
      const bTime = Math.max(parseDateMs(b?.Modified_Time), parseDateMs(b?.Created_Time));
      return bTime - aTime;
    })[0];
}

async function ensureAcceptanceUrl(quoteId, quote, config) {
  const existing = toText(quote?.[config.quoteAcceptanceUrlField]);
  if (existing) return existing;

  const dealId = toText(
    quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
  );
  if (!dealId) {
    throw new Error("La cotizacion no tiene Deal asociado.");
  }

  const expMs = getExpirationMs(quote?.[config.quoteDateField], config.validityDays);
  const payload = {
    quoteId,
    dealId,
    iat: Date.now(),
    exp: expMs,
    nonce: crypto.randomBytes(8).toString("hex"),
    v: 1,
  };
  const token = signAcceptancePayload(payload);
  const acceptanceUrl = `${config.baseUrl}/quote-acceptance.html?token=${encodeURIComponent(token)}`;
  await updateRecord(
    config.quoteModule,
    quoteId,
    {
      [config.quoteAcceptanceUrlField]: acceptanceUrl,
    },
    true
  );
  return acceptanceUrl;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendHtml(
      res,
      405,
      "<h1>Metodo no permitido</h1><p>Este endpoint solo acepta GET.</p>"
    );
    return;
  }

  try {
    const config = getAcceptanceConfig(req);
    const quoteIdQuery = toText(req.query?.quoteId);
    const dealIdQuery = toText(req.query?.dealId);

    let quoteId = quoteIdQuery;
    let quote = null;

    if (quoteId) {
      quote = await getRecord(config.quoteModule, quoteId);
    } else if (dealIdQuery) {
      const criteria = `(${config.quoteDealLookupField}:equals:${dealIdQuery})`;
      const rows = await searchRecords(config.quoteModule, criteria, [
        "id",
        config.quoteAcceptanceUrlField,
        config.quoteDateField,
        config.quoteDealLookupField,
        "Created_Time",
        "Modified_Time",
      ]);
      const picked = pickLatestQuote(rows, config.quoteAcceptanceUrlField);
      if (!picked) {
        sendHtml(
          res,
          404,
          "<h1>Cotizacion no encontrada</h1><p>No se encontro una cotizacion asociada a este Deal.</p>"
        );
        return;
      }
      quoteId = toText(picked.id);
      quote = picked;
    } else {
      sendHtml(
        res,
        400,
        "<h1>Solicitud invalida</h1><p>Debes enviar quoteId o dealId para continuar.</p>"
      );
      return;
    }

    if (!quoteId || !quote) {
      sendHtml(
        res,
        404,
        "<h1>Cotizacion no encontrada</h1><p>No se pudo resolver la cotizacion solicitada.</p>"
      );
      return;
    }

    const acceptanceUrl = await ensureAcceptanceUrl(quoteId, quote, config);
    res.statusCode = 302;
    res.setHeader("Location", acceptanceUrl);
    res.end();
  } catch (error) {
    sendHtml(
      res,
      500,
      `<h1>Error al abrir aceptacion</h1><p>${String(error?.message || error)}</p>`
    );
  }
}

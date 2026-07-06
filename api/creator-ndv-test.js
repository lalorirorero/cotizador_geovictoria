// Endpoint de test: replica lo que hace Vicky POST-PAGO para crear la NDV en
// Zoho Creator, sin pasar por MercadoPago. Corre el mismo handoff + subforms que
// api/_shared/post-payment-finalize.js y devuelve el ID_NDV para revisar en Creator.
//
// Además vuelca Form_Order / FORM_STATUS / JsonPdf del registro creado, para
// confirmar por qué el PDF no se genera.
//
// Uso:
//   POST /api/creator-ndv-test?secret=<QUOTE_ACCEPTANCE_SECRET>
//   body: { "quoteId": "...", "dealId": "..." }   (dealId opcional; se resuelve del quote)
//
// TEMPORAL: borrar tras diagnosticar.
const { getAcceptanceConfig } = require("./_shared/quote-acceptance-config");
const { getRecord, toText } = require("./_shared/zoho-crm");
const { getCreatorConfig, creatorApiFetch } = require("./_shared/zoho-creator-auth");
const { runNdvHandoff } = require("./_shared/ndv-handoff");
const { runNdvSubformSetup } = require("./_shared/ndv-subforms");
const { buildAcceptanceDataFromQuote } = require("./_shared/post-payment-finalize");

function parseBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" ? req.body : {};
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch (_e) { return { raw: text.slice(0, 500) }; }
}

// Trae el registro maestro ALL_DATA por su ID numérico para inspeccionar Form_Order.
async function fetchNdvRecord(creatorConfig, ndvId) {
  const path = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/report/${encodeURIComponent(creatorConfig.reportLinkName)}/${encodeURIComponent(toText(ndvId))}`;
  const resp = await creatorApiFetch(path, { method: "GET" });
  const payload = await readJson(resp);
  const data = payload?.data || {};
  return {
    status: resp.status,
    ID_NDV: data.ID_NDV,
    FORM_STATUS: data.FORM_STATUS,
    STATUS: data.STATUS,
    Form_Order: data.Form_Order,
    Form_Order_len: Array.isArray(data.Form_Order) ? data.Form_Order.length : 0,
    JsonPdf_present: Boolean(data.JsonPdf),
    PDF_STRING_present: Boolean(data.PDF_STRING),
    Servicios_Recurrentes: data.Servicios_Recurrentes,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const expected = String(process.env.QUOTE_ACCEPTANCE_SECRET || "");
  const provided = String(req.query?.secret || req.headers["x-diag-secret"] || "");
  if (!expected || expected !== provided) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Usa POST con { quoteId, dealId }" }));
    return;
  }

  const out = { ok: false, steps: {} };
  try {
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Falta quoteId en el body" }));
      return;
    }

    const config = getAcceptanceConfig(req);
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `No se encontró la cotización ${quoteId}` }));
      return;
    }
    const dealId = toText(
      body.dealId || quote?.[config.quoteDealLookupField]?.id || quote?.[config.quoteDealLookupField]
    );
    const acceptanceData = buildAcceptanceDataFromQuote(config, quote);
    out.steps.resolved = { quoteId, dealId };

    // 1) Handoff NDV (crea el registro maestro en Creator)
    const ndvResult = await runNdvHandoff({ config, quoteId, dealId, acceptanceData });
    const ndvId = toText(ndvResult?.ndvId);
    out.steps.handoff = {
      ndvId,
      reconciled: ndvResult?.reconciled === true,
      servicios: ndvResult?.ndvRecord?.Servicios_Recurrentes,
    };

    // 2) Subforms (Servicio_Recurrente x N + Finalizar_Formulario → dispara GeneratePDF)
    if (ndvId) {
      const subformSetup = await runNdvSubformSetup({ ndvId, ndvRecord: ndvResult?.ndvRecord || {} });
      out.steps.subforms = subformSetup;

      // 3) Estado del registro tras crear subforms — confirma Form_Order / PDF
      const creatorConfig = getCreatorConfig();
      out.steps.ndvRecordAfter = await fetchNdvRecord(creatorConfig, ndvId);
    }

    out.ok = true;
    out.reviewHint = out.steps.handoff.ndvId
      ? `Revisa en Creator → Reporte NDV el ID_NDV=${out.steps.ndvRecordAfter?.ID_NDV || "(ver arriba)"}`
      : "No se obtuvo ndvId";
    res.statusCode = 200;
    res.end(JSON.stringify(out, null, 2));
  } catch (e) {
    out.error = String((e && e.stack) || (e && e.message) || e);
    out.errorDetail = e?.detail || e?.code || undefined;
    res.statusCode = 500;
    res.end(JSON.stringify(out, null, 2));
  }
};

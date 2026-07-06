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

    // ── Modo "fresh": crea un NDV maestro directo (sin CRM quote) y corre el
    //    código REAL de runNdvSubformSetup para validar el fix de Form_Order. ──
    if (body.fresh === true) {
      const creatorConfig = getCreatorConfig();
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, "0");
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yyyy = String(now.getFullYear());
      const creatorDate = `${dd}-${mm}-${yyyy}`;

      // ndvRecord mínimo que consumen buildServicioRecurrenteRecord/Finalizar y
      // que reproduce lo que produciría runNdvHandoff para Huellero (caso simple).
      const ndvRecord = {
        Formulario: "Nota de Venta",
        FORM_STATUS: "CREATED",
        STATUS: "PENDIENTE",
        Nombre_del_documento: `TEST Form_Order fix / ${yyyy}-${mm}-${dd}`,
        CRM_Account: "3525045000633660939",
        CRM_ACCOUNT_NAME: "Huellero company",
        Correo_Vendedor: "adiazg@geovictoria.com",
        Pa_s_Facturaci_n: "Chile",
        Identificador_Tributario_Empresa: "20.788.061-2",
        Moneda: "UF",
        Linea_de_Negocio: "Telemarketing",
        Servicio_Recurrente: "Control de Asistencia",
        Servicios_Recurrentes: ["Control de Asistencia"],
        Hito_de_Facturaci_n: "Cargando...",
        N_Empleados_Compometidos: 10,
        Cantidad_de_Usuarios: 10,
        Cantidad_de_Usuarios_PDF: 10,
        Plantilla_Tabla_de_Cobro: "Sin Plantilla",
        Tabla_de_Cobro: [
          { Modalidad: "Rango Fijo", Desde: 1, Hasta: 10, Valor: 1.39, Valor_Usuario_Adicional: 0.139 },
        ],
        Fecha_de_creaci_n: creatorDate,
        fecha_uf_usd: creatorDate,
      };

      // Crear el maestro (form Nota_de_Venta → report ALL_DATA)
      const createPath = `/creator/v2.1/data/${encodeURIComponent(creatorConfig.ownerName)}/${encodeURIComponent(creatorConfig.appLinkName)}/form/${encodeURIComponent("Nota_de_Venta")}`;
      const createResp = await creatorApiFetch(createPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ndvRecord }),
      });
      const createPayload = await readJson(createResp);
      const ndvId = toText(createPayload?.data?.ID || createPayload?.data?.id);
      out.steps.createMaster = { status: createResp.status, ndvId, payload: ndvId ? undefined : createPayload };

      if (!ndvId) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ...out, error: "No se obtuvo ndvId del maestro" }, null, 2));
        return;
      }

      // Correr el código REAL que estamos probando
      const subformSetup = await runNdvSubformSetup({ ndvId, ndvRecord });
      out.steps.subforms = subformSetup;

      // Estado del registro tras el fix
      out.steps.ndvRecordAfter = await fetchNdvRecord(creatorConfig, ndvId);
      out.ok = true;
      out.reviewHint = `Revisa en Creator → Reporte NDV el ID_NDV=${out.steps.ndvRecordAfter?.ID_NDV || "(ver arriba)"}`;
      res.statusCode = 200;
      res.end(JSON.stringify(out, null, 2));
      return;
    }

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

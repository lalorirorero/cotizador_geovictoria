/**
 * Endpoint: POST /api/quote-acceptance/consultar-siguiente-descuento
 *
 * READ-ONLY (negociación). Devuelve el siguiente descuento que Vicky puede
 * ofrecer en la conversación, junto con el PRECIO RECALCULADO (pago inicial y
 * mensual), SIN regenerar el PDF ni comitear el descuento. Vicky usa el
 * `mensaje_para_prospecto` para negociar verbalmente.
 *
 * Lo único que persiste es el puntero de negociación (Escalon_Negociacion):
 * cada llamada avanza un escalón aplicable, de modo que si el cliente insiste
 * en más rebaja, la siguiente consulta ofrece el escalón siguiente. El
 * descuento comiteado (Escalon_Descuento), el PDF y la versión NO se tocan:
 * eso solo ocurre en aplicar-siguiente-descuento cuando el cliente acepta.
 *
 * Body:
 *   { "quoteId": "<id de la cotización en Zoho>" }
 *
 * Respuesta exitosa:
 *   {
 *     ok: true,
 *     escalon: { tipo, pct, condicion_discursiva },
 *     preview: { pago_inicial_clp, mensual_clp },
 *     tope_alcanzado: false,       // true si este es el último escalón posible
 *     mensaje_para_prospecto: "Texto que Vicky usa para negociar (sin PDF)"
 *   }
 *
 * Cuando ya no hay más escalones que ofrecer:
 *   { ok: false, error: "TOPE_ALCANZADO", tope_alcanzado: true }
 */

const { getRecord, updateRecord, toText } = require("../_shared/zoho-crm");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");
const {
  DISCOUNT_LADDER,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
  previewAmounts,
} = require("../_shared/discount-engine");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return typeof req.body === "object" && req.body ? req.body : {};
}

// Formato CLP simple e independiente de ICU (Vercel/Node): $1.234.567
function fmtCLP(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + v.toLocaleString("en-US").replace(/,/g, ".");
}

function buildMensajeNegociacion(escalon, amounts) {
  const pagoInicial = fmtCLP(amounts.oneShotClp);
  const mensual = fmtCLP(amounts.recurringClp);

  let oferta;
  if (escalon.tipo === "instalacion_rm") {
    oferta = `Puedo ofrecerte un ${escalon.pct}% de descuento en la instalación de los equipos (Región Metropolitana).`;
  } else if (escalon.tipo === "instalacion_region") {
    oferta = `Puedo ofrecerte un ${escalon.pct}% de descuento en la instalación de los equipos.`;
  } else {
    oferta = `Puedo ofrecerte un ${escalon.pct}% de descuento sobre el plan mensual.`;
  }

  const partes = [
    oferta,
    `Con eso tu pago inicial queda en ${pagoInicial} y el plan mensual en ${mensual}/mes (IVA incluido).`,
  ];
  if (escalon.condicionDiscursiva) partes.push(escalon.condicionDiscursiva);
  partes.push(
    "¿Lo dejamos así y te actualizo la cotización, o querés que veamos algo más?",
  );
  return partes.join(" ");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vicky-secret");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Metodo no permitido." });
  }

  const expectedSecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  const providedSecret = toText(req.headers["x-vicky-secret"]);
  if (expectedSecret && expectedSecret !== providedSecret) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    const body = parseBody(req);
    const quoteId = toText(body.quoteId);
    if (!quoteId) {
      return sendJson(res, 400, { ok: false, error: "Falta quoteId." });
    }

    stage = "fetch_quote";
    const quote = await getRecord(config.quoteModule, quoteId);
    if (!quote) {
      return sendJson(res, 404, { ok: false, error: "Cotizacion no encontrada." });
    }

    // El puntero de negociación nunca retrocede por debajo de lo comiteado.
    stage = "elegir_escalon";
    const commitIdx = Math.max(0, Number(quote?.[config.quoteEscalonField] || 0));
    const negocIdx = Math.max(0, Number(quote?.[config.quoteEscalonNegociacionField] || 0));
    const start = Math.max(commitIdx, negocIdx);

    const i = siguienteEscalonAplicable(quote, config, start);
    if (i < 0) {
      return sendJson(res, 200, {
        ok: false,
        error: "TOPE_ALCANZADO",
        tope_alcanzado: true,
      });
    }
    const escalon = DISCOUNT_LADDER[i];

    // Avanzar SOLO el puntero de negociación. No tocamos descuento comiteado,
    // PDF ni versión.
    stage = "avanzar_puntero";
    await updateRecord(
      config.quoteModule,
      quoteId,
      { [config.quoteEscalonNegociacionField]: i + 1 },
      false,
    );

    // Preview de precio con el descuento ACUMULADO hasta este escalón.
    stage = "preview";
    const { descuentos } = descuentosHasta(quote, config, i);
    const amounts = previewAmounts(quote, config, descuentos);

    return sendJson(res, 200, {
      ok: true,
      escalon: {
        tipo: escalon.tipo,
        pct: escalon.pct,
        condicion_discursiva: escalon.condicionDiscursiva,
      },
      preview: {
        pago_inicial_clp: amounts.oneShotClp,
        mensual_clp: amounts.recurringClp,
        descuentos,
      },
      tope_alcanzado: !hayEscalonDespues(quote, config, i),
      mensaje_para_prospecto: buildMensajeNegociacion(escalon, amounts),
    });
  } catch (error) {
    console.error(`[consultar-siguiente-descuento] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, {
      ok: false,
      error: "No se pudo consultar el siguiente descuento.",
      detail: String(error?.message || error).slice(0, 400),
    });
  }
};

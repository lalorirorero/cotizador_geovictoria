/**
 * Motor de descuentos escalonados (Vicky V3).
 *
 * Lógica compartida entre:
 *   - consultar-siguiente-descuento.js (read-only, negociación): avanza el
 *     puntero de negociación y devuelve el preview de precio SIN regenerar PDF.
 *   - aplicar-siguiente-descuento.js (commit): comitea el nivel negociado
 *     (acumulado) y regenera el PDF una sola vez.
 *
 * Modelo de estado en Zoho:
 *   - Escalon_Descuento   → nivel COMITEADO (lo que refleja el PDF vigente).
 *   - Escalon_Negociacion → puntero "hasta dónde ofrecí en la conversación".
 *     Siempre >= Escalon_Descuento. La negociación avanza este puntero; el
 *     commit sincroniza ambos.
 *
 * Ambos índices se guardan en forma "siguiente índice a considerar" (i+1),
 * igual que el `Escalon_Descuento` original: 0 = nada ofrecido/comiteado.
 *
 * CAMBIO DE TARIFAS jul-2026: la escalera quedó SOLO con los escalones del
 * plan mensual (10 → 20%). Los descuentos de instalación desaparecieron
 * (los reemplazó la tarifa plana por zona), pero los YA COMITEADOS en
 * cotizaciones antiguas se preservan: descuentosHasta los lee de los campos
 * Descuento_Instalacion_*_Pct del quote en vez de recalcularlos desde la
 * escalera. Los índices guardados con la escalera vieja (largo 4) se
 * re-derivan del % recurrente comiteado (normalizarIndiceGuardado).
 */

const { DISCOUNT_LADDER, MESES_DESCUENTO_PLAN, PRICING_TIERS } = require("./proposal-constants");
const { sanitizeItems, computePaymentAmounts } = require("./quote-pricing");

// Tarifa del micro-plan (tramo fijo 1-1: 1 trabajador que marca). En ese tramo
// NO se aplica descuento sobre el plan mensual recurrente (acuerdo comercial).
const MICRO_PLAN_UF = (() => {
  const t = (PRICING_TIERS || []).find((x) => x.min === 1 && x.max === 1 && x.type === "fijo");
  return t ? Number(t.uf) : null;
})();

// Detecta el micro-plan leyendo el ítem de asistencia del subform: si su precio
// unitario coincide con la tarifa del tramo 1-1, es micro-plan.
function esMicroPlan(quote, config) {
  if (MICRO_PLAN_UF == null) return false;
  const items = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(items)) return false;
  return items.some((row) => {
    const codigo = String(row?.Codigo_Item || "").toLowerCase();
    if (codigo !== "asistencia") return false;
    const pu = Number(row?.Precio_Unitario_UF || 0);
    return Math.abs(pu - MICRO_PLAN_UF) < 1e-6;
  });
}

// ¿El escalón en `idx` aplica a esta cotización?
function escalonAplica(quote, config, idx) {
  const escalon = DISCOUNT_LADDER[idx];
  if (!escalon) return false;
  // Escalón del plan mensual (recurrente): NO aplica en el micro-plan
  // (1 trabajador que marca). En ese tramo no hay descuento del servicio
  // recurrente.
  return !esMicroPlan(quote, config);
}

// Los índices guardados en Zoho (Escalon_Descuento / Escalon_Negociacion)
// apuntan a la escalera VIGENTE al momento de guardarse. La escalera vieja
// (pre jul-2026) tenía 2 escalones de instalación adelante (largo 4); la nueva
// solo tiene los del plan (largo 2). Un índice guardado MAYOR que el largo
// actual viene de la escalera vieja: se re-deriva desde el % recurrente ya
// comiteado — la única dimensión que sigue en la escalera. (Los valores 1-2 de
// la escalera vieja se leen como nueva escala; a lo más adelantan un tramo del
// plan en favor del cliente, nunca sobre el tope.)
function normalizarIndiceGuardado(stored, recurrentePctComiteado) {
  const idx = Math.max(0, Number(stored) || 0);
  if (idx <= DISCOUNT_LADDER.length) return idx;
  const rec = Number(recurrentePctComiteado) || 0;
  let derivado = 0;
  for (let i = 0; i < DISCOUNT_LADDER.length; i++) {
    if (DISCOUNT_LADDER[i].pct <= rec) derivado = i + 1;
  }
  return derivado;
}

// Primer escalón aplicable cuyo índice sea >= fromIdx. Devuelve el índice o -1.
function siguienteEscalonAplicable(quote, config, fromIdx) {
  for (let i = Math.max(0, Number(fromIdx) || 0); i < DISCOUNT_LADDER.length; i++) {
    if (escalonAplica(quote, config, i)) return i;
  }
  return -1;
}

// ¿Queda algún escalón aplicable después del índice `idx`?
function hayEscalonDespues(quote, config, idx) {
  return siguienteEscalonAplicable(quote, config, idx + 1) >= 0;
}

// Descuentos acumulados al aplicar los escalones aplicables de 0..targetIdx
// (inclusive). Devuelve los 3 porcentajes + el último escalón efectivamente
// aplicado (para componer el mensaje / condición discursiva).
//
// Los % de instalación NO salen de la escalera (ya no existen esos escalones):
// se COPIAN de lo ya comiteado en el quote, para que una cotización antigua
// con 50/25% de instalación no pierda ese descuento (ni en el preview ni al
// regenerar el PDF) cuando negocia el plan. En quotes nuevos y pseudo-quotes
// (flujo referencial) esos campos no existen → 0.
function descuentosHasta(quote, config, targetIdx) {
  let recurrentePct = 0;
  let lastIdx = -1;
  const top = Math.min(Number(targetIdx), DISCOUNT_LADDER.length - 1);
  for (let i = 0; i <= top; i++) {
    if (!escalonAplica(quote, config, i)) continue;
    recurrentePct = DISCOUNT_LADDER[i].pct;
    lastIdx = i;
  }
  return {
    descuentos: {
      recurrentePct,
      instalacionRMPct: Number(quote?.[config.quoteDiscountInstRMPctField] || 0),
      instalacionRegionPct: Number(quote?.[config.quoteDiscountInstRegionPctField] || 0),
    },
    lastIdx,
    lastEscalon: lastIdx >= 0 ? DISCOUNT_LADDER[lastIdx] : null,
  };
}

// Preview de montos (CLP, IVA incluido, con el primer mes dentro del pago
// inicial — igual que el bloque "Pago inicial" del PDF) para un set de
// descuentos. Función pura: no toca Zoho ni regenera nada.
function previewAmounts(quote, config, descuentos) {
  const items = sanitizeItems(quote?.[config.quoteItemsSubformField]);
  return computePaymentAmounts(items, descuentos, {
    includeIva: true,
    includeFirstMonth: true,
  });
}

// Formato CLP simple e independiente de ICU (Vercel/Node): $1.234.567
function fmtCLP(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + v.toLocaleString("en-US").replace(/,/g, ".");
}

// Mensaje que Vicky copia tal cual para ofrecer el descuento en la
// conversación (negociación), con el precio recalculado. Mismo formato en el
// flujo referencial (preform) y en el post-cotización.
// opts:
//   - conciso: oferta NO es la primera de la negociación → solo el nuevo precio,
//     sin repetir el detalle largo ("incluye el primer mes", "desde el 2º mes",
//     "IVA incluido"), que ya se explicó en la primera oferta.
//   - esPrimerDescuentoPlan: este es el PRIMER tramo de descuento del PLAN → se
//     muestra la condición de los 6 meses. En los tramos siguientes NO se repite.
function buildMensajeNegociacion(escalon, amounts, esUltimo = false, opts = {}) {
  const conciso = opts.conciso === true;
  const esPrimerDescuentoPlan = opts.esPrimerDescuentoPlan !== false; // default: true
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

  // El pago inicial incluye el primer mes cuando se calculó con
  // includeFirstMonth (lo aclaramos para que el cliente no lo lea como un
  // cobro mensual aparte del inicial).
  // ¿El pago inicial difiere del mensual? Solo difiere cuando hay cargos de UNA
  // vez (compra de equipos, instalación, envío). En planes solo-software el pago
  // inicial = el primer mes = el mensual, así que mostrar ambos números (y el
  // "desde el 2º mes…") es redundante: se dice el mismo monto dos veces.
  const hayCargoInicial =
    Math.round(amounts.oneShotClp) !== Math.round(amounts.recurringClp);

  const partes = [oferta];
  if (!hayCargoInicial) {
    // Solo-software: un solo número, corto.
    partes.push(`Con eso queda en ${mensual}/mes (IVA incluido).`);
  } else if (conciso) {
    partes.push(`Con eso queda en ${mensual}/mes (pago inicial ${pagoInicial}).`);
  } else {
    partes.push(
      `Con eso el pago inicial queda en ${pagoInicial} (incluye el primer mes) y luego ${mensual}/mes (IVA incluido).`,
    );
  }
  // La condición de los 6 meses se dice UNA sola vez: solo en el primer tramo de
  // descuento del plan, para no repetirla en cada oferta.
  const tieneDescPlan = Number(amounts?.descuentos?.recurrentePct || 0) > 0;
  if (tieneDescPlan && esPrimerDescuentoPlan) {
    partes.push(
      `Ese precio con descuento en el plan aplica los primeros ${MESES_DESCUENTO_PLAN} meses; desde el mes ${MESES_DESCUENTO_PLAN + 1} el plan vuelve a su tarifa normal.`,
    );
  }
  if (escalon.condicionDiscursiva) partes.push(escalon.condicionDiscursiva);
  // En el último escalón no invitamos a seguir pidiendo rebaja: es el mejor
  // precio posible, así que cerramos hacia la decisión.
  partes.push(
    esUltimo
      ? "De verdad es el mejor precio que te puedo dejar. ¿Lo cerramos?"
      : "¿Lo cerramos?",
  );
  return partes.join(" ");
}

module.exports = {
  DISCOUNT_LADDER,
  escalonAplica,
  normalizarIndiceGuardado,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
  previewAmounts,
  fmtCLP,
  buildMensajeNegociacion,
};

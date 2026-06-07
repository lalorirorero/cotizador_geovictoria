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
 * Los descuentos son acumulativos sobre líneas distintas: instalación (RM o
 * regiones) convive con el descuento recurrente. Caminar la escalera hasta un
 * índice N produce el set acumulado de descuentos vigente en ese nivel.
 */

const { DISCOUNT_LADDER } = require("./proposal-constants");
const { sanitizeItems, computePaymentAmounts } = require("./quote-pricing");

// Detecta si la cotización tiene ítems de instalación de la zona dada, leyendo
// el subform. Si la zona no existe, ese escalón se salta automáticamente.
function tieneInstalacionDeZona(quote, config, zona) {
  const items = quote?.[config.quoteItemsSubformField];
  if (!Array.isArray(items)) return false;
  return items.some((row) => {
    const codigo = String(row?.Codigo_Item || "").toLowerCase();
    if (codigo !== "instalacion_reloj") return false;
    const rowZona = String(row?.[config.quoteItemZonaTarifaField] || "")
      .toLowerCase()
      .trim();
    if (zona === "RM") return rowZona === "rm";
    if (zona === "regiones") return rowZona === "regiones" || rowZona === "region";
    return false;
  });
}

// ¿El escalón en `idx` aplica a esta cotización? Los de instalación requieren
// que exista un ítem de instalación de la zona correspondiente.
function escalonAplica(quote, config, idx) {
  const escalon = DISCOUNT_LADDER[idx];
  if (!escalon) return false;
  if (escalon.tipo === "instalacion_rm") {
    return tieneInstalacionDeZona(quote, config, "RM");
  }
  if (escalon.tipo === "instalacion_region") {
    return tieneInstalacionDeZona(quote, config, "regiones");
  }
  return true;
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
function descuentosHasta(quote, config, targetIdx) {
  let recurrentePct = 0;
  let instalacionRMPct = 0;
  let instalacionRegionPct = 0;
  let lastIdx = -1;
  const top = Math.min(Number(targetIdx), DISCOUNT_LADDER.length - 1);
  for (let i = 0; i <= top; i++) {
    if (!escalonAplica(quote, config, i)) continue;
    const escalon = DISCOUNT_LADDER[i];
    if (escalon.tipo === "instalacion_rm") instalacionRMPct = escalon.pct;
    else if (escalon.tipo === "instalacion_region") instalacionRegionPct = escalon.pct;
    else recurrentePct = escalon.pct;
    lastIdx = i;
  }
  return {
    descuentos: { recurrentePct, instalacionRMPct, instalacionRegionPct },
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
function buildMensajeNegociacion(escalon, amounts, esUltimo = false) {
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
  const inicialDetalle =
    amounts.firstMonthClp > 0
      ? `${pagoInicial} (incluye el primer mes)`
      : pagoInicial;

  const partes = [
    oferta,
    `Con eso tu pago inicial queda en ${inicialDetalle} y el plan mensual en ${mensual}/mes (IVA incluido).`,
  ];
  if (escalon.condicionDiscursiva) partes.push(escalon.condicionDiscursiva);
  // En el último escalón no invitamos a seguir pidiendo rebaja: es el mejor
  // precio posible, así que cerramos hacia la decisión.
  partes.push(
    esUltimo
      ? "Es el mejor precio que puedo ofrecerte. ¿Lo tomamos?"
      : "¿Lo dejamos así o prefieres que veamos algo más?",
  );
  return partes.join(" ");
}

module.exports = {
  DISCOUNT_LADDER,
  tieneInstalacionDeZona,
  escalonAplica,
  siguienteEscalonAplicable,
  hayEscalonDespues,
  descuentosHasta,
  previewAmounts,
  fmtCLP,
  buildMensajeNegociacion,
};

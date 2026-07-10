/**
 * Calculo de montos a cobrar a partir de los items de una cotizacion.
 *
 * Replica la logica de totales de `api/quote-acceptance/session.js`
 * (sanitizeItems / clampDescuentoPct / isRecurrentModalidad) y agrega el
 * desglose por bucket (one-shot vs recurrente) con IVA separado, necesario
 * para mapear montos a Mercado Pago.
 *
 * Convenciones de negocio (heredadas del cotizador):
 * - Hay tres descuentos posibles, todos acumulativos sobre líneas distintas:
 *     · recurrentePct: aplica al bucket recurrente (plan mensual + 1er mes).
 *     · instalacionRMPct: aplica solo a items de instalación con zona RM.
 *     · instalacionRegionPct: aplica solo a items de instalación con zona
 *       "regiones".
 * - "venta" / "no recurrente" => pago unico (one-shot).
 * - Cualquier otra modalidad => recurrente.
 * - IVA = 19% sobre items afectos.
 */

const IVA_RATE = 0.19;

const DEFAULT_FIELD_MAP = {
  itemName: "Nombre_Item",
  qty: "Cantidad",
  unitUF: "Precio_Unitario_UF",
  unitCLP: "Precio_Unitario_CLP",
  subtotalUF: "Subtotal_UF",
  subtotalCLP: "Subtotal_CLP",
  modalidad: "Modalidad",
  afectoIva: "Afecto_IVA",
  codigo: "Codigo_Item",
  zonaTarifa: "Zona_Tarifa",
};

// Codigo_Item de los servicios de instalación reconocidos. Si en el futuro
// se agregan más tipos de instalación (cámaras, etc.), añadirlos acá.
const CODIGOS_INSTALACION = new Set(["instalacion_reloj"]);

function isInstalacionItem(row) {
  const codigo = String(row?.codigo || "").toLowerCase();
  return CODIGOS_INSTALACION.has(codigo);
}

function getZonaTarifa(row) {
  const raw = String(row?.zonaTarifa || "").toLowerCase().trim();
  if (raw === "rm") return "RM";
  if (raw === "regiones" || raw === "region") return "regiones";
  return null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRecurrentModalidad(value) {
  const modalidad = String(value || "").toLowerCase();
  if (!modalidad) return true;
  if (modalidad.includes("venta")) return false;
  if (modalidad.includes("no recurrente")) return false;
  return true;
}

function clampDescuentoPct(value) {
  const n = Math.round(toNumber(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Backstop de seguridad del descuento recurrente: 40%. La escalera de
  // negociación nueva tope en 20% (DISCOUNT_LADDER 10→20), pero este clamp se
  // mantiene en 40% a propósito para NO recortar cotizaciones antiguas ya
  // comiteadas a 30/40% al regenerar/cobrar (las antiguas siguen igual).
  return Math.max(0, Math.min(40, Math.round(n / 5) * 5));
}

function sanitizeItems(items, fieldMap = DEFAULT_FIELD_MAP) {
  if (!Array.isArray(items)) return [];
  return items.map((row) => ({
    nombre: String(row?.[fieldMap.itemName] || ""),
    cantidad: toNumber(row?.[fieldMap.qty]),
    precioUnitarioUf: toNumber(row?.[fieldMap.unitUF]),
    precioUnitarioClp: toNumber(row?.[fieldMap.unitCLP]),
    subtotalUf: toNumber(row?.[fieldMap.subtotalUF]),
    subtotalClp: toNumber(row?.[fieldMap.subtotalCLP]),
    modalidad: String(row?.[fieldMap.modalidad] || ""),
    afectoIva: row?.[fieldMap.afectoIva] === true,
    codigo: String(row?.[fieldMap.codigo] || ""),
    zonaTarifa: String(row?.[fieldMap.zonaTarifa] || ""),
  }));
}

// Acepta tanto la firma vieja (número = descuento recurrente) como la nueva
// (objeto con los 3 descuentos posibles).
function normalizeDescuentos(input) {
  if (input == null) return { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 };
  if (typeof input === "number") {
    return { recurrentePct: clampDescuentoPct(input), instalacionRMPct: 0, instalacionRegionPct: 0 };
  }
  return {
    recurrentePct: clampDescuentoPct(input.recurrentePct ?? input.recurrente ?? 0),
    instalacionRMPct: clampInstalacionPct(input.instalacionRMPct ?? input.instalacionRM ?? 0),
    instalacionRegionPct: clampInstalacionPct(input.instalacionRegionPct ?? input.instalacionRegion ?? 0),
  };
}

// Descuentos de instalación: 0..50, sin múltiplos forzados (los valores
// reales del negocio son 25 y 50; igual saneamos por defensa en profundidad).
function clampInstalacionPct(value) {
  const n = Math.round(toNumber(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(50, n));
}

/**
 * Calcula los montos a cobrar en CLP para cada flujo de Mercado Pago.
 *
 * @param {Array} items  items ya sanitizados (sanitizeItems)
 * @param {number|object} descuentos  Si number, se interpreta como descuento
 *   recurrente (compat con la firma anterior). Si object:
 *     { recurrentePct, instalacionRMPct, instalacionRegionPct }
 * @param {{ includeIva?: boolean, includeFirstMonth?: boolean }} options
 */
function computePaymentAmounts(items, descuentos = 0, options = {}) {
  const includeIva = options.includeIva !== false;
  const includeFirstMonth = options.includeFirstMonth === true;
  const rows = Array.isArray(items) ? items : [];
  const { recurrentePct, instalacionRMPct, instalacionRegionPct } =
    normalizeDescuentos(descuentos);

  const factorRec = 1 - recurrentePct / 100;
  const factorInstRM = 1 - instalacionRMPct / 100;
  const factorInstRegion = 1 - instalacionRegionPct / 100;

  let oneShotNet = 0;
  let oneShotIvaBase = 0;
  let recurringNet = 0;
  let recurringIvaBase = 0;

  rows.forEach((row) => {
    const subtotal = toNumber(row?.subtotalClp);
    const afecto = row?.afectoIva !== false;
    const recurrente = isRecurrentModalidad(row?.modalidad);

    // Descuento de instalación: solo aplica al item si es de instalación con
    // la zona correspondiente. No se mezcla con el descuento del recurrente.
    let factorLinea = 1;
    if (isInstalacionItem(row)) {
      const zona = getZonaTarifa(row);
      if (zona === "RM") factorLinea = factorInstRM;
      else if (zona === "regiones") factorLinea = factorInstRegion;
    }
    const subtotalAjustado = subtotal * factorLinea;

    if (recurrente) {
      // El descuento negociado del plan mensual aplica SOLO al plan de software
      // (asistencia), NO al arriendo de hardware (reloj u otros equipos en
      // arriendo), aunque ambos vivan en el bucket recurrente. Regla comercial.
      const esArriendoHardware = String(row?.modalidad || "")
        .toLowerCase()
        .includes("arriendo");
      const factorPlan = esArriendoHardware ? 1 : factorRec;
      recurringNet += subtotalAjustado * factorPlan;
      if (afecto) recurringIvaBase += subtotalAjustado * factorPlan;
    } else {
      oneShotNet += subtotalAjustado;
      if (afecto) oneShotIvaBase += subtotalAjustado;
    }
  });

  // El descuento recurrente ya se aplicó por línea (solo al plan de software, no
  // al arriendo de hardware), así que el bucket recurrente ya viene neto.
  const recurringNetDisc = recurringNet;
  const recurringIvaBaseDisc = recurringIvaBase;

  const oneShotIva = includeIva ? oneShotIvaBase * IVA_RATE : 0;
  const recurringIva = includeIva ? recurringIvaBaseDisc * IVA_RATE : 0;

  const oneShotItemsClp = Math.round(oneShotNet + oneShotIva);
  const recurringClp = Math.round(recurringNetDisc + recurringIva);
  const firstMonthClp = includeFirstMonth ? recurringClp : 0;
  const oneShotClp = oneShotItemsClp + firstMonthClp;

  return {
    oneShotClp,
    oneShotItemsClp,
    firstMonthClp,
    recurringClp,
    includeIva,
    includeFirstMonth,
    descuentoPct: recurrentePct,
    descuentos: { recurrentePct, instalacionRMPct, instalacionRegionPct },
    breakdown: {
      oneShotNetClp: Math.round(oneShotNet),
      oneShotIvaClp: Math.round(oneShotIva),
      recurringNetClp: Math.round(recurringNetDisc),
      recurringIvaClp: Math.round(recurringIva),
    },
  };
}

// ── COLOMBIA ────────────────────────────────────────────────────────────────
// Totales CO con IVA POR LÍNEA (Afecto_IVA del subform): el plan mensual va
// exento (art. 476 E.T.) y activación/equipos/envío/instalación llevan 19 %.
// Convención COLOMBIA.md: en CO el subform guarda COP en los campos *_CLP, por
// eso acá `subtotalClp` se lee como COP. Buckets distintos de Chile: el "Pago
// inicial" son SOLO los pagos únicos (la Activación ya ES el primer mes cobrado
// por adelantado); la "Mensualidad" son los recurrentes, facturada desde el mes
// siguiente. Sin descuentos en CO v1.
// (Extraída de session.js para compartirla con el flujo de pago sin duplicar.)
function computeTotalsCO(items) {
  const rows = Array.isArray(items) ? items : [];
  let pagoInicialNetoCop = 0;
  let pagoInicialIvaCop = 0;
  let mensualidadNetaCop = 0;
  let mensualidadIvaCop = 0;

  rows.forEach((row) => {
    const netoCop = toNumber(row?.subtotalClp);
    const ivaCop = row?.afectoIva === true ? netoCop * IVA_RATE : 0;
    if (isRecurrentModalidad(row?.modalidad)) {
      mensualidadNetaCop += netoCop;
      mensualidadIvaCop += ivaCop;
    } else {
      pagoInicialNetoCop += netoCop;
      pagoInicialIvaCop += ivaCop;
    }
  });

  return {
    pagoInicialNetoCop: Math.round(pagoInicialNetoCop),
    pagoInicialIvaCop: Math.round(pagoInicialIvaCop),
    pagoInicialCop: Math.round(pagoInicialNetoCop + pagoInicialIvaCop),
    mensualidadNetaCop: Math.round(mensualidadNetaCop),
    mensualidadIvaCop: Math.round(mensualidadIvaCop),
    mensualidadCop: Math.round(mensualidadNetaCop + mensualidadIvaCop),
  };
}

/**
 * Montos a cobrar de una cotización COLOMBIA, en el MISMO shape que
 * computePaymentAmounts para que el resto del flujo de pago (preferencia,
 * status, finalize, pago.html) lea los montos sin ramas por país.
 *
 * POR QUÉ difiere de Chile:
 *  - El pago único CO = solo ítems NO recurrentes: neto + IVA de las líneas
 *    afectas. La fila de Activación (pago único, afecta) YA equivale al primer
 *    mes cobrado por adelantado → NUNCA se agrega un "primer mes" adicional
 *    (firstMonthClp = 0 siempre, ignora MP_ONESHOT_INCLUDE_FIRST_MONTH).
 *  - IVA POR LÍNEA (Afecto_IVA), no el flag global chileno MP_CHARGE_INCLUDE_IVA.
 *  - Sin descuentos en CO v1.
 * Los campos *Clp del resultado llevan COP (misma convención del subform).
 */
function computePaymentAmountsCO(items) {
  const totals = computeTotalsCO(items);
  return {
    oneShotClp: totals.pagoInicialCop,
    oneShotItemsClp: totals.pagoInicialCop,
    firstMonthClp: 0,
    recurringClp: totals.mensualidadCop,
    includeIva: true,
    includeFirstMonth: false,
    descuentoPct: 0,
    descuentos: { recurrentePct: 0, instalacionRMPct: 0, instalacionRegionPct: 0 },
    breakdown: {
      oneShotNetClp: totals.pagoInicialNetoCop,
      oneShotIvaClp: totals.pagoInicialIvaCop,
      recurringNetClp: totals.mensualidadNetaCop,
      recurringIvaClp: totals.mensualidadIvaCop,
    },
    co: totals,
  };
}

module.exports = {
  IVA_RATE,
  DEFAULT_FIELD_MAP,
  CODIGOS_INSTALACION,
  sanitizeItems,
  clampDescuentoPct,
  clampInstalacionPct,
  isRecurrentModalidad,
  isInstalacionItem,
  getZonaTarifa,
  computePaymentAmounts,
  computeTotalsCO,
  computePaymentAmountsCO,
};

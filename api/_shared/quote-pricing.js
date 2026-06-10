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
  // Tope del descuento recurrente del plan: 40% (escalera 10→20→30→35→40).
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
      recurringNet += subtotalAjustado;
      if (afecto) recurringIvaBase += subtotalAjustado;
    } else {
      oneShotNet += subtotalAjustado;
      if (afecto) oneShotIvaBase += subtotalAjustado;
    }
  });

  // Descuento recurrente: aplica al bucket recurrente después de los descuentos
  // por línea (que no son recurrentes; quedaron en one-shot).
  const recurringNetDisc = recurringNet * factorRec;
  const recurringIvaBaseDisc = recurringIvaBase * factorRec;

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
};

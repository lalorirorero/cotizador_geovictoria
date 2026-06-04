/**
 * Calculo de montos a cobrar a partir de los items de una cotizacion.
 *
 * Replica la logica de totales de `api/quote-acceptance/session.js`
 * (sanitizeItems / clampDescuentoPct / isRecurrentModalidad) y agrega el
 * desglose por bucket (one-shot vs recurrente) con IVA separado, necesario
 * para mapear montos a Mercado Pago.
 *
 * Convenciones de negocio (heredadas del cotizador):
 * - El descuento aplica SOLO al bucket recurrente.
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
};

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
  return Math.max(0, Math.min(30, Math.round(n / 5) * 5));
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
  }));
}

/**
 * Calcula los montos a cobrar en CLP para cada flujo de Mercado Pago.
 *
 * @param {Array} items  items ya sanitizados (sanitizeItems)
 * @param {number} descuentoPct  descuento recurrente (0..30)
 * @param {{ includeIva?: boolean }} options
 * @returns {{
 *   oneShotClp: number, recurringClp: number, includeIva: boolean,
 *   descuentoPct: number, breakdown: object
 * }}
 */
function computePaymentAmounts(items, descuentoPct = 0, options = {}) {
  const includeIva = options.includeIva !== false;
  const rows = Array.isArray(items) ? items : [];
  const pct = clampDescuentoPct(descuentoPct);
  const factor = 1 - pct / 100;

  let oneShotNet = 0;
  let oneShotIvaBase = 0;
  let recurringNet = 0;
  let recurringIvaBase = 0;

  rows.forEach((row) => {
    const subtotal = toNumber(row?.subtotalClp);
    const afecto = row?.afectoIva !== false;
    if (isRecurrentModalidad(row?.modalidad)) {
      recurringNet += subtotal;
      if (afecto) recurringIvaBase += subtotal;
    } else {
      oneShotNet += subtotal;
      if (afecto) oneShotIvaBase += subtotal;
    }
  });

  // El descuento aplica solo al bucket recurrente (neto e IVA por igual).
  const recurringNetDisc = recurringNet * factor;
  const recurringIvaBaseDisc = recurringIvaBase * factor;

  const oneShotIva = includeIva ? oneShotIvaBase * IVA_RATE : 0;
  const recurringIva = includeIva ? recurringIvaBaseDisc * IVA_RATE : 0;

  // CLP no admite decimales: se cobra en enteros.
  const oneShotClp = Math.round(oneShotNet + oneShotIva);
  const recurringClp = Math.round(recurringNetDisc + recurringIva);

  return {
    oneShotClp,
    recurringClp,
    includeIva,
    descuentoPct: pct,
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
  sanitizeItems,
  clampDescuentoPct,
  isRecurrentModalidad,
  computePaymentAmounts,
};

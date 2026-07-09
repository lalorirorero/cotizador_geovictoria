/**
 * UF del día con timeout y fuente de respaldo.
 *
 * mindicador.cl se degrada con frecuencia (respuestas 500 o conexiones que
 * quedan colgadas sin responder); sin timeout, la lambda entera muere por
 * FUNCTION_INVOCATION_TIMEOUT esperándolo. Cada fuente tiene 6s y si la
 * primaria falla se consulta api.gael.cloud (mismo dato oficial del BCCh).
 *
 * Devuelve el valor de la UF en CLP, o 0 si TODAS las fuentes fallaron
 * (el llamador decide si 0 es tolerable — para un PDF cliente no lo es).
 */

const TIMEOUT_MS = 6000;

async function ufDesdeMindicador() {
  const res = await fetch("https://mindicador.cl/api/uf", {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return 0;
  const data = await res.json();
  return Number(data?.serie?.[0]?.valor) || 0;
}

async function ufDesdeGael() {
  const res = await fetch("https://api.gael.cloud/general/public/monedas/UF", {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return 0;
  const data = await res.json();
  // Valor viene como string con coma decimal: "40844,79".
  return Number(String(data?.Valor || "").replace(/\./g, "").replace(",", ".")) || 0;
}

async function getUFActualSafe() {
  try {
    const uf = await ufDesdeMindicador();
    if (uf > 0) return uf;
  } catch {}
  try {
    const uf = await ufDesdeGael();
    if (uf > 0) return uf;
  } catch {}
  return 0;
}

module.exports = { getUFActualSafe };

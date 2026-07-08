/**
 * Configuracion de la integracion con Mercado Pago.
 *
 * Todo se controla por variables de entorno (Vercel). Por defecto la
 * integracion esta DESACTIVADA (`MP_PAYMENTS_ENABLED` != "true") y apunta a
 * ambiente de PRUEBA, de modo que pasar a produccion sea solo un cambio de
 * configuracion (Access Token productivo + `MP_ENVIRONMENT=production`).
 *
 * Nunca exponer `MP_ACCESS_TOKEN` en el cliente: solo se usa desde el backend.
 */

const { toText } = require("./zoho-crm");

const MP_API_BASE = "https://api.mercadopago.com";

function toBool(value, fallback = false) {
  const raw = toText(value).toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "si";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBaseUrl(req) {
  const envBase = toText(process.env.QUOTE_ACCEPT_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/+$/, "");

  const host = toText(req?.headers?.host);
  const proto = toText(req?.headers?.["x-forwarded-proto"]) || "https";
  if (!host) {
    return "https://cotizacion.geovictoria.com";
  }
  return `${proto}://${host}`;
}

// ── Carril de test por empresa ──
// Permite probar el flujo completo (incluido el pago) con MercadoPago sandbox
// SIN afectar a clientes reales: si la cotización es de la empresa de prueba
// (HuelleroCompany, por ID de cuenta CRM o RUT), el pago usa credenciales de
// test. Los IDs/RUTs se pueden configurar por env; por defecto HuelleroCompany.
function normalizeRut(value) {
  return toText(value).replace(/[.\s-]/g, "").toUpperCase();
}

function isTestLaneQuote(quote, acceptanceConfig) {
  if (!quote) return false;
  const testAccountIds = (toText(process.env.MP_TEST_LANE_ACCOUNT_IDS) || "3525045000208660206")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const testRuts = (toText(process.env.MP_TEST_LANE_RUTS) || "76622058-4")
    .split(",").map((s) => normalizeRut(s)).filter(Boolean);
  const testNames = (toText(process.env.MP_TEST_LANE_COMPANIES) || "huellerocompany")
    .split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  const accountId = toText(
    quote?.Cuenta_Asociada?.id || quote?.CRM_Account?.id || quote?.[acceptanceConfig?.onboardingAccountLookupField]?.id
  );
  const rut = normalizeRut(
    quote?.[acceptanceConfig?.companyRutField] || quote?.RUT_Cliente || quote?.RUT || quote?.Identificador_Tributario_Empresa
  );
  const companyName = toText(
    quote?.Cuenta_Asociada?.name || quote?.CRM_ACCOUNT_NAME || quote?.Account_Name?.name || quote?.CRM_ACCOUNT
  ).toLowerCase().replace(/\s+/g, "");
  if (accountId && testAccountIds.includes(accountId)) return true;
  if (rut && testRuts.includes(rut)) return true;
  if (companyName && testNames.includes(companyName)) return true;
  return false;
}

function getMercadoPagoConfig(req, opts = {}) {
  const baseUrl = getBaseUrl(req);
  const testLane = opts.testLane === true;
  const environment = testLane
    ? "test"
    : toText(process.env.MP_ENVIRONMENT || "test").toLowerCase();
  const landingPath = toText(process.env.MP_PAYMENT_LANDING_PATH || "/pago.html");

  // Carril de test: usa credenciales sandbox y marca la URL de notificación con
  // ?lane=test para que el webhook consulte el pago en la cuenta MP correcta.
  const baseNotificationUrl = toText(process.env.MP_NOTIFICATION_URL) || `${baseUrl}/api/payments/webhook`;
  const notificationUrl = testLane
    ? baseNotificationUrl + (baseNotificationUrl.includes("?") ? "&" : "?") + "lane=test"
    : baseNotificationUrl;

  return {
    enabled: toBool(process.env.MP_PAYMENTS_ENABLED, false),
    testLane,
    environment,
    isProduction: environment === "production" || environment === "prod",
    apiBase: MP_API_BASE,
    accessToken: testLane ? toText(process.env.MP_TEST_ACCESS_TOKEN) : toText(process.env.MP_ACCESS_TOKEN),
    publicKey: testLane ? toText(process.env.MP_TEST_PUBLIC_KEY) : toText(process.env.MP_PUBLIC_KEY),
    webhookSecret: toText(process.env.MP_WEBHOOK_SECRET),
    currencyId: toText(process.env.MP_CURRENCY_ID || "CLP"),
    includeIva: toBool(process.env.MP_CHARGE_INCLUDE_IVA, true),
    // Suscripcion recurrente: desactivada por ahora. El monto recurrente varia
    // por usuarios activos/mes (input aun no integrado), asi que por defecto solo
    // se cobra el pago unico. Encender con MP_SUBSCRIPTION_ENABLED=true.
    subscriptionEnabled: toBool(process.env.MP_SUBSCRIPTION_ENABLED, false),
    // Cobrar el primer mes de servicio por adelantado dentro del pago unico.
    oneShotIncludeFirstMonth: toBool(process.env.MP_ONESHOT_INCLUDE_FIRST_MONTH, true),
    statementDescriptor: toText(process.env.MP_STATEMENT_DESCRIPTOR || "GEOVICTORIA"),
    subscriptionReason: toText(process.env.MP_SUBSCRIPTION_REASON || "Suscripcion GeoVictoria"),
    oneShotTitle: toText(process.env.MP_ONESHOT_TITLE || "Servicios iniciales GeoVictoria"),
    paymentSessionTtlMinutes: toInt(process.env.MP_PAYMENT_SESSION_TTL_MINUTES, 1440),
    baseUrl,
    landingPath,
    landingUrl: `${baseUrl}${landingPath.startsWith("/") ? "" : "/"}${landingPath}`,
    notificationUrl,
    // Valor (best-effort) que se escribe en el campo de estado del handoff de la
    // cotizacion mientras el pago esta pendiente.
    statusPaymentPending: toText(process.env.MP_QUOTE_STATUS_PAYMENT_PENDING || "Pago Pendiente"),
  };
}

/**
 * Devuelve el init_point correcto segun ambiente. En ambiente de prueba se
 * prefiere `sandbox_init_point` cuando esta disponible (preferencias). El
 * preapproval solo expone `init_point`.
 */
function pickInitPoint(resource, config) {
  if (!resource) return "";
  if (!config.isProduction && resource.sandbox_init_point) {
    return resource.sandbox_init_point;
  }
  return resource.init_point || resource.sandbox_init_point || "";
}

module.exports = {
  MP_API_BASE,
  getMercadoPagoConfig,
  isTestLaneQuote,
  pickInitPoint,
  toBool,
};

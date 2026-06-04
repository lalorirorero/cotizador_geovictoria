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

function getMercadoPagoConfig(req) {
  const baseUrl = getBaseUrl(req);
  const environment = toText(process.env.MP_ENVIRONMENT || "test").toLowerCase();
  const landingPath = toText(process.env.MP_PAYMENT_LANDING_PATH || "/pago.html");

  return {
    enabled: toBool(process.env.MP_PAYMENTS_ENABLED, false),
    environment,
    isProduction: environment === "production" || environment === "prod",
    apiBase: MP_API_BASE,
    accessToken: toText(process.env.MP_ACCESS_TOKEN),
    publicKey: toText(process.env.MP_PUBLIC_KEY),
    webhookSecret: toText(process.env.MP_WEBHOOK_SECRET),
    currencyId: toText(process.env.MP_CURRENCY_ID || "CLP"),
    includeIva: toBool(process.env.MP_CHARGE_INCLUDE_IVA, true),
    statementDescriptor: toText(process.env.MP_STATEMENT_DESCRIPTOR || "GEOVICTORIA"),
    subscriptionReason: toText(process.env.MP_SUBSCRIPTION_REASON || "Suscripcion GeoVictoria"),
    oneShotTitle: toText(process.env.MP_ONESHOT_TITLE || "Servicios iniciales GeoVictoria"),
    paymentSessionTtlMinutes: toInt(process.env.MP_PAYMENT_SESSION_TTL_MINUTES, 1440),
    baseUrl,
    landingPath,
    landingUrl: `${baseUrl}${landingPath.startsWith("/") ? "" : "/"}${landingPath}`,
    notificationUrl: toText(process.env.MP_NOTIFICATION_URL) || `${baseUrl}/api/payments/webhook`,
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
  pickInitPoint,
  toBool,
};

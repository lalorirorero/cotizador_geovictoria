const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

const tokenState = {
  accessToken: "",
  expiresAtMs: 0,
  refreshingPromise: null,
};

function toNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(url, fallback) {
  const raw = toNonEmptyString(url) || fallback;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function getZohoConfig() {
  const clientId = toNonEmptyString(process.env.ZOHO_CLIENT_ID);
  const clientSecret = toNonEmptyString(process.env.ZOHO_CLIENT_SECRET);
  const refreshToken = toNonEmptyString(process.env.ZOHO_REFRESH_TOKEN);
  const accountsDomain = normalizeUrl(process.env.ZOHO_ACCOUNTS_DOMAIN, "https://accounts.zoho.com");
  const apiDomain = normalizeUrl(process.env.ZOHO_API_DOMAIN, "https://www.zohoapis.com");

  const missing = [];
  if (!clientId) missing.push("ZOHO_CLIENT_ID");
  if (!clientSecret) missing.push("ZOHO_CLIENT_SECRET");
  if (!refreshToken) missing.push("ZOHO_REFRESH_TOKEN");
  if (!accountsDomain) missing.push("ZOHO_ACCOUNTS_DOMAIN");
  if (!apiDomain) missing.push("ZOHO_API_DOMAIN");

  return {
    clientId,
    clientSecret,
    refreshToken,
    accountsDomain,
    apiDomain,
    missing,
  };
}

function getTokenMeta() {
  return {
    hasToken: Boolean(tokenState.accessToken),
    expiresAtMs: tokenState.expiresAtMs || 0,
    expiresAtIso: tokenState.expiresAtMs ? new Date(tokenState.expiresAtMs).toISOString() : null,
  };
}

function canReuseToken() {
  if (!tokenState.accessToken) return false;
  return Date.now() + TOKEN_SAFETY_MARGIN_MS < tokenState.expiresAtMs;
}

async function fetchNewAccessToken() {
  const config = getZohoConfig();
  if (config.missing.length > 0) {
    throw new Error(`Missing Zoho env vars: ${config.missing.join(", ")}`);
  }

  const url = `${config.accountsDomain}/oauth/v2/token`;
  const body = new URLSearchParams({
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    payload = { raw: text };
  }

  if (!response.ok || !payload.access_token) {
    const reason = payload.error || payload.error_description || payload.raw || `HTTP ${response.status}`;
    throw new Error(`Zoho token refresh failed: ${reason}`);
  }

  const expiresInSec = Number(payload.expires_in || payload.expires_in_sec || 3600);
  const ttlSec = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;

  tokenState.accessToken = String(payload.access_token);
  tokenState.expiresAtMs = Date.now() + ttlSec * 1000;
  return tokenState.accessToken;
}

async function getZohoAccessToken(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && canReuseToken()) {
    return tokenState.accessToken;
  }

  if (!forceRefresh && tokenState.refreshingPromise) {
    return tokenState.refreshingPromise;
  }

  tokenState.refreshingPromise = fetchNewAccessToken()
    .catch((error) => {
      tokenState.accessToken = "";
      tokenState.expiresAtMs = 0;
      throw error;
    })
    .finally(() => {
      tokenState.refreshingPromise = null;
    });

  return tokenState.refreshingPromise;
}

async function zohoApiFetch(path, options = {}) {
  const config = getZohoConfig();
  if (config.missing.length > 0) {
    throw new Error(`Missing Zoho env vars: ${config.missing.join(", ")}`);
  }

  const method = toNonEmptyString(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  const requestBody = options.body;
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${config.apiDomain}${fullPath}`;

  const doFetch = async (forceRefresh) => {
    const accessToken = await getZohoAccessToken({ forceRefresh });
    const finalHeaders = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...headers,
    };
    return fetch(url, {
      method,
      headers: finalHeaders,
      body: requestBody,
    });
  };

  let response = await doFetch(false);
  if (response.status !== 401) return response;

  response = await doFetch(true);
  return response;
}

module.exports = {
  getZohoConfig,
  getZohoAccessToken,
  getTokenMeta,
  zohoApiFetch,
};


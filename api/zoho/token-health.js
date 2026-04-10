const { getZohoConfig, getZohoAccessToken, getTokenMeta, zohoApiFetch } = require("../_shared/zoho-auth");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readResponseAsJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { success: false, error: "Método no permitido." });
    return;
  }

  try {
    const config = getZohoConfig();
    if (config.missing.length > 0) {
      sendJson(res, 500, {
        success: false,
        error: "Faltan variables de entorno de Zoho.",
        missing: config.missing,
      });
      return;
    }

    await getZohoAccessToken();
    const tokenMeta = getTokenMeta();

    const pingResp = await zohoApiFetch("/crm/v3/users?type=CurrentUser");
    const pingPayload = await readResponseAsJsonSafe(pingResp);

    if (!pingResp.ok) {
      sendJson(res, 502, {
        success: false,
        error: "No se pudo validar acceso a Zoho CRM.",
        zohoStatus: pingResp.status,
        zohoPayload: pingPayload,
        tokenMeta,
      });
      return;
    }

    const firstUser = Array.isArray(pingPayload?.users) ? pingPayload.users[0] : null;
    sendJson(res, 200, {
      success: true,
      message: "Integración Zoho operativa con token vigente.",
      tokenMeta,
      crmValidation: {
        status: pingResp.status,
        userId: firstUser?.id || null,
        userEmail: firstUser?.email || null,
      },
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Error validando token Zoho.",
      detail: String(error?.message || error),
    });
  }
}


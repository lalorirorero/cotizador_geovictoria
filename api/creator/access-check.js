const { getCreatorConfig, getCreatorAccessToken, getTokenMeta, creatorApiFetch } = require("../_shared/zoho-creator-auth");

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
    const config = getCreatorConfig();
    if (config.missing.length > 0) {
      sendJson(res, 500, {
        success: false,
        error: "Faltan variables de entorno de Zoho Creator.",
        missing: config.missing,
      });
      return;
    }

    await getCreatorAccessToken();
    const tokenMeta = getTokenMeta();

    // Read-only ping against Creator report data.
    const path = `/creator/v2.1/data/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/report/${encodeURIComponent(config.reportLinkName)}`;
    const pingResp = await creatorApiFetch(path);
    const pingPayload = await readResponseAsJsonSafe(pingResp);

    if (!pingResp.ok) {
      sendJson(res, 502, {
        success: false,
        error: "No se pudo validar acceso a Zoho Creator (lectura de reporte).",
        zohoStatus: pingResp.status,
        zohoPayload: pingPayload,
        tokenMeta,
        target: {
          ownerName: config.ownerName,
          appLinkName: config.appLinkName,
          reportLinkName: config.reportLinkName,
        },
      });
      return;
    }

    const rows = Array.isArray(pingPayload?.data) ? pingPayload.data.length : null;
    sendJson(res, 200, {
      success: true,
      message: "Integración Zoho Creator operativa (solo lectura).",
      tokenMeta,
      creatorValidation: {
        status: pingResp.status,
        ownerName: config.ownerName,
        appLinkName: config.appLinkName,
        reportLinkName: config.reportLinkName,
        rowsVisible: rows,
      },
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Error validando acceso a Zoho Creator.",
      detail: String(error?.message || error),
    });
  }
}

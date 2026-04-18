const { getCreatorConfig, creatorApiFetch } = require("../_shared/zoho-creator-auth");

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

    const queryForm = typeof req.query?.formLinkName === "string" ? req.query.formLinkName.trim() : "";
    const formLinkName = queryForm || config.formLinkName;

    // Creator has had multiple meta path variants; probe read-only variants.
    const candidates = [
      `/creator/v2/meta/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(formLinkName)}`,
      `/creator/v2.1/meta/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}/form/${encodeURIComponent(formLinkName)}`,
      `/creator/v2/meta/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}`,
      `/creator/v2.1/meta/${encodeURIComponent(config.ownerName)}/${encodeURIComponent(config.appLinkName)}`,
    ];

    const attempts = [];
    for (const path of candidates) {
      const response = await creatorApiFetch(path);
      const payload = await readResponseAsJsonSafe(response);
      attempts.push({
        path,
        status: response.status,
      });

      if (response.ok) {
        sendJson(res, 200, {
          success: true,
          message: "Metadata de Creator obtenida.",
          target: {
            ownerName: config.ownerName,
            appLinkName: config.appLinkName,
            formLinkName,
          },
          attempts,
          meta: payload,
        });
        return;
      }
    }

    sendJson(res, 502, {
      success: false,
      error: "No se pudo obtener metadata de Creator con las rutas probadas.",
      target: {
        ownerName: config.ownerName,
        appLinkName: config.appLinkName,
        formLinkName,
      },
      attempts,
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Error consultando metadata de Zoho Creator.",
      detail: String(error?.message || error),
    });
  }
}

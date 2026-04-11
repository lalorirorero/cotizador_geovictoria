const { getZohoConfig, zohoApiFetch } = require("./zoho-auth");

function toText(value) {
  return value == null ? "" : String(value).trim();
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function buildPath(moduleApiName, recordId) {
  const moduleName = encodeURIComponent(toText(moduleApiName));
  const id = encodeURIComponent(toText(recordId));
  return `/crm/v3/${moduleName}/${id}`;
}

async function getRecord(moduleApiName, recordId) {
  getZohoConfig();
  const response = await zohoApiFetch(buildPath(moduleApiName, recordId), {
    method: "GET",
  });
  const payload = await readJsonSafe(response);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!response.ok || !row) {
    const msg =
      toText(payload?.message) ||
      toText(payload?.code) ||
      toText(payload?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho getRecord failed: ${msg}`);
  }
  return row;
}

async function updateRecord(moduleApiName, recordId, fieldsMap, triggerWorkflows) {
  getZohoConfig();
  const payload = {
    data: [fieldsMap || {}],
  };
  if (triggerWorkflows) {
    payload.trigger = ["workflow"];
  }

  const response = await zohoApiFetch(buildPath(moduleApiName, recordId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await readJsonSafe(response);
  const row = Array.isArray(result?.data) ? result.data[0] : null;
  const ok = response.ok && row && /SUCCESS/i.test(toText(row.code || row.status || ""));
  if (!ok) {
    const msg =
      toText(row?.message) ||
      toText(result?.message) ||
      toText(result?.code) ||
      toText(result?.raw) ||
      `HTTP ${response.status}`;
    throw new Error(`Zoho updateRecord failed: ${msg}`);
  }
  return row;
}

module.exports = {
  getRecord,
  updateRecord,
  readJsonSafe,
  toText,
};


const { getZohoConfig, zohoApiFetch, getTokenMeta } = require("../_shared/zoho-auth");
const { readJsonSafe, toText } = require("../_shared/zoho-crm");

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getDiagnosticsSecret() {
  return toText(
    process.env.ZOHO_DIAGNOSTICS_SECRET ||
      process.env.CRON_SECRET ||
      process.env.QUOTE_ACCEPTANCE_SECRET
  );
}

function isPrimitiveUpdatableField(field) {
  if (!field || typeof field !== "object") return false;
  if (!field.api_name) return false;
  if (toText(field.api_name).toLowerCase() === "id") return false;
  if (field.system_mandatory === true) return false;
  if (field.read_only === true) return false;
  if (field.operation_type?.api_update !== true) return false;

  const dataType = toText(field.data_type).toLowerCase();
  const supported = [
    "text",
    "email",
    "phone",
    "textarea",
    "website",
    "picklist",
    "boolean",
    "integer",
    "bigint",
    "double",
    "currency",
    "percent",
    "date",
    "datetime",
  ];
  return supported.includes(dataType);
}

async function fetchCurrentUser() {
  const response = await zohoApiFetch("/crm/v3/users?type=CurrentUser", { method: "GET" });
  const payload = await readJsonSafe(response);
  return { response, payload };
}

async function fetchModules() {
  const response = await zohoApiFetch("/crm/v3/settings/modules", { method: "GET" });
  const payload = await readJsonSafe(response);
  return { response, payload };
}

async function fetchFields(moduleApiName) {
  const response = await zohoApiFetch(
    `/crm/v3/settings/fields?module=${encodeURIComponent(moduleApiName)}`,
    { method: "GET" }
  );
  const payload = await readJsonSafe(response);
  return { response, payload };
}

async function fetchFirstRecord(moduleApiName) {
  const response = await zohoApiFetch(
    `/crm/v3/${encodeURIComponent(moduleApiName)}?fields=id,Name&per_page=1&page=1`,
    { method: "GET" }
  );
  const payload = await readJsonSafe(response);
  return { response, payload };
}

async function runWriteNoOpProbe(moduleApiName, record, fields) {
  const candidates = (fields || []).filter(isPrimitiveUpdatableField);
  const candidate = candidates.find((field) => {
    const value = record?.[field.api_name];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });

  if (!candidate) {
    return {
      ok: false,
      skipped: true,
      reason:
        "No se encontro campo primitivo actualizable con valor para ejecutar no-op write probe.",
    };
  }

  const fieldName = candidate.api_name;
  const fieldValue = record[fieldName];
  const recordId = toText(record?.id);
  const path = `/crm/v3/${encodeURIComponent(moduleApiName)}/${encodeURIComponent(recordId)}`;

  const body = {
    data: [
      {
        [fieldName]: fieldValue,
      },
    ],
    trigger: [],
  };

  const response = await zohoApiFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJsonSafe(response);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  const code = toText(row?.code || row?.status || "");
  const message = toText(row?.message || payload?.message || payload?.code || "");
  const ok = response.ok && /SUCCESS/i.test(code);

  return {
    ok,
    skipped: false,
    httpStatus: response.status,
    field: fieldName,
    code,
    message,
  };
}

export default async function handler(req, res) {
  const expectedSecret = getDiagnosticsSecret();
  const providedSecret = toText(req.headers["x-diagnostics-secret"] || req.query?.secret);
  if (!expectedSecret) {
    sendJson(res, 500, {
      success: false,
      error: "Falta secreto de diagnostico en servidor.",
    });
    return;
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    sendJson(res, 401, {
      success: false,
      error: "No autorizado.",
    });
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { success: false, error: "Metodo no permitido." });
    return;
  }

  try {
    getZohoConfig();
    const targetModule = toText(req.query?.module || process.env.ZOHO_ONBOARDING_MODULE || "Autoservicio_Onboarding");
    const result = {
      success: true,
      targetModule,
      tokenMeta: null,
      checks: {
        users: {},
        modules: {},
        fields: {},
        records: {},
        writeProbe: {},
      },
    };

    await fetchCurrentUser();
    result.tokenMeta = getTokenMeta();

    const users = await fetchCurrentUser();
    const currentUser = Array.isArray(users.payload?.users) ? users.payload.users[0] : null;
    result.checks.users = {
      ok: users.response.ok,
      httpStatus: users.response.status,
      userId: toText(currentUser?.id),
      userEmail: toText(currentUser?.email),
    };

    const modulesResp = await fetchModules();
    const modules = Array.isArray(modulesResp.payload?.modules) ? modulesResp.payload.modules : [];
    const hasTarget = modules.some(
      (m) =>
        toText(m?.api_name).toLowerCase() === targetModule.toLowerCase() ||
        toText(m?.module_name).toLowerCase() === targetModule.toLowerCase()
    );
    result.checks.modules = {
      ok: modulesResp.response.ok,
      httpStatus: modulesResp.response.status,
      totalModules: modules.length,
      hasTargetModule: hasTarget,
    };

    const fieldsResp = await fetchFields(targetModule);
    const fields = Array.isArray(fieldsResp.payload?.fields) ? fieldsResp.payload.fields : [];
    result.checks.fields = {
      ok: fieldsResp.response.ok,
      httpStatus: fieldsResp.response.status,
      totalFields: fields.length,
      updatablePrimitiveFields: fields.filter(isPrimitiveUpdatableField).length,
    };

    const recordsResp = await fetchFirstRecord(targetModule);
    const records = Array.isArray(recordsResp.payload?.data) ? recordsResp.payload.data : [];
    const firstRecord = records[0] || null;
    result.checks.records = {
      ok: recordsResp.response.ok,
      httpStatus: recordsResp.response.status,
      totalReturned: records.length,
      firstRecordId: toText(firstRecord?.id),
    };

    if (!firstRecord) {
      result.checks.writeProbe = {
        ok: false,
        skipped: true,
        reason: "No hay registros para ejecutar write probe.",
      };
    } else {
      result.checks.writeProbe = await runWriteNoOpProbe(targetModule, firstRecord, fields);
    }

    const finalOk =
      result.checks.users.ok &&
      result.checks.modules.ok &&
      result.checks.modules.hasTargetModule &&
      result.checks.fields.ok &&
      result.checks.records.ok &&
      (result.checks.writeProbe.ok || result.checks.writeProbe.skipped);

    result.success = finalOk;
    result.summary = finalOk
      ? "Conexion Zoho valida para modulo objetivo."
      : "Conexion Zoho con restricciones o fallas en checks.";

    sendJson(res, finalOk ? 200 : 207, result);
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Fallo diagnostico de acceso Zoho.",
      detail: String(error?.message || error),
    });
  }
}

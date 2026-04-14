const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12MB

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_UPLOAD_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const allowedByRule =
    /^https:\/\/[a-z0-9-]+\.zappsusercontent\.com$/i.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?zoho\.[a-z.]+$/i.test(origin) ||
    origin === "https://cotizacion.geovictoria.com" ||
    origin === "http://127.0.0.1:5000" ||
    origin === "http://localhost:3000";

  const allowed = allowedByRule || allowedList.includes(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return allowed;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sanitizeFileName(name) {
  return String(name || "cotizacion.pdf")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 120);
}

function sanitizePathSegment(value, fallback) {
  const sanitized = String(value || "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 80);
  return sanitized || fallback;
}

async function ensureBucketExists({ supabaseUrl, serviceRoleKey, bucket, maxBytes }) {
  const createUrl = `${supabaseUrl}/storage/v1/bucket`;
  const createResp = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: true,
      file_size_limit: maxBytes,
    }),
  });

  if (createResp.ok) return;

  const detail = await createResp.text();
  const alreadyExists =
    createResp.status === 409 ||
    /already exists/i.test(detail) ||
    /duplicate/i.test(detail) ||
    /Bucket exists/i.test(detail);

  if (alreadyExists) return;

  throw new Error(`No se pudo crear bucket '${bucket}': ${detail.slice(0, 400)}`);
}

export default async function handler(req, res) {
  const corsAllowed = setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = corsAllowed ? 204 : 403;
    res.end();
    return;
  }

  if (!corsAllowed) {
    sendJson(res, 403, { success: false, error: "Origin no permitido." });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Método no permitido." });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.QUOTES_PDF_BUCKET || "cotizaciones-pdf";
  const maxBytes = Number(process.env.QUOTES_PDF_MAX_BYTES || DEFAULT_MAX_BYTES);

  if (!supabaseUrl || !serviceRoleKey) {
    sendJson(res, 500, { success: false, error: "Falta configuración de Supabase en el servidor." });
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body && typeof req.body === "object"
        ? req.body
        : {};

    const pdfBase64 = String(body.pdfBase64 || "").trim();
    const fileName = sanitizeFileName(body.fileName || "cotizacion.pdf");
    const dealId = sanitizePathSegment(body.dealId, "sin_deal");
    const empresa = sanitizePathSegment(body.empresa, "empresa");

    if (!pdfBase64) {
      sendJson(res, 400, { success: false, error: "Falta el PDF en base64." });
      return;
    }

    const buffer = Buffer.from(pdfBase64, "base64");
    if (!buffer.length) {
      sendJson(res, 400, { success: false, error: "El PDF es inválido o está vacío." });
      return;
    }
    if (buffer.length > maxBytes) {
      sendJson(res, 413, { success: false, error: "El PDF excede el tamaño permitido." });
      return;
    }

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const objectPath = `quotes/${yyyy}/${mm}/${dd}/${dealId}/${empresa}_${stamp}_${fileName}`;

    const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
    let uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: buffer,
    });

    if (!uploadResp.ok) {
      const firstDetail = await uploadResp.text();
      if (uploadResp.status === 404 && /Bucket not found/i.test(firstDetail)) {
        await ensureBucketExists({ supabaseUrl, serviceRoleKey, bucket, maxBytes });
        uploadResp = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/pdf",
            "x-upsert": "true",
          },
          body: buffer,
        });
      }
    }

    if (!uploadResp.ok) {
      const detail = await uploadResp.text();
      sendJson(res, 502, {
        success: false,
        error: "No se pudo guardar el PDF en Supabase.",
        detail: detail.slice(0, 400),
      });
      return;
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
    sendJson(res, 200, {
      success: true,
      pdfUrl: publicUrl,
      path: objectPath,
      sizeBytes: buffer.length,
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: "Error inesperado al subir PDF.",
      detail: String(error?.message || error),
    });
  }
}

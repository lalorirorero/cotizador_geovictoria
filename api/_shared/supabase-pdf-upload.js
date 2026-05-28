/**
 * Sube un PDF buffer a Supabase Storage y devuelve la URL pública.
 *
 * IMPORTANTE: la URL devuelta NO apunta directamente a Supabase, sino al dominio
 * Vercel de la cotizadora (default https://cotizacion.geovictoria.com), gracias
 * al rewrite configurado en vercel.json que mapea /pdf/<quoteId>/<filename>
 * hacia el storage público de Supabase.
 *
 * Esto oculta totalmente el dominio Supabase de cara al cliente y mantiene la
 * URL del PDF con el branding de GeoVictoria.
 */

const DEFAULT_BUCKET = "cotizaciones-pdf";
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12MB
const DEFAULT_PUBLIC_BASE = "https://cotizacion.geovictoria.com";

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
  const resp = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: bucket, name: bucket, public: true, file_size_limit: maxBytes }),
  });
  if (resp.ok) return;
  const detail = await resp.text();
  const alreadyExists =
    resp.status === 409 ||
    /already exists/i.test(detail) ||
    /duplicate/i.test(detail);
  if (alreadyExists) return;
  throw new Error(`No se pudo crear bucket '${bucket}': ${detail.slice(0, 300)}`);
}

/**
 * Sube un Buffer PDF a Supabase Storage.
 *
 * @param {Object} params
 * @param {Buffer} params.pdfBuffer - PDF como Buffer
 * @param {string} params.quoteId - ID del Quote (usado en el path)
 * @param {string} params.empresa - Nombre de empresa (usado en filename)
 * @returns {Promise<{pdfUrl: string, objectPath: string}>}
 *   pdfUrl: URL pública con dominio Vercel (ej: https://cotizacion.geovictoria.com/pdf/abc123/cotizacion_xxx.pdf)
 *   objectPath: ruta dentro del bucket Supabase (ej: abc123/cotizacion_xxx.pdf)
 */
async function uploadPdfToSupabase({ pdfBuffer, quoteId, empresa }) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const bucket = String(process.env.QUOTES_PDF_BUCKET || DEFAULT_BUCKET).trim();
  const maxBytes = Number(process.env.QUOTES_PDF_MAX_BYTES || DEFAULT_MAX_BYTES);
  const publicBase = String(process.env.PDF_PUBLIC_BASE || DEFAULT_PUBLIC_BASE).trim().replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error("pdfBuffer debe ser un Buffer");
  }
  if (pdfBuffer.length > maxBytes) {
    throw new Error(`PDF excede el límite (${pdfBuffer.length} > ${maxBytes} bytes)`);
  }

  await ensureBucketExists({ supabaseUrl, serviceRoleKey, bucket, maxBytes });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const empresaSeg = sanitizePathSegment(empresa, "cotizacion");
  const fileName = sanitizeFileName(`cotizacion_${empresaSeg}_${timestamp}.pdf`);
  const quoteIdSeg = sanitizePathSegment(quoteId, "no_quote");
  const objectPath = `${quoteIdSeg}/${fileName}`;

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/pdf",
      "Cache-Control": "public, max-age=31536000",
    },
    body: pdfBuffer,
  });

  if (!uploadResp.ok) {
    const detail = await uploadResp.text();
    throw new Error(`Supabase upload failed (${uploadResp.status}): ${detail.slice(0, 300)}`);
  }

  // URL pública servida por el rewrite de Vercel en vercel.json
  // El rewrite /pdf/<quoteId>/<filename> apunta internamente a:
  //   ${SUPABASE_URL}/storage/v1/object/public/${bucket}/<quoteId>/<filename>
  const pdfUrl = `${publicBase}/pdf/${objectPath}`;

  return { pdfUrl, objectPath };
}

module.exports = { uploadPdfToSupabase };

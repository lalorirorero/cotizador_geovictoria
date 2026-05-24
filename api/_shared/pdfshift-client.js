/**
 * Cliente PDFShift para convertir HTML a PDF server-side.
 * Doc: https://docs.pdfshift.io/api-reference/convert-to-pdf
 */

async function htmlToPdfBuffer(html, options = {}) {
  const apiKey = String(process.env.PDFSHIFT_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Falta PDFSHIFT_API_KEY en environment variables");
  }
  if (!html || typeof html !== "string") {
    throw new Error("htmlToPdfBuffer requiere un HTML string como primer argumento");
  }

  // Sandbox = true genera PDF con marca de agua sin gastar créditos.
  // Útil para pruebas. Producción debe ir con sandbox=false.
  const isSandbox = options.sandbox === true || process.env.PDFSHIFT_SANDBOX === "true";

  const body = {
    source: html,
    format: options.format || "Letter",
    margin: options.margin || "20mm",
    landscape: options.landscape === true,
    use_print: options.use_print === true,
    delay: typeof options.delay === "number" ? options.delay : 0,
    timeout: typeof options.timeout === "number" ? options.timeout : 30,
    sandbox: isSandbox,
  };

  let response;
  try {
    response = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`PDFShift network error: ${err?.message || String(err)}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `PDFShift HTTP ${response.status}: ${errText.slice(0, 300)}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { htmlToPdfBuffer };

/**
 * Construye el HTML de la propuesta (cotización) server-side.
 * Diseño: profesional, austero, optimizado para PDFShift (Chromium).
 *
 * Recibe `cliente` (datos del prospect) + `cotizacion` (items y totales calculados
 * por la tool cotizar_referencial de Vicky) + `acceptanceUrl` (link firmado para
 * aceptar la cotización, embebido como botón hipervinculado).
 */

const LOGO_URL =
  "https://geovictoria.com/wp-content/uploads/2020/07/logo-geovictoria-dark.svg";
const BRAND_COLOR = "#1a73e8";
const BRAND_DARK = "#0d47a1";

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatUF(value) {
  const n = Number(value || 0);
  return n.toFixed(3);
}

function formatCLP(value) {
  const n = Math.round(Number(value || 0));
  return "$" + n.toLocaleString("es-CL");
}

function buildItemRow(item, ufActual) {
  const subtotalCLP = ufActual > 0 ? Math.round(item.subtotalUF * ufActual) : 0;
  const cantidadCol =
    item.modalidad === "Fijo" || item.modalidad === "Por usuario"
      ? `${item.cantidad}`
      : `${item.cantidad}`;
  const precioCol =
    item.modalidad === "Fijo"
      ? `${formatUF(item.precioUnitarioUF)} UF (fijo)`
      : `${formatUF(item.precioUnitarioUF)} UF`;
  return `
    <tr>
      <td class="col-nombre">
        <div class="item-nombre">${escapeHtml(item.nombre)}</div>
        ${item.tierAplicado ? `<div class="item-tier">Tier: ${escapeHtml(item.tierAplicado)}</div>` : ""}
      </td>
      <td class="col-tipo">${escapeHtml(item.modalidad)}</td>
      <td class="col-cant">${cantidadCol}</td>
      <td class="col-precio">${precioCol}</td>
      <td class="col-sub">${formatUF(item.subtotalUF)} UF</td>
      <td class="col-clp">${ufActual > 0 ? formatCLP(subtotalCLP) : "—"}</td>
    </tr>`;
}

/**
 * @param {Object} params
 * @param {Object} params.cliente
 * @param {string} params.cliente.empresa
 * @param {string} params.cliente.contacto
 * @param {string} params.cliente.contactoEmail
 * @param {string} [params.cliente.contactoTelefono]
 * @param {string} params.cliente.rutEmpresa
 * @param {number} params.cliente.userCount
 * @param {string} [params.cliente.ejecutivo] - Nombre del ejecutivo
 * @param {Object} params.cotizacion
 * @param {Array}  params.cotizacion.items
 * @param {number} params.cotizacion.subtotalUF
 * @param {number} params.cotizacion.ivaUF
 * @param {number} params.cotizacion.totalUF
 * @param {number} params.cotizacion.ufActual
 * @param {number} params.cotizacion.totalCLP
 * @param {string} params.acceptanceUrl - URL firmada para aceptar la cotización
 * @param {string} [params.cotizacionId] - ID legible para mostrar (folio)
 * @returns {string} HTML completo
 */
function buildProposalHtml({ cliente, cotizacion, acceptanceUrl, cotizacionId }) {
  const fechaEmision = new Date().toLocaleDateString("es-CL", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const folio = cotizacionId || "—";
  const ejecutivo = cliente.ejecutivo || "Eddyluz Mujica";

  const itemsHtml = cotizacion.items
    .map((it) => buildItemRow(it, cotizacion.ufActual))
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Cotización ${escapeHtml(cliente.empresa)} — GeoVictoria</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #2d3748;
    background: #fff;
    line-height: 1.5;
    font-size: 11pt;
  }
  .page { padding: 30mm 20mm; max-width: 100%; min-height: 100vh; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: center;
            border-bottom: 3px solid ${BRAND_COLOR}; padding-bottom: 12px; margin-bottom: 24px; }
  .logo { font-size: 24pt; font-weight: 700; color: ${BRAND_DARK}; }
  .logo small { display: block; font-size: 9pt; font-weight: 400; color: #718096; margin-top: 2px; }
  .header-right { text-align: right; font-size: 9pt; color: #718096; }
  .header-right strong { color: ${BRAND_DARK}; font-size: 11pt; }

  /* Title */
  h1.title { font-size: 18pt; color: ${BRAND_DARK}; margin-bottom: 4px; }
  .subtitle { color: #718096; font-size: 10pt; margin-bottom: 24px; }

  /* Client box */
  .client-box { background: #f7fafc; border-left: 4px solid ${BRAND_COLOR};
                padding: 14px 18px; margin-bottom: 28px; border-radius: 4px; }
  .client-box h2 { font-size: 11pt; color: ${BRAND_DARK}; margin-bottom: 8px; }
  .client-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; font-size: 10pt; }
  .client-grid .label { color: #718096; font-weight: 500; }

  /* Items table */
  h2.section-title { font-size: 13pt; color: ${BRAND_DARK}; margin-bottom: 12px;
                     padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  table.items { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 20px; }
  table.items th { background: ${BRAND_DARK}; color: #fff; padding: 9px 8px;
                   text-align: left; font-weight: 600; }
  table.items td { padding: 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  table.items tbody tr:nth-child(even) { background: #f7fafc; }
  .col-nombre { width: 35%; }
  .col-tipo { width: 14%; }
  .col-cant { width: 8%; text-align: center; }
  .col-precio { width: 15%; }
  .col-sub { width: 14%; text-align: right; font-weight: 600; }
  .col-clp { width: 14%; text-align: right; color: #718096; }
  .item-nombre { font-weight: 600; color: #2d3748; }
  .item-tier { font-size: 8pt; color: #a0aec0; margin-top: 2px; }

  /* Totals */
  .totals { margin-left: auto; width: 60%; margin-top: 12px; font-size: 10pt; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 0;
                 border-bottom: 1px solid #e2e8f0; }
  .totals .row.grand { border-top: 2px solid ${BRAND_DARK}; border-bottom: none;
                       margin-top: 6px; padding-top: 10px; font-size: 13pt;
                       font-weight: 700; color: ${BRAND_DARK}; }
  .totals .uf { color: #2d3748; font-weight: 600; }
  .totals .clp { color: #718096; font-size: 9pt; }

  /* CTA */
  .cta-box { background: linear-gradient(135deg, ${BRAND_COLOR}, ${BRAND_DARK});
             border-radius: 10px; padding: 28px; margin: 32px 0 24px;
             text-align: center; color: #fff; }
  .cta-box h3 { font-size: 14pt; margin-bottom: 8px; }
  .cta-box p { font-size: 10pt; opacity: 0.9; margin-bottom: 16px; }
  .cta-btn { display: inline-block; background: #fff; color: ${BRAND_DARK};
             padding: 13px 32px; border-radius: 6px; text-decoration: none;
             font-weight: 700; font-size: 11pt; }

  /* Footer */
  .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #e2e8f0;
            font-size: 8.5pt; color: #a0aec0; text-align: center; }
  .footer p { margin-bottom: 4px; }
  .footer .ejecutivo { color: ${BRAND_DARK}; font-weight: 600; font-size: 9.5pt; margin-bottom: 8px; }

  /* Notas */
  .nota { background: #fffaf0; border-left: 3px solid #f6ad55; padding: 10px 14px;
          font-size: 9pt; color: #744210; margin-top: 16px; border-radius: 3px; }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="logo">
      GeoVictoria
      <small>Workforce Management Solutions</small>
    </div>
    <div class="header-right">
      <strong>Cotización N°</strong><br>
      ${escapeHtml(folio)}<br>
      <span style="font-size: 8pt;">${escapeHtml(fechaEmision)}</span>
    </div>
  </div>

  <h1 class="title">Propuesta Comercial</h1>
  <div class="subtitle">Solución personalizada para tu equipo de ${cliente.userCount} ${cliente.userCount === 1 ? "trabajador" : "trabajadores"}</div>

  <div class="client-box">
    <h2>Datos del cliente</h2>
    <div class="client-grid">
      <div><span class="label">Empresa:</span> ${escapeHtml(cliente.empresa)}</div>
      <div><span class="label">RUT:</span> ${escapeHtml(cliente.rutEmpresa)}</div>
      <div><span class="label">Contacto:</span> ${escapeHtml(cliente.contacto)}</div>
      <div><span class="label">Email:</span> ${escapeHtml(cliente.contactoEmail)}</div>
      ${cliente.contactoTelefono ? `<div><span class="label">Teléfono:</span> ${escapeHtml(cliente.contactoTelefono)}</div>` : ""}
      <div><span class="label">Trabajadores:</span> ${cliente.userCount}</div>
    </div>
  </div>

  <h2 class="section-title">Detalle de la propuesta</h2>
  <table class="items">
    <thead>
      <tr>
        <th class="col-nombre">Producto / Servicio</th>
        <th class="col-tipo">Modalidad</th>
        <th class="col-cant">Cant.</th>
        <th class="col-precio">Precio unit.</th>
        <th class="col-sub">Subtotal UF</th>
        <th class="col-clp">CLP estim.</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="row">
      <span>Subtotal</span>
      <span class="uf">${formatUF(cotizacion.subtotalUF)} UF</span>
    </div>
    <div class="row">
      <span>IVA (19%)</span>
      <span class="uf">${formatUF(cotizacion.ivaUF)} UF</span>
    </div>
    <div class="row grand">
      <span>Total mensual</span>
      <span>${formatUF(cotizacion.totalUF)} UF</span>
    </div>
    ${cotizacion.ufActual > 0 ? `
    <div class="row">
      <span style="font-size: 9pt; color: #718096;">Equivalente en CLP (UF ${formatCLP(cotizacion.ufActual)})</span>
      <span class="clp" style="font-weight: 600;">${formatCLP(cotizacion.totalCLP)}</span>
    </div>` : ""}
  </div>

  <div class="cta-box">
    <h3>Aceptá tu cotización online</h3>
    <p>Hacé clic en el botón para revisarla en detalle y confirmar la contratación con un solo paso.</p>
    <a href="${escapeHtml(acceptanceUrl)}" class="cta-btn">Revisar y aceptar cotización</a>
  </div>

  <div class="nota">
    <strong>Importante:</strong> Los precios mostrados son referenciales y están expresados en UF.
    El valor final en CLP se calcula con la UF del día de facturación. Esta cotización tiene una
    validez de 30 días desde la fecha de emisión.
  </div>

  <div class="footer">
    <p class="ejecutivo">Tu ejecutivo asignado: ${escapeHtml(ejecutivo)}</p>
    <p>¿Tenés dudas? Respondé a este correo o escribinos por WhatsApp.</p>
    <p style="margin-top: 12px;">GeoVictoria — geovictoria.com</p>
  </div>

</div>
</body>
</html>`;
}

module.exports = { buildProposalHtml };

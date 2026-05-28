/**
 * Construye el HTML de la propuesta (cotización) server-side.
 *
 * Port del `buildProposalHTML` del cliente (index.html) — genera el mismo
 * HTML de 4 páginas (Cover, Resumen, Detalle, T&C+Firma) que se descarga
 * desde la cotizadora interactiva, pero ejecutado server-side para que
 * PDFShift (Chromium headless) lo renderice como PDF profesional.
 *
 * Mantiene la interfaz pública intacta:
 *   buildProposalHtml({ cliente, cotizacion, acceptanceUrl, cotizacionId })
 *
 * Internamente adapta el formato de Vicky (`cotizacion.items` con tipos
 * modulo/hardware/servicio) al formato del builder original (servicios,
 * equipos, accesorios, serviciosAsoc) — el caller no cambia.
 */

const {
  PROPOSAL_INTRO,
  PROPOSAL_BENEFICIOS,
  PROPOSAL_TYC,
  SERVICIOS_GRATIS,
  PRICING_TIERS,
  LOGO_BLANCO_SVG,
  LOGO_ORIGINAL_SVG,
  ISO_ORIGINAL_SVG,
} = require("./proposal-constants");

// ───────────────────────────────────────────────────────────────────────────
// Helpers de formato
// ───────────────────────────────────────────────────────────────────────────

function escapeHtml(unsafe) {
  return String(unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatUF(value) {
  return Number(value || 0).toFixed(3);
}

function formatCLP(value) {
  return "$" + Math.round(Number(value || 0)).toLocaleString("es-CL");
}

function formatFechaLarga(date = new Date()) {
  return date.toLocaleDateString("es-CL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Adaptador Vicky → formato del builder cliente
// ───────────────────────────────────────────────────────────────────────────

/**
 * Convierte la estructura `cotizacion.items` (Vicky) al formato esperado
 * por el builder original (servicios / equipos / accesorios / serviciosAsoc).
 *
 * Vicky envía items con `tipo: "modulo" | "hardware" | "servicio"`. El
 * builder espera 4 listas separadas con campos algo distintos.
 *
 * Mapeo:
 *   tipo "modulo"   → servicios (suscripción mensual)
 *   tipo "hardware" → equipos   (arriendo recurrente o venta no recurrente)
 *   tipo "servicio" → serviciosAsoc (instalación, no recurrente)
 */
function adaptarItemsVicky(items) {
  const servicios = [];
  const equipos = [];
  const accesorios = []; // Vicky no genera accesorios separados hoy
  const serviciosAsoc = [];

  for (const it of items || []) {
    if (it.tipo === "modulo") {
      servicios.push({
        nombre: String(it.nombre || ""),
        cantidad: Number(it.cantidad || 1),
        tipo: it.modalidad === "Fijo" ? "Fijo" : "Por usuario",
        precioUnit: Number(it.precioUnitarioUF || 0),
        descuento: 0,
        subtotalUF: Number(it.subtotalUF || 0),
        rango: it.tierAplicado || "",
      });
    } else if (it.tipo === "hardware") {
      const modalidad = String(it.modalidad || "").toLowerCase();
      const tipo = modalidad.startsWith("venta") ? "Venta" : "Arriendo";
      equipos.push({
        nombre: String(it.nombre || ""),
        cantidad: Number(it.cantidad || 1),
        tipo,
        precioUnit: Number(it.precioUnitarioUF || 0),
        subtotalUF: Number(it.subtotalUF || 0),
      });
    } else if (it.tipo === "servicio") {
      // El nombre suele venir como "Instalación reloj (Comuna)" — extraemos
      // la zona entre paréntesis si existe.
      const nombreRaw = String(it.nombre || "");
      const zonaMatch = nombreRaw.match(/\(([^)]+)\)\s*$/);
      const zona = zonaMatch ? zonaMatch[1] : "";
      const nombre = zonaMatch ? nombreRaw.replace(/\s*\([^)]+\)\s*$/, "") : nombreRaw;
      serviciosAsoc.push({
        nombre,
        cantidad: Number(it.cantidad || 1),
        zona,
        precioUnit: Number(it.precioUnitarioUF || 0),
        subtotalUF: Number(it.subtotalUF || 0),
      });
    }
  }

  return { servicios, equipos, accesorios, serviciosAsoc };
}

// ───────────────────────────────────────────────────────────────────────────
// CSS (idéntico al del cliente, embebido en cada PDF)
// ───────────────────────────────────────────────────────────────────────────

const PP_CSS = `
.pp *{margin:0;padding:0;box-sizing:border-box}
.pp{font-family:'Nunito',sans-serif;color:#646464;font-size:13px;line-height:1.5}
.pp-page{width:816px;height:1056px;position:relative;overflow:hidden;background:#fff}
.pp .cover-hdr{background:#00AFF2;color:#fff;padding:48px 60px 38px}
.pp .cv-br{display:block;line-height:1}.pp .cv-br b{color:#FFBB00}
.pp .cv-tg{font-size:13px;opacity:.8;margin-top:4px}
.pp .cv-tl{font-size:38px;font-weight:700;margin-top:30px;font-family:'BRSonoma','Nunito',sans-serif}
.pp .cv-st{font-size:22px;font-weight:700;color:#FFBB00;margin-top:6px;font-family:'BRSonoma','Nunito',sans-serif}
.pp .ys{height:6px;background:#FFBB00}
.pp .info{display:grid;grid-template-columns:1fr 1fr;padding:16px 40px}
.pp .info-i{padding:8px 0}.pp .info-l{font-size:10px;font-weight:700;color:#00AFF2;text-transform:uppercase;letter-spacing:1px}
.pp .info-v{font-size:15px;font-weight:700;margin-top:2px}
.pp .pc{padding:0 40px 50px}
.pp .sh{font-size:18px;font-weight:700;color:#fff;padding:8px 14px;margin:14px 0 8px;background:#00AFF2;border-left:5px solid #FFBB00;font-family:'BRSonoma','Nunito',sans-serif}
.pp .it{font-size:12px;color:rgba(100,100,100,0.8);line-height:1.6;margin-bottom:8px}
.pp .bf-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0 0}
.pp .bf-item{background:rgba(0,175,242,0.2);border-radius:6px;padding:8px 12px;border-left:4px solid #00AFF2}
.pp .bf-t{font-size:12px;font-weight:700;color:#00AFF2;margin-bottom:2px}
.pp .bf-d{font-size:11px;color:rgba(100,100,100,0.8);line-height:1.4}
.pp .alc{background:rgba(100,100,100,0.06);border:1px solid rgba(100,100,100,0.2);border-radius:6px;padding:14px 18px}
.pp .alc>p{font-size:12px;color:#646464;margin-bottom:10px}
.pp .alc ul{list-style:none;padding:0;margin:0}
.pp .alc li{font-size:12px;color:rgba(100,100,100,0.8);padding:3px 0 3px 16px;position:relative}
.pp .alc li:before{content:'';position:absolute;left:0;top:9px;width:5px;height:5px;background:rgba(100,100,100,0.6);border-radius:50%}
.pp .alc-cols{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;margin-top:6px}
.pp .alc-col{border-right:1px solid rgba(100,100,100,0.2);padding-right:20px}
.pp .alc-col:last-child{border-right:none;padding-right:0;padding-left:4px}
.pp .alc-col ul{margin:0}
.pp .alc-label{font-size:12px;font-weight:800;color:#646464;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.pp .alc-tots{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(100,100,100,0.2)}
.pp .alc-tot{font-size:13px;font-weight:700;color:#646464}
.pp .alc-tot .pr{color:#00AFF2}.pp .alc-tot .rf{color:rgba(100,100,100,0.6);font-size:11px;font-weight:400}
.pp .sb{margin-top:14px;border-radius:8px;overflow:hidden;box-shadow:0 1px 8px rgba(0,175,242,0.2)}
.pp .sb table{font-size:12px;margin:0}
.pp .sb td{padding:9px 14px;border-bottom:1px solid rgba(100,100,100,0.2)}
.pp .sb .tr-sub td{background:rgba(100,100,100,0.06);font-weight:700;border-bottom:1px solid rgba(100,100,100,0.2)}
.pp .sb .tr-iva td{background:#fff}
.pp .sb .tr-tot{background:#00AFF2}.pp .sb .tr-tot td{color:#fff;border-bottom:none;font-weight:700;font-size:14px}
.pp .qa-cta{margin-top:12px;background:#EDF6FF;border:1px solid #B8D8F4;border-radius:14px;padding:20px 22px}
.pp .qa-cta-text{font-size:11.5px;line-height:1.45;color:#315A8A;text-align:center;margin:0 0 14px}
.pp .qa-cta-action{display:flex;justify-content:center}
.pp .qa-cta-btn{display:inline-block;background:#00AFF2;color:#fff;text-decoration:none;font-size:12px;font-weight:700;padding:10px 34px;border:1px solid #009EDC;border-radius:18px;box-shadow:0 2px 0 rgba(0,0,0,0.1)}
.pp table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px}
.pp th{background:rgba(0,175,242,0.2);color:#00AFF2;font-weight:700;padding:6px 7px;text-align:center;font-size:9px;text-transform:uppercase;letter-spacing:.3px;border-bottom:2px solid rgba(0,175,242,0.4)}
.pp td{padding:5px 7px;text-align:center;border-bottom:1px solid rgba(100,100,100,0.2);font-size:10.5px}
.pp td:first-child{text-align:left;font-weight:600}
.pp tr:nth-child(even) td{background:transparent}
.pp .str{background:rgba(100,100,100,0.06)}.pp .str td{border-bottom:none;font-weight:700;background:transparent;color:#646464}
.pp .rng{font-size:9px;color:rgba(100,100,100,0.6);font-weight:400;font-style:italic}
.pp .ufn{font-size:9px;color:rgba(100,100,100,0.6);font-style:italic;margin-top:4px}
.pp .phb{display:flex;justify-content:space-between;align-items:center;padding:20px 40px;background:rgba(100,100,100,0.06);border-bottom:3px solid #FFBB00}
.pp .ph-br{display:block;flex-shrink:0;line-height:1}.pp .ph-br b{color:#FFBB00}
.pp .ph-r{font-size:10px;color:rgba(100,100,100,0.6)}
.pp .tyc{padding-left:18px}.pp .tyc li{font-size:11px;color:rgba(100,100,100,0.8);line-height:1.5;margin-bottom:3px}
.pp .tyc li::marker{color:#00AFF2;font-weight:700}
.pp .ft th{background:rgba(255,187,0,0.2);color:#646464;border-bottom:2px solid #FFBB00}.pp .ft td:first-child{color:#00AFF2;font-weight:700}
.pp .vn{background:rgba(255,187,0,0.2);border-left:4px solid #FFBB00;padding:10px 14px;font-size:11.5px;color:rgba(100,100,100,0.8);margin-top:14px;border-radius:0 6px 6px 0}
.pp .sig{margin-top:20px;padding:20px;border-top:2px solid rgba(100,100,100,0.2);display:flex;align-items:center;gap:16px}
.pp .sig-icon{flex-shrink:0}
.pp .sig-info{display:flex;flex-direction:column;gap:1px}
.pp .sig-n{font-size:14px;font-weight:700;color:#646464}
.pp .sig-c{font-size:12px;color:rgba(100,100,100,0.8)}
.pp .sig-co{font-size:12px;color:rgba(100,100,100,0.8)}
.pp .sig-div{width:1px;background:rgba(100,100,100,0.2);align-self:stretch;margin:0 4px}
.pp .sig-contact{display:flex;flex-direction:column;gap:1px}
.pp .sig-cx{font-size:12px;font-weight:700;color:#00AFF2}
.pp .pn{position:absolute;bottom:12px;right:40px;font-size:10px;color:rgba(100,100,100,0.4)}
@page{size:Letter;margin:0}
body,html{margin:0;padding:0;background:#fff}
`;

// ───────────────────────────────────────────────────────────────────────────
// Builder principal
// ───────────────────────────────────────────────────────────────────────────

function buildProposalHtml({ cliente, cotizacion, acceptanceUrl, cotizacionId }) {
  const empresa = escapeHtml(cliente.empresa || "EMPRESA");
  const contacto = escapeHtml(cliente.contacto || "");
  const email = escapeHtml(cliente.contactoEmail || "");
  const telefono = escapeHtml(cliente.contactoTelefono || "");
  const ejecutivo = escapeHtml(cliente.ejecutivo || "Eddyluz Mujica");
  const cargo = escapeHtml(cliente.cargo || "Ejecutiva Comercial");

  const hoy = new Date();
  const fecha = formatFechaLarga(hoy);
  const ufDate = fecha;

  // Adaptar items de Vicky al formato del builder
  const { servicios, equipos, accesorios, serviciosAsoc } = adaptarItemsVicky(cotizacion.items || []);

  // totalServ = subtotal de servicios mensuales (sin hardware ni instalación)
  const totalServ = servicios.reduce((s, x) => s + Number(x.subtotalUF || 0), 0);

  const totals = {
    totalServ,
    subtotalNeto: Number(cotizacion.subtotalUF || 0),
    iva: Number(cotizacion.ivaUF || 0),
    totalConIva: Number(cotizacion.totalUF || 0),
  };

  const ufValue = Number(cotizacion.ufActual || 0);

  // ── Pre-cálculos espejo del cliente ──
  let totalRec = totals.totalServ;
  let totalNR = 0;
  equipos.forEach(e => {
    if (e.tipo === "Arriendo") totalRec += e.subtotalUF;
    else totalNR += e.subtotalUF;
  });
  accesorios.forEach(a => {
    if (a.tipo === "Arriendo") totalRec += a.subtotalUF;
    else totalNR += a.subtotalUF;
  });
  serviciosAsoc.forEach(s => { totalNR += s.subtotalUF; });

  // ── PAGE 1: Intro + Beneficios ──
  let introHTML = "";
  PROPOSAL_INTRO.forEach(p => { introHTML += '<p class="it">' + escapeHtml(p) + "</p>"; });
  let benefHTML = "";
  PROPOSAL_BENEFICIOS.forEach(b => {
    benefHTML += '<div class="bf-item"><div class="bf-t">' + escapeHtml(b.titulo) + '</div><div class="bf-d">' + escapeHtml(b.desc) + "</div></div>";
  });

  // ── PAGE 2: Summary items ──
  let sumRecItems = "";
  let sumNRItems = "";
  servicios.forEach(s => {
    sumRecItems += "<li>" + escapeHtml(s.nombre) + " (" + s.cantidad + " usuarios)</li>";
  });
  equipos.forEach(e => {
    if (e.tipo === "Arriendo") {
      sumRecItems += "<li>" + e.cantidad + "x " + escapeHtml(e.nombre) + "</li>";
    } else {
      sumNRItems += "<li>" + e.cantidad + "x " + escapeHtml(e.nombre) + " (Venta)</li>";
    }
  });
  accesorios.forEach(a => {
    if (a.tipo === "Arriendo") {
      sumRecItems += "<li>" + a.cantidad + "x " + escapeHtml(a.nombre) + "</li>";
    } else {
      sumNRItems += "<li>" + a.cantidad + "x " + escapeHtml(a.nombre) + " (Venta)</li>";
    }
  });
  serviciosAsoc.forEach(s => {
    sumNRItems += "<li>" + s.cantidad + "x " + escapeHtml(s.nombre) + (s.zona ? " (" + escapeHtml(s.zona) + ")" : "") + "</li>";
  });

  // ── Tabla de Pricing Tiers ──
  let tiersRows = "";
  PRICING_TIERS.forEach(t => {
    const rango = t.max === Infinity ? t.min + "+" : t.min + " - " + t.max;
    const precio = t.type === "fijo" ? formatUF(t.uf) + " UF (Fijo)" : formatUF(t.uf) + " UF/usuario";
    tiersRows += "<tr><td>" + rango + "</td><td>" + precio + "</td></tr>";
  });

  // ── PAGE 3: Detalle plano ──
  let detailRows = "";
  servicios.forEach(s => {
    const precio = s.tipo === "Fijo" ? "Fijo: " + formatUF(s.precioUnit) + " UF" : formatUF(s.precioUnit) + " UF/u";
    const rng = s.rango ? '<br><span class="rng">Rango aplicado: ' + escapeHtml(s.rango) + "</span>" : "";
    detailRows += "<tr><td>" + escapeHtml(s.nombre) + rng + "</td><td>Servicio</td><td>Mensual</td><td>" + s.cantidad + "</td><td>" + precio + "</td><td>" + (s.descuento > 0 ? s.descuento + "%" : "-") + "</td><td>" + formatUF(s.subtotalUF) + "</td><td>" + (ufValue > 0 ? formatCLP(s.subtotalUF * ufValue) : "-") + "</td></tr>";
  });
  equipos.forEach(e => {
    detailRows += "<tr><td>" + escapeHtml(e.nombre) + "</td><td>Equipo</td><td>" + e.tipo + "</td><td>" + e.cantidad + "</td><td>" + formatUF(e.precioUnit) + " UF</td><td>-</td><td>" + formatUF(e.subtotalUF) + "</td><td>" + (ufValue > 0 ? formatCLP(e.subtotalUF * ufValue) : "-") + "</td></tr>";
  });
  accesorios.forEach(a => {
    detailRows += "<tr><td>" + escapeHtml(a.nombre) + "</td><td>Accesorio</td><td>" + a.tipo + "</td><td>" + a.cantidad + "</td><td>" + formatUF(a.precioUnit) + " UF</td><td>-</td><td>" + formatUF(a.subtotalUF) + "</td><td>" + (ufValue > 0 ? formatCLP(a.subtotalUF * ufValue) : "-") + "</td></tr>";
  });
  serviciosAsoc.forEach(s => {
    detailRows += "<tr><td>" + escapeHtml(s.nombre) + (s.zona ? " (" + escapeHtml(s.zona) + ")" : "") + "</td><td>Serv. Asoc.</td><td>-</td><td>" + s.cantidad + "</td><td>" + formatUF(s.precioUnit) + " UF</td><td>-</td><td>" + formatUF(s.subtotalUF) + "</td><td>" + (ufValue > 0 ? formatCLP(s.subtotalUF * ufValue) : "-") + "</td></tr>";
  });

  // ── PAGE 4: T&C + Firma ──
  let tycItems = "";
  PROPOSAL_TYC.forEach(item => { tycItems += "<li>" + escapeHtml(item) + "</li>"; });
  let freeRows = "";
  SERVICIOS_GRATIS.forEach(s => {
    freeRows += "<tr><td>" + escapeHtml(s.servicio) + '</td><td style="text-align:left">' + escapeHtml(s.desc) + "</td></tr>";
  });

  const ufNote = ufValue > 0
    ? '<p class="ufn">* Valores referenciales en CLP calculados con UF del ' + escapeHtml(ufDate) + ": " + formatCLP(ufValue) + ". El cobro se realiza en UF.</p>"
    : "";

  // ── Render HTML completo (4 páginas) ──
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Propuesta Comercial — ${empresa}</title>
<style>${PP_CSS}</style>
</head>
<body>
<div class="pp">
  <!-- PAGE 1: Cover + About GeoVictoria -->
  <div class="pp-page">
    <div class="cover-hdr">
      <div class="cv-br">${LOGO_BLANCO_SVG}</div>
      <div class="cv-tg">Control de Asistencia &amp; Gestión de Personal</div>
      <div class="cv-tl">Propuesta Comercial</div>
      <div class="cv-st">${empresa}</div>
    </div>
    <div class="ys"></div>
    <div class="info">
      <div class="info-i"><div class="info-l">Fecha</div><div class="info-v">${escapeHtml(fecha)}</div></div>
      <div class="info-i"><div class="info-l">Ejecutivo Comercial</div><div class="info-v">${ejecutivo}</div></div>
      <div class="info-i"><div class="info-l">Empresa</div><div class="info-v">${empresa}</div></div>
      <div class="info-i"><div class="info-l">Email</div><div class="info-v">${email || "-"}</div></div>
      <div class="info-i"><div class="info-l">Contacto</div><div class="info-v">${contacto || "-"}</div></div>
      <div class="info-i"><div class="info-l">Teléfono</div><div class="info-v">${telefono || "-"}</div></div>
    </div>
    <div class="pc">
      <div class="sh">Acerca de GeoVictoria</div>
      ${introHTML}
      <div class="sh">¿Por qué GeoVictoria?</div>
      <div class="bf-grid">${benefHTML}</div>
    </div>
    <div class="pn">1</div>
  </div>

  <!-- PAGE 2: Summary + Totals -->
  <div class="pp-page">
    <div class="phb">
      <div class="ph-br">${LOGO_ORIGINAL_SVG}</div>
      <div class="ph-r">Propuesta Comercial — ${empresa}</div>
    </div>
    <div class="pc" style="padding-top:6px">
      <div class="sh">Resumen de la Propuesta</div>
      <div class="alc">
        <p>Propuesta para <strong>${empresa}</strong>:</p>
        <div class="alc-cols">
          <div class="alc-col"><div class="alc-label">Recurrente Mensual</div><ul>${sumRecItems}</ul></div>
          ${sumNRItems ? '<div class="alc-col"><div class="alc-label">No Recurrente</div><ul>' + sumNRItems + "</ul></div>" : ""}
        </div>
        <div class="alc-tots">
          <div class="alc-tot">Recurrente Mensual: <span class="pr">${formatUF(totalRec)} UF</span>${ufValue > 0 ? ' <span class="rf">(' + formatCLP(totalRec * ufValue) + ")</span>" : ""}</div>
          ${totalNR > 0 ? '<div class="alc-tot">No Recurrente: <span class="pr">' + formatUF(totalNR) + " UF</span>" + (ufValue > 0 ? ' <span class="rf">(' + formatCLP(totalNR * ufValue) + ")</span>" : "") + "</div>" : ""}
        </div>
      </div>
      <div class="sb">
        <table>
          <tr class="tr-sub"><td style="text-align:left">Subtotal (sin IVA)</td><td>${formatUF(totals.subtotalNeto)} UF</td><td>${ufValue > 0 ? formatCLP(totals.subtotalNeto * ufValue) + " CLP" : "-"}</td></tr>
          <tr><td style="text-align:left">IVA (19%)</td><td>${formatUF(totals.iva)} UF</td><td>${ufValue > 0 ? formatCLP(totals.iva * ufValue) + " CLP" : "-"}</td></tr>
          <tr class="tr-tot"><td style="text-align:left">Total con IVA</td><td>${formatUF(totals.totalConIva)} UF</td><td>${ufValue > 0 ? formatCLP(totals.totalConIva * ufValue) + " CLP" : "-"}</td></tr>
        </table>
      </div>
      ${ufNote}
      <div class="qa-cta">
        <p class="qa-cta-text">Para continuar con tu implementación, confirma esta propuesta en línea.<br>Te tomará menos de 2 minutos y validaremos tu identidad con un código a tu correo de contacto.</p>
        <div class="qa-cta-action"><a class="qa-cta-btn" href="${escapeHtml(acceptanceUrl || "https://cotizacion.geovictoria.com/quote-acceptance.html")}" target="_blank" rel="noopener">Revisar y aceptar cotización</a></div>
      </div>
    </div>
    <div class="pn">2</div>
  </div>

  <!-- PAGE 3: Detalle de costos -->
  <div class="pp-page">
    <div class="phb">
      <div class="ph-br">${LOGO_ORIGINAL_SVG}</div>
      <div class="ph-r">Propuesta Comercial — ${empresa}</div>
    </div>
    <div class="pc" style="padding-top:6px">
      <div class="sh">Detalle de Costos</div>
      <table>
        <thead>
          <tr><th>Ítem</th><th>Tipo</th><th>Modalidad</th><th>Cant.</th><th>Precio Unit.</th><th>Dcto.</th><th>Subtotal (UF)</th><th>Ref. CLP</th></tr>
        </thead>
        <tbody>
          ${detailRows}
          <tr class="str" style="border-top:2px solid rgba(100,100,100,0.4)"><td colspan="6"><strong>Subtotal (sin IVA)</strong></td><td><strong>${formatUF(totals.subtotalNeto)}</strong></td><td><strong>${ufValue > 0 ? formatCLP(totals.subtotalNeto * ufValue) : "-"}</strong></td></tr>
          <tr class="str"><td colspan="6"><strong>IVA (19%)</strong></td><td><strong>${formatUF(totals.iva)}</strong></td><td><strong>${ufValue > 0 ? formatCLP(totals.iva * ufValue) : "-"}</strong></td></tr>
          <tr style="background:#00AFF2"><td colspan="6" style="color:#fff;font-weight:700;font-size:12px;border-bottom:none">Total con IVA</td><td style="color:#fff;font-weight:700;font-size:12px;border-bottom:none">${formatUF(totals.totalConIva)}</td><td style="color:#fff;font-weight:700;font-size:12px;border-bottom:none">${ufValue > 0 ? formatCLP(totals.totalConIva * ufValue) : "-"}</td></tr>
        </tbody>
      </table>
      ${ufNote}
      <div class="sh" style="margin-top:16px">Tabla de Precios — Asistencia</div>
      <table>
        <thead><tr><th>Rango de Usuarios</th><th>Precio Mensual</th></tr></thead>
        <tbody>${tiersRows}</tbody>
      </table>
    </div>
    <div class="pn">3</div>
  </div>

  <!-- PAGE 4: T&C + Firma -->
  <div class="pp-page">
    <div class="phb">
      <div class="ph-br">${LOGO_ORIGINAL_SVG}</div>
      <div class="ph-r">Propuesta Comercial — ${empresa}</div>
    </div>
    <div class="pc" style="padding-top:6px">
      <div class="sh">Términos y Condiciones</div>
      <ol class="tyc">${tycItems}</ol>
      <div class="sh">Servicios Adicionales Sin Costo</div>
      <table class="ft">
        <thead><tr><th>Servicio Incluido</th><th style="text-align:left">Descripción</th></tr></thead>
        <tbody>${freeRows}</tbody>
      </table>
      <div class="vn"><strong>Vigencia:</strong> Esta propuesta tiene una validez de 30 días a partir de la fecha de emisión (${escapeHtml(fecha)}). Posterior a este período, los valores podrán ser actualizados.</div>
      <div class="sig">
        <div class="sig-icon">${ISO_ORIGINAL_SVG}</div>
        <div class="sig-info">
          <p class="sig-n">${ejecutivo}</p>
          <p class="sig-c">${cargo}</p>
          <p class="sig-co">GeoVictoria | Chile</p>
        </div>
        <div class="sig-div"></div>
        <div class="sig-contact">
          ${email ? '<p class="sig-cx">' + email + "</p>" : ""}
          ${telefono ? '<p class="sig-cx">' + telefono + "</p>" : ""}
          <p class="sig-cx">www.geovictoria.com</p>
        </div>
      </div>
    </div>
    <div class="pn">4</div>
  </div>
</div>
</body>
</html>`;
}

module.exports = { buildProposalHtml };

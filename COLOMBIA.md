# Cotizador Colombia — diseño y estado (10-jul-2026)

Plan de implementación del flujo de cotización formal CO. Las decisiones de
negocio están CERRADAS (Lalo + evidencia de 15 cotizaciones reales de Creator
CO + planilla de tropicalización); lo que sigue es ejecución.

## Decisiones de negocio (NO reabrir)

- **Precios (COP, lista canónica de Vicky):** plan 1-10 = $315.000 fijo ·
  11-50 = $13.700/usuario. Reloj: arriendo $86.000/mes · venta $620.000.
  Envío venta $42.000 capital / $69.000 resto (arriendo $0). Instalación
  venta $67.000 / $92.000 (arriendo $0; $0 si auto-instala). "Capital" =
  capital de departamento (clasificador en el agente: lib/paises/co/geografia).
- **IMPUESTOS (10-jul, refinado el mismo día):** precios FINALES en todo
  EXCEPTO el hardware — el reloj (arriendo y venta) lleva IVA 19%, marcado
  por línea (`Afecto_IVA`/`afectoIva` true solo en reloj) y desglosado en
  chat, cotización, PDF y cobro. Plan, activación, envío e instalación van
  con precio final. Retenciones y artículos tributarios no se mencionan
  jamás.
- **Activación** = 1 mes del plan cobrado por adelantado, concepto de pago
  único. Es el "pago inicial" CO. NO existe el esquema mes-2-con-30%-dcto.
- **Capacitación:** $95.000 con 100% dcto (tachada), como Chile.
- **Sin descuentos en CO v1** (escalera 10→20% pendiente de confirmación).
- **Sin suscripciones MP**: checkout = pago único (activación + one-offs).
  Mensualidad por facturación (30 días, como opera CO).
- **Entidad del PDF:** Geovictoria Colombia SAS · NIT 901.367.959-1 ·
  Carrera 14 # 89-48 Of. 201, Edificio Novanta, Bogotá. Ejecutiva: Laura
  Vargas (lvargash@geovictoria.com, +57 310 609 5259 — correo por confirmar).
- **Vigencia 30 días. Registro de usted en todo texto al cliente.**

## Infraestructura YA lista

- **MP Colombia:** app Checkout Pro creada (cuenta GEOVICTORIA COLOMBIA SAS,
  site MCO). Envs en Vercel: `MP_ACCESS_TOKEN_CO`, `MP_PUBLIC_KEY_CO`,
  `MP_WEBHOOK_SECRET_CO`. ⚠️ Rotar el access token antes del go-live de
  cobros reales (quedó expuesto en chat) y revocar el token de Vercel usado.
- **Webhook multi-país:** `api/payments/webhook.js` valida la firma CL y, si
  no calza, la CO (`getMercadoPagoConfigCO` en `_shared/mercadopago-config`);
  la app que firma define las credenciales. Simulación esperada: 200.
- **Agente (repo geovictoria-whatsapp-agent, rama vicky-v3):** Vicky CO viva
  en `/api/vic-botmaker-co` (línea +57 318 107 0737, flag `VICKY_CO_ENABLED`),
  pipeline asíncrono endurecido, motor de precios `lib/paises/co/cotizar.ts`
  (testeado), perfil `lib/paises/co/`. Hoy al aceptar deriva a ejecutivo
  (tools.ts: `derivar_a_ejecutivo`); cuando este cotizador CO exista, se le
  agrega la tool `generar_link_cotizadora` CO.

## Pasos de implementación (en orden)

1. **`api/quote-acceptance/create-from-vicky-co.js`** — endpoint espejo
   simplificado del chileno (auth x-vicky-secret): recibe
   `{empresa, contacto, contactoEmail, nit, contactoTelefono, items[]}` con
   los items YA calculados por el motor CO del agente (misma confianza que
   Chile). Crea en Zoho: Account (dedup por NIT en RUT_Empresa), Contact,
   Deal (Territorio Colombia) y Cotización con subform: los campos
   `Precio_Unitario_UF/Subtotal_UF` guardan el valor en COP (convención
   "unidad de pricing del país") y `*_CLP` el MISMO valor COP; fila extra
   de Activación; `Moneda`/nota COP. SIN convert de leads en v1 (leads CO
   los crea derivar_a_ejecutivo; enlazar si viene leadId es fase 2).
2. **`api/_shared/proposal-html-builder-co.js`** — PDF colombiano: mismo
   layout que Chile pero encabezado Geovictoria Colombia SAS/NIT, montos en
   COP sin columna UF ni "UF del día", montos finales (precios finales
   10-jul: sin columna, notas ni menciones de IVA), bloque "Pago inicial" =
   activación (+equipos si hay), "Mensualidad desde el mes siguiente",
   capacitación tachada
   ($95.000, 100% dcto), T&C CO (sin DT, sin UF; permanencia: aviso 30 días;
   soporte L-V 8:30-18:30; Azure 99,5%), vigencia 30 días, ejecutiva Laura.
3. **Aceptación online country-aware:** `session.js` agrega `pais` (desde
   Territorio del quote o campo nuevo) y totales CO (montos finales);
   `quote-acceptance.html` oculta columnas UF y muestra COP cuando
   `pais==='co'` (mínimo cambio: flag en el payload de sesión).
4. **Pago CO:** `payment-session.js`/`create-preference.js` usan
   `getMercadoPagoConfigCO` cuando la cotización es CO (currency COP, monto
   = pago inicial CO). `post-payment-finalize` calcula paymentsComplete con
   el one-shot CO (sin suscripción). Transferencia CO: mostrar datos
   bancarios CO (PENDIENTE: pedir cuenta bancaria CO a Lalo) o solo tarjeta
   en v1.
5. **Agente:** tool `generar_link_cotizadora` CO en `lib/paises/co/tools.ts`
   que llama a create-from-vicky-co con los items de cotizarCO + NIT
   validado; prompt CO: reemplazar el paso 7 (derivar) por generar link,
   manteniendo derivar como fallback.
6. **E2E:** cotización de prueba CO → aceptación → pago con tarjeta de
   prueba MP CO (panel: Tarjetas de prueba) → webhook → finalize. Limpiar
   registros de prueba al terminar.

## Paridad de capacidades con Vicky Chile (10-jul)

Directiva de Lalo: Vicky CO debe tener las mismas capacidades que Vicky CL.
Estado (repo agente, rama vicky-v3):

- ✅ Cotización referencial, cotización formal online (link + pago), derivar
  a ejecutivo (lead CO por tómbola determinista).
- ✅ Soporte operativo con el agente Foundry (mismo de Chile; escalamiento
  con canales CO — pendiente confirmar WhatsApp/teléfono de soporte CO).
- ✅ Opt-out / pérdida declarada (marcar_no_contactar) con cierre de ciclo.
- ✅ Seguimiento consensuado (programar_seguimiento, zona America/Bogota).
  NOTA: el TOQUE único consensuado CO no se envía aún (requiere HSM CO);
  la cadencia automática sí se apaga.
- ✅ Re-engagement 1h/23h (texto libre, ventana 24h): nudges en usted por el
  canal CO (vic-followup-cron country-aware).
- ⛔ Reactivación 47h/7d/15d: EXCLUIDA para CO hasta tener HSM CO aprobadas
  (el cron filtra country='co' — jamás enviará plantillas chilenas).
- ⏳ Agendar reuniones (Cal.com): requiere crear el event type del equipo CO
  en Cal.com (calendario de Laura / round robin CO) — pedir a Lalo.
- ⏳ Descuentos: sin escalera CO por decisión de negocio v1 (las 3 tools de
  descuento chilenas se agregan cuando exista la escalera CO).
- ⏳ enviar_certificacion: el certificado es de la Dirección del Trabajo
  (Chile); definir con el equipo CO si existe documento equivalente.

## Fase 2 — Backlog CO (detectado en pruebas E2E, 10-jul)

- **Catálogos de facturación por país** (detectado por Lalo en la prueba de
  aceptación): los combobox de "Actividad económica" y "Ciudad/Municipio" de
  quote-acceptance.html sirven los datos CHILENOS (giros SII + comunas) para
  todos los países. Para CO deben ser actividades CIIU (DIAN) y
  ciudades/municipios de Colombia (la planilla de tropicalización ya lo
  anticipaba: "Giro/actividad: CIIU – DIAN · archivo giros.json del
  cotizador"). Mientras tanto son texto libre, no bloquea.
- **URLs por país (/co, /mx, /pe)**: vanity path por país vía rewrites de
  Vercel — percepción local + analítica por país + puede servir para cargar
  el bundle de datos de facturación correcto (catálogos de arriba) sin
  esperar al token. Aditivo (las URLs actuales siguen funcionando).
- **Conversaciones por (teléfono, país)**: hoy la conversación es única por
  teléfono; un mismo número que habla con la línea CL y la CO comparte hilo
  (contaminación de contexto). Migración: unique index (contact, country) +
  fetchHistory/getOrCreate country-aware. Prioridad alta antes del go-live CO.
- **Rescate/regeneración de PDF CO** (backfill-pdf hoy salta las CO a propósito).
- **Datos bancarios CO** para transferencia en la página de pago.
- **Cuenta de prueba CO canónica única** (la desambiguación creó dos; dejar
  una con NIT 901.234.567-7 al limpiar registros de prueba).

## Pendientes de negocio (no bloquean 1-2)

- Cuenta bancaria CO para transferencias (página de pago).
- Confirmar correo Laura (lvargas@ vs lvargash@).
- Escalera de descuentos CO → habilita negociación (fase 2).
- HSM CO en Botmaker → outbound CO (fase 2, textos ya entregados).
- Crons (followup/reactivación/cadencia) country-aware antes del outbound CO.

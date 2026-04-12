# Cotizador GeoVictoria (Replica 1:1)

Replica estatica de la calculadora publicada en:
`https://geovictoria-cotizador.netlify.app/`

## Alcance de la replica
- Misma UI y comportamiento funcional (login, calculos UF, descuentos, equipos/accesorios/servicios, PDF).
- Misma integracion activa detectada: consulta UF desde `https://mindicador.cl/api/uf`.
- Sin integraciones backend/CRM embebidas (la version original tampoco las incluye en su codigo cliente).
- Soporte de prefill opcional por URL para uso CRM:
  - `?prefill=<base64url-json>`
  - Campos soportados: `empresa`, `contacto`, `ejecutivo`, `userCount`.

## Widget Zoho CRM (Blueprint)
- Código base en:
  - `zoho-widget/blueprint-cotizador/index.html`
  - `zoho-widget/blueprint-cotizador/widget.js`
- Objetivo: abrir la cotizadora desde transición de Blueprint con datos del Deal/Account prellenados.

## Ejecutar local
Abrir `index.html` o usar un servidor estatico.

## Deploy
Compatible con Vercel como proyecto estatico.

## Flujo de trabajo oficial (igual a otras apps)
1. Probar cambios en local.
2. Commit y push a `main` en GitHub (`lalorirorero/cotizador_geovictoria`).
3. Vercel despliega automaticamente desde GitHub.

### Regla operativa
- No usar deploy productivo directo desde carpeta local.
- Produccion se actualiza solo por cambios versionados en GitHub.

## Integración Widget Blueprint + creación de cotización

### Condición estricta de éxito (Blueprint)
- La transición se considera válida solo si:
1. Se crea registro en `Cotizaciones_GeoVictoria`.
2. El campo `PDF_URL` queda con valor no vacío.

### API names configurados
- Módulo cotizaciones: `Cotizaciones_GeoVictoria`
- Lookup Deal: `Deal_Asociado`
- File Upload PDF: `PDF_Archivo`
- URL PDF: `PDF_URL`
- Estado: `Estado_Cotizacion`
- Fecha cotización: `Fecha_Cotizacion`
- Subform: `Detalle_Items_Cotizacion`
- Campos subform: `Nombre_Item`, `Cantidad`, `Precio_Unitario_UF`, `Precio_Unitario_CLP`, `Subtotal_CLP`, `Subtotal_UF`, `Modalidad`, `Afecto_IVA`

### Valores de `Modalidad` (sin traducción)
- `Por usuario`
- `Fijo`
- `Arriendo`
- `Venta`

### Endpoint backend de carga PDF
- Ruta: `POST /api/quotes/upload-pdf`
- Uso: sube PDF a Supabase Storage y retorna URL pública para guardar en `PDF_URL`.

### Variables de entorno requeridas (Vercel)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `QUOTES_PDF_BUCKET` (opcional, default `cotizaciones-pdf`)
- `QUOTES_PDF_MAX_BYTES` (opcional, default `12582912`)
- `ALLOWED_UPLOAD_ORIGINS` (opcional, CSV de origins permitidos)

### Integración Zoho CRM (OAuth server-side)
Para dejar conexión estable con renovación automática de token:
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ACCOUNTS_DOMAIN` (ej: `https://accounts.zoho.com`)
- `ZOHO_API_DOMAIN` (ej: `https://www.zohoapis.com`)

Endpoint de validación:
- `GET /api/zoho/token-health`
- Responde `success: true` cuando el token está vigente y hay acceso real a CRM (`/crm/v3/users?type=CurrentUser`).
- `GET /api/zoho/access-check?module=Autoservicio_Onboarding`
  - Endpoint de diagnostico integral (users/modules/fields/records/write-probe).
  - Requiere header `x-diagnostics-secret` con valor de `ZOHO_DIAGNOSTICS_SECRET` (o `CRON_SECRET` como fallback).

## Flujo de aceptacion web de cotizacion (MVP)

### Endpoints nuevos
- `POST /api/quote-acceptance/create-link`
  - input: `{ "quoteId": "<ID_COTIZACION>" }`
  - output: `acceptanceUrl` con token firmado para cliente final.
- `GET /api/quote-acceptance/session?token=...`
  - carga datos de cotizacion + detalle de items para mostrar en web.
- `POST /api/quote-acceptance/send-email-code`
  - input: `{ "token": "..." }`
  - output: `challengeToken` y expiración del código OTP.
- `POST /api/quote-acceptance/verify-email-code`
  - input: `{ "token": "...", "challengeToken": "...", "code": "123456" }`
  - output: `verificationToken` para habilitar confirmación final.
- `POST /api/quote-acceptance/confirm`
  - confirma TyC + datos de facturación + `verificationToken` válido, marca cotización `Aceptada`, y dispara handoff a onboarding.

### Web de aceptacion
- URL base: `/quote-acceptance.html?token=...`
- Esta pantalla:
  - muestra resumen + items + terminos,
  - solicita datos obligatorios de facturacion,
  - usa el correo de facturacion definido en la cotizacion (solo lectura para cliente),
  - exige verificacion por codigo enviado al correo de facturacion,
  - confirma TyC,
  - y redirige a onboarding si handoff devuelve `onboardingUrl`.
  - por defecto usa handoff interno Zoho+Onboarding (si no se define webhook externo).

### Variables de entorno adicionales
- `QUOTE_ACCEPTANCE_SECRET` (obligatoria para firmar/verificar token)
- `QUOTE_ACCEPT_BASE_URL` (opcional, recomendado para links publicos)
- `QUOTE_ACCEPTANCE_VALIDITY_DAYS` (opcional, default `30`)
- `QUOTE_TERMS_VERSION` (opcional, default `TYC-CL-2026-04`)
- `QUOTE_VERIFICATION_SECRET` (opcional; si no existe usa `QUOTE_ACCEPTANCE_SECRET`)
- `QUOTE_VERIFICATION_CODE_TTL_MINUTES` (opcional, default `10`)
- `QUOTE_VERIFICATION_PROOF_TTL_MINUTES` (opcional, default `60`)
- `QUOTE_SUPPORT_CONTACT_LABEL` (opcional, default `Soporte Comercial`)
- `QUOTE_SUPPORT_CONTACT_EMAIL` (opcional, default `egomez@geovictoria.com`)
- `RESEND_API_KEY` y `RESEND_FROM_EMAIL` (opcionales; si están definidos se usa Resend para enviar OTP)
- `ZOHO_VERIFICATION_FROM_EMAIL` y `ZOHO_VERIFICATION_FROM_NAME` (opcionales; override remitente si se envía por Zoho CRM)
- `QUOTE_HANDOFF_WEBHOOK_URL` (opcional; si existe, se invoca al confirmar)
  - si no existe, `confirm` usa handoff interno:
    1. crea/reutiliza `Autoservicio_Onboarding`,
    2. llama `ONBOARDING_GENERATE_LINK_URL`,
    3. guarda link/token en `Autoservicio_Onboarding` y en cotizacion.
- `ONBOARDING_GENERATE_LINK_URL` (opcional; default `https://v0-v0onboardingturnosmvp2main.vercel.app/api/generate-link`)

### Mapeo de campos CRM (customizable por env)
Los siguientes defaults asumen API names ya creados en `Cotizaciones_GeoVictoria`:
- `QUOTE_STATUS_FIELD` => `Estado_Cotizacion`
- `QUOTE_DATE_FIELD` => `Fecha_Cotizacion`
- `QUOTE_DEAL_LOOKUP_FIELD` => `Deal_Asociado`
- `QUOTE_PDF_URL_FIELD` => `PDF_URL`
- `QUOTE_ITEMS_SUBFORM_FIELD` => `Detalle_Items_Cotizacion`
- `QUOTE_ACCEPTANCE_URL_FIELD` => `URL_Aceptacion_Web`
- `QUOTE_ACCEPTED_AT_FIELD` => `Fecha_Aceptacion_Web`
- `QUOTE_TERMS_ACCEPTED_FIELD` => `TyC_Aceptados_Web`
- `QUOTE_TERMS_VERSION_FIELD` => `Version_TyC_Web`
- `QUOTE_EMAIL_VERIFIED_FIELD` => (opcional, ej: `Correo_Verificado_Web`)
- `QUOTE_EMAIL_VERIFIED_AT_FIELD` => (opcional, ej: `Fecha_Verificacion_Correo_Web`)
- `QUOTE_HANDOFF_STATUS_FIELD` => `Estado_Handoff`
- `QUOTE_HANDOFF_ERROR_FIELD` => `Error_Handoff`
- `QUOTE_ONBOARDING_LOOKUP_FIELD` => `Auto_Onboarding_Asociado`
- `QUOTE_ONBOARDING_URL_FIELD` => `Onboarding_Link`
- `QUOTE_ONBOARDING_TOKEN_FIELD` => `Onboarding_Token`
- `QUOTE_ONBOARDING_STATUS_PENDING` => `En Curso`
- `QUOTE_ONBOARDING_STATUS_READY` => `Cerrada`
- `QUOTE_ONBOARDING_STATUS_ERROR` => `Error`
- `QUOTE_BILLING_EMAIL_FIELD` => `Email_Facturacion`
- `QUOTE_BILLING_PHONE_FIELD` => `Telefono_Facturacion`
- `QUOTE_COMPANY_RUT_FIELD` => `RUT_Empresa`
- `QUOTE_COMPANY_GIRO_FIELD` => `Giro`
- `QUOTE_COMPANY_COMUNA_FIELD` => `Comuna`
- `QUOTE_COMPANY_ADDRESS_FIELD` => `Direccion`

Campos de `Autoservicio_Onboarding` usados por handoff interno (default):
- `ONBOARDING_DEAL_LOOKUP_FIELD` => `Deal_asociado`
- `ONBOARDING_EXECUTOR_CONTACT_LOOKUP_FIELD` => `Contacto_Ejecutor` (lookup al contacto del Deal)
- `ONBOARDING_QUOTE_LOOKUP_FIELD` => `Cotizacion_Asociada`
- `ONBOARDING_ORIGIN_ACCEPTANCE_ID_FIELD` => `Origen_Aceptacion_Id`
- `ONBOARDING_CHANNEL_FIELD` => `Canal_Entrega_Link` (`ONBOARDING_CHANNEL_VALUE=redirect_web`)
- `ONBOARDING_HANDOFF_STATUS_FIELD` => `Estado_Handoff`
- `ONBOARDING_HANDOFF_ERROR_FIELD` => `Error_Handoff`
- `ONBOARDING_URL_FIELD` => `URL_de_Onboarding`
- `ONBOARDING_TOKEN_FIELD` => `Token_p_blico`
- `ONBOARDING_TOKEN_ACTIVE_FIELD` => `Token_Activo`
- `ONBOARDING_TOKEN_DATE_FIELD` => `Fecha_generaci_n_token`

### Validación backend en Blueprint (Before Transition)
- Archivo de referencia: `zoho-widget/DELUGE_before_transition_validar_cotizacion.deluge`
- Este control evita bypass de UI y bloquea la transición si no existe cotización válida con `PDF_URL`.

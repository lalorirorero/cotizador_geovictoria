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

### Validación backend en Blueprint (Before Transition)
- Archivo de referencia: `zoho-widget/DELUGE_before_transition_validar_cotizacion.deluge`
- Este control evita bypass de UI y bloquea la transición si no existe cotización válida con `PDF_URL`.

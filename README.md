# Cotizador GeoVictoria (Replica 1:1)

Replica estatica de la calculadora publicada en:
`https://geovictoria-cotizador.netlify.app/`

## Alcance de la replica
- Misma UI y comportamiento funcional (login, calculos UF, descuentos, equipos/accesorios/servicios, PDF).
- Misma integracion activa detectada: consulta UF desde `https://mindicador.cl/api/uf`.
- Sin integraciones backend/CRM embebidas (la version original tampoco las incluye en su codigo cliente).

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

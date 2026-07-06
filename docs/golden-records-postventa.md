# Golden Records — Post-venta (Ticket ST + Solicitud Adm. y Finanzas)

> Contexto guardado a pedido del equipo (jul-2026). Son ejemplos REALES de los 2
> registros que hoy se crean **a mano** cuando un cliente termina el auto-onboarding,
> para servir de referencia ("golden record") cuando automaticemos el post-venta.
>
> Ambos ejemplos fueron creados manualmente por **Telemarketing (Nailliw Riverol)**
> por encargo del ejecutivo **Anderson Díaz** — ese es exactamente el trabajo manual
> que la automatización debería reemplazar cuando el onboarding queda `ready`/completo.

## ⚠️ Mapeo de módulos (la URL engaña)
La URL de Zoho usa el `module_name` interno, que está **cruzado** respecto al nombre:

| URL (tab) | Módulo real (api_name) | Qué es |
|---|---|---|
| `CustomModule41` | **`TicketsST`** | Ticket ST (despacho/instalación de relojes) |
| `CustomModule63` | **`Solicitud_Adm_y_Finanzas`** | Solicitud Adm. y Finanzas (facturación) |

## Links de referencia
**Tickets ST** (`TicketsST`, layout "ST CHILE"):
- Supermercado Sur: https://crm.zoho.com/crm/org685875245/tab/CustomModule41/3525045000637838135
- ELEAM: https://crm.zoho.com/crm/org685875245/tab/CustomModule41/3525045000640664217

**Solicitudes Adm. y Finanzas** (`Solicitud_Adm_y_Finanzas`, layout "Chile"):
- ELEAM: https://crm.zoho.com/crm/org685875245/tab/CustomModule63/3525045000640664193
- Supermercado Sur: https://crm.zoho.com/crm/org685875245/tab/CustomModule63/3525045000637838128

---

## Golden Record 1 — Ticket ST (envío de equipo)
Ejemplo: `TicketsST/3525045000637838135` — "ENVIO DE EQUIPO- SUPERMERCADO SUR SPA".
Creado por Nailliw Riverol (Telemarketing). Campos clave para crear uno:

| Campo (api) | Valor de ejemplo | Nota |
|---|---|---|
| `Name` | `ENVIO DE EQUIPO- SUPERMERCADO SUR SPA` | "ENVIO DE EQUIPO- {empresa}" |
| `Layout` | `ST CHILE` (id 3525045000282855283) | layout obligatorio |
| `Tipo` | `Venta` | |
| `Subcategor_a` | `Asistencia y/o comedor` | |
| `rea_solicitante` | `Telemarketing` | área solicitante |
| `Pick_List_1` | `Envío` | tipo de gestión |
| `Cliente_retira_reloj_en_GeoVictoria` | `Envío a dirección del cliente` | vs. retiro en GV |
| `Cantidad_dispositivos` | `1` | nº de relojes |
| `Cliente/Lookup_1` (Account) | SUPERMERCADO SUR SPA (id ...635991794) | cuenta |
| `Contacto` | Sergio Jimenez Díaz (id ...635807588) | |
| `N_mero_contacto` / `Correo_contacto` | +56926393013 / supersurchilechico@gmail.com | |
| `Direcci_n_env_o_visita` | `Bernardo Ohiggins 394, Chile Chico\tChile Chico\tXI` | dirección tab-separada: calle · comuna · región |
| `Regi_n_inst_visita_env_o` | `["Aysén"]` | |
| `M_todo_env_o` | `Chilexpress` | |
| `ID_Nota_de_venta` | NDV-28907 (id ...638215034) | vincula a la NDV |
| `ID_Sales_order` | `SO-26590` | |
| `PDF_NDV` | (URL blob del PDF de la NDV) | |
| `Ejecutivo_Comercial` | Anderson Diaz (id ...426432190) | |
| `Correo_ejecutivo_a` | adiazg@geovictoria.com | |
| `Reloj_ya_fue_pagado_Solo_Telemarketing` | `Sí` | |
| `Observaciones_factura` | `Facturar arriendo de equipo desde Julio 2026.` | |
| `Descripci_n` | "Favor su ayuda para Envío de equipos a la empresa {empresa} a la dirección: … Adjunto documentos." | |
| `SLA` | `5` | |
| Adjuntos | WhatsApp image + `Planilla equipos asistencia 2025.xlsx` | la planilla de equipos es clave |

## Golden Record 2 — Solicitud Adm. y Finanzas (facturación)
Ejemplo: `Solicitud_Adm_y_Finanzas/3525045000640664193` — "FACTURA - ELEAM CASA FIORENZA LIMITADA".
Creado por Nailliw Riverol (Telemarketing). Campos clave:

| Campo (api) | Valor de ejemplo | Nota |
|---|---|---|
| `Name` | `FACTURA - ELEAM CASA FIORENZA LIMITADA` | "FACTURA - {empresa}" |
| `Layout` | `Chile` (id 3525045000411885140) | |
| `Solicitud` | `Facturación` | tipo de solicitud |
| `rea_solicitante` | `Telemarketing` | |
| `Estado` | `Creado` | estado inicial |
| `Cuenta` (Account) | ELEAM CASA FIORENZA LIMITADA (id ...623387197) | |
| `ID_NDV` | NDV-29251 (id ...640621081) | vincula a la NDV |
| `PDF_NDV` | (URL blob del PDF de la NDV) | |
| `Mes_Inicio_Facturaci_n` | `2026-08-03` | cuándo empieza a facturar |
| `Nombre_solicitante_GV` | `ANDERSON DÍAZ` | |
| `Correo_solicitante_gv1` | adiazg@geovictoria.com | |
| `Pais` | `Chile` | |
| `nombre_por_colocar` | `Nueva empresa` | |
| `Descripci_n` | Bloque con: Razón Social, Nombre fantasía, RUT, Giro, Dirección, Comuna, Email facturación, Teléfono, Sistema, Rubro, y datos del contacto (nombre, RUT, fono, email). | todo tab-separado |

---

## Observaciones para la automatización
- Ambos registros **cuelgan de la Nota de Venta (NDV)** — se crean DESPUÉS de que exista
  la NDV. En el flujo automático, la NDV ya la crea el finalize (`ID_SO`), así que estos
  2 registros serían el paso siguiente.
- Los dos apuntan al **ejecutivo Anderson** (Ejecutivo_Comercial / solicitante) y al
  **Account** del cliente.
- El **Ticket ST** necesita la **dirección de despacho** y la **planilla de equipos** —
  datos que hoy se recopilan a mano; para automatizar hay que definir de dónde salen
  (dirección: del onboarding/cotización; planilla: generada).
- El **caso RM + auto-instalación** (ej. ELEAM) igual genera Ticket ST de **envío** del
  equipo, aunque no haya visita de instalación.
- Ambos ejemplos fueron creados por Telemarketing a mano → ESTE es el trabajo a eliminar.

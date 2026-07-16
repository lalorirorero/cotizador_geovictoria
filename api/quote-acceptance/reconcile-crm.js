/**
 * Endpoint: POST/GET /api/quote-acceptance/reconcile-crm (cron cada 15 min)
 *
 * Reconciliador del principio "la cotización SIEMPRE se entrega" (16-jul):
 * cuando create-from-vicky(.co) no logra crear Cuenta/Contacto/Deal, la
 * cotización sale igual marcada con CRM_Incompleto=true. Este cron toma esas
 * cotizaciones y reintenta el plumbing con calma:
 *
 *   1. Cuenta: buscar por RUT/NIT en variantes de formato; si no existe,
 *      crearla (con dedupe idempotente: buscar SIEMPRE antes de crear).
 *   2. Contacto: buscar por email; si no, crear uno mínimo.
 *   3. Deal: crear si falta, colgado de la cuenta.
 *   4. Actualizar los lookups de la cotización y apagar CRM_Incompleto solo
 *      si quedó completa; si no, queda para el próximo tick.
 *
 * Idempotente por diseño: cada paso busca antes de crear, así una corrida
 * doble o un humano que ya arregló a mano no generan duplicados.
 *
 * Auth: Bearer CRON_SECRET o x-vicky-secret (mismo esquema que backfill-pdf).
 */

const { getRecord, updateRecord, createRecord, toText } = require("../_shared/zoho-crm");
const { zohoApiFetch } = require("../_shared/zoho-auth");
const { getAcceptanceConfig } = require("../_shared/quote-acceptance-config");

const BATCH = 5;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const cronSecret = toText(process.env.CRON_SECRET);
  const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (cronSecret && bearer === cronSecret) return true;
  const vickySecret = toText(process.env.VICKY_COTIZADORA_SECRET);
  if (vickySecret && toText(req.headers["x-vicky-secret"]) === vickySecret) return true;
  return false;
}

async function coql(selectQuery) {
  const response = await zohoApiFetch("/crm/v3/coql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ select_query: selectQuery }),
  });
  if (response.status === 204) return [];
  const text = await response.text();
  if (!response.ok) throw new Error(`COQL ${response.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text)?.data || [];
}

const compactar = (v) => String(v || "").replace(/[.\s-]/g, "").toUpperCase();

// Variantes de formato del RUT/NIT para buscar en datos históricos sucios.
function variantes(doc) {
  const raw = String(doc || "").trim();
  if (!raw) return [];
  const compact = compactar(raw);
  if (compact.length < 2) return [raw];
  const cuerpo = compact.slice(0, -1);
  const dv = compact.slice(-1);
  const conPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return [...new Set([raw, compact, `${cuerpo}-${dv}`, `${conPuntos}-${dv}`])];
}

async function buscarCuentaPorDoc(doc, empresa) {
  const vs = variantes(doc);
  if (!vs.length) return null;
  const escaped = vs.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  const rows = await coql(`select id, Account_Name from Accounts where RUT_Empresa in (${escaped}) limit 10`).catch(() => []);
  if (!rows.length) return null;
  const norm = (x) => String(x || "").trim().toLowerCase();
  const porNombre = rows.find((r) => norm(r.Account_Name) === norm(empresa));
  return toText((porNombre || rows[0])?.id) || null;
}

async function buscarContactoPorEmail(email) {
  if (!email) return null;
  const rows = await coql(`select id from Contacts where Email = '${String(email).replace(/'/g, "''")}' limit 1`).catch(() => []);
  return toText(rows[0]?.id) || null;
}

// "Cotización ACME SpA - 2026-07-16" → "ACME SpA"
function empresaDesdeNombre(quoteName) {
  const m = String(quoteName || "").match(/^Cotización\s+(.+?)\s+-\s+\d{4}-\d{2}-\d{2}$/);
  return (m && m[1]) || String(quoteName || "").slice(0, 100) || "Empresa sin nombre";
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  let stage = "init";
  try {
    const config = getAcceptanceConfig(req);
    stage = "buscar_pendientes";
    const f = {
      rut: config.companyRutField,
      email: config.contactEmailField,
      phone: config.contactPhoneField,
      deal: config.quoteDealLookupField,
      contact: config.quoteContactLookupField,
    };
    const pendientes = await coql(
      `select id, Name, ${f.rut}, ${f.email}, ${f.phone}, ${f.deal}, ${f.contact}, Cuenta_Asociada, Grand_Total ` +
        `from ${config.quoteModule} where CRM_Incompleto = true limit ${BATCH}`,
    );
    if (!pendientes.length) return sendJson(res, 200, { ok: true, pendientes: 0, reconciliadas: 0 });

    let reconciliadas = 0;
    const detalle = [];
    for (const q of pendientes) {
      const quoteId = toText(q.id);
      const empresa = empresaDesdeNombre(q.Name);
      const doc = toText(q[f.rut]);
      const email = toText(q[f.email]);
      const phone = toText(q[f.phone]);
      let accountId = toText(q.Cuenta_Asociada?.id || q.Cuenta_Asociada);
      let contactId = toText(q[f.contact]?.id || q[f.contact]);
      let dealId = toText(q[f.deal]?.id || q[f.deal]);

      try {
        // 1. Cuenta: buscar SIEMPRE antes de crear (idempotencia).
        if (!accountId) {
          stage = `cuenta:${quoteId}`;
          accountId = await buscarCuentaPorDoc(doc, empresa);
          if (!accountId) {
            const nombre = `${empresa} (${doc})`;
            try {
              const r = await createRecord("Accounts", {
                Account_Name: nombre,
                RUT_Empresa: doc,
                Phone: phone || undefined,
                Description: `Cuenta creada por el reconciliador CRM (cotización ${quoteId} entregada en modo degradado).`,
              }, true);
              accountId = toText(r?.id);
            } catch (e) {
              // Duplicado en la carrera: re-buscar y usar lo que haya.
              accountId = await buscarCuentaPorDoc(doc, empresa);
              if (!accountId) throw e;
            }
          }
        }

        // 2. Contacto: por email; crear mínimo si no existe.
        if (!contactId && email) {
          stage = `contacto:${quoteId}`;
          contactId = await buscarContactoPorEmail(email);
          if (!contactId) {
            try {
              const r = await createRecord("Contacts", {
                Last_Name: email.split("@")[0] || "Contacto",
                Email: email,
                Phone: phone || undefined,
                ...(accountId ? { Account_Name: { id: accountId } } : {}),
              }, true);
              contactId = toText(r?.id);
            } catch (e) {
              contactId = await buscarContactoPorEmail(email);
            }
          }
        }

        // 3. Deal: crear si falta (necesita cuenta para colgarse bien).
        if (!dealId && accountId) {
          stage = `deal:${quoteId}`;
          const r = await createRecord("Deals", {
            Deal_Name: `${empresa} - Cotización Vicky`,
            Account_Name: { id: accountId },
            ...(contactId ? { Contact_Name: { id: contactId } } : {}),
            Stage: "4. Propuesta Enviada / En Negociación",
            Pipeline: "Standard (Standard)",
            Amount: Number(q.Grand_Total || 0) || undefined,
            Description: `Deal creado por el reconciliador CRM (cotización ${quoteId} entregada en modo degradado).`,
          }, true).catch(() => null);
          dealId = toText(r?.id);
        }

        // 4. Actualizar la cotización con lo conseguido.
        stage = `update:${quoteId}`;
        const completo = Boolean(accountId && dealId);
        await updateRecord(config.quoteModule, quoteId, {
          ...(accountId ? { Cuenta_Asociada: { id: accountId } } : {}),
          ...(contactId ? { [f.contact]: { id: contactId } } : {}),
          ...(dealId ? { [f.deal]: { id: dealId } } : {}),
          CRM_Incompleto: !completo,
        }, true);
        if (completo) reconciliadas++;
        detalle.push({ quoteId, empresa, accountId: accountId || null, dealId: dealId || null, completo });
      } catch (err) {
        console.error(`[reconcile-crm] falló ${quoteId} en stage=${stage}:`, toText(err?.message || err).slice(0, 200));
        detalle.push({ quoteId, empresa, error: toText(err?.message || err).slice(0, 150) });
      }
    }

    console.log(`[reconcile-crm] pendientes=${pendientes.length} reconciliadas=${reconciliadas}`);
    return sendJson(res, 200, { ok: true, pendientes: pendientes.length, reconciliadas, detalle });
  } catch (error) {
    console.error(`[reconcile-crm] ERROR en stage=${stage}:`, error);
    return sendJson(res, 500, { ok: false, error: toText(error?.message || error).slice(0, 300) });
  }
};

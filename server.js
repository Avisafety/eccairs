// server.js
// Avisafe ECCAIRS gateway (Fly.io)

const express = require("express");
const Joi = require("joi");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const { buildE2Payload } = require("./eccairsPayload");
const { getE2AccessToken } = require("./e2Client");

// =========================
// CORS (må ligge FØR routes)
// =========================
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Server-to-server/curl uten Origin -> ingen CORS nødvendig
  if (!origin) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }

  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowOrigin = allowAll ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.use(express.json({ limit: "2mb" }));

// =========================
// Supabase
// =========================
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pmucsvrypogtttrajqxq.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabaseAdmin = null;
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY mangler! Gateway kan ikke skrive til Supabase.");
} else {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// =========================
// Schemas
// =========================
const draftsSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

const draftsUpdateSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

const getUrlSchema = Joi.object({
  e2_id: Joi.string().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

const submitSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

// =========================
// Helpers
// =========================
const requireAdminSupabase = (res) => {
  if (!supabaseAdmin) {
    res.status(503).json({ ok: false, error: "Supabase (service role) er ikke konfigurert" });
    return false;
  }
  return true;
};

const getBearerToken = (req) => {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

// Bruker-scoped Supabase client (RLS håndheves)
const makeUserSupabase = (jwt) => {
  if (!SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
};

// Auth middleware for /api/eccairs/*
const requireAuth = async (req, res, next) => {
  // Valgfritt: server-to-server nøkkel
  const apiKey = req.headers["x-api-key"];
  const expectedApiKey = process.env.GATEWAY_API_KEY;
  if (expectedApiKey && apiKey && apiKey === expectedApiKey) return next();

  const jwt = getBearerToken(req);
  if (!jwt) return res.status(401).json({ ok: false, error: "Missing Authorization: Bearer <token>" });

  if (!requireAdminSupabase(res)) return;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: "Invalid session token" });
  }

  req.user = data.user;
  req.jwt = jwt;
  return next();
};

// RLS tilgangssjekk for incident (bruker må ha tilgang)
async function assertIncidentAccess({ jwt, incident_id }) {
  const userSb = makeUserSupabase(jwt);
  if (!userSb) {
    return {
      ok: false,
      status: 500,
      error: "SUPABASE_ANON_KEY mangler i gateway secrets (trengs for RLS-sjekk)",
    };
  }

  const { data: incidentRls, error: rlsErr } = await userSb
    .from("incidents")
    .select("id, company_id")
    .eq("id", incident_id)
    .single();

  if (rlsErr || !incidentRls) {
    return { ok: false, status: 403, error: "Ingen tilgang til incident (RLS)" };
  }

  return { ok: true, incident: incidentRls };
}

// Finn aktiv integrasjon for company + env
async function loadIntegration({ company_id, environment }) {
  const { data: integration, error: intErr } = await supabaseAdmin
    .from("eccairs_integrations")
    .select("*")
    .eq("company_id", company_id)
    .eq("environment", environment)
    .eq("enabled", true)
    .maybeSingle();

  if (intErr) {
    return { ok: false, status: 500, error: "Feil ved henting av eccairs_integrations", details: intErr };
  }
  if (!integration) {
    return {
      ok: false,
      status: 400,
      error: "ECCAIRS integrasjon er ikke konfigurert for dette selskapet/miljøet",
    };
  }
  return { ok: true, integration };
}

// Les E2-response robust (tekst først, parse JSON hvis mulig)
async function readResponseBody(res) {
  const rawText = await res.text().catch(() => "");
  if (!rawText) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    return { _nonJsonBody: rawText };
  }
}

function pickErrMsg(j, fallback) {
  return j?.errorDetails || j?.message || j?.error || fallback;
}

// =========================
// Health
// =========================
app.get("/", (req, res) => res.send("Avisafe ECCAIRS gateway kjører ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// =========================
// Token test (server-side)
// =========================
app.post("/api/e2/token/test", async (req, res) => {
  try {
    const token = await getE2AccessToken();
    res.json({ ok: true, token_present: !!token });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Protected routes
// =========================
app.use("/api/eccairs", requireAuth);

// =========================
// Create ECCAIRS Draft (OR)
// POST /api/eccairs/drafts
// body: { incident_id, environment }
// =========================
app.post("/api/eccairs/drafts", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = draftsSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 0) RLS tilgangssjekk
    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    const incidentCompanyId = access.incident.company_id;

    // 1) Integrasjon
    const integrationRes = await loadIntegration({ company_id: incidentCompanyId, environment });
    if (!integrationRes.ok) {
      return res.status(integrationRes.status).json({
        ok: false,
        error: integrationRes.error,
        details: integrationRes.details,
      });
    }
    const integration = integrationRes.integration;

    // 2) Upsert eccairs_exports => pending (+ attempts)
    const nowIso = new Date().toISOString();

    const { data: existingExport } = await supabaseAdmin
      .from("eccairs_exports")
      .select("id, attempts")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    const nextAttempts = (existingExport?.attempts || 0) + 1;

    const { data: exportRow, error: upErr } = await supabaseAdmin
      .from("eccairs_exports")
      .upsert(
        {
          incident_id,
          company_id: incidentCompanyId,
          environment,
          status: "pending",
          attempts: nextAttempts,
          last_attempt_at: nowIso,
          last_error: null,
        },
        { onConflict: "incident_id,environment" }
      )
      .select("*")
      .single();

    if (upErr) {
      return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports", details: upErr });
    }

    // 3) Build E2 payload
    const { payload, meta } = await buildE2Payload({
      supabase: supabaseAdmin,
      incident: { id: incident_id },
      exportRow,
      integration,
      environment,
    });

    console.log("E2 payload meta:", JSON.stringify(meta, null, 2));

    // 4) Call E2 create
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });

    const createRes = await fetch(`${base}/occurrences/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const createJson = await readResponseBody(createRes);

    console.log("E2 CREATE RESPONSE", {
      status: createRes.status,
      ok: createRes.ok,
      body: createJson,
    });

    if (!createRes.ok) {
      const errMsg = pickErrMsg(createJson, `E2 create failed (${createRes.status})`);

      await supabaseAdmin
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error: errMsg,
          response: createJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exportRow.id);

      return res.status(createRes.status).json({
        ok: false,
        error: "E2 create failed",
        status: createRes.status,
        message: errMsg,
        details: createJson,
      });
    }

    const e2Id = createJson?.data?.e2Id || createJson?.e2Id || null;
    const e2Version = createJson?.data?.version || createJson?.version || null;

    const { data: updatedExport, error: updErr } = await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "draft_created",
        e2_id: e2Id,
        e2_version: e2Version,
        payload,
        response: createJson,
        last_error: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", exportRow.id)
      .select("*")
      .single();

    if (updErr) {
      return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports etter create", details: updErr });
    }

    return res.json({
      ok: true,
      incident_id,
      environment,
      e2_id: e2Id,
      e2_version: e2Version,
      export: updatedExport,
      meta,
      raw: createJson,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Update ECCAIRS Draft (OR)
// POST /api/eccairs/drafts/update
// body: { incident_id, environment }
// =========================
app.post("/api/eccairs/drafts/update", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = draftsUpdateSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 0) RLS tilgangssjekk
    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    // 1) Hent exportRow
    const { data: exportRow, error: expErr } = await supabaseAdmin
      .from("eccairs_exports")
      .select("*")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    if (expErr) {
      return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_exports", details: expErr });
    }
    if (!exportRow?.e2_id) {
      return res.status(400).json({ ok: false, error: "Ingen e2_id funnet. Opprett draft først." });
    }
    if (!exportRow?.e2_version) {
      return res.status(400).json({ ok: false, error: "Ingen e2_version funnet. Opprett draft på nytt eller hent korrekt versjon." });
    }

    // 2) Integrasjon
    const integrationRes = await loadIntegration({ company_id: exportRow.company_id, environment });
    if (!integrationRes.ok) {
      return res.status(integrationRes.status).json({
        ok: false,
        error: integrationRes.error,
        details: integrationRes.details,
      });
    }
    const integration = integrationRes.integration;

    // 3) Oppdater attempts + status før kall
    const nextAttempts = (exportRow.attempts || 0) + 1;
    await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "pending",
        attempts: nextAttempts,
        last_attempt_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", exportRow.id);

    // 4) Bygg payload
    const { payload, meta } = await buildE2Payload({
      supabase: supabaseAdmin,
      incident: { id: incident_id },
      exportRow,
      integration,
      environment,
    });

    console.log("E2 update payload meta:", JSON.stringify(meta, null, 2));

    // 5) Call E2 edit (PUT)
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });

    const updateRes = await fetch(`${base}/occurrences/edit`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        e2Id: exportRow.e2_id,
        version: exportRow.e2_version,
        ...payload,
      }),
    });

    const updateJson = await readResponseBody(updateRes);

    console.log("E2 EDIT RESPONSE", {
      status: updateRes.status,
      ok: updateRes.ok,
      body: updateJson,
    });

    if (!updateRes.ok) {
      const errMsg = pickErrMsg(updateJson, `E2 edit failed (${updateRes.status})`);

      await supabaseAdmin
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error: errMsg,
          response: updateJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exportRow.id);

      return res.status(updateRes.status).json({
        ok: false,
        error: "E2 edit failed",
        status: updateRes.status,
        message: errMsg,
        details: updateJson,
      });
    }

    const newVersion = updateJson?.data?.version ?? updateJson?.version ?? exportRow.e2_version ?? null;

    const { data: updatedExport, error: updErr } = await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "draft_updated",
        e2_version: newVersion,
        payload,
        response: updateJson,
        last_error: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", exportRow.id)
      .select("*")
      .single();

    if (updErr) {
      return res.status(500).json({
        ok: false,
        error: "Kunne ikke oppdatere eccairs_exports etter edit",
        details: updErr,
      });
    }

    return res.json({
      ok: true,
      incident_id,
      environment,
      e2_id: exportRow.e2_id,
      e2_version: updatedExport.e2_version,
      export: updatedExport,
      meta,
      raw: updateJson,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts/update:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Get URL to open in E2 UI
// GET /api/eccairs/get-url?e2_id=OR-...&environment=sandbox|prod
// =========================
app.get("/api/eccairs/get-url", async (req, res) => {
  try {
    const { error, value } = getUrlSchema.validate(req.query || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { e2_id, environment } = value;

    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });

    const url = `${base}/occurrences/get-URL/${encodeURIComponent(e2_id)}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const j = await readResponseBody(r);

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "get-URL failed",
        environment,
        details: j,
        used: url,
        status: r.status,
      });
    }

    const openUrl = j?.data?.url || null;
    return res.json({ ok: true, e2_id, environment, url: openUrl, raw: j, used: url });
  } catch (err) {
    console.error("Feil i /api/eccairs/get-url:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Submit ECCAIRS report (change status)
// POST /api/eccairs/submit
// body: { incident_id, environment }
// =========================
app.post("/api/eccairs/submit", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = submitSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 0) RLS tilgangssjekk
    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    // 1) Hent export row
    const { data: exp, error: expErr } = await supabaseAdmin
      .from("eccairs_exports")
      .select("*")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    if (expErr) {
      return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_exports", details: expErr });
    }
    if (!exp?.e2_id) {
      return res.status(400).json({ ok: false, error: "Ingen e2_id funnet. Opprett draft først." });
    }

    // 2) Øk attempts + mark attempt timestamp før kall
    const nextAttempts = (exp.attempts || 0) + 1;
    await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "pending",
        attempts: nextAttempts,
        last_attempt_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", exp.id);

    // 3) Kall E2 change-status
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });

    const payload = { e2Id: exp.e2_id, status: "SENT" };

    const r = await fetch(`${base}/occurrences/change-status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const j = await readResponseBody(r);

    console.log("E2 CHANGE-STATUS RESPONSE", {
      status: r.status,
      ok: r.ok,
      body: j,
    });

    if (!r.ok) {
      const errMsg = pickErrMsg(j, `E2 change-status failed (${r.status})`);

      await supabaseAdmin
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error: errMsg,
          response: j,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exp.id);

      return res.status(r.status).json({ ok: false, error: "E2 change-status failed", details: j, message: errMsg });
    }

    // 4) Oppdater export status => submitted
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "submitted",
        last_error: null,
        response: j,
        payload,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", exp.id)
      .select("*")
      .single();

    if (updErr) {
      return res.status(500).json({
        ok: false,
        error: "Kunne ikke oppdatere eccairs_exports etter submit",
        details: updErr,
      });
    }

    return res.json({
      ok: true,
      incident_id,
      environment,
      e2_id: exp.e2_id,
      export: updated,
      raw: j,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/submit:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Start server
// =========================
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server kjører på port ${port}`);
});
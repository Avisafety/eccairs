// server.js
// Avisafe ECCAIRS gateway (Fly.io) - with DELETE and ATTACHMENTS endpoints
// Lokalt referanse - deploy til Fly.io

const express = require("express");
const Joi = require("joi");
const multer = require("multer");
const FormData = require("form-data");
const { createClient } = require("@supabase/supabase-js");
const { buildE2Payload } = require("./eccairsPayload");
const { getE2AccessToken, clearTokenCache } = require("./e2Client");

// Multer configuration for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max per file
    files: 10, // max 10 files at once
  },
});

const app = express();

// -------------------------
// CORS (before routes)
// -------------------------
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin) {
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  }

  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowOrigin = allowAll ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*") res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.use(express.json({ limit: "2mb" }));

// -------------------------
// Supabase setup
// -------------------------
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

const requireAdminSupabase = (res) => {
  if (!supabaseAdmin) {
    res.status(503).json({ ok: false, error: "Supabase (service role) er ikke konfigurert" });
    return false;
  }
  return true;
};

// user-scoped client (RLS)
const makeUserSupabase = (jwt) => {
  if (!SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
};

const getBearerToken = (req) => {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

// Auth middleware for /api/eccairs/*
const requireAuth = async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const expectedApiKey = process.env.GATEWAY_API_KEY;
  if (expectedApiKey && apiKey && apiKey === expectedApiKey) return next();

  const jwt = getBearerToken(req);
  if (!jwt) return res.status(401).json({ ok: false, error: "Missing Authorization: Bearer <token>" });

  if (!requireAdminSupabase(res)) return;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return res.status(401).json({ ok: false, error: "Invalid session token" });

  req.user = data.user;
  req.jwt = jwt;
  return next();
};

// RLS access check: must be able to read incident via anon+jwt
async function assertIncidentAccess({ jwt, incident_id }) {
  const userSb = makeUserSupabase(jwt);
  if (!userSb) {
    return { ok: false, status: 500, error: "SUPABASE_ANON_KEY mangler i Fly secrets (trengs for RLS-sjekk)" };
  }

  const { data, error } = await userSb.from("incidents").select("id, company_id").eq("id", incident_id).single();

  if (error || !data) return { ok: false, status: 403, error: "Ingen tilgang til incident (RLS)" };
  return { ok: true, incident: data };
}

// Get default base URL based on environment
function getDefaultBaseUrl(environment) {
  return environment === 'prod'
    ? 'https://api.aviationreporting.eu'
    : 'https://api.uat.aviationreporting.eu';
}

// Load active integration for company+env with per-company credentials support
async function loadIntegration({ company_id, environment }) {
  const { data, error } = await supabaseAdmin
    .from("eccairs_integrations")
    .select("*")
    .eq("company_id", company_id)
    .eq("environment", environment)
    .eq("enabled", true)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: "Feil ved henting av eccairs_integrations", details: error };
  if (!data) return { ok: false, status: 400, error: "ECCAIRS integrasjon er ikke konfigurert for dette selskapet/miljøet" };

  // Try to get per-company credentials from Supabase RPC (decrypted)
  const { data: creds, error: credErr } = await supabaseAdmin
    .rpc("get_eccairs_credentials", {
      p_company_id: company_id,
      p_environment: environment,
    });

  if (credErr) {
    console.warn("[loadIntegration] Could not fetch credentials via RPC:", credErr.message);
  }

  // Build integration object with credentials
  let integration = { ...data, company_id };
  
  if (creds && creds.length > 0) {
    const c = creds[0];
    const normalizedScope = c.e2_scope && String(c.e2_scope).trim() ? String(c.e2_scope).trim() : null;
    integration = {
      ...integration,
      e2_client_id: c.e2_client_id,
      e2_client_secret: c.e2_client_secret,
      e2_base_url: c.e2_base_url || getDefaultBaseUrl(environment),
      e2_scope: normalizedScope,
      credentials_source: 'database',
    };
    console.log(`[loadIntegration] Using per-company credentials for ${company_id}`);
  } else {
    // Fallback to global env vars
    integration = {
      ...integration,
      e2_client_id: process.env.E2_CLIENT_ID,
      e2_client_secret: process.env.E2_CLIENT_SECRET,
      e2_base_url: process.env.E2_BASE_URL,
      e2_scope: process.env.E2_SCOPE && String(process.env.E2_SCOPE).trim() ? String(process.env.E2_SCOPE).trim() : null,
      credentials_source: 'environment',
    };
    console.log(`[loadIntegration] Using global env credentials (fallback) for ${company_id}`);
  }

  return { ok: true, integration };
}

// Read E2 response safely (JSON or text)
async function readE2Response(resp) {
  const text = await resp.text();
  if (!text) return { parsed: {}, rawText: "" };
  try {
    return { parsed: JSON.parse(text), rawText: text };
  } catch {
    return { parsed: { _nonJsonBody: text }, rawText: text };
  }
}

// -------------------------
// Health
// -------------------------
app.get("/", (req, res) => res.send("Avisafe ECCAIRS gateway kjører ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------------
// Token test (server-side) - uses global credentials
// -------------------------
app.post("/api/e2/token/test", async (req, res) => {
  try {
    const token = await getE2AccessToken();
    res.json({ ok: true, token_present: !!token });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Protected routes
// -------------------------
app.use("/api/eccairs", requireAuth);

// -------------------------
// Test ECCAIRS Connection (per-company credentials)
// POST /api/eccairs/test-connection
// -------------------------
app.post("/api/eccairs/test-connection", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { company_id, environment } = req.body;

    if (!company_id || !environment) {
      return res.status(400).json({ ok: false, error: "company_id og environment er påkrevd" });
    }

    // Load integration with credentials
    const result = await loadIntegration({ company_id, environment });
    if (!result.ok) {
      return res.status(result.status).json({ 
        ok: false, 
        error: result.error,
        credentials_source: 'none'
      });
    }

    try {
      // Try to get a token using the integration's credentials
      const token = await getE2AccessToken(result.integration);
      
      return res.json({ 
        ok: true, 
        message: "Tilkobling vellykket",
        credentials_source: result.integration.credentials_source,
        base_url: result.integration.e2_base_url,
        has_token: !!token,
      });
    } catch (tokenErr) {
      return res.json({ 
        ok: false, 
        error: tokenErr.message,
        credentials_source: result.integration.credentials_source,
        base_url: result.integration.e2_base_url,
      });
    }
  } catch (err) {
    console.error("Feil i /api/eccairs/test-connection:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Schemas
// -------------------------
const baseSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

const getUrlSchema = Joi.object({
  e2_id: Joi.string().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

const deleteSchema = Joi.object({
  e2_id: Joi.string().required(),
  incident_id: Joi.string().uuid().optional(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
}).unknown(false);

// -------------------------
// Create draft
// POST /api/eccairs/drafts
// -------------------------
app.post("/api/eccairs/drafts", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = baseSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 0) RLS access
    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    const company_id = access.incident.company_id;

    // 1) integration with credentials
    const integrationRes = await loadIntegration({ company_id, environment });
    if (!integrationRes.ok) return res.status(integrationRes.status).json({ ok: false, error: integrationRes.error, details: integrationRes.details });
    const integration = integrationRes.integration;

    // 2) upsert export row
    const nowIso = new Date().toISOString();
    const { data: existing } = await supabaseAdmin
      .from("eccairs_exports")
      .select("id, attempts")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    const nextAttempts = (existing?.attempts || 0) + 1;

    const { data: exportRow, error: upErr } = await supabaseAdmin
      .from("eccairs_exports")
      .upsert(
        {
          incident_id,
          company_id,
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

    if (upErr) return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports", details: upErr });

    // 3) build payload
    const { payload, meta } = await buildE2Payload({
      supabase: supabaseAdmin,
      incident: { id: incident_id },
      exportRow,
      integration,
      environment,
      mode: "create",
    });

    console.log("E2 payload meta:", JSON.stringify(meta, null, 2));

    // 4) call E2 create with per-company credentials
    const token = await getE2AccessToken(integration);
    const base = integration.e2_base_url || process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });

    const createResp = await fetch(`${base}/occurrences/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const { parsed: createJson } = await readE2Response(createResp);

    console.log("E2 CREATE RESPONSE", { status: createResp.status, ok: createResp.ok, body: createJson });

    if (!createResp.ok) {
      const errMsg = createJson?.errorDetails || createJson?.message || createJson?.error || `E2 create failed (${createResp.status})`;

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

      return res.status(createResp.status).json({ ok: false, error: "E2 create failed", status: createResp.status, message: errMsg, details: createJson, meta });
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

    if (updErr) return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports etter create", details: updErr });

    return res.json({ ok: true, incident_id, environment, e2_id: e2Id, e2_version: e2Version, export: updatedExport, meta, raw: createJson });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Update draft (edit)
// POST /api/eccairs/drafts/update
// -------------------------
app.post("/api/eccairs/drafts/update", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = baseSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 0) RLS access
    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    // 1) fetch export row
    const { data: exportRow, error: expErr } = await supabaseAdmin
      .from("eccairs_exports")
      .select("*")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    if (expErr) return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_exports", details: expErr });
    if (!exportRow?.e2_id) return res.status(400).json({ ok: false, error: "Ingen e2_id funnet. Opprett draft først." });
    if (!exportRow?.e2_version) return res.status(400).json({ ok: false, error: "Ingen e2_version funnet. Opprett draft på nytt eller hent korrekt versjon." });

    // 2) integration with credentials
    const integrationRes = await loadIntegration({ company_id: exportRow.company_id, environment });
    if (!integrationRes.ok) return res.status(integrationRes.status).json({ ok: false, error: integrationRes.error, details: integrationRes.details });
    const integration = integrationRes.integration;

    // 3) mark pending attempt
    const nextAttempts = (exportRow.attempts || 0) + 1;
    await supabaseAdmin
      .from("eccairs_exports")
      .update({ status: "pending", attempts: nextAttempts, last_attempt_at: new Date().toISOString(), last_error: null })
      .eq("id", exportRow.id);

    // 4) build payload (edit mode)
    const { payload, meta } = await buildE2Payload({
      supabase: supabaseAdmin,
      incident: { id: incident_id },
      exportRow,
      integration,
      environment,
      mode: "edit",
    });

    console.log("E2 update payload meta:", JSON.stringify(meta, null, 2));

    // 5) call E2 edit with per-company credentials
    const token = await getE2AccessToken(integration);
    const base = integration.e2_base_url || process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });

    const editResp = await fetch(`${base}/occurrences/edit`, {
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

    const { parsed: editJson } = await readE2Response(editResp);

    if (!editResp.ok) {
      const errMsg = editJson?.errorDetails || editJson?.message || editJson?.error || `E2 edit failed (${editResp.status})`;

      console.error("E2 EDIT FAILED", { status: editResp.status, errMsg, editJson });

      await supabaseAdmin
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error: errMsg,
          response: editJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exportRow.id);

      return res.status(editResp.status).json({ ok: false, error: "E2 edit failed", status: editResp.status, message: errMsg, details: editJson, meta });
    }

    const newVersion = editJson?.data?.version ?? editJson?.version ?? exportRow.e2_version ?? null;

    const { data: updatedExport, error: updErr } = await supabaseAdmin
      .from("eccairs_exports")
      .update({
        status: "draft_updated",
        e2_version: newVersion,
        payload,
        response: editJson,
        last_error: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", exportRow.id)
      .select("*")
      .single();

    if (updErr) return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports etter edit", details: updErr });

    return res.json({ ok: true, incident_id, environment, e2_id: exportRow.e2_id, e2_version: updatedExport.e2_version, export: updatedExport, meta, raw: editJson });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts/update:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Delete draft
// POST /api/eccairs/drafts/delete
// -------------------------
app.post("/api/eccairs/drafts/delete", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = deleteSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { e2_id, incident_id, environment } = value;

    // Hvis incident_id er gitt, sjekk RLS-tilgang og hent company_id
    let company_id = null;
    if (incident_id) {
      const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
      if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
      company_id = access.incident.company_id;
    }

    // Load integration for credentials if we have company_id
    let integration = null;
    if (company_id) {
      const integrationRes = await loadIntegration({ company_id, environment });
      if (integrationRes.ok) {
        integration = integrationRes.integration;
      }
    }

    // Get access token (use integration if available, otherwise global)
    const token = await getE2AccessToken(integration);
    const base = integration?.e2_base_url || process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });

    // ECCAIRS E2 DELETE (API Guide v4.26)
    const type = e2_id.startsWith("VR-") ? "VR" : e2_id.startsWith("OC-") ? "OC" : "OR";
    const encodedE2Id = encodeURIComponent(String(e2_id));

    const deleteUrl = `${base}/occurrences/delete-draft/${type}/${encodedE2Id}`;

    console.log("E2 DELETE request:", deleteUrl, { e2_id, type });

    const deleteResp = await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const { parsed: deleteJson } = await readE2Response(deleteResp);

    console.log("E2 DELETE RESPONSE", { 
      status: deleteResp.status, 
      ok: deleteResp.ok, 
      body: deleteJson 
    });

    if (!deleteResp.ok) {
      const errMsg = deleteJson?.errorDetails || deleteJson?.message || deleteJson?.error || `E2 delete failed (${deleteResp.status})`;
      
      if (incident_id) {
        await supabaseAdmin
          .from("eccairs_exports")
          .update({
            status: "delete_failed",
            last_error: errMsg,
            response: deleteJson,
            last_attempt_at: new Date().toISOString(),
          })
          .eq("incident_id", incident_id)
          .eq("environment", environment);
      }

      return res.status(deleteResp.status).json({ 
        ok: false, 
        error: "E2 delete failed", 
        status: deleteResp.status, 
        message: errMsg, 
        details: deleteJson 
      });
    }

    // returnCode 1 = success i ECCAIRS
    if (deleteJson?.returnCode === 1 || deleteResp.ok) {
      if (incident_id) {
        await supabaseAdmin
          .from("eccairs_exports")
          .delete()
          .eq("incident_id", incident_id)
          .eq("environment", environment);
      }

      return res.json({ 
        ok: true, 
        deleted: e2_id,
        environment,
        message: "Draft deleted successfully",
        raw: deleteJson
      });
    }

    return res.status(400).json({ 
      ok: false, 
      error: deleteJson?.errorDetails || "Unknown error from E2",
      details: deleteJson
    });

  } catch (err) {
    console.error("Feil i /api/eccairs/drafts/delete:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Get URL to open in E2 UI
// GET /api/eccairs/get-url?e2_id=...&environment=...
// -------------------------
app.get("/api/eccairs/get-url", async (req, res) => {
  try {
    const { error, value } = getUrlSchema.validate(req.query || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { e2_id, environment } = value;

    // For get-url we use global credentials as we don't have company context
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });

    const url = `${base}/occurrences/get-URL/${encodeURIComponent(e2_id)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const { parsed: j } = await readE2Response(r);

    if (!r.ok) {
      return res.status(404).json({ ok: false, error: "get-URL failed", environment, details: j, used: url, status: r.status });
    }

    const openUrl = j?.data?.url || null;
    return res.json({ ok: true, e2_id, environment, url: openUrl, raw: j, used: url });
  } catch (err) {
    console.error("Feil i /api/eccairs/get-url:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Submit report
// POST /api/eccairs/submit
// -------------------------
app.post("/api/eccairs/submit", async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { error, value } = baseSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    const access = await assertIncidentAccess({ jwt: req.jwt, incident_id });
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });

    const { data: exp, error: expErr } = await supabaseAdmin
      .from("eccairs_exports")
      .select("*")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    if (expErr) return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_exports", details: expErr });
    if (!exp?.e2_id) return res.status(400).json({ ok: false, error: "Ingen e2_id funnet. Opprett draft først." });

    // Load integration with credentials
    const integrationRes = await loadIntegration({ company_id: exp.company_id, environment });
    if (!integrationRes.ok) return res.status(integrationRes.status).json({ ok: false, error: integrationRes.error });
    const integration = integrationRes.integration;

    const nextAttempts = (exp.attempts || 0) + 1;
    await supabaseAdmin
      .from("eccairs_exports")
      .update({ status: "pending", attempts: nextAttempts, last_attempt_at: new Date().toISOString(), last_error: null })
      .eq("id", exp.id);

    const token = await getE2AccessToken(integration);
    const base = integration.e2_base_url || process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });

    const payload = { e2Id: exp.e2_id, status: "SENT" };

    const r = await fetch(`${base}/occurrences/change-status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });

    const { parsed: j } = await readE2Response(r);

    if (!r.ok) {
      const errMsg = j?.errorDetails || j?.message || j?.error || `E2 change-status failed (${r.status})`;

      await supabaseAdmin
        .from("eccairs_exports")
        .update({ status: "failed", last_error: errMsg, response: j, payload, last_attempt_at: new Date().toISOString() })
        .eq("id", exp.id);

      return res.status(r.status).json({ ok: false, error: "E2 change-status failed", status: r.status, message: errMsg, details: j });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("eccairs_exports")
      .update({ status: "submitted", last_error: null, response: j, payload, last_attempt_at: new Date().toISOString() })
      .eq("id", exp.id)
      .select("*")
      .single();

    if (updErr) return res.status(500).json({ ok: false, error: "Kunne ikke oppdatere eccairs_exports etter submit", details: updErr });

    return res.json({ ok: true, incident_id, environment, e2_id: exp.e2_id, export: updated, raw: j });
  } catch (err) {
    console.error("Feil i /api/eccairs/submit:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Upload Attachments
// POST /api/eccairs/attachments/:e2Id
// Multipart form-data with files
// -------------------------
app.post("/api/eccairs/attachments/:e2Id", upload.array("files", 10), async (req, res) => {
  try {
    if (!requireAdminSupabase(res)) return;

    const { e2Id } = req.params;
    if (!e2Id) {
      return res.status(400).json({ ok: false, error: "e2Id er påkrevd" });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ ok: false, error: "Ingen filer lastet opp" });
    }

    // Get optional parameters from body
    const attributePath = req.body.attributePath || "24.ATTRIBUTES.793"; // Default: occurrence level
    const versionType = req.body.versionType || "DRAFT";
    const entityID = req.body.entityID || null;
    const incident_id = req.body.incident_id || null;

    // Validate versionType
    if (!["DRAFT", "MINOR", "MAJOR"].includes(versionType)) {
      return res.status(400).json({ ok: false, error: "versionType må være DRAFT, MINOR eller MAJOR" });
    }

    // Try to get integration credentials if incident_id is provided
    let integration = null;
    if (incident_id) {
      const { data: exp } = await supabaseAdmin
        .from("eccairs_exports")
        .select("company_id")
        .eq("incident_id", incident_id)
        .maybeSingle();
      
      if (exp?.company_id) {
        const environment = req.body.environment || "sandbox";
        const integrationRes = await loadIntegration({ company_id: exp.company_id, environment });
        if (integrationRes.ok) {
          integration = integrationRes.integration;
        }
      }
    }

    // Get E2 access token
    const token = await getE2AccessToken(integration);
    const base = integration?.e2_base_url || process.env.E2_BASE_URL;
    if (!base) {
      return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler" });
    }

    // Build multipart form data for E2 API - ONLY files in body (per Swagger docs)
    const formData = new FormData();
    
    // Add files ONLY - parameters go as query params per API spec
    for (const file of files) {
      formData.append("files", file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
    }

    // Build URL with query parameters (as per Swagger docs - NOT in FormData body)
    const queryParams = new URLSearchParams();
    queryParams.append("attributePath", attributePath);
    queryParams.append("versionType", versionType);
    if (entityID) {
      queryParams.append("entityID", entityID);
    }

    const uploadUrl = `${base}/occurrences/attachments/${encodeURIComponent(e2Id)}?${queryParams.toString()}`;

    // Convert FormData to Buffer for native fetch compatibility
    const formBuffer = formData.getBuffer();
    const formHeaders = formData.getHeaders();

    console.log("E2 ATTACHMENT UPLOAD:", {
      url: uploadUrl,
      fileCount: files.length,
      fileNames: files.map(f => f.originalname),
      attributePath,
      versionType,
      entityID,
      contentType: formHeaders['content-type'],
    });

    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Avisafe-ECCAIRS-Gateway/1.0",
        ...formHeaders,
      },
      body: formBuffer,
    });

    const { parsed: uploadJson } = await readE2Response(uploadResp);

    console.log("E2 ATTACHMENT RESPONSE:", {
      status: uploadResp.status,
      ok: uploadResp.ok,
      body: uploadJson,
    });

    if (!uploadResp.ok) {
      const errMsg = uploadJson?.errorDetails || uploadJson?.message || uploadJson?.error || `E2 attachment upload failed (${uploadResp.status})`;
      return res.status(uploadResp.status).json({
        ok: false,
        error: "E2 attachment upload failed",
        status: uploadResp.status,
        message: errMsg,
        details: uploadJson,
      });
    }

    return res.json({
      ok: true,
      e2Id,
      fileCount: files.length,
      fileNames: files.map(f => f.originalname),
      attributePath,
      versionType,
      raw: uploadJson,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/attachments:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// -------------------------
// Start server
// -------------------------
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Server kjører på port ${port}`));

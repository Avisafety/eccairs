// server.js
// Avisafe ECCAIRS gateway (Fly.io)

const express = require("express");
const Joi = require("joi");
const { createClient } = require("@supabase/supabase-js");

const app = express();

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
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://pmucsvrypogtttrajqxq.supabase.co";

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; // <-- legg inn i Fly secrets

let supabaseAdmin = null;
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_SERVICE_ROLE_KEY mangler! Gateway kan ikke skrive til Supabase.");
} else {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// =========================
// E2 OAuth helper
// =========================
const { getE2AccessToken } = require("./e2Client");

// =========================
// Schemas
// =========================
const draftsSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
});

const getUrlSchema = Joi.object({
  e2_id: Joi.string().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
});

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

// Auth middleware for /api/eccairs/*
const requireAuth = async (req, res, next) => {
  // Valgfritt: server-to-server nøkkel
  const apiKey = req.headers["x-api-key"];
  const expectedApiKey = process.env.GATEWAY_API_KEY;
  if (expectedApiKey && apiKey && apiKey === expectedApiKey) return next();

  const jwt = getBearerToken(req);
  if (!jwt) return res.status(401).json({ ok: false, error: "Missing Authorization: Bearer <token>" });

  // Verifiser JWT mot Supabase Auth (bruk service role)
  if (!requireAdminSupabase(res)) return;
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);

  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: "Invalid session token" });
  }

  req.user = data.user;
  req.jwt = jwt;
  return next();
};

// Bruker-scoped Supabase client (RLS håndheves)
const makeUserSupabase = (jwt) => {
  if (!SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
};

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

    // 0) Sjekk at bruker har tilgang til incident via RLS (viktig!)
    const userSb = makeUserSupabase(req.jwt);
    if (!userSb) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_ANON_KEY mangler i gateway secrets (trengs for RLS-sjekk)",
      });
    }

    const { data: incidentRls, error: rlsErr } = await userSb
      .from("incidents")
      .select("id, company_id")
      .eq("id", incident_id)
      .single();

    if (rlsErr || !incidentRls) {
      return res.status(403).json({ ok: false, error: "Ingen tilgang til incident (RLS)" });
    }

    const incidentCompanyId = incidentRls.company_id;

    // 1) Finn integrasjon for company + env
    const { data: integration, error: intErr } = await supabaseAdmin
      .from("eccairs_integrations")
      .select("*")
      .eq("company_id", incidentCompanyId)
      .eq("environment", environment)
      .eq("enabled", true)
      .maybeSingle();

    if (intErr) {
      return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_integrations", details: intErr });
    }
    if (!integration) {
      return res.status(400).json({ ok: false, error: "ECCAIRS integrasjon er ikke konfigurert for dette selskapet/miljøet" });
    }

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

    // 3) Minimal E2 payload (alltid valid)
    const payload = {
      type: "REPORT",
      status: "DRAFT",
      taxonomyCodes: {
        "24": {
          ID: "ID00000000000000000000000000000001",
          ATTRIBUTES: {},
          ENTITIES: {},
        },
      },
    };

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

    const createJson = await createRes.json().catch(() => ({}));

    if (!createRes.ok) {
      await supabaseAdmin
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error: createJson?.errorDetails || createJson?.message || `E2 create failed (${createRes.status})`,
          response: createJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exportRow.id);

      return res.status(createRes.status).json({ ok: false, error: "E2 create failed", details: createJson });
    }

    const e2Id = createJson?.data?.e2Id || null;
    const e2Version = createJson?.data?.version || null;

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
      raw: createJson,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Get URL to open in E2 UI
// GET /api/eccairs/get-url?e2_id=OR-...&environment=sandbox|prod
// Uses swagger path: /occurrences/get-URL/{e2Id}
// =========================
app.get("/api/eccairs/get-url", async (req, res) => {
  try {
    const { error, value } = getUrlSchema.validate(req.query || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { e2_id, environment } = value;

    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;
    if (!base) return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });

    // Swagger sier: GET /occurrences/get-URL/{e2Id}
    const url = `${base}/occurrences/get-URL/${encodeURIComponent(e2_id)}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      // E2 returnCode=2 "not found" -> vi gir 404
      return res.status(404).json({
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
// Start server
// =========================
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server kjører på port ${port}`);
});
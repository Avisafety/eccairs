// server.js
// Avisafe ECCAIRS gateway (Fly.io)

const express = require("express");
const Joi = require("joi");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "2mb" }));

// =========================
// Supabase (SERVICE ROLE)
// =========================
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://pmucsvrypogtttrajqxq.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "SUPABASE_SERVICE_ROLE_KEY er ikke satt som secret! Starter uten Supabase."
  );
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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
const reportSchema = Joi.object({
  // Legacy endpoint - not used by Lovable flow, but kept for now
  type: Joi.string().valid("REPORT", "VALIDATED", "OCCURRENCE").required(),
  taxonomyCodes: Joi.object().required(),
  reportingEntityId: Joi.number().integer().required(), // E2 reporting entity id (integer)
  status: Joi.string().valid("SENT", "OPEN", "DRAFT").default("DRAFT"),
});

const draftsSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
});

const draftsUpdateSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
});

const getUrlSchema = Joi.object({
  e2_id: Joi.string().required(),
});

const submitSchema = Joi.object({
  incident_id: Joi.string().uuid().required(),
  environment: Joi.string().valid("sandbox", "prod").default("sandbox"),
});

// =========================
// Helpers
// =========================
const requireSupabase = (res) => {
  if (!supabase) {
    res.status(503).json({
      ok: false,
      error: "Supabase er ikke konfigurert på serveren",
    });
    return false;
  }
  return true;
};

// =========================
// Health
// =========================
app.get("/", (req, res) => res.send("Avisafe ECCAIRS gateway kjører ✅"));

// =========================
// Token test
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
// Create ECCAIRS Draft (OR)
// POST /api/eccairs/drafts
// body: { incident_id, environment }
// Writes/updates eccairs_exports and returns e2_id
// =========================
app.post("/api/eccairs/drafts", async (req, res) => {
  try {
    if (!requireSupabase(res)) return;

    const { error, value } = draftsSchema.validate(req.body || {});
    if (error) {
      return res.status(400).json({ ok: false, error: error.details[0].message });
    }

    const { incident_id, environment } = value;

    // 1) Load incident (must have company_id)
    const { data: incident, error: incErr } = await supabase
      .from("incidents")
      .select("id, company_id")
      .eq("id", incident_id)
      .single();

    if (incErr || !incident) {
      return res.status(404).json({ ok: false, error: "Incident ikke funnet" });
    }

    // 2) Get integration settings for company + environment
    const { data: integration, error: intErr } = await supabase
      .from("eccairs_integrations")
      .select("*")
      .eq("company_id", incident.company_id)
      .eq("environment", environment)
      .eq("enabled", true)
      .maybeSingle();

    if (intErr) {
      return res.status(500).json({
        ok: false,
        error: "Feil ved henting av eccairs_integrations",
        details: intErr,
      });
    }

    if (!integration) {
      return res.status(400).json({
        ok: false,
        error: "ECCAIRS integrasjon er ikke konfigurert for dette selskapet/miljøet",
      });
    }

    // 3) Upsert eccairs_exports => pending
    const nowIso = new Date().toISOString();

    const { data: existingExport } = await supabase
      .from("eccairs_exports")
      .select("id, attempts")
      .eq("incident_id", incident_id)
      .eq("environment", environment)
      .maybeSingle();

    const nextAttempts = (existingExport?.attempts || 0) + 1;

    const { data: exportRow, error: upErr } = await supabase
      .from("eccairs_exports")
      .upsert(
        {
          incident_id,
          company_id: incident.company_id,
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
      return res.status(500).json({
        ok: false,
        error: "Kunne ikke oppdatere eccairs_exports",
        details: upErr,
      });
    }

    // 4) Minimal E2 payload (always valid)
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

    // 5) Token + call E2 create
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;

    if (!base) {
      return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });
    }

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
      await supabase
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error:
            createJson?.errorDetails ||
            createJson?.message ||
            `E2 create failed (${createRes.status})`,
          response: createJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exportRow.id);

      return res.status(createRes.status).json({
        ok: false,
        error: "E2 create failed",
        details: createJson,
      });
    }

    const e2Id = createJson?.data?.e2Id || null;
    const e2Version = createJson?.data?.version || null;

    // 6) Update eccairs_exports => draft_created
    const { data: updatedExport, error: updErr } = await supabase
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
      return res.status(500).json({
        ok: false,
        error: "Kunne ikke oppdatere eccairs_exports etter create",
        details: updErr,
      });
    }

    return res.json({
      ok: true,
      incident_id,
      environment,
      e2_id: e2Id,
      status: "DRAFT",
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
// Update ECCAIRS Draft with incident fields (MVP mapping)
// POST /api/eccairs/drafts/update
// body: { incident_id, environment }
// NOTE: Endpoint path for E2 update may differ. If this fails with 404, we will adjust to correct E2 path.
// =========================
app.post("/api/eccairs/drafts/update", async (req, res) => {
  try {
    if (!requireSupabase(res)) return;

    const { error, value } = draftsUpdateSchema.validate(req.body || {});
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    const { incident_id, environment } = value;

    // 1) Find export row (must have e2_id)
    const { data: exp, error: expErr } = await supabase
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

    // 2) Load incident (adjust select fields to your schema)
    const { data: incident, error: incErr } = await supabase
      .from("incidents")
      .select("id, company_id, title, description, occurred_at, created_at")
      .eq("id", incident_id)
      .single();

    if (incErr || !incident) {
      return res.status(404).json({ ok: false, error: "Incident ikke funnet" });
    }

    // 3) Load integration (for later mapping)
    const { data: integration, error: intErr } = await supabase
      .from("eccairs_integrations")
      .select("*")
      .eq("company_id", incident.company_id)
      .eq("environment", environment)
      .eq("enabled", true)
      .maybeSingle();

    if (intErr) {
      return res.status(500).json({ ok: false, error: "Feil ved henting av eccairs_integrations", details: intErr });
    }
    if (!integration) {
      return res.status(400).json({ ok: false, error: "ECCAIRS integrasjon mangler for company/env" });
    }

    // 4) Build payload (MVP)
    // WARNING: Attribute codes are taxonomy dependent. This MVP just demonstrates updating a text field.
    const text =
      incident.description ||
      incident.title ||
      `Oppdatert fra AviSafe (${incident.id})`;

    const payload = {
      e2Id: exp.e2_id,
      type: "OR",
      status: "DRAFT",
      taxonomyCodes: {
        "24": {
          ID: "ID00000000000000000000000000000001",
          ATTRIBUTES: {
            "425": [{ text }],
          },
          ENTITIES: {},
        },
      },
    };

    // 5) Call E2 update (path may differ in your E2 swagger)
    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;

    if (!base) {
      return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });
    }

    const updRes = await fetch(`${base}/occurrences/update`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const updJson = await updRes.json().catch(() => ({}));

    if (!updRes.ok) {
      await supabase
        .from("eccairs_exports")
        .update({
          status: "failed",
          last_error:
            updJson?.errorDetails ||
            updJson?.message ||
            `E2 update failed (${updRes.status})`,
          response: updJson,
          payload,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", exp.id);

      return res.status(updRes.status).json({
        ok: false,
        error: "E2 update failed",
        details: updJson,
      });
    }

    await supabase
      .from("eccairs_exports")
      .update({
        status: "draft_created",
        last_error: null,
        response: updJson,
        payload,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", exp.id);

    return res.json({ ok: true, e2_id: exp.e2_id, updated: true, raw: updJson });
  } catch (err) {
    console.error("Feil i /api/eccairs/drafts/update:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Get URL to open in E2 UI
// GET /api/eccairs/get-url?e2_id=OR-...
// =========================
app.get("/api/eccairs/get-url", async (req, res) => {
  try {
    const { error, value } = getUrlSchema.validate(req.query || {});
    if (error) {
      return res.status(400).json({ ok: false, error: error.details[0].message });
    }

    const { e2_id } = value;

    const token = await getE2AccessToken();
    const base = process.env.E2_BASE_URL;

    if (!base) {
      return res.status(500).json({ ok: false, error: "E2_BASE_URL mangler i secrets" });
    }

    const r = await fetch(`${base}/occurrences/get-URL/${encodeURIComponent(e2_id)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: "get-URL failed", details: j });
    }

    const url = j?.data?.url || j?.url || j?.data || null;

    return res.json({ ok: true, e2_id, url, raw: j });
  } catch (err) {
    console.error("Feil i /api/eccairs/get-url:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// OPTIONAL: Submit (future)
// POST /api/eccairs/submit
// body: { incident_id, environment }
// This is a placeholder for later when you implement "submit" flow.
// =========================
app.post("/api/eccairs/submit", async (req, res) => {
  try {
    if (!requireSupabase(res)) return;

    const { error, value } = submitSchema.validate(req.body || {});
    if (error) {
      return res.status(400).json({ ok: false, error: error.details[0].message });
    }

    return res.status(501).json({
      ok: false,
      error: "Ikke implementert ennå. Bruk draft-opprettelse først.",
      details: value,
    });
  } catch (err) {
    console.error("Feil i /api/eccairs/submit:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// Legacy endpoint (FIXED lookup)
// POST /eccairs/report
// body: { type, taxonomyCodes, reportingEntityId, status }
// NOTE: This does NOT talk to E2. Kept as legacy stub.
// We fix the wrong tenant lookup to use eccairs_integrations (E2 reporting entity id).
// =========================
app.post("/eccairs/report", async (req, res) => {
  try {
    const report = req.body;

    const { error } = reportSchema.validate(report);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    if (!supabase) {
      return res.status(503).json({ error: "Supabase er ikke konfigurert på serveren" });
    }

    // FIX: reportingEntityId is an E2 integer, not companies.id (uuid).
    const { data: integration, error: integrationError } = await supabase
      .from("eccairs_integrations")
      .select("id, company_id, environment, enabled, reporting_entity_id, responsible_entity_id")
      .eq("reporting_entity_id", report.reportingEntityId)
      .eq("enabled", true)
      .maybeSingle();

    if (integrationError) {
      return res.status(500).json({
        error: "Feil ved oppslag i eccairs_integrations",
        details: integrationError,
      });
    }

    if (!integration) {
      return res.status(400).json({
        error: "Ingen aktiv ECCAIRS-integrasjon funnet for reportingEntityId",
      });
    }

    // Legacy payload (kept)
    const eccairsData = {
      type: report.type,
      reportingEntityId: report.reportingEntityId,
      taxonomyCodes: report.taxonomyCodes,
      status: report.status,
    };

    // NOTE: This was a placeholder endpoint. We keep it, but it's not real.
    const response = await fetch("https://safetydata.api.endpoint/submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer YOUR_ACCESS_TOKEN`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eccairsData),
    });

    const responseData = await response.json().catch(() => ({}));

    if (response.ok) {
      return res.json({
        status: "ok",
        message: "Rapport sendt til Safetydata (placeholder)",
        data: responseData,
      });
    }

    return res.status(response.status).json({
      status: "error",
      message: "Feil ved sending til Safetydata (placeholder)",
      details: responseData,
    });
  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

// =========================
// Start server
// =========================
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server kjører på port ${port}`);
}); 
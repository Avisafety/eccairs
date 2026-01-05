const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));



const Joi = require("joi");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://pmucsvrypogtttrajqxq.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (!SUPABASE_ANON_KEY) {
  console.warn("Supabase anon key er ikke satt som secret! Starter uten Supabase.");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const reportSchema = Joi.object({
  type: Joi.string().valid("REPORT", "VALIDATED", "OCCURRENCE").required(),
  taxonomyCodes: Joi.object().required(),
  reportingEntityId: Joi.number().integer().required(),
  status: Joi.string().valid("SENT", "OPEN", "DRAFT").default("DRAFT"),
});

const { getE2AccessToken } = require("./e2Client");

app.post("/api/e2/token/test", async (req, res) => {
  try {
    const token = await getE2AccessToken();
    res.json({ ok: true, token_present: !!token });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

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

    const { data: tenant, error: tenantError } = await supabase
      .from("companies")
      .select("*")
      .eq("company_id", report.reportingEntityId)
      .single();

    if (tenantError || !tenant) {
      return res.status(400).json({ error: "Tenant ikke funnet" });
    }

    const eccairsData = {
      type: report.type,
      reportingEntityId: report.reportingEntityId,
      taxonomyCodes: report.taxonomyCodes,
      status: report.status,
    };

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
        message: "Rapport sendt til Safetydata",
        data: responseData,
      });
    }

    return res.status(response.status).json({
      status: "error",
      message: "Feil ved sending til Safetydata",
      details: responseData,
    });
  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

app.get("/", (req, res) => res.send("Avisafe ECCAIRS gateway kjører ✅"));

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server kjører på port ${port}`);
});

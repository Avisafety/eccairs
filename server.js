const express = require("express");
const app = express();
const Joi = require("joi");
const { createClient } = require('@supabase/supabase-js');

// Konfigurer Supabase-klienten med dine API-nøkler
const supabase = createClient('https://your-project-url.supabase.co', 'public-anon-key');

app.post("/eccairs/report", async (req, res) => {
  try {
    const report = req.body;
    
    // Slå opp tenant ved å hente company_id basert på en unik identifikator
    const { data: tenant, error } = await supabase
      .from('companies')
      .select('*')
      .eq('company_id', report.reportingEntityId)
      .single();

    if (error) {
      return res.status(400).json({ error: "Tenant ikke funnet" });
    }

    console.log("Tenant funnet:", tenant);

    // TODO: Mapp data til ECCAIRS-format
    // TODO: Send videre til Safetydata API med fetch()

    res.json({
      status: "ok",
      message: "Rapport mottatt og tenant verifisert",
      tenant: tenant,
      received: report
    });
  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

// Eksempel på validering av rapportdata
const reportSchema = Joi.object({
  type: Joi.string().valid("REPORT", "VALIDATED", "OCCURRENCE").required(),
  taxonomyCodes: Joi.object().required(), // Legg til detaljert validering for taxonomyCodes
  reportingEntityId: Joi.number().integer().required(),
  status: Joi.string().valid("SENT", "OPEN", "DRAFT").default("DRAFT")
});

app.post("/eccairs/report", async (req, res) => {
  try {
    const report = req.body;

    // Valider data mot ECCAIRS-formatet
    const { error } = reportSchema.validate(report);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // TODO: Slå opp tenant i Supabase og mapp til ECCAIRS-format
    // TODO: Send videre til Safetydata API med fetch()

    res.json({
      status: "ok",
      message: "Rapport mottatt og validert",
      received: report
    });
  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

app.use(express.json());

// Healthcheck / test
app.get("/", (req, res) => {
  res.send("Avisafe ECCAIRS gateway kjører ✅");
});

// Endepunkt som senere skal sende til Safetydata/ECCAIRS
app.post("/eccairs/report", async (req, res) => {
  try {
    const report = req.body;

    // TODO:
    // 1) Valider data
    // 2) Slå opp tenant i Supabase (company_id etc, hvis du vil)
    // 3) Mapp til ECCAIRS-format
    // 4) Send videre til Safetydata API med fetch()

    // Foreløpig bare echo:
    res.json({
      status: "ok",
      message: "Rapport mottatt (dummy-endepunkt)",
      received: report
    });
  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});

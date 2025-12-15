const express = require("express");
const app = express();
const Joi = require("joi");
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// Hent Supabase URL og Anon Key fra Fly.io secrets
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmucsvrypogtttrajqxq.supabase.co';  // Sett URL hvis du har den som secret
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;  // Anon key fra Fly.io secrets

if (!SUPABASE_ANON_KEY) {
  console.error("Supabase anon key er ikke satt som secret!");
  process.exit(1);  // Stopp applikasjonen hvis API-nøkkelen ikke er tilgjengelig
}

// Konfigurer Supabase-klienten med API-nøkkelen fra miljøvariabelen
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Eksempel på validering av rapportdata med Joi
const reportSchema = Joi.object({
  type: Joi.string().valid("REPORT", "VALIDATED", "OCCURRENCE").required(),
  taxonomyCodes: Joi.object().required(), // Legg til detaljert validering for taxonomyCodes
  reportingEntityId: Joi.number().integer().required(),
  status: Joi.string().valid("SENT", "OPEN", "DRAFT").default("DRAFT")
});

// Endepunkt for å motta og validere rapporter
app.post("/eccairs/report", async (req, res) => {
  try {
    const report = req.body;

    // Valider data mot ECCAIRS-formatet
    const { error } = reportSchema.validate(report);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // Slå opp tenant ved å hente company_id basert på en unik identifikator
    const { data: tenant, error: tenantError } = await supabase
      .from('companies')
      .select('*')
      .eq('company_id', report.reportingEntityId)
      .single();

    if (tenantError) {
      return res.status(400).json({ error: "Tenant ikke funnet" });
    }

    console.log("Tenant funnet:", tenant);

    // Mapp data til ECCAIRS-format (forbered dataene før videre sending)
    const eccairsData = {
      type: report.type,
      reportingEntityId: report.reportingEntityId,
      taxonomyCodes: report.taxonomyCodes,
      status: report.status,
    };

    // Send data videre til Safetydata API med fetch()
    const response = await fetch('https://safetydata.api.endpoint/submit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer YOUR_ACCESS_TOKEN`, // Bruk riktig API-token
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eccairsData),
    });

    const responseData = await response.json();

    if (response.ok) {
      res.json({
        status: "ok",
        message: "Rapport sendt til Safetydata",
        data: responseData,
      });
    } else {
      res.status(response.status).json({
        status: "error",
        message: "Feil ved sending til Safetydata",
        details: responseData,
      });
    }

  } catch (error) {
    console.error("Feil i /eccairs/report:", error);
    res.status(500).json({ error: "Noe gikk galt på serveren" });
  }
});

// Healthcheck / test
app.get("/", (req, res) => {
  res.send("Avisafe ECCAIRS gateway kjører ✅");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});

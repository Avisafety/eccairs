const express = require("express");
const app = express();
const Joi = require("joi");
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// Konfigurer Supabase-klienten med dine API-nøkler
const supabase = createClient('https://your-project-url.supabase.co', 'public-anon-key');

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

    // Logg tenant (kan være nyttig for debugging)
    console.log("Tenant funnet:", tenant);

    // Mapp data til ECCAIRS-format (du kan legge til mer spesifikk mapping her)
    const eccairsData = {
      type: report.type,
      reportingEntityId: report.reportingEntityId,
      taxonomyCodes: report.taxonomyCodes,
      status: report.status,
    };

    // Send data til Safetydata API (f.eks., ved hjelp av fetch())
    const response = await fetch('https://safetydata.api.endpoint/submit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer YOUR_ACCESS_TOKEN`, // Sett inn din API-token
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

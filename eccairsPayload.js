// Schema-aware payload builder for E2 (ECCAIRS2 / E2)
// Versjon 2.0 - Oppdatert til korrekt E2 API-format

function toAttributeCode(codeOrVlKey) {
  if (codeOrVlKey == null) return null;
  const s = String(codeOrVlKey).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^vl(\d+)$/i);
  if (m) return m[1];
  return null;
}

function ensureString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function asInt(v) {
  const s = ensureString(v);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n); // Sikre heltall
}

// -------------------------
// Validate value-list selections against eccairs.value_list_items
// -------------------------
async function validateValueListSelections(supabase, selections) {
  const valid = new Set();

  const byCode = new Map();
  for (const sel of selections) {
    if (!sel?.code || sel?.valueId == null) continue;
    const code = String(sel.code);
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add(String(sel.valueId));
  }

  for (const [code, valueSet] of byCode.entries()) {
    const vlKey = `VL${code}`;
    const values = Array.from(valueSet);

    const { data, error } = await supabase
      .schema("eccairs")
      .from("value_list_items")
      .select("value_list_key, value_id")
      .eq("value_list_key", vlKey)
      .in("value_id", values);

    if (error) throw error;

    for (const row of data || []) {
      valid.add(`${row.value_list_key}:${row.value_id}`);
    }
  }

  return valid;
}

// -------------------------
// Hent value description fra eccairs.value_list_items
// -------------------------
async function getValueDescription(supabase, vlKey, valueId) {
  if (!vlKey || valueId == null) return null;
  
  const { data, error } = await supabase
    .schema("eccairs")
    .from("value_list_items")
    .select("value_description")
    .eq("value_list_key", vlKey)
    .eq("value_id", String(valueId))
    .maybeSingle();

  if (error) {
    console.warn(`Failed to get description for ${vlKey}:${valueId}`, error);
    return null;
  }
  return data?.value_description || null;
}

// -------------------------
// Loaders
// -------------------------
async function loadIncidentMappingsWide(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_mappings")
    .select("incident_id, occurrence_class, phase_of_flight, aircraft_category")
    .eq("incident_id", incident_id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function loadIntegrationSettings(supabase, company_id) {
  const { data, error } = await supabase
    .from("eccairs_integrations")
    .select("responsible_entity_id, responsible_entity_value_id, reporting_entity_id")
    .eq("company_id", company_id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id, taxonomy_code, format, payload_json, text_value")
    .eq("incident_id", incident_id);

  if (error) {
    // Tabell finnes kanskje ikke
    if (String(error.code) === "42P01") return null;
    throw error;
  }
  return data || [];
}

// -------------------------
// Build "selections" list
// -------------------------
async function buildSelections({ supabase, incident_id, company_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);

  // Prioriter incident_eccairs_attributes hvis de finnes
  if (generic && generic.length > 0) {
    const selections = [];

    for (const r of generic) {
      const code = toAttributeCode(r.attribute_code);
      if (!code) continue;

      selections.push({
        code,
        taxonomy_code: ensureString(r.taxonomy_code) || "24",
        format: ensureString(r.format) || "value_list_int_array",
        valueId: ensureString(r.value_id),
        text: ensureString(r.text_value),
        raw: r.payload_json || null,
      });
    }

    return { source: "incident_eccairs_attributes", selections };
  }

  // Fallback til incident_eccairs_mappings (legacy)
  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  // Hent responsible_entity fra eccairs_integrations
  const integration = await loadIntegrationSettings(supabase, company_id);

  const selections = [];

  // Handle Occurrence Class (431) - påkrevd
  // Gyldige verdier ifølge E2 API: 100, 200, 300, 301, 302, 400, 500, 501, 502
  const validOccurrenceClasses = [100, 200, 300, 301, 302, 400, 500, 501, 502];
  const occurrenceClass = validOccurrenceClasses.includes(wide.occurrence_class) 
    ? wide.occurrence_class 
    : 100; // Default: Occurrence
    
  selections.push({
    code: "431",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(occurrenceClass)
  });

  // Handle Phase of Flight (1072) - krever content-objekt
  if (wide.phase_of_flight) {
    // Hent beskrivelse for content-feltet
    const description = await getValueDescription(supabase, 'VL1072', wide.phase_of_flight);
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      format: "content_object_array",  // Spesialformat for 1072
      valueId: String(wide.phase_of_flight),
      text: description || ""
    });
  }

  // Handle Aircraft Category (17)
  if (wide.aircraft_category) {
    selections.push({
      code: "17",
      taxonomy_code: "24",
      format: "value_list_int_array",
      valueId: String(wide.aircraft_category)
    });
  }

  // Handle Responsible Entity (453) - fra integration settings
  const responsibleEntity = integration?.responsible_entity_id || 133; // Default: Norway
  selections.push({
    code: "453",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(responsibleEntity)
  });

  return { source: "incident_eccairs_mappings", selections };
}

// -------------------------
// Convert selection -> E2 attribute payload value
// Basert på ECCAIRS 2.0 API Guide v4.26
// -------------------------
function selectionToE2Value(sel) {
  // Raw JSON override - bruk direkte
  if (sel.format === "raw_json") {
    return sel.raw;
  }

  // Text content array (for narrativer som ren tekst)
  // E2 format: [{ "text": "..." }]
  if (sel.format === "text_content_array") {
    if (!sel.text) return null;
    return [{ text: sel.text }];
  }

  // Content object array (for 1072 Phase of Flight etc.)
  // E2 format: [{ "content": "..." }] eller [{ "content": [n] }]
  if (sel.format === "content_object_array") {
    if (sel.text) {
      return [{ content: sel.text }];
    }
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ content: [n] }];
  }

  // Value-list integer array (standard for 431, 453, 17, 430, etc.)
  // E2 format: [n] - IKKE [{ value: n }]!
  if (sel.format === "value_list_int_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [n];  // RIKTIG E2 FORMAT
  }

  // Multiple value-list integers
  // E2 format: [n1, n2, n3]
  if (sel.format === "value_list_int_multi_array") {
    if (!sel.raw || !Array.isArray(sel.raw)) return null;
    return sel.raw.map(v => asInt(v)).filter(n => n != null);
  }

  // Date format (YYYY-MM-DD)
  // E2 format: ["2024-01-15"]
  if (sel.format === "date_array" || sel.format === "local_date") {
    if (!sel.text) return null;
    return [sel.text];  // ISO-8601 dato som string i array
  }

  // Time format (HH:MM:SS)
  // E2 format: ["14:30:00"]
  if (sel.format === "time_array" || sel.format === "local_time") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // Unit-value format (for 176, 310 etc.)
  // E2 format: [{ "unit": "m", "content": "100" }]
  if (sel.format === "unit_content_array") {
    if (!sel.raw) return null;
    return Array.isArray(sel.raw) ? sel.raw : [sel.raw];
  }

  // String array (for enkle tekst-attributter)
  // E2 format: ["tekst"]
  if (sel.format === "string_array") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // Object array (for komplekse strukturer)
  if (sel.format === "object_array") {
    if (sel.raw) return Array.isArray(sel.raw) ? sel.raw : [sel.raw];
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [n];
  }

  // Fallback: hvis ukjent format og raw finnes, bruk raw
  if (sel.raw) return sel.raw;

  // Last resort: prøv integer-array (korrekt E2 format)
  const n = asInt(sel.valueId);
  return n == null ? null : [n];
}

// -------------------------
// Main builder
// -------------------------
async function buildE2Payload({ supabase, incident, exportRow, integration, environment, mode }) {
  const taxBlock = {
    "24": {
      ID: "ID00000000000000000000000000000001",
      ATTRIBUTES: {},
      ENTITIES: {},
    },
  };

  const { selections, source } = await buildSelections({ 
    supabase, 
    incident_id: incident.id,
    company_id: integration?.company_id || incident.company_id 
  });

  const rejected = [];
  const attrs = {};

  // Filtrer til taxonomy 24
  const filtered = selections.filter((s) => 
    (ensureString(s.taxonomy_code) || "24") === "24"
  );

  // Valider value-list seleksjoner mot eccairs.value_list_items
  const valueListCandidates = filtered
    .filter((s) => s.format === "value_list_int_array")
    .filter((s) => s.valueId)
    .map((s) => ({ code: s.code, valueId: s.valueId }));

  const validSet = await validateValueListSelections(supabase, valueListCandidates);

  for (const sel of filtered) {
    // Valider value-list attributter
    if (sel.format === "value_list_int_array") {
      if (!sel.valueId) continue;
      const key = `VL${sel.code}:${sel.valueId}`;
      if (!validSet.has(key)) {
        rejected.push({ 
          attribute_code: sel.code, 
          taxonomy_code: "24", 
          value_id: sel.valueId, 
          reason: "Not found in eccairs.value_list_items" 
        });
        continue;
      }
    }

    const v = selectionToE2Value(sel);
    if (v == null) {
      rejected.push({ 
        attribute_code: sel.code, 
        taxonomy_code: "24", 
        reason: `No value produced for format=${sel.format}` 
      });
      continue;
    }

    attrs[sel.code] = v;
  }

  taxBlock["24"].ATTRIBUTES = attrs;

  // Bygg payload i henhold til E2 API spec
  const payload = {
    type: "REPORT",
    status: "DRAFT",
    taxonomy_codes: taxBlock,
    taxonomyCodes: taxBlock,  // Begge for kompatibilitet
  };

  const meta = {
    mode: mode || null,
    source,
    environment: environment || null,
    incident_id: incident?.id || null,
    usedCount: Object.keys(attrs).length,
    selectionsCount: selections.length,
    rejected,
    attributes: attrs,
    export_id: exportRow?.id || null,
    company_id: integration?.company_id || null,
    e2Id: exportRow?.e2_id,
    e2Version: exportRow?.e2_version,
  };

  return { payload, meta };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
  // Eksporter hjelpefunksjoner for testing/debugging
  loadIncidentAttributesGeneric,
  loadIntegrationSettings,
  getValueDescription,
  selectionToE2Value,
  validateValueListSelections,
};
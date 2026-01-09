// Schema-aware payload builder for E2 (ECCAIRS2 / E2)

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
  return n;
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

// NEW: Load incident_eccairs_attributes (den manglende funksjonen!)
async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id, taxonomy_code, format, payload_json, text_value")
    .eq("incident_id", incident_id);

  if (error) {
    // Table might not exist
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
    const selections = []; // <-- FIKSET: Manglende array definisjon

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
  const validOccurrenceClasses = [100, 200, 300, 301, 302];
  const occurrenceClass = validOccurrenceClasses.includes(wide.occurrence_class) 
    ? wide.occurrence_class 
    : 100; // Default: Occurrence
    
  selections.push({
    code: "431",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(occurrenceClass)
  });

  // Handle Phase of Flight (1072)
  if (wide.phase_of_flight) {
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      format: "value_list_int_array",
      valueId: String(wide.phase_of_flight)
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
  // Bruk responsible_entity_id (integer) eller fall tilbake til 133 (Norway)
  const responsibleEntity = integration?.responsible_entity_id || 133;
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
// -------------------------
function selectionToE2Value(sel) {
  // Raw JSON override - bruk direkte
  if (sel.format === "raw_json") {
    return sel.raw;
  }

  // Text content array (f.eks. narrativer)
  if (sel.format === "text_content_array") {
    if (!sel.text) return null;
    return [{ content: sel.text }];
  }

  // Object array (for komplekse strukturer)
  if (sel.format === "object_array") {
    if (sel.raw) return sel.raw;
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ value: n }];
  }

  // Value-list int array (standard format for de fleste attributter)
  if (sel.format === "value_list_int_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ value: n }];
  }

  // Date format (YYYY-MM-DD)
  if (sel.format === "date_array" || sel.format === "local_date") {
    if (!sel.text) return null;
    // E2 forventer ISO-8601 dato
    return [{ value: sel.text }];
  }

  // Fallback: hvis ukjent format og raw finnes, bruk raw
  if (sel.raw) return sel.raw;

  // Last resort: prøv int-array med riktig format
  const n = asInt(sel.valueId);
  return n == null ? null : [{ value: n }]; // FIKSET: Var [n], nå [{ value: n }]
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

  const payload = {
    type: "REPORT",
    status: "DRAFT",
    taxonomy_codes: taxBlock,
    taxonomyCodes: taxBlock,
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
  // Eksporter også hjelpefunksjoner for testing
  loadIncidentAttributesGeneric,
  loadIntegrationSettings,
  selectionToE2Value,
};
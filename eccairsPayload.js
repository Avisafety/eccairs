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

    for (const row of data || []) valid.add(`${row.value_list_key}:${row.value_id}`);
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
    .select("responsible_entity_id")
    .eq("company_id", company_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// -------------------------
// Build "selections" list
// -------------------------
async function buildSelections({ supabase, incident_id, company_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);

  if (generic && generic.length > 0) {
    // Existing code stays the same ...
    return { source: "incident_eccairs_attributes", selections };
  }

  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  // Get responsible_entity from eccairs_integrations
  const integration = await loadIntegrationSettings(supabase, company_id);

  const selections = [];

  // Handle Occurrence Class (431)
  const validOccurrenceClass = [100, 200, 300, 301, 302].includes(wide.occurrence_class) ? wide.occurrence_class : 100;
  selections.push({
    code: "431",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(validOccurrenceClass)
  });

  // Handle Phase of Flight (1072)
  if (wide.phase_of_flight) {
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      format: "value_list_int_array",
      valueId: String(wide.phase_of_flight),
      content: "Flight Phase Content"  // Ensure content is added
    });
  }

  // Handle Aircraft Category (17) - Verify if it needs to be a nested entity
  if (wide.aircraft_category) {
    selections.push({
      code: "17",
      taxonomy_code: "24",
      format: "value_list_int_array",
      valueId: String(wide.aircraft_category)
    });
  }

  // Handle Responsible Entity (453) - from integration settings
  const responsibleEntity = integration?.responsible_entity_id || 133; // Default Norway
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
  // raw JSON override
  if (sel.format === "raw_json") {
    return sel.raw;
  }

  // common E2 "content" pattern
  if (sel.format === "text_content_array") {
    if (!sel.text) return null;
    return [{ content: sel.text }];
  }

  // object array (for cases like your 1072 schema complaining "object expected")
  if (sel.format === "object_array") {
    if (sel.raw) return sel.raw; // you store the exact array-of-objects in payload_json
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ value: n }];
  }

  // value-list int array (classic)
  if (sel.format === "value_list_int_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ value: n }];
  }

  // Handle date_array format
  if (sel.format === "date_array") {
    if (!sel.text) return null;
    return [{ value: sel.text }]; // ISO-8601 date string
  }

  // fallback: if unknown format and raw provided, use raw
  if (sel.raw) return sel.raw;

  // last resort: try int-array
  const n = asInt(sel.valueId);
  return n == null ? null : [{ value: n }];
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

  const filtered = selections.filter((s) => (ensureString(s.taxonomy_code) || "24") === "24");

  const valueListCandidates = filtered
    .filter((s) => s.format === "value_list_int_array")
    .filter((s) => s.valueId)
    .map((s) => ({ code: s.code, valueId: s.valueId }));

  const validSet = await validateValueListSelections(supabase, valueListCandidates);

  for (const sel of filtered) {
    if (sel.format === "value_list_int_array") {
      if (!sel.valueId) continue;
      const key = `VL${sel.code}:${sel.valueId}`;
      if (!validSet.has(key)) {
        rejected.push({ attribute_code: sel.code, taxonomy_code: "24", value_id: sel.valueId, reason: "Not found in eccairs.value_list_items" });
        continue;
      }
    }

    const v = selectionToE2Value(sel);
    if (v == null) {
      rejected.push({ attribute_code: sel.code, taxonomy_code: "24", reason: `No value produced for format=${sel.format}` });
      continue;
    }

    attrs[sel.code] = v;
  }

  taxBlock["24"].ATTRIBUTES = attrs;

  const payload = {
    type: "REPORT",
    status: "DRAFT",  // Ensure status is correct for "create" or "edit" operation
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
    e2Id: exportRow?.e2_id,   // Ensure e2Id is included for update
    e2Version: exportRow?.e2_version,  // Ensure e2Version is included for update
  };

  return { payload, meta };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
};

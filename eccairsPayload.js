// ECCAIRS2 E2 API Payload Builder
// Fikset for korrekt JSON-struktur per API Guide v4.26

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

// Generer unik entity-ID
function generateEntityId(suffix = "1") {
  const id = "ID" + String(suffix).padStart(32, "0");
  return id.slice(0, 34);
}

// Attributter som tilhører nested entities (ikke top-level)
const ENTITY_ATTRIBUTE_MAP = {
  "1": ["17", "18", "19", "20", "21"],     // Aircraft entity
  "4": ["90", "91", "92"],                  // Aerodrome entity
  "14": ["390"],                            // Event entity
};

// -------------------------
// Value-list validation
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
    .select("*")
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
    if (String(error.code) === "42P01") return null;
    throw error;
  }
  return data || [];
}

async function getValueDescription(supabase, vlKey, valueId) {
  const { data } = await supabase
    .schema("eccairs")
    .from("value_list_items")
    .select("value_description")
    .eq("value_list_key", vlKey)
    .eq("value_id", String(valueId))
    .maybeSingle();
  return data?.value_description || null;
}

// -------------------------
// Build selections
// -------------------------
async function buildSelections({ supabase, incident_id, company_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);

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

  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  const integration = await loadIntegrationSettings(supabase, company_id);
  const selections = [];

  // 431 - Occurrence Class (påkrevd, top-level)
  const validOccurrenceClasses = [100, 200, 300, 301, 302, 400, 500, 501, 502];
  const occurrenceClass = validOccurrenceClasses.includes(Number(wide.occurrence_class)) 
    ? Number(wide.occurrence_class) 
    : 300;
  selections.push({
    code: "431",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(occurrenceClass)
  });

  // 453 - Responsible Entity (top-level)
  const responsibleEntity = integration?.responsible_entity_id || 133;
  selections.push({
    code: "453",
    taxonomy_code: "24",
    format: "value_list_int_array",
    valueId: String(responsibleEntity)
  });

  // 1072 - Phase of Flight (krever content-array format)
  if (wide.phase_of_flight) {
    const description = await getValueDescription(supabase, 'VL1072', wide.phase_of_flight);
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      format: "content_array",  // Nytt format for content: [...]
      valueId: String(wide.phase_of_flight),
      text: description || "Unknown"
    });
  }

  // 17 - Aircraft Category (ENTITY 1, ikke top-level!)
  if (wide.aircraft_category) {
    selections.push({
      code: "17",
      taxonomy_code: "24",
      format: "value_list_int_array",
      valueId: String(wide.aircraft_category),
      entityCode: "1"  // Marker at dette tilhører Entity 1 (Aircraft)
    });
  }

  return { source: "incident_eccairs_mappings", selections };
}

// -------------------------
// Convert selection to E2 value
// -------------------------
function selectionToE2Value(sel) {
  if (sel.format === "raw_json") {
    return sel.raw;
  }

  // Content array - content må være en array
  if (sel.format === "content_array") {
    if (sel.text) {
      return [{ content: [sel.text] }];  // FIKSET: content er array
    }
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ content: [n] }];  // FIKSET: content er array
  }

  // Text content array (for narrativer)
  if (sel.format === "text_content_array") {
    if (!sel.text) return null;
    return [{ text: sel.text }];
  }

  // Value-list integer array (standard)
  if (sel.format === "value_list_int_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [n];  // Bare integer i array
  }

  // Date format
  if (sel.format === "date_array" || sel.format === "local_date") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // Fallback
  if (sel.raw) return sel.raw;
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
  const topLevelAttrs = {};
  const entityAttrs = {};  // Gruppert per entity

  const filtered = selections.filter((s) => 
    (ensureString(s.taxonomy_code) || "24") === "24"
  );

  // Valider value-list seleksjoner
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
        rejected.push({ 
          attribute_code: sel.code, 
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
        reason: `No value for format=${sel.format}` 
      });
      continue;
    }

    // Sjekk om attributtet tilhører en entity
    if (sel.entityCode) {
      if (!entityAttrs[sel.entityCode]) entityAttrs[sel.entityCode] = {};
      entityAttrs[sel.entityCode][sel.code] = v;
    } else {
      topLevelAttrs[sel.code] = v;
    }
  }

  // Sett top-level attributter
  taxBlock["24"].ATTRIBUTES = topLevelAttrs;

  // Bygg ENTITIES-struktur for nested attributter
  for (const [entityCode, attrs] of Object.entries(entityAttrs)) {
    if (Object.keys(attrs).length > 0) {
      taxBlock["24"].ENTITIES[entityCode] = [{
        ID: generateEntityId(entityCode),
        ATTRIBUTES: attrs
      }];
    }
  }

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
    usedCount: Object.keys(topLevelAttrs).length + Object.values(entityAttrs).reduce((sum, a) => sum + Object.keys(a).length, 0),
    selectionsCount: selections.length,
    rejected,
    topLevelAttributes: topLevelAttrs,
    entityAttributes: entityAttrs,
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
  loadIncidentAttributesGeneric,
  loadIntegrationSettings,
  selectionToE2Value,
  generateEntityId,
};
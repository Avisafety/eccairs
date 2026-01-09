// ECCAIRS2 E2 API Payload Builder
// Oppdatert for korrekt JSON-struktur per API Guide v4.26
// Synkronisert med Lovable frontend config

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

// Generer unik entity-ID (34 tegn)
function generateEntityId(suffix = "1") {
  const id = "ID" + String(suffix).padStart(32, "0");
  return id.slice(0, 34);
}

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
    .select("attribute_code, value_id, taxonomy_code, format, payload_json, text_value, entity_path")
    .eq("incident_id", incident_id);

  if (error) {
    if (String(error.code) === "42P01") return null;
    throw error;
  }
  return data || [];
}

// -------------------------
// Build selections fra incident_eccairs_attributes
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
        entity_path: r.entity_path || null,  // NYTT: Les entity_path fra database
      });
    }
    return { source: "incident_eccairs_attributes", selections };
  }

  // Fallback til legacy incident_eccairs_mappings
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
    entity_path: null,
    format: "value_list_int_array",
    valueId: String(occurrenceClass)
  });

  // 453 - Responsible Entity (top-level)
  const responsibleEntity = integration?.responsible_entity_id || 133;
  selections.push({
    code: "453",
    taxonomy_code: "24",
    entity_path: null,
    format: "value_list_int_array",
    valueId: String(responsibleEntity)
  });

  // 1072 - Detection Phase (FIKSET: content_object_array med integer)
  if (wide.phase_of_flight) {
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      entity_path: null,
      format: "content_object_array",  // FIKSET: Riktig format-navn
      valueId: String(wide.phase_of_flight)  // Integer ID, ikke tekst!
    });
  }

  // 32 - Aircraft Category (FIKSET: Entity 4, ikke Entity 1!)
  if (wide.aircraft_category) {
    selections.push({
      code: "32",  // FIKSET: Var 17, nå 32
      taxonomy_code: "24",
      entity_path: "4",  // FIKSET: Aircraft entity (var "1")
      format: "value_list_int_array",
      valueId: String(wide.aircraft_category)
    });
  }

  return { source: "incident_eccairs_mappings", selections };
}

// -------------------------
// Convert selection to E2 value
// -------------------------
function selectionToE2Value(sel) {
  // 1. Raw JSON (for manuell overstyring)
  if (sel.format === "raw_json") {
    return sel.raw;
  }

  // 2. Content object array - FIKSET: content må være integer array
  // Brukes for: 1072 (Detection Phase), 454, etc.
  if (sel.format === "content_object_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [{ content: [n] }];  // RIKTIG: [{"content": [10]}], ikke [{"content": ["Approach"]}]
  }

  // 3. Text content array (for narrativer, 1087 etc.)
  if (sel.format === "text_content_array") {
    if (!sel.text) return null;
    return [{ text: sel.text }];
  }

  // 4. Value-list integer array (standard for 431, 453, 32, 390, 391 etc.)
  if (sel.format === "value_list_int_array") {
    const n = asInt(sel.valueId);
    if (n == null) return null;
    return [n];  // RIKTIG: [200], ikke [{"value": 200}]
  }

  // 5. Local date (433)
  if (sel.format === "local_date" || sel.format === "date_array") {
    if (!sel.text) return null;
    return [sel.text];  // ["2024-01-15"]
  }

  // 6. String array (440 Location Name, etc.)
  if (sel.format === "string_array") {
    if (!sel.text) return null;
    return [sel.text];  // ["Oslo"]
  }

  // 7. Time array (457 Local Time)
  if (sel.format === "time_array") {
    if (!sel.text) return null;
    return [sel.text];  // ["14:30:00"]
  }

  // Fallback
  if (sel.raw) return sel.raw;
  const n = asInt(sel.valueId);
  return n == null ? null : [n];
}

// -------------------------
// Main payload builder
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
  const entityAttrs = {};  // Gruppert per entity_path

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
    // Valider value-list verdier mot eccairs.value_list_items
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

    // FIKSET: Bruk entity_path fra database/selection
    if (sel.entity_path) {
      if (!entityAttrs[sel.entity_path]) entityAttrs[sel.entity_path] = {};
      entityAttrs[sel.entity_path][sel.code] = v;
    } else {
      topLevelAttrs[sel.code] = v;
    }
  }

  // Sett top-level attributter
  taxBlock["24"].ATTRIBUTES = topLevelAttrs;

  // Bygg ENTITIES-struktur for nested attributter
  for (const [entityPath, attrs] of Object.entries(entityAttrs)) {
    if (Object.keys(attrs).length > 0) {
      taxBlock["24"].ENTITIES[entityPath] = [{
        ID: generateEntityId(entityPath),
        ATTRIBUTES: attrs
      }];
    }
  }

  // Fjern tom ENTITIES hvis ingen entity-attributter
  if (Object.keys(taxBlock["24"].ENTITIES).length === 0) {
    delete taxBlock["24"].ENTITIES;
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
    usedCount: Object.keys(topLevelAttrs).length + 
      Object.values(entityAttrs).reduce((sum, a) => sum + Object.keys(a).length, 0),
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
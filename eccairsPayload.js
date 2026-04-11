// ECCAIRS2 E2 API Payload Builder
// Oppdatert for korrekt JSON-struktur per API Guide v4.26
// Støtter CREATE, EDIT og DELETE operasjoner

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

// Shared parser for valueId - handles both JSON arrays like '["1116"]' and plain strings like "5"
function parseValueIds(valueId) {
  if (!valueId) return null;
  try {
    if (typeof valueId === 'string' && valueId.startsWith('[')) {
      const arr = JSON.parse(valueId);
      const ids = (Array.isArray(arr) ? arr : [arr]).map(v => asInt(v)).filter(n => n != null);
      return ids.length > 0 ? ids : null;
    }
  } catch (e) { /* fall through */ }
  const n = asInt(valueId);
  return n != null ? [n] : null;
}

// Generer unik entity-ID (34 tegn)
function generateEntityId(suffix = "1") {
  const id = "ID" + String(suffix).padStart(32, "0");
  return id.slice(0, 34);
}

// Bestem rapport-type fra e2Id prefix
function getReportType(e2Id) {
  if (!e2Id) return 'OR';
  if (e2Id.startsWith('VR-')) return 'VR';
  if (e2Id.startsWith('OC-')) return 'OC';
  return 'OR';
}

// Extract numeric part from e2Id (e.g., "OR-0000000000073873" -> "0000000000073873")
function getE2IdNumericPart(e2Id) {
  if (!e2Id) return e2Id;
  // Remove prefix (OR-, VR-, OC-)
  return e2Id.replace(/^(OR|VR|OC)-/, '');
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
// Entity path overrides - attributter som alltid må ligge under en spesifikk entitet
// -------------------------
const ENTITY_PATH_OVERRIDES = {
  '390': '14',   // Event_Type -> Events entity (Entity 14)
  '391': '14',   // Risk Classification -> Events entity (Entity 14)
  '1065': '53',  // Risk classification (internal) -> Reporting history (Entity 53)
  '1068': '53',  // Risk assessment -> Reporting history (Entity 53)
  '32': '4',     // Aircraft Category -> Aircraft entity (Entity 4)
  '215': '4',    // Operator -> Aircraft entity (Entity 4)
  
  '438': '53',   // Report identification -> Reporting history (Entity 53)
  '447': '53',   // Reporting entity -> Reporting history (Entity 53)
  '476': '53',   // Report source -> Reporting history (Entity 53)
  '495': '53',   // Reporting form type -> Reporting history (Entity 53)
  '800': '53',   // Report status -> Reporting history (Entity 53)
  '801': '53',   // Reporting date -> Reporting history (Entity 53)
  '802': '53',   // Report (attachments) -> Reporting history (Entity 53)
  '1064': '53',  // Parties informed -> Reporting history (Entity 53)
  '1091': '53',  // Reporter's Language -> Reporting history (Entity 53)
  '1092': '53',  // Reporter's Description -> Reporting history (Entity 53)
  '646': '4',    // Birds/wildlife seen -> Aircraft entity (Entity 4)
  '647': '4',    // Birds/wildlife struck -> Aircraft entity (Entity 4)
  '648': '4',    // Bird size -> Aircraft entity (Entity 4)
  '649': '4',    // Pilot advised of birds -> Aircraft entity (Entity 4)
};

// -------------------------
// Attributes to skip (removed/invalid fields that may still exist in DB)
// -------------------------
const SKIP_ATTRIBUTES = new Set(['216', '393', '394']);

// -------------------------
// Attributes that must ALWAYS be at top-level (Entity 24) regardless of DB value
// -------------------------
const FORCE_TOP_LEVEL = new Set(['432', '448']);

// -------------------------
// Format overrides - force correct format for attributes where DB rows may have wrong format
// -------------------------
const FORMAT_OVERRIDES = {
  '454': 'code_and_additional_text', // State/area of occurrence - E2 spec: Code and Additional Text
  '495': 'content_object_array',   // Reporting form type - E2 expects content_object_array
  '1064': 'content_object_array',  // Parties informed - E2 expects content_object_array
};

// -------------------------
// Max length constraints per E2 schema
// -------------------------
const MAX_LENGTH = {
  '244': 11, // Aircraft serial number - E2 allows max 11 chars
};

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
      if (SKIP_ATTRIBUTES.has(code)) continue;
      
      // Force certain attributes to top-level, ignoring any stored entity_path
      let entityPath;
      if (FORCE_TOP_LEVEL.has(code)) {
        entityPath = null;
      } else {
        entityPath = r.entity_path || ENTITY_PATH_OVERRIDES[code] || null;
      }
      
      
      // Apply format overrides for attributes where DB may have wrong format
      const format = FORMAT_OVERRIDES[code] || ensureString(r.format) || "value_list_int_array";
      
      // Apply max length truncation for string values
      let textValue = ensureString(r.text_value);
      if (textValue && MAX_LENGTH[code]) {
        textValue = textValue.slice(0, MAX_LENGTH[code]);
      }
      
      selections.push({
        code,
        taxonomy_code: ensureString(r.taxonomy_code) || "24",
        format,
        valueId: ensureString(r.value_id),
        text: textValue,
        raw: r.payload_json || null,
        entity_path: entityPath,
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

  // 1072 - Detection Phase
  if (wide.phase_of_flight) {
    selections.push({
      code: "1072",
      taxonomy_code: "24",
      entity_path: null,
      format: "content_object_array",
      valueId: String(wide.phase_of_flight)
    });
  }

  // 32 - Aircraft Category (Entity 4)
  if (wide.aircraft_category) {
    selections.push({
      code: "32",
      taxonomy_code: "24",
      entity_path: "4",
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

  // 2. Content object array - content må være integer array
  if (sel.format === "content_object_array") {
    const ids = parseValueIds(sel.valueId);
    if (!ids) return null;
    return ids.map(n => ({ content: [n] }));
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
    return [n];
  }

  // 4b. Code and additional text (e.g. 215 Operator - integer code + free text name)
  if (sel.format === "code_and_additional_text") {
    const ids = parseValueIds(sel.valueId);
    if (!ids) return null;
    return ids.map((n, i) => {
      if (i === 0 && sel.text) {
        return { content: [n], additionalText: sel.text };
      }
      return { content: [n] };
    });
  }

  // 5. Local date (433)
  if (sel.format === "local_date" || sel.format === "date_array") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // 6. UTC date (477) - same format as local_date
  if (sel.format === "utc_date") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // 7. Local time (457) - format HH:MM eller HH:MM:SS
  if (sel.format === "local_time" || sel.format === "time_array") {
    if (!sel.text) return null;
    // Sørg for HH:MM:SS format hvis bare HH:MM
    const timeValue = sel.text;
    if (timeValue.match(/^\d{2}:\d{2}$/)) {
      return [timeValue + ':00'];
    }
    return [timeValue];
  }

  // 8. String array (440 Location Name, 601 Headline, etc.)
  if (sel.format === "string_array") {
    if (!sel.text) return null;
    return [sel.text];
  }

  // Fallback
  if (sel.raw) return sel.raw;
  const n = asInt(sel.valueId);
  return n == null ? null : [n];
}

// -------------------------
// Build DELETE request info
// API Guide v4.26:
//  - DELETE {BASE_URL}/occurrences/delete-draft/OR/{e2Id}
//  - Body must be empty
//  - e2Id is the full identifier, e.g. "OR-0000000000000010"
// -------------------------
function buildDeleteRequest({ e2Id, environment }) {
  if (!e2Id) {
    throw new Error('e2_id is required for delete operation');
  }

  const baseUrl = environment === 'prod'
    ? 'https://api.aviationreporting.eu'
    : 'https://api.intg-aviationreporting.eu';

  const type = getReportType(e2Id);
  const encodedE2Id = encodeURIComponent(String(e2Id));

  return {
    method: 'DELETE',
    url: `${baseUrl}/occurrences/delete-draft/${type}/${encodedE2Id}`,
    headers: {
      'Accept': 'application/json'
    },
    body: null, // DELETE må ha tom body per API-dokumentasjon
    meta: {
      e2Id,
      type,
      environment,
      operation: 'delete'
    }
  };
}

// -------------------------
// Main payload builder
// -------------------------
async function buildE2Payload({ supabase, incident, exportRow, integration, environment, mode, versionType }) {
  const { selections, source } = await buildSelections({
    supabase,
    incident_id: incident.id,
    company_id: integration?.company_id || incident.company_id
  });

  const rejected = [];
  const topLevelAttrs = {};
  const entityAttrs = {};

  const filtered = selections.filter((s) =>
    (ensureString(s.taxonomy_code) || "24") === "24"
  );

  // Valider value-list seleksjoner (including code_and_additional_text which also uses VL codes)
  const valueListCandidates = filtered
    .filter((s) => s.format === "value_list_int_array" || s.format === "code_and_additional_text")
    .filter((s) => s.valueId)
    .map((s) => ({ code: s.code, valueId: s.valueId }));

  const validSet = await validateValueListSelections(supabase, valueListCandidates);

  for (const sel of filtered) {
    if (sel.format === "value_list_int_array" || sel.format === "code_and_additional_text") {
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

    if (sel.entity_path) {
      if (!entityAttrs[sel.entity_path]) entityAttrs[sel.entity_path] = {};
      entityAttrs[sel.entity_path][sel.code] = v;
    } else {
      topLevelAttrs[sel.code] = v;
    }
  }

  // Mode-basert payload-bygging
  let payload;
  const effectiveMode = mode || 'create';

  if (effectiveMode === 'edit' || effectiveMode === 'update') {
    // ========================
    // EDIT MODE - Oppdater eksisterende draft
    // ========================
    if (!exportRow?.e2_id) {
      throw new Error('e2_id is required for edit mode');
    }

    // Bygg taxonomyCodes UTEN top-level ID
    const editTaxBlock = {
      "24": {
        ATTRIBUTES: topLevelAttrs,
      }
    };

    // Legg til ENTITIES kun hvis det er noen
    if (Object.keys(entityAttrs).length > 0) {
      editTaxBlock["24"].ENTITIES = {};
      for (const [entityPath, attrs] of Object.entries(entityAttrs)) {
        if (Object.keys(attrs).length > 0) {
          editTaxBlock["24"].ENTITIES[entityPath] = [{
            ID: generateEntityId(entityPath),
            ATTRIBUTES: attrs
          }];
        }
      }
    }

    payload = {
      e2Id: exportRow.e2_id,
      versionType: versionType || "DRAFT", // DRAFT, MINOR, eller MAJOR
      taxonomyCodes: editTaxBlock,
    };

  } else {
    // ========================
    // CREATE MODE - Ny rapport
    // ========================
    const createTaxBlock = {
      "24": {
        ID: "ID00000000000000000000000000000001",
        ATTRIBUTES: topLevelAttrs,
      }
    };

    // Legg til ENTITIES kun hvis det er noen
    if (Object.keys(entityAttrs).length > 0) {
      createTaxBlock["24"].ENTITIES = {};
      for (const [entityPath, attrs] of Object.entries(entityAttrs)) {
        if (Object.keys(attrs).length > 0) {
          createTaxBlock["24"].ENTITIES[entityPath] = [{
            ID: generateEntityId(entityPath),
            ATTRIBUTES: attrs
          }];
        }
      }
    }

    payload = {
      type: "REPORT",
      status: "DRAFT",
      taxonomyCodes: createTaxBlock,
    };
  }

  const meta = {
    mode: effectiveMode,
    versionType: effectiveMode === 'edit' ? (versionType || 'DRAFT') : null,
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
    e2Id: exportRow?.e2_id || null,
    e2Version: exportRow?.e2_version || null,
  };

  return { payload, meta };
}

module.exports = {
  buildE2Payload,
  buildDeleteRequest,
  toAttributeCode,
  loadIncidentAttributesGeneric,
  loadIntegrationSettings,
  selectionToE2Value,
  generateEntityId,
  getReportType,
};

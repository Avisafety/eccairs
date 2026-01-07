// eccairsPayload.js
// ---------------------------------------------
// Bygger E2 payload basert på AviSafe-data
// Støtter:
//  - incident_eccairs_mappings (wide table)
//  - evt. incident_eccairs_attributes (generic, senere)
//
// VIKTIG:
// - Lovable lagrer attribute code som "431" (IKKE "VL431")
// - Supabase-taxonomi bruker value_list_key = "VL431"
// - E2 API forventer attributeCode = "431"
//
// Taxonomi-tabell:
//   eccairs.value_list_items
//     - value_list_key (text)  -> "VL431"
//     - value_id        (text) -> "300"
// ---------------------------------------------

/**
 * Normaliser attribute code
 *  "431"   -> "431"
 *  "VL431" -> "431"
 */
function toAttributeCode(codeOrVlKey) {
  if (!codeOrVlKey) return null;
  const s = String(codeOrVlKey).trim();

  if (/^\d+$/.test(s)) return s;

  const m = s.match(/^vl(\d+)$/i);
  if (m) return m[1];

  return null;
}

function ensureString(v) {
  if (v == null) return null;
  return String(v);
}

/**
 * E2 value-list format
 *  { "431": [{ value: "300" }] }
 */
function asValueListAttr(valueId) {
  const v = ensureString(valueId);
  if (!v) return null;
  return [{ value: v }];
}

/**
 * Valider at (attributeCode, valueId) finnes i taxonomi
 * Matcher mot:
 *   value_list_key = "VL" + attributeCode
 *   value_id       = valueId
 */
async function validateValueListSelections(supabase, selections) {
  const valid = new Set();

  const byCode = new Map();
  for (const s of selections) {
    if (!s?.code || !s?.valueId) continue;
    if (!byCode.has(s.code)) byCode.set(s.code, new Set());
    byCode.get(s.code).add(String(s.valueId));
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

/**
 * Les fra "wide table" (nåværende løsning)
 */
async function loadIncidentMappingsWide(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_mappings")
    .select("incident_id, occurrence_class, phase_of_flight, aircraft_category")
    .eq("incident_id", incident_id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * Les fra generic table (valgfritt, fremtid)
 */
async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id")
    .eq("incident_id", incident_id);

  if (error) {
    if (String(error.code) === "42P01") return null; // table missing
    throw error;
  }
  return data || [];
}

/**
 * Bygg liste over { code, valueId }
 */
async function buildSelections({ supabase, incident_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);
  if (generic && generic.length > 0) {
    return {
      source: "incident_eccairs_attributes",
      selections: generic
        .map(r => ({
          code: toAttributeCode(r.attribute_code),
          valueId: ensureString(r.value_id),
        }))
        .filter(r => r.code && r.valueId),
    };
  }

  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  const selections = [];
  if (wide.occurrence_class)
    selections.push({ code: "431", valueId: wide.occurrence_class });
  if (wide.phase_of_flight)
    selections.push({ code: "1072", valueId: wide.phase_of_flight });
  if (wide.aircraft_category)
    selections.push({ code: "17", valueId: wide.aircraft_category });

  return { source: "incident_eccairs_mappings", selections };
}

/**
 * HOVEDFUNKSJON
 * Bygger korrekt E2 payload
 */
async function buildE2Payload({ supabase, incident }) {
  const payload = {
    type: "REPORT",
    status: "DRAFT",
    taxonomyCodes: {
      "24": {
        ID: "ID00000000000000000000000000000001",
        ATTRIBUTES: {},
        ENTITIES: {},
      },
    },
  };

  const { selections, source } = await buildSelections({
    supabase,
    incident_id: incident.id,
  });

  const validSet = await validateValueListSelections(supabase, selections);

  const attrs = {};
  const rejected = [];

  for (const sel of selections) {
    const code = sel.code;
    const valueId = sel.valueId;
    const key = `VL${code}:${valueId}`;

    if (!validSet.has(key)) {
      rejected.push({
        attribute_code: code,
        value_id: valueId,
        reason: "Not found in eccairs.value_list_items",
      });
      continue;
    }

    attrs[code] = asValueListAttr(valueId);
  }

  payload.taxonomyCodes["24"].ATTRIBUTES = attrs;

  return {
    payload,
    meta: {
      source,
      selectionsCount: selections.length,
      rejected,
    },
  };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
};
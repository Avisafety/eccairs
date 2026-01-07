// eccairsPayload.js
// ---------------------------------------------
// Bygger E2 payload basert på AviSafe-data
//
// Støtter:
//  - incident_eccairs_mappings (wide table)
//  - incident_eccairs_attributes (generic table, valgfritt)
//
// VIKTIG:
// - Lovable lagrer attribute code som "431" (IKKE "VL431")
// - Supabase-taxonomi bruker value_list_key = "VL431"
// - E2 API forventer attributeCode = "431"
// - E2 validering (i ditt miljø) forventer INTEGERS i ATTRIBUTES for value-lists
//
// Taxonomi-tabell (din):
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
  if (codeOrVlKey == null) return null;
  const s = String(codeOrVlKey).trim();
  if (!s) return null;

  // "431"
  if (/^\d+$/.test(s)) return s;

  // "VL431" / "vl431"
  const m = s.match(/^vl(\d+)$/i);
  if (m) return m[1];

  return null;
}

function ensureString(v) {
  if (v == null) return null;
  const s = String(v);
  return s.trim() ? s : null;
}

/**
 * E2 value-list format (per E2-valideringen du ser):
 *   ATTRIBUTES["431"] = [200]
 *
 * Vi konverterer valueId til number og sender array.
 */
function asE2ValueListAttr(valueId) {
  const s = ensureString(valueId);
  if (!s) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return [n];
}

/**
 * Valider at (attributeCode, valueId) finnes i taxonomi.
 * Matcher mot:
 *   value_list_key = "VL" + attributeCode
 *   value_id       = valueId
 */
async function validateValueListSelections(supabase, selections) {
  const valid = new Set();

  // grupper per code
  const byCode = new Map();
  for (const sel of selections) {
    if (!sel?.code || !sel?.valueId) continue;
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
 * Les fra generic table (valgfritt)
 */
async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id")
    .eq("incident_id", incident_id);

  if (error) {
    // 42P01 = undefined_table (hvis den ikke finnes enda)
    if (String(error.code) === "42P01") return null;
    throw error;
  }

  return data || [];
}

/**
 * Tillatte attribute codes i MVP for DRAFT CREATE.
 * Basert på feilen du fikk: 17/1072 ble avvist/feil format.
 *
 * Vi starter med 431 (occurrence class) for å få create til å lykkes.
 */
const MVP_ALLOWED_CODES = new Set(["431"]);

/**
 * Bygg liste over { code, valueId } fra:
 *  - generic (om finnes) ellers wide
 */
async function buildSelections({ supabase, incident_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);
  if (generic && generic.length > 0) {
    const selections = generic
      .map((r) => ({
        code: toAttributeCode(r.attribute_code),
        valueId: ensureString(r.value_id),
      }))
      .filter((r) => r.code && r.valueId);

    return { source: "incident_eccairs_attributes", selections };
  }

  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  const selections = [];

  // occurrence_class -> 431
  if (wide.occurrence_class) {
    selections.push({ code: "431", valueId: wide.occurrence_class });
  }

  // Skipper disse foreløpig til vi har korrekt E2-format/placement:
  // phase_of_flight  -> 1072
  // aircraft_category-> 17
  // if (wide.phase_of_flight) selections.push({ code: "1072", valueId: wide.phase_of_flight });
  // if (wide.aircraft_category) selections.push({ code: "17", valueId: wide.aircraft_category });

  return { source: "incident_eccairs_mappings", selections };
}

/**
 * HOVEDFUNKSJON
 * Bygger E2 payload
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

  // Filtrer selections til MVP (kun 431) for å sikre create lykkes
  const filtered = [];
  const rejected = [];

  for (const sel of selections) {
    const code = toAttributeCode(sel.code);
    const valueId = ensureString(sel.valueId);

    if (!code || !valueId) continue;

    if (!MVP_ALLOWED_CODES.has(code)) {
      rejected.push({
        attribute_code: code,
        value_id: valueId,
        reason: "Skipped in MVP (not yet supported in create payload)",
      });
      continue;
    }

    filtered.push({ code, valueId });
  }

  // Valider mot taxonomi
  const validSet = await validateValueListSelections(supabase, filtered);

  const attrs = {};
  for (const sel of filtered) {
    const code = sel.code;
    const valueId = sel.valueId;

    const taxKey = `VL${code}:${valueId}`;
    if (!validSet.has(taxKey)) {
      rejected.push({
        attribute_code: code,
        value_id: valueId,
        reason: "Not found in eccairs.value_list_items (value_list_key/value_id mismatch)",
      });
      continue;
    }

    const e2Val = asE2ValueListAttr(valueId);
    if (!e2Val) {
      rejected.push({
        attribute_code: code,
        value_id: valueId,
        reason: "Value is not numeric (cannot send as integer list to E2)",
      });
      continue;
    }

    attrs[code] = e2Val;
  }

  payload.taxonomyCodes["24"].ATTRIBUTES = attrs;

  return {
    payload,
    meta: {
      source,
      selectionsCount: selections.length,
      usedCount: filtered.length,
      rejected,
      attributes: attrs, // nyttig for debugging
    },
  };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
};
// eccairsPayload.js
// Bygger E2 payload basert på:
//  1) incident_eccairs_mappings (dine kolonner) OG/ELLER
//  2) incident_eccairs_attributes (anbefalt, generic table) hvis du lager den senere
//
// Viktig: Lovable bruker nå "431" (attribute code), ikke "VL431".
// Derfor støtter vi direkte attribute codes, men tåler også "VL431" som fallback.
//
// Krever at Supabase taxonomi-tabell finnes:
//  eccairs.value_list_items
// med minst kolonnene: value_list_id (int), value_id (text)

function toAttributeCode(codeOrVlKey) {
  if (codeOrVlKey == null) return null;

  const s = String(codeOrVlKey).trim();

  // "431" -> "431"
  if (/^\d+$/.test(s)) return s;

  // "VL431" / "vl431" -> "431"
  const m = s.match(/^vl(\d+)$/i);
  if (m) return m[1];

  return null;
}

function ensureString(val) {
  if (val == null) return null;
  return String(val);
}

function asValueListAttr(valueId) {
  // E2 value-list format: [{ value: "300" }]
  const v = ensureString(valueId);
  if (!v) return null;
  return [{ value: v }];
}

/**
 * Valider at (attributeCode,valueId) finnes i eccairs.value_list_items:
 *  value_list_id = attributeCode
 *  value_id      = valueId
 */
async function validateValueListSelections(supabase, selections) {
  // selections: [{ code: "431", valueId: "300" }, ...]
  const valid = new Set();

  // Gruppér per code for færre queries
  const byCode = new Map();
  for (const s of selections) {
    if (!s?.code || !s?.valueId) continue;
    if (!byCode.has(s.code)) byCode.set(s.code, new Set());
    byCode.get(s.code).add(String(s.valueId));
  }

  // Kjør en query per code (MVP). Kan optimaliseres senere.
  for (const [code, valueSet] of byCode.entries()) {
    const values = Array.from(valueSet);

    const { data, error } = await supabase
      .schema("eccairs")
      .from("value_list_items")
      .select("value_list_id, value_id")
      .eq("value_list_id", Number(code))
      .in("value_id", values);

    if (error) throw error;

    for (const row of data || []) {
      valid.add(`${row.value_list_id}:${row.value_id}`);
    }
  }

  return valid;
}

/**
 * Les mapping fra din "wide table" incident_eccairs_mappings.
 * Tilpass select/listen til dine faktiske kolonner.
 *
 * Denne funksjonen antar at kolonneverdiene er VALUE_ID (f.eks. "300"),
 * og at vi vet hvilke attribute codes de hører til.
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
 * Hvis du senere lager en generic table:
 * incident_eccairs_attributes(incident_id uuid, attribute_code int, value_id text, text_value text, ...)
 * da kan gateway lese ALT uten hardkoding.
 */
async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id, text_value")
    .eq("incident_id", incident_id);

  if (error) {
    // Hvis tabellen ikke finnes enda, bare returner null uten å kræsje
    // (Postgres: 42P01 undefined_table)
    if (String(error.code) === "42P01") return null;
    throw error;
  }
  return data || [];
}

/**
 * Bygg selections-listen (attributeCode + valueId) fra:
 *  A) wide mapping (hardkodet) eller
 *  B) generic mapping (hvis finnes)
 *
 * Du sa Lovable bruker/lagrer 431, så vi bygger på attribute codes direkte.
 */
async function buildSelections({ supabase, incident_id }) {
  // 1) prøv generic table først (hvis du lager den)
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);
  if (generic && generic.length > 0) {
    const selections = [];

    for (const row of generic) {
      const code = toAttributeCode(row.attribute_code);
      const valueId = ensureString(row.value_id);
      if (code && valueId) selections.push({ code, valueId });
      // text_value støttes senere (da blir det ikke value-list)
    }

    return { selections, source: "incident_eccairs_attributes" };
  }

  // 2) fallback: wide table (din nåværende)
  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { selections: [], source: "none" };

  // HER er “koblingen” mellom dine kolonner og E2 attribute codes:
  // occurrence_class -> 431
  // phase_of_flight  -> 1072
  // aircraft_category-> 17
  const selections = [];
  if (wide.occurrence_class) selections.push({ code: "431", valueId: wide.occurrence_class });
  if (wide.phase_of_flight) selections.push({ code: "1072", valueId: wide.phase_of_flight });
  if (wide.aircraft_category) selections.push({ code: "17", valueId: wide.aircraft_category });

  return { selections, source: "incident_eccairs_mappings" };
}

/**
 * Bygg E2 payload. Vi validerer value-list valg mot taxonomien.
 */
async function buildE2Payload({ supabase, incident, exportRow, integration, environment }) {
  // Base (minimal valid)
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

  // Valider mot taxonomy-tabellen du lastet opp
  const validSet = await validateValueListSelections(supabase, selections);

  const attrs = {};
  const rejected = [];

  for (const sel of selections) {
    const code = toAttributeCode(sel.code);
    const valueId = ensureString(sel.valueId);
    if (!code || !valueId) continue;

    const key = `${Number(code)}:${valueId}`;
    const ok = validSet.has(key);

    if (!ok) {
      rejected.push({ attribute_code: code, value_id: valueId, reason: "Not found in eccairs.value_list_items" });
      continue;
    }

    attrs[code] = asValueListAttr(valueId);
  }

  payload.taxonomyCodes["24"].ATTRIBUTES = attrs;

  return { payload, meta: { source, rejected, selectionsCount: selections.length } };
}

module.exports = {
  toAttributeCode,
  buildE2Payload,
};
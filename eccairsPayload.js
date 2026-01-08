// eccairsPayload.js
// ----------------------------------------------------
// Bygger E2 payload basert på AviSafe-data
//
// Støtter:
//  - incident_eccairs_mappings (wide table – fallback)
//  - incident_eccairs_attributes (generic table – anbefalt)
//
// VIKTIG (basert på E2-validering):
// - attributeCode er "431" (ikke "VL431")
// - Supabase-taxonomi bruker value_list_key = "VL431"
// - E2 forventer INTEGER-arrays i ATTRIBUTES for value-lists
//
// Taxonomi-tabell (Supabase):
//   eccairs.value_list_items
//     - value_list_key (text)  -> "VL431"
//     - value_id        (text) -> "300"
// ----------------------------------------------------

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

/**
 * E2 value-list format:
 *   ATTRIBUTES["431"] = [200]
 */
function asE2ValueListAttr(valueId) {
  const s = ensureString(valueId);
  if (!s) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return [n];
}

/**
 * Valider at (attributeCode, valueId) finnes i taxonomi:
 *   value_list_key = "VL" + attributeCode
 *   value_id       = valueId
 */
async function validateValueListSelections(supabase, selections) {
  const valid = new Set();

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

// -------------------------
// Loaders
// -------------------------
async function loadIncidentMappingsWide(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_mappings")
    .select("incident_id, occurrence_class, phase_of_flight, aircraft_category, responsible_entity")
    .eq("incident_id", incident_id)
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
    if (String(error.code) === "42P01") return null; // table missing
    throw error;
  }

  return data || [];
}

/**
 * MVP tillatt i CREATE akkurat nå.
 * Du kan utvide når du vet E2 aksepterer dem i taxonomy 24.
 */
const MVP_ALLOWED_CODES = new Set([
  "431", // Occurrence class
  "1072", // Phase of flight
  "17", // Aircraft category
  "453", // Responsible entity (hvis taxonomi faktisk finnes hos deg)
]);

/**
 * Bygger selections fra generic table hvis den har data,
 * ellers fallback til wide table.
 */
async function buildSelections({ supabase, incident_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);

  // Hvis du har gått “generic” fullt ut: bruk kun disse.
  if (generic && generic.length > 0) {
    const selections = [];

    for (const r of generic) {
      // taxonomy_code støttes, men vi bygger foreløpig kun taxonomy 24 i payload her
      const tax = ensureString(r.taxonomy_code) || "24";
      const code = toAttributeCode(r.attribute_code);
      const format = ensureString(r.format) || "value_list_int_array";

      // raw_json override (payload_json) – hvis du vil slippe value-list validering for spesial-case
      if (format === "raw_json" && r.payload_json) {
        selections.push({
          code,
          taxonomy_code: tax,
          kind: "raw_json",
          raw: r.payload_json,
        });
        continue;
      }

      // text_content_array (fritekst)
      if (format === "text_content_array" && ensureString(r.text_value)) {
        selections.push({
          code,
          taxonomy_code: tax,
          kind: "text_content_array",
          text: ensureString(r.text_value),
        });
        continue;
      }

      // default: value list (int array)
      const valueId = ensureString(r.value_id);
      if (code && valueId) {
        selections.push({
          code,
          taxonomy_code: tax,
          kind: "value_list_int_array",
          valueId,
        });
      }
    }

    return { source: "incident_eccairs_attributes", selections };
  }

  // fallback wide table
  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  const selections = [];

  if (wide.occurrence_class) selections.push({ code: "431", taxonomy_code: "24", kind: "value_list_int_array", valueId: wide.occurrence_class });
  if (wide.phase_of_flight) selections.push({ code: "1072", taxonomy_code: "24", kind: "value_list_int_array", valueId: wide.phase_of_flight });
  if (wide.aircraft_category) selections.push({ code: "17", taxonomy_code: "24", kind: "value_list_int_array", valueId: wide.aircraft_category });
  if (wide.responsible_entity) selections.push({ code: "453", taxonomy_code: "24", kind: "value_list_int_array", valueId: wide.responsible_entity });

  return { source: "incident_eccairs_mappings", selections };
}

/**
 * HOVEDFUNKSJON
 * Bygger E2 payload for CREATE (DRAFT)
 *
 * Returnerer alltid: { payload, meta }
 */
async function buildE2Payload({ supabase, incident, exportRow, integration, environment }) {
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

  const rejected = [];
  const filtered = [];

  // 1) Filtrer til taxonomy 24 + MVP_ALLOWED_CODES (for create)
  for (const sel of selections) {
    const code = toAttributeCode(sel.code);
    const tax = ensureString(sel.taxonomy_code) || "24";

    if (!code) continue;

    if (tax !== "24") {
      rejected.push({ attribute_code: code, taxonomy_code: tax, reason: "Skipped (only taxonomy 24 supported in CREATE builder right now)" });
      continue;
    }

    if (!MVP_ALLOWED_CODES.has(code)) {
      rejected.push({ attribute_code: code, taxonomy_code: tax, reason: "Skipped (not yet allowed in CREATE payload)" });
      continue;
    }

    // raw/text går rett gjennom uten value-list validering
    if (sel.kind === "raw_json") {
      filtered.push({ ...sel, code, taxonomy_code: tax });
      continue;
    }
    if (sel.kind === "text_content_array") {
      filtered.push({ ...sel, code, taxonomy_code: tax });
      continue;
    }

    // value list må ha valueId
    const valueId = ensureString(sel.valueId);
    if (!valueId) continue;

    filtered.push({ ...sel, code, taxonomy_code: tax, valueId });
  }

  // 2) Valider kun value-list selections mot taxonomi
  const valueListSelections = filtered
    .filter((s) => s.kind === "value_list_int_array")
    .map((s) => ({ code: s.code, valueId: s.valueId }));

  const validSet = await validateValueListSelections(supabase, valueListSelections);

  // 3) Bygg ATTRIBUTES
  const attrs = {};

  for (const sel of filtered) {
    if (sel.kind === "raw_json") {
      attrs[sel.code] = sel.raw;
      continue;
    }

    if (sel.kind === "text_content_array") {
      // E2 “content”-format
      attrs[sel.code] = [{ content: sel.text }];
      continue;
    }

    // value list
    const taxKey = `VL${sel.code}:${sel.valueId}`;
    if (!validSet.has(taxKey)) {
      rejected.push({
        attribute_code: sel.code,
        taxonomy_code: "24",
        value_id: sel.valueId,
        reason: "Not found in eccairs.value_list_items",
      });
      continue;
    }

    const e2Val = asE2ValueListAttr(sel.valueId);
    if (!e2Val) {
      rejected.push({
        attribute_code: sel.code,
        taxonomy_code: "24",
        value_id: sel.valueId,
        reason: "Value is not numeric (E2 requires integer array)",
      });
      continue;
    }

    attrs[sel.code] = e2Val;
  }

  payload.taxonomyCodes["24"].ATTRIBUTES = attrs;

  const meta = {
    source,
    environment: environment || null,
    incident_id: incident?.id || null,
    usedCount: Object.keys(attrs).length,
    selectionsCount: selections.length,
    rejected,
    attributes: attrs,
    export_id: exportRow?.id || null,
    company_id: integration?.company_id || null,
  };

  return { payload, meta };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
};
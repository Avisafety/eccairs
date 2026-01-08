// eccairsPayload.js
// ----------------------------------------------------
// Bygger E2 payload basert på AviSafe-data
//
// Støtter:
//  - incident_eccairs_mappings (wide table – nåværende)
//  - incident_eccairs_attributes (generic table – valgfritt / fremtid)
//
// VIKTIG (basert på faktisk E2-validering):
// - Lovable lagrer attribute code som "431" (IKKE "VL431")
// - Supabase-taxonomi bruker value_list_key = "VL431"
// - E2 API forventer attributeCode = "431"
// - E2 forventer INTEGER-arrays i ATTRIBUTES for value-lists
//
// Taxonomi-tabell (Supabase):
//   eccairs.value_list_items
//     - value_list_key (text)  -> "VL431"
//     - value_id        (text) -> "300"
//
// Endring i denne versjonen:
// - Ny robust batch-validering: validateValueListAttrsBatch()
//   (grupperer per VL-key og bruker .in() per VL, i stedet for sårbar OR-hack)
// ----------------------------------------------------

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
  const s = String(v).trim();
  return s || null;
}

/**
 * E2 value-list format (det som FAKTISK funker):
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
 * Robust batch-validering av value-list attributter mot taxonomi-tabellen.
 *
 * For hver VL-key (VL{attribute_code}) kjører vi en egen query:
 *  .eq('value_list_key', vlKey)
 *  .in('value_id', [...])
 *
 * Returnerer en struktur som kan brukes til:
 * - å bygge et Set med "VLxxx:valueId"
 * - å gi strukturerte valideringsfeil
 */
async function validateValueListAttrsBatch({ supabase, selections }) {
  // selections: [{ code: "431", valueId: "200" }, ...]
  const validSet = new Set();
  const validationErrors = [];

  if (!Array.isArray(selections) || selections.length === 0) {
    return { ok: true, validSet, validationErrors };
  }

  // Group per VL key
  // vlKey -> { values:Set<string>, checks:Array<{code,valueId}> }
  const byVlKey = new Map();

  for (const sel of selections) {
    const code = toAttributeCode(sel?.code);
    const valueId = ensureString(sel?.valueId);
    if (!code || !valueId) continue;

    const vlKey = `VL${code}`;

    if (!byVlKey.has(vlKey)) byVlKey.set(vlKey, { values: new Set(), checks: [] });
    const group = byVlKey.get(vlKey);
    group.values.add(valueId);
    group.checks.push({ code, valueId });
  }

  for (const [vlKey, group] of byVlKey.entries()) {
    const values = Array.from(group.values);

    const { data: validItems, error: valErr } = await supabase
      .schema("eccairs")
      .from("value_list_items")
      .select("value_list_key, value_id")
      .eq("value_list_key", vlKey)
      .in("value_id", values);

    if (valErr) {
      // Hard fail: vi kan ikke stole på videre validering
      return {
        ok: false,
        validSet,
        validationErrors: [
          {
            attribute_code: null,
            value_id: null,
            reason: `Taxonomy validation query failed for ${vlKey}: ${valErr.message || String(valErr)}`,
          },
        ],
      };
    }

    // Fill validSet
    for (const row of validItems || []) {
      validSet.add(`${row.value_list_key}:${row.value_id}`);
    }

    // Find missing
    for (const check of group.checks) {
      const key = `${vlKey}:${check.valueId}`;
      if (!validSet.has(key)) {
        validationErrors.push({
          attribute_code: check.code,
          value_id: check.valueId,
          reason: `Not found in eccairs.value_list_items for ${vlKey}`,
        });
      }
    }
  }

  return { ok: validationErrors.length === 0, validSet, validationErrors };
}

/**
 * Les fra "wide table" (nåværende løsning)
 */
async function loadIncidentMappingsWide(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_mappings")
    .select("incident_id, occurrence_class, phase_of_flight, aircraft_category, responsible_entity")
    .eq("incident_id", incident_id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * Les fra generic table (fremtid / valgfritt)
 */
async function loadIncidentAttributesGeneric(supabase, incident_id) {
  const { data, error } = await supabase
    .from("incident_eccairs_attributes")
    .select("attribute_code, value_id")
    .eq("incident_id", incident_id);

  if (error) {
    // 42P01 = table does not exist
    if (String(error.code) === "42P01") return null;
    throw error;
  }

  return data || [];
}

/**
 * Tillatte attribute codes i CREATE (MVP)
 * Utvides kontrollert etter hvert
 */
const MVP_ALLOWED_CODES = new Set([
  "431", // Occurrence class
  "453", // Responsible entity (f.eks. Norway = 133)
  // Når du vil utvide: legg til "1072", "17", osv (men først når E2-formatet er bekreftet i ditt miljø)
]);

/**
 * Bygg liste over { code, valueId }
 */
async function buildSelections({ supabase, incident_id }) {
  const generic = await loadIncidentAttributesGeneric(supabase, incident_id);
  if (generic && generic.length > 0) {
    return {
      source: "incident_eccairs_attributes",
      selections: generic
        .map((r) => ({
          code: toAttributeCode(r.attribute_code),
          valueId: ensureString(r.value_id),
        }))
        .filter((r) => r.code && r.valueId),
    };
  }

  const wide = await loadIncidentMappingsWide(supabase, incident_id);
  if (!wide) return { source: "none", selections: [] };

  const selections = [];

  // Occurrence class -> 431
  if (wide.occurrence_class) {
    selections.push({ code: "431", valueId: wide.occurrence_class });
  }

  // Responsible entity -> 453 (f.eks. Norway = 133)
  if (wide.responsible_entity) {
    selections.push({ code: "453", valueId: wide.responsible_entity });
  }

  // Andre attributter (1072, 17, osv.) tas senere når E2-format er bekreftet
  // if (wide.phase_of_flight) selections.push({ code: "1072", valueId: wide.phase_of_flight });
  // if (wide.aircraft_category) selections.push({ code: "17", valueId: wide.aircraft_category });

  return { source: "incident_eccairs_mappings", selections };
}

/**
 * HOVEDFUNKSJON
 * Bygger E2 payload for CREATE (DRAFT)
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
const updateRes = await fetch(`${E2_BASE_URL}/occurrences/edit`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    e2Id: exportRow.e2_id,
    version: exportRow.e2_version,
    ...payload, // taxonomyCodes osv.
  }),
});
  const { selections, source } = await buildSelections({
    supabase,
    incident_id: incident.id,
  });

  // 1) Filter til MVP allowed + sanity checks
  const filtered = [];
  const rejected = [];

  for (const sel of selections) {
    const code = toAttributeCode(sel?.code);
    const valueId = ensureString(sel?.valueId);

    if (!code || !valueId) continue;

    if (!MVP_ALLOWED_CODES.has(code)) {
      rejected.push({
        attribute_code: code,
        value_id: valueId,
        reason: "Skipped (not yet supported in CREATE payload)",
      });
      continue;
    }

    filtered.push({ code, valueId });
  }

  // 2) Taxonomy validation (robust batch)
  const { ok: taxOk, validSet, validationErrors } = await validateValueListAttrsBatch({
    supabase,
    selections: filtered,
  });

  if (!taxOk) {
    // Ikke throw – returner meta som gjør feilsøk lett
    return {
      payload,
      meta: {
        source,
        selectionsCount: selections.length,
        usedCount: 0,
        rejected: rejected.concat(validationErrors),
        attributes: {},
        taxonomyValidationFailed: true,
      },
    };
  }

  // 3) Build ATTRIBUTES with integer arrays
  const attrs = {};

  for (const sel of filtered) {
    const vlKey = `VL${sel.code}`;
    const taxKey = `${vlKey}:${sel.valueId}`;

    if (!validSet.has(taxKey)) {
      rejected.push({
        attribute_code: sel.code,
        value_id: sel.valueId,
        reason: "Not found in eccairs.value_list_items",
      });
      continue;
    }

    const e2Val = asE2ValueListAttr(sel.valueId);
    if (!e2Val) {
      rejected.push({
        attribute_code: sel.code,
        value_id: sel.valueId,
        reason: "Value is not numeric (E2 requires integer array)",
      });
      continue;
    }

    attrs[sel.code] = e2Val;
  }

  payload.taxonomyCodes["24"].ATTRIBUTES = attrs;

  return {
    payload,
    meta: {
      source,
      selectionsCount: selections.length,
      usedCount: Object.keys(attrs).length,
      rejected,
      attributes: attrs,
    },
  };
}

module.exports = {
  buildE2Payload,
  toAttributeCode,
};
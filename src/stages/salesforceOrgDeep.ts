import { objectsNamedIn } from "./salesforceOrgModel.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";

/**
 * Phase 1, slice 1: what the org's setup says beyond fields and picklists, read for the objects the
 * request names (SALESFORCE_DEEP_DISCOVERY_ENABLED, off by default).
 *
 * - Each record type's own create layout and picklist values, where they differ from the default
 *   one (scenario 1a: "choosing a record type renders the right layout and values").
 * - Dynamic Forms visibility rules from the object's Lightning record page (1d: "SLA shows only
 *   when Customer Priority = High"), read from FlexiPage metadata.
 * - What a calculated custom field computes: a formula, or a roll-up's operation and summed field
 *   (1e: "TB Total Opportunity Amount = sum of Opportunity.Amount").
 *
 * Shapes as the scratch org returned them on 2026-11-03 (tests/salesforceOrgDeep.test.ts holds
 * canary copies). READ-ONLY GETs, best effort: a call that fails leaves that fact out. Only for the
 * request's objects, and capped, because a scratch org's API allowance is small.
 */

type ApiGet = (path: string) => Promise<any>;
type OrgObject = SalesforceOrgModel["objects"][number];

export function deepDiscoveryEnabled(): boolean {
  return process.env.SALESFORCE_DEEP_DISCOVERY_ENABLED === "true";
}

/** Objects read deeply per run, and Lightning record pages opened per run. */
const MAX_DEEP_OBJECTS = 3;
const MAX_RECORD_PAGES = 4;

async function tryGet(apiGet: ApiGet, path: string): Promise<any | null> {
  try { return await apiGet(path); } catch { return null; }
}
const tooling = (apiGet: ApiGet, q: string) => tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(q)}`);
const safeName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

/** A field's label on this object, by API name; the API name when the model does not list it. */
function labelOf(o: OrgObject, api: string): string {
  return o.fields.find((f) => f.api === api)?.label ?? o.calculated?.find((c) => c.api === api)?.label ?? api;
}

/** The API names of the fields a UI API layout shows. */
export function layoutFields(layout: any): string[] {
  const out: string[] = [];
  for (const sec of layout?.sections ?? []) for (const row of sec?.layoutRows ?? []) for (const item of row?.layoutItems ?? []) {
    for (const c of item?.layoutComponents ?? []) {
      if (c?.componentType === "Field" && typeof c.apiName === "string" && !out.includes(c.apiName)) out.push(c.apiName);
    }
  }
  return out;
}

/** Picklist labels per field API name, from a UI API picklist-values response. */
export function picklistLabels(res: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [api, v] of Object.entries<any>(res?.picklistFieldValues ?? {})) {
    const labels = (v?.values ?? []).map((x: any) => String(x?.label ?? "")).filter(Boolean);
    if (labels.length) out[api] = labels;
  }
  return out;
}

/** How each non-default record type differs from the default one: fields only its create layout
 *  shows, and picklists whose values differ. Mutates `o.recordTypes`. */
async function readRecordTypeDifferences(apiGet: ApiGet, o: OrgObject): Promise<void> {
  const rts = o.recordTypes ?? [];
  const def = rts.find((r) => r.default);
  if (rts.length < 2 || !def) return;
  const enc = encodeURIComponent(o.api);
  const read = async (id: string) => ({
    fields: layoutFields(await tryGet(apiGet, `/ui-api/layout/${enc}?layoutType=Full&mode=Create&recordTypeId=${id}`)),
    picks: picklistLabels(await tryGet(apiGet, `/ui-api/object-info/${enc}/picklist-values/${id}`)),
  });
  const base = await read(def.id);
  for (const rt of rts) {
    if (rt.default) continue;
    const mine = await read(rt.id);
    const onlyFields = mine.fields.filter((f) => !base.fields.includes(f)).map((f) => labelOf(o, f));
    const picklists: Record<string, string[]> = {};
    for (const [api, values] of Object.entries(mine.picks)) {
      if (JSON.stringify(values) !== JSON.stringify(base.picks[api] ?? [])) picklists[labelOf(o, api)] = values;
    }
    if (onlyFields.length) rt.onlyFields = onlyFields.slice(0, 15);
    if (Object.keys(picklists).length) rt.picklists = picklists;
  }
}

const VIS_OPS: Record<string, string> = {
  EQUAL: "=", NE: "is not", GT: ">", LT: "<", GE: ">=", LE: "<=", CONTAINS: "contains",
};

/** One visibility rule as a plain condition: "Customer Priority = High". */
export function visibilityCondition(rule: any, o: OrgObject): string | undefined {
  const parts = (rule?.criteria ?? []).map((c: any) => {
    const m = /^\{!Record\.([A-Za-z0-9_]+)\}$/.exec(String(c?.leftValue ?? ""));
    const left = m ? labelOf(o, m[1]) : String(c?.leftValue ?? "");
    return `${left} ${VIS_OPS[c?.operator] ?? String(c?.operator ?? "").toLowerCase()} ${c?.rightValue ?? ""}`.trim();
  }).filter(Boolean);
  if (!parts.length) return undefined;
  const filter = String(rule?.booleanFilter ?? "").trim();
  if (!filter) return parts.join(" and ");
  if (/^[\d\s]+(OR[\d\s]+)+$/i.test(filter)) return parts.join(" or ");
  return `${parts.join("; ")} (combined as ${filter})`;
}

/** Visibility rules on one record page's metadata: fields by label, sections by their label. */
export function visibilityRulesOf(meta: any, o: OrgObject): { target: string; when: string }[] {
  const out: { target: string; when: string }[] = [];
  for (const region of meta?.flexiPageRegions ?? []) for (const it of region?.itemInstances ?? []) {
    const fi = it?.fieldInstance;
    if (fi?.visibilityRule) {
      const api = String(fi.fieldItem ?? "").replace(/^Record\./, "");
      const when = visibilityCondition(fi.visibilityRule, o);
      if (api && when) out.push({ target: labelOf(o, api), when });
    }
    const ci = it?.componentInstance;
    if (ci?.visibilityRule) {
      const label = (ci.componentInstanceProperties ?? []).find((p: any) => p?.name === "label")?.value;
      const when = visibilityCondition(ci.visibilityRule, o);
      if (when) out.push({ target: label ? `section "${label}"` : `component ${ci.componentName ?? ""}`.trim(), when });
    }
  }
  return out;
}

/** Visibility rules from the Lightning record pages of `objects`. Mutates each object. */
async function readVisibilityRules(apiGet: ApiGet, objects: OrgObject[]): Promise<void> {
  const res = await tooling(apiGet, "SELECT Id, DeveloperName, EntityDefinitionId FROM FlexiPage WHERE Type = 'RecordPage'");
  const rows: any[] = Array.isArray(res?.records) ? res.records : [];
  const apis = new Set(objects.map((o) => o.api));
  // A custom object's EntityDefinitionId is an id, not its name: such pages are opened and matched
  // by their metadata's sobjectType. A standard object's is its name.
  const candidates = rows.filter((r) => typeof r?.Id === "string" && safeName(r.Id)
    && (apis.has(String(r.EntityDefinitionId)) || /^01I/.test(String(r.EntityDefinitionId)))).slice(0, MAX_RECORD_PAGES);
  for (const r of candidates) {
    const meta = (await tooling(apiGet, `SELECT Metadata FROM FlexiPage WHERE Id = '${r.Id}'`))?.records?.[0]?.Metadata;
    const sobject = String(meta?.sobjectType ?? r.EntityDefinitionId ?? "");
    const o = objects.find((x) => x.api === sobject);
    if (!o) continue;
    const rules = visibilityRulesOf(meta, o);
    if (rules.length) o.visibilityRules = [...(o.visibilityRules ?? []), ...rules].slice(0, 20);
  }
}

/** A calculated custom field's definition from its metadata: "= <formula>" or "sum of Opportunity.Amount". */
export function calculatedDefinition(meta: any): string | undefined {
  if (typeof meta?.formula === "string" && meta.formula.trim()) return `= ${meta.formula.trim().replace(/\s+/g, " ")}`;
  const op = String(meta?.summaryOperation ?? "").toLowerCase();
  if (!op) return undefined;
  const of = op === "count" ? `${String(meta.summaryForeignKey ?? "").split(".")[0] || "child"} records`
    : String(meta.summarizedField ?? "");
  const filters = (meta.summaryFilterItems ?? []).map((f: any) => `${f.field} ${VIS_OPS[String(f.operation ?? "").toUpperCase()] ?? f.operation} ${f.value ?? ""}`.trim());
  return `${op} of ${of}${filters.length ? ` where ${filters.join(" and ")}` : ""}`.trim();
}

/** Definitions of the object's calculated CUSTOM fields (a standard computed field has none to read). */
async function readCalculatedDefinitions(apiGet: ApiGet, o: OrgObject): Promise<void> {
  for (const c of (o.calculated ?? []).filter((x) => /__c$/.test(x.api)).slice(0, 8)) {
    const dev = c.api.replace(/__c$/, "").replace(/^[A-Za-z0-9]+__/, "");
    if (!safeName(dev)) continue;
    const rows: any[] = (await tooling(apiGet, `SELECT Id, TableEnumOrId FROM CustomField WHERE DeveloperName = '${dev}'`))?.records ?? [];
    const row = rows.find((r) => r?.TableEnumOrId === o.api) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row || !safeName(String(row.Id))) continue;
    const meta = (await tooling(apiGet, `SELECT Metadata FROM CustomField WHERE Id = '${row.Id}'`))?.records?.[0]?.Metadata;
    const definition = calculatedDefinition(meta);
    if (definition) c.definition = definition;
  }
}

/** Lookup filter operations (FilterOperation) as words. */
const FILTER_OPS: Record<string, string> = {
  equals: "=", notEqual: "is not", lessThan: "<", greaterThan: ">", lessOrEqual: "<=", greaterOrEqual: ">=",
  contains: "contains", notContain: "does not contain", startsWith: "starts with", includes: "includes", excludes: "excludes",
};

/** A lookup filter from a custom lookup field's metadata, as words: "Type = Customer - Direct and ...". */
export function lookupFilterText(meta: any): string | undefined {
  const lf = meta?.lookupFilter;
  if (!lf || lf.active === false) return undefined;
  const items = (lf.filterItems ?? []).map((f: any) => `${String(f.field ?? "").replace(/^\$Source\./, "this record's ")} ${FILTER_OPS[String(f.operation ?? "")] ?? f.operation} ${f.value ?? String(f.valueField ?? "").replace(/^\$Source\./, "this record's ")}`.trim());
  if (!items.length) return undefined;
  return `${items.join(lf.booleanFilter ? ` (${lf.booleanFilter}) ` : " and ")}${lf.isOptional ? " (a suggestion only)" : ""}`;
}

/** Lookup filters of the object's custom lookup fields: what a case may pick in them. */
async function readLookupFilters(apiGet: ApiGet, o: OrgObject): Promise<void> {
  for (const f of o.fields.filter((x) => x.lookup && /__c$/.test(x.api)).slice(0, 5)) {
    const dev = f.api.replace(/__c$/, "").replace(/^[A-Za-z0-9]+__/, "");
    if (!safeName(dev)) continue;
    const rows: any[] = (await tooling(apiGet, `SELECT Id, TableEnumOrId FROM CustomField WHERE DeveloperName = '${dev}'`))?.records ?? [];
    const row = rows.find((r) => r?.TableEnumOrId === o.api) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row || !safeName(String(row.Id))) continue;
    const text = lookupFilterText((await tooling(apiGet, `SELECT Metadata FROM CustomField WHERE Id = '${row.Id}'`))?.records?.[0]?.Metadata);
    if (text) f.lookupFilter = text;
  }
}

/**
 * Add the deep facts to the request's objects in `org` (mutated). Returns how many API calls and
 * milliseconds it took, for the log: the budget on a scratch org is real.
 */
export async function readDeepFacts(apiGet: ApiGet, org: SalesforceOrgModel, request: string): Promise<{ objects: number; calls: number; ms: number }> {
  const objects = objectsNamedIn(request, org).slice(0, MAX_DEEP_OBJECTS);
  let calls = 0;
  const counted: ApiGet = (p) => { calls++; return apiGet(p); };
  const started = Date.now();
  for (const o of objects) {
    await readRecordTypeDifferences(counted, o);
    await readCalculatedDefinitions(counted, o);
    await readLookupFilters(counted, o);
  }
  if (objects.length) await readVisibilityRules(counted, objects);
  return { objects: objects.length, calls, ms: Date.now() - started };
}

import { createHash } from "node:crypto";
import { testDataEnabled } from "./testData.js";
import type { FrontdoorSession } from "./salesforceFrontdoor.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";

/**
 * Read what a Salesforce org says about itself, through its own metadata APIs (D-63).
 *
 * WHY. A DOM crawl of Lightning sees the same header and nav bar on every page, and a list page
 * before its rows have drawn; it never sees which fields are required, what a picklist allows, or
 * which validation rules exist. The org knows all of that and says it through the UI API and the
 * Tooling API — the same calls the manual discovery of 2026-10-24 used to find 16 custom objects,
 * their required fields and picklists in a minute. A case written from this is about the org's real
 * structure, not about what a crawler happened to render.
 *
 * READ-ONLY: every call is a GET through `session.apiGet`. Best effort: any call that fails leaves
 * that part out, and the whole read returns null only when not even the app could be read. Nothing
 * here is a secret (labels, API names, picklist values, rule messages), so the result may be cached
 * and put into a prompt like the rest of the AppModel.
 */

/** Objects read per run: the app's own tabs, in nav order. */
const MAX_OBJECTS = 20; // nav objects + custom objects; the prompt block has its own character ceiling
/** Fields kept per object (required first, then picklists and lookups, then the rest). */
const MAX_FIELDS = 40;
/** Fields every object has and no test is about. */
const SYSTEM_FIELDS = new Set([
  "Id", "OwnerId", "CreatedById", "CreatedDate", "LastModifiedById", "LastModifiedDate",
  "SystemModstamp", "IsDeleted", "LastActivityDate", "LastViewedDate", "LastReferencedDate",
  "RecordTypeId", "MasterRecordId", "CurrencyIsoCode",
]);

type ApiGet = (path: string) => Promise<any>;

async function tryGet(apiGet: ApiGet, path: string): Promise<any | null> {
  try { return await apiGet(path); } catch { return null; }
}

/** The app the user last selected, with its nav items; falls back to the first app listed. */
async function readApp(apiGet: ApiGet): Promise<{ label?: string; objects: string[] } | null> {
  const selected = await tryGet(apiGet, "/ui-api/apps/selected?formFactor=Large");
  const app = selected?.navItems ? selected
    : (await tryGet(apiGet, "/ui-api/apps?formFactor=Large"))?.apps?.find((a: any) => a?.navItems?.length);
  if (!app?.navItems) return null;
  const objects: string[] = [];
  for (const n of app.navItems) {
    const api = n?.objectApiName;
    if (typeof api === "string" && api && !objects.includes(api)) objects.push(api);
  }
  return { label: typeof app.label === "string" ? app.label : undefined, objects };
}

async function readObject(apiGet: ApiGet, api: string): Promise<SalesforceOrgModel["objects"][number] | null> {
  const info = await tryGet(apiGet, `/ui-api/object-info/${encodeURIComponent(api)}`);
  if (!info?.fields) return null;
  const picklists = info.defaultRecordTypeId
    ? (await tryGet(apiGet, `/ui-api/object-info/${encodeURIComponent(api)}/picklist-values/${info.defaultRecordTypeId}`))?.picklistFieldValues ?? {}
    : {};
  const lists = await tryGet(apiGet, `/ui-api/list-info/${encodeURIComponent(api)}`);
  // The create LAYOUT's required fields: what the form actually refuses to save without. Object-info
  // misses layout- and system-required ones (Lead's Company, run 2026-10-25T05-01-36-627Z-b0d6a138:
  // "Review the following fields: Company"). Page layouts differ per org, so it is read, never assumed.
  const layout = info.defaultRecordTypeId
    ? await tryGet(apiGet, `/ui-api/layout/${encodeURIComponent(api)}?layoutType=Full&mode=Create&recordTypeId=${info.defaultRecordTypeId}`)
    : null;
  const layoutRequired = new Set<string>();
  for (const sec of layout?.sections ?? []) for (const row of sec?.layoutRows ?? []) for (const item of row?.layoutItems ?? []) {
    // One field per item only: a compound item (Lead's Name = Salutation + First + Last) is required
    // as a whole, and object-info already says which of its parts are (run
    // 2026-10-25T06-38-05-099Z-07e036cc filled an unrequested Salutation and First Name).
    const parts = (item?.layoutComponents ?? []).filter((c: any) => c?.componentType === "Field" && c.apiName);
    if (item?.required && parts.length === 1) layoutRequired.add(parts[0].apiName);
  }

  const fields = Object.values<any>(info.fields)
    .filter((f) => f && typeof f.apiName === "string" && !SYSTEM_FIELDS.has(f.apiName)
      && (f.createable || f.updateable))
    .map((f) => {
      const required = !!((f.required || layoutRequired.has(f.apiName)) && f.createable && f.dataType !== "Boolean");
      const values: string[] | undefined = picklists[f.apiName]?.values?.map((v: any) => String(v.label)).filter(Boolean);
      const lookup = (f.referenceToInfos ?? []).map((r: any) => r?.apiName).filter(Boolean).join("/") || undefined;
      const dependency = dependencyOf(f, picklists);
      return {
        label: String(f.label ?? f.apiName), api: f.apiName, type: String(f.dataType ?? ""),
        ...(required ? { required: true } : {}),
        ...(values?.length ? { picklist: values.slice(0, 25) } : {}),
        ...(lookup ? { lookup } : {}),
        ...dependency,
      };
    })
    // Required first (in the org's own order), then picklists and lookups (what a form step needs to
    // get right), then the rest. A stable sort, so each group keeps the API's order.
    .sort((a, b) => {
      if (!!a.required !== !!b.required) return a.required ? -1 : 1;
      if (a.required) return 0;
      return Number(!!(b.picklist || b.lookup)) - Number(!!(a.picklist || a.lookup));
    })
    .slice(0, MAX_FIELDS);

  // Formula and roll-up summary fields: neither createable nor updateable, so the list above drops
  // them, and the case writer never knew "Expected Revenue" existed to be checked.
  // What the record PAGE calls each field: its View layout's label, which can differ from object-info
  // (Opportunity.ExpectedRevenue is "Expected Amount" there and "Expected Revenue" on the page, run
  // 2026-10-26T07-53-43-702Z-d5524309 asserted the former and failed).
  const viewLayout = info.defaultRecordTypeId
    ? await tryGet(apiGet, `/ui-api/layout/${encodeURIComponent(api)}?layoutType=Full&mode=View&recordTypeId=${info.defaultRecordTypeId}`)
    : null;
  const shownAs = new Map<string, string>();
  for (const sec of viewLayout?.sections ?? []) for (const row of sec?.layoutRows ?? []) for (const item of row?.layoutItems ?? []) {
    const parts = (item?.layoutComponents ?? []).filter((c: any) => c?.componentType === "Field" && c.apiName);
    if (parts.length === 1 && typeof item?.label === "string" && item.label) shownAs.set(parts[0].apiName, item.label);
  }

  // Also the org's own computed standard fields, which object-info does not flag as `calculated`
  // (Opportunity's Expected Revenue: read-only, not a formula), when the record page shows them (or
  // its layout could not be read). Flagged ones first; lookups are left out (a read-only reference
  // is an owner or audit field), and so are status flags (IsConverted).
  const calculated = Object.values<any>(info.fields)
    .filter((f) => f && typeof f.apiName === "string" && !SYSTEM_FIELDS.has(f.apiName)
      && (f.calculated === true || (!f.createable && !f.updateable && !["Reference", "Boolean"].includes(f.dataType) && !f.compound
        && (!viewLayout || shownAs.has(f.apiName)))))
    .sort((a, b) => Number(b.calculated === true) - Number(a.calculated === true))
    .map((f) => ({ label: shownAs.get(f.apiName) ?? String(f.label ?? f.apiName), api: f.apiName, type: String(f.dataType ?? "") }))
    .slice(0, 15);

  // Record types the user may create. One alone changes nothing a test does, so two or more only.
  const recordTypes = Object.values<any>(info.recordTypeInfos ?? {})
    .filter((r) => r?.available && !r.master && typeof r.name === "string" && /^012[A-Za-z0-9]{12,15}$/.test(String(r.recordTypeId)))
    .map((r) => ({ name: String(r.name), id: String(r.recordTypeId), ...(r.defaultRecordTypeMapping ? { default: true } : {}) }));

  return {
    api,
    label: String(info.label ?? api),
    ...(info.labelPlural ? { labelPlural: String(info.labelPlural) } : {}),
    ...(info.createable === true ? { createable: true } : {}),
    ...(recordTypes.length >= 2 ? { recordTypes } : {}),
    ...(calculated.length ? { calculated } : {}),
    fields,
    ...(lists?.lists?.length ? { listViews: lists.lists.map((l: any) => String(l.label)).filter(Boolean).slice(0, 15) } : {}),
  };
}

/**
 * A dependent picklist's rule, from the UI API: the field's `controllerName`, and per value the
 * controlling values it is offered under (`validFor` holds indexes into the controller's
 * `controllerValues`, whose keys are the controlling field's API values). Both as LABELS, the way
 * a form shows them. A dependent value picked under the wrong controlling value is simply not in
 * the list, so the step can never succeed. Empty when the field is not dependent or unreadable.
 */
function dependencyOf(f: any, picklists: Record<string, any>): { controlledBy?: string; validFor?: Record<string, string[]> } {
  const own = picklists[f.apiName];
  const controller = typeof f.controllerName === "string" ? f.controllerName : null;
  if (!controller || !own?.controllerValues || !Array.isArray(own.values)) return {};
  // Index -> controlling LABEL. A checkbox controller has no picklist entry: its keys are "false"/"true".
  const labelOf = new Map<string, string>(
    (picklists[controller]?.values ?? []).map((v: any) => [String(v.value), String(v.label)]));
  const byIndex = new Map<number, string>(
    Object.entries<number>(own.controllerValues).map(([value, i]) => [i, labelOf.get(value) ?? value]));
  const validFor: Record<string, string[]> = {};
  for (const v of own.values) {
    const under = (v?.validFor ?? []).map((i: number) => byIndex.get(i)).filter((x: unknown): x is string => !!x);
    if (v?.label && under.length) validFor[String(v.label)] = under;
  }
  return Object.keys(validFor).length ? { controlledBy: controller, validFor } : {};
}

type Rule = { name: string; field?: string; message: string; condition?: string };

/** Rules whose formula is read, one Tooling query each (the API returns Metadata only for one row). */
const MAX_RULE_FORMULAS = 20;

/** Active validation rules per object, from the Tooling API; null when the API refused. */
async function readValidationRules(apiGet: ApiGet, objects: string[]): Promise<Map<string, Rule[]> | null> {
  if (!objects.length) return new Map();
  const inList = objects.map((o) => `'${o.replace(/'/g, "")}'`).join(",");
  const q = "SELECT Id, ValidationName, ErrorDisplayField, ErrorMessage, EntityDefinition.QualifiedApiName "
    + `FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${inList})`;
  const res = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(q)}`);
  if (!res || !Array.isArray(res.records)) return null;
  const out = new Map<string, Rule[]>();
  let formulas = 0;
  for (const r of res.records) {
    const obj = r?.EntityDefinition?.QualifiedApiName;
    if (typeof obj !== "string" || typeof r.ErrorMessage !== "string") continue;
    // The condition is what lets a negative case trip the rule: run 2026-10-24T12-33-54-871Z-d09ba86d
    // filled only Phone for a rule whose formula also reads the country, so it could never fire.
    let condition: string | undefined;
    if (typeof r.Id === "string" && /^[a-zA-Z0-9]{15,18}$/.test(r.Id) && formulas < MAX_RULE_FORMULAS) {
      formulas++;
      const one = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(`SELECT Metadata FROM ValidationRule WHERE Id = '${r.Id}'`)}`);
      const f = one?.records?.[0]?.Metadata?.errorConditionFormula;
      if (typeof f === "string" && f.trim()) condition = f.trim();
    }
    const list = out.get(obj) ?? [];
    list.push({
      name: String(r.ValidationName ?? ""),
      ...(r.ErrorDisplayField ? { field: String(r.ErrorDisplayField) } : {}),
      message: r.ErrorMessage,
      ...(condition ? { condition } : {}),
    });
    out.set(obj, list);
  }
  return out;
}

/** Flows read per run (one Tooling query each for what a flow does). */
const MAX_FLOWS = 10;

const FLOW_OPS: Record<string, string> = {
  EqualTo: "=", NotEqualTo: "is not", GreaterThan: ">", LessThan: "<", GreaterThanOrEqualTo: ">=",
  LessThanOrEqualTo: "<=", Contains: "contains", StartsWith: "starts with", IsNull: "is blank", IsChanged: "changed",
};
const flowValue = (v: any): string => {
  for (const k of ["stringValue", "numberValue", "booleanValue", "dateValue", "elementReference"]) {
    if (v?.[k] !== undefined && v[k] !== null) return String(v[k]);
  }
  return "";
};

/**
 * What a flow visibly does, from its metadata, as plain lines for the case writer: the start
 * conditions, the fields it sets on the record, the records it creates. Branches are only flagged:
 * the outcome then depends on the record's values. Never the whole flow.
 */
export function flowEffects(meta: any): string[] {
  const out: string[] = [];
  const conds = (meta?.start?.filters ?? []).map((f: any) => `${f.field} ${FLOW_OPS[f.operator] ?? f.operator} ${flowValue(f.value)}`.trim());
  if (conds.length) out.push(`only when ${conds.join(String(meta.start.filterLogic).toLowerCase() === "or" ? " or " : " and ")}`);
  for (const u of meta?.recordUpdates ?? []) {
    const sets = (u?.inputAssignments ?? []).map((a: any) => `${a.field} = ${flowValue(a.value)}`);
    if (sets.length) out.push(`sets ${sets.join(", ")}${u.object && u.inputReference !== "$Record" ? ` on ${u.object}` : ""}`);
  }
  // A before-save flow sets the record's own fields through assignments to $Record.
  for (const a of meta?.assignments ?? []) {
    for (const it of a?.assignmentItems ?? []) {
      const ref = String(it?.assignToReference ?? "");
      if (ref.startsWith("$Record.")) out.push(`sets ${ref.slice(8)} = ${flowValue(it.value)}`);
    }
  }
  for (const c of meta?.recordCreates ?? []) out.push(`creates a ${c?.object ?? "record"}`);
  if ((meta?.decisions ?? []).length) out.push(`branches on ${meta.decisions.length} decision(s): what it does depends on the record's values`);
  return out.slice(0, 8);
}

const RECORD_TRIGGER: Record<string, string> = { Create: "create", Update: "update", CreateAndUpdate: "create or update", Delete: "delete" };

/** Active flows, record-triggered first (what a create or edit case sees happen). Undefined when the org refused. */
async function readFlows(apiGet: ApiGet): Promise<SalesforceOrgModel["flows"]> {
  const q = "SELECT ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, ActiveVersionId "
    + "FROM FlowDefinitionView WHERE IsActive = true";
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(q)}`);
  if (!res || !Array.isArray(res.records)) return undefined;
  const rows = res.records
    .map((r: any) => {
      const trigger = String(r?.TriggerType ?? "");
      const type = /^Record(After|Before)(Save|Delete)$/.test(trigger) ? "record-triggered"
        : trigger === "Scheduled" ? "scheduled"
        : r?.ProcessType === "Flow" ? "screen"
        : r?.ProcessType === "AutoLaunchedFlow" ? "autolaunched" : String(r?.ProcessType ?? "flow").toLowerCase();
      return { r, type };
    })
    .sort((a: any, b: any) => Number(b.type === "record-triggered") - Number(a.type === "record-triggered"))
    .slice(0, MAX_FLOWS);
  const flows: NonNullable<SalesforceOrgModel["flows"]> = [];
  for (const { r, type } of rows) {
    if (typeof r?.ApiName !== "string") continue;
    let effects: string[] = [];
    if (typeof r.ActiveVersionId === "string" && /^[a-zA-Z0-9]{15,18}$/.test(r.ActiveVersionId)) {
      const one = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(`SELECT Metadata FROM Flow WHERE Id = '${r.ActiveVersionId}'`)}`);
      effects = flowEffects(one?.records?.[0]?.Metadata);
    }
    flows.push({
      label: String(r.Label ?? r.ApiName), api: r.ApiName, type,
      ...(type === "record-triggered" && r.TriggerObjectOrEventLabel ? { object: String(r.TriggerObjectOrEventLabel) } : {}),
      ...(RECORD_TRIGGER[r.RecordTriggerType] ? { when: RECORD_TRIGGER[r.RecordTriggerType] } : {}),
      ...(effects.length ? { effects } : {}),
    });
  }
  return flows;
}

/** Custom objects (`__c`) a user can create and query — the org's own data model, nav or no nav.
 *  Shares, history, metadata types (`__mdt`) and platform events (`__e`) are not `__c`. */
async function readCustomObjects(apiGet: ApiGet): Promise<string[]> {
  const res = await tryGet(apiGet, "/sobjects");
  return (res?.sobjects ?? [])
    // ponytail: no `custom` check — every `__c` object is custom, so it could never decide anything.
    .filter((s: any) => s?.createable && s.queryable && /__c$/.test(String(s.name)))
    .map((s: any) => String(s.name));
}

/** Records the object holds, or undefined when SOQL refused (no access, not queryable). */
async function countRecords(apiGet: ApiGet, api: string): Promise<number | undefined> {
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${api}`)}`);
  return typeof res?.totalSize === "number" ? res.totalSize : undefined;
}

/** The org model, or null when the connection cannot read even the app. */
export async function readSalesforceOrgModel(session: Pick<FrontdoorSession, "apiGet">): Promise<SalesforceOrgModel | null> {
  const apiGet = session.apiGet;
  if (!apiGet) return null;
  const app = await readApp(apiGet);
  if (!app) return null;
  const apps = ((await tryGet(apiGet, "/ui-api/apps?formFactor=Large"))?.apps ?? [])
    .map((a: any) => a?.label).filter((l: unknown): l is string => typeof l === "string" && !!l);
  // The app's own tabs first, then custom objects no nav shows (where an org's real model lives).
  const names = [...app.objects];
  for (const c of await readCustomObjects(apiGet)) if (!names.includes(c)) names.push(c);
  const objects = (await Promise.all(names.slice(0, MAX_OBJECTS).map(async (o) => {
    const obj = await readObject(apiGet, o);
    if (!obj) return null;
    const records = await countRecords(apiGet, o);
    return records === undefined ? obj : { ...obj, records };
  }))).filter((o): o is NonNullable<typeof o> => !!o);
  const rules = await readValidationRules(apiGet, objects.map((o) => o.api));
  for (const o of objects) {
    const r = rules?.get(o.api);
    if (r?.length) o.validationRules = r;
  }
  const userLocale = await readUserLocale(apiGet);
  const flows = await readFlows(apiGet);
  return {
    ...(app.label ? { app: app.label } : {}),
    ...(apps.length ? { apps } : {}),
    objects, validationRulesRead: rules !== null,
    ...(userLocale ? { userLocale } : {}),
    ...(flows?.length ? { flows } : {}),
  };
}

/**
 * What the org's setup looks like, as one hash: the org model (objects, fields, picklists, record
 * types, validation rules, flows) without record counts, which change with every create, plus the
 * last change to any Lightning page, page layout, or LWC/Aura component (none is in the model, and
 * each changes what a page shows). Apex code is left out: it changes behaviour, not the pages.
 * Same hash = same setup, so a discovery crawled under it still describes the org. Null when the
 * Tooling API refuses: an unprovable "unchanged" never reuses a crawl.
 */
export async function orgSetupFingerprint(org: SalesforceOrgModel, apiGet: ApiGet): Promise<string | null> {
  const stamps: string[] = [];
  for (const type of ["FlexiPage", "Layout", "LightningComponentBundle", "AuraDefinitionBundle"]) {
    const q = `SELECT LastModifiedDate FROM ${type} ORDER BY LastModifiedDate DESC LIMIT 1`;
    const res = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(q)}`);
    if (!res || !Array.isArray(res.records)) return null;
    stamps.push(`${type}:${res.records[0]?.LastModifiedDate ?? "none"}`);
  }
  const setup = { ...org, objects: org.objects.map(({ records: _records, ...o }) => o) };
  return createHash("sha1").update(JSON.stringify(setup) + "|" + stamps.join("|")).digest("hex");
}

/** The connected user's locale ("en_US"), which decides how a typed date is read. The user's own
 *  record first; failing that (no Chatter scope), the most recently active user — usually the same
 *  person on a test org. Undefined when neither answers, and the date falls back to en-US. */
async function readUserLocale(apiGet: ApiGet): Promise<string | undefined> {
  const me = await tryGet(apiGet, "/chatter/users/me");
  const id = typeof me?.id === "string" ? me.id : null;
  const q = id
    ? `SELECT LocaleSidKey FROM User WHERE Id = '${id.replace(/[^A-Za-z0-9]/g, "")}'`
    : "SELECT LocaleSidKey FROM User WHERE IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1";
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(q)}`);
  const locale = res?.records?.[0]?.LocaleSidKey;
  return typeof locale === "string" && /^[a-z]{2,3}(_[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : undefined;
}

/** Create forms discovery opens per run; a Lightning page costs ~6 s, and the nav objects come first. */
const MAX_CREATE_FORMS = 8;

/** The create form of each createable object, at the org's Lightning origin: the one screen a
 *  link crawl never opens, and the one every "create a record" case needs (TD-167's successor:
 *  run 2026-10-24T11-34-49-878Z-a7697ccd could not ground "Company" because no page had it). */
export function createFormUrls(lightningOrigin: string, org: Pick<SalesforceOrgModel, "objects">, request = ""): string[] {
  // The objects the request names first: a custom object 9th in the nav was never opened, and the
  // run tested a plain Lead instead of a "Broker Lead" (run 2026-10-25T06-38-05-178Z-ebdc2303).
  const named = objectsNamedIn(request, org);
  const ordered = [...named, ...org.objects.filter((o) => !named.includes(o))];
  const base = (o: { api: string }) => `${lightningOrigin.replace(/\/$/, "")}/lightning/o/${encodeURIComponent(o.api)}/new`;
  // The form of each record type the request names, first: /new alone opens only the default one.
  const rtForms = ordered.filter((o) => o.createable)
    .flatMap((o) => recordTypesNamedIn(request, o).filter((rt) => !rt.default).map((rt) => recordTypeFormUrl(base(o), rt)));
  return [...rtForms, ...ordered.filter((o) => o.createable).map(base)].slice(0, MAX_CREATE_FORMS);
}

/** The create form of one record type: Lightning opens it directly, with no chooser. */
export function recordTypeFormUrl(createForm: string, rt: { id: string }): string {
  return `${createForm}?recordTypeId=${encodeURIComponent(rt.id)}`;
}

/** The record types of `o` a request names, whole words, case-insensitive ("partner account" names "Partner"). */
export function recordTypesNamedIn<R extends { name: string }>(request: string, o: { recordTypes?: R[] }): R[] {
  const key = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const req = key(request);
  return (o.recordTypes ?? []).filter((rt) => key(rt.name).trim() && req.includes(key(rt.name)));
}

/** Record pages discovery opens per run: one per object the request names, at most this many. */
const MAX_RECORD_PAGES = 3;

/**
 * A record page (/lightning/r/<Object>/<Id>/view) of each object the request names, from its most
 * recently modified record: an edit or "verify the saved record" flow lands there, and without it
 * the model did not hold the record's own "Edit" (run 2026-10-25T06-38-05-163Z-3a6663ef clicked
 * "Edit List"). Only objects the request names: each page costs a full Lightning load. An object
 * with no record, or a query the org refuses, adds nothing.
 */
export async function recordPageUrls(
  lightningOrigin: string, org: Pick<SalesforceOrgModel, "objects">, request: string, apiGet: ApiGet,
): Promise<string[]> {
  const out: string[] = [];
  for (const o of objectsNamedIn(request, org).slice(0, MAX_RECORD_PAGES)) {
    if (!/^[A-Za-z0-9_]+$/.test(o.api)) continue;
    const q = `SELECT Id FROM ${o.api} ORDER BY LastModifiedDate DESC LIMIT 1`;
    const id = (await tryGet(apiGet, `/query?q=${encodeURIComponent(q)}`))?.records?.[0]?.Id;
    if (typeof id === "string" && /^[A-Za-z0-9]{15,18}$/.test(id)) {
      out.push(`${lightningOrigin.replace(/\/$/, "")}/lightning/r/${o.api}/${id}/view`);
    }
  }
  return out;
}

/**
 * The org objects a request names, by label, plural label or API name — whole words, CASE-SENSITIVE
 * (Salesforce labels are capitalised; a request's "test cases" is not the Case object), LONGEST name
 * first, each match consuming its words: "Broker Lead" names the custom object, not also Lead.
 */
export function objectsNamedIn<O extends { api: string; label: string; labelPlural?: string }>(
  request: string, org: { objects: O[] } | undefined,
): O[] {
  if (!org?.objects.length || !request.trim()) return [];
  const words = (s: string) => ` ${s.replace(/[^\p{L}\p{N}_]+/gu, " ").trim()} `;
  let rest = words(request);
  const names = org.objects.flatMap((o) => [o.label, o.labelPlural, o.api].filter((n): n is string => !!n).map((n) => ({ o, n: words(n) })))
    .sort((a, b) => b.n.length - a.n.length);
  const named: O[] = [];
  for (const { o, n } of names) {
    if (!rest.includes(n)) continue;
    rest = rest.split(n).join(" ");
    if (!named.includes(o)) named.push(o);
  }
  return named;
}

/** The org model as a compact prompt block for the case writer. "" when there is nothing to say. */
export function orgModelForCases(org: SalesforceOrgModel | undefined, maxChars = 9000): string {
  if (!org?.objects.length) return "";
  const lines: string[] = [];
  for (const o of org.objects) {
    const req = o.fields.filter((f) => f.required).map((f) => f.label);
    const label = (api: string) => o.fields.find((x) => x.api === api)?.label ?? api;
    const picks = o.fields.filter((f) => f.picklist?.length)
      .map((f) => `${f.label} = ${f.picklist!.join(" | ")}` + (f.controlledBy && f.validFor
        ? ` (depends on ${label(f.controlledBy)}: ${Object.entries(f.validFor).map(([v, under]) => `${v} only when ${under.join(" or ")}`).join("; ")})`
        : ""));
    const createForm = `/lightning/o/${o.api}/new`;
    const rts = (o.recordTypes ?? []).map((rt) => rt.default
      ? `${rt.name} (default: ${createForm})` : `${rt.name} (${recordTypeFormUrl(createForm, rt)})`);
    const looks = o.fields.filter((f) => f.lookup).map((f) => `${f.label} -> ${f.lookup}`);
    // Session 102 (TEST_DATA_ENABLED): each typed field's type, so values are written for the field
    // ("Phone (Phone)", "Close Date (Date)") rather than guessed from its label.
    const typed = testDataEnabled()
      ? o.fields.filter((f) => !f.picklist?.length && !f.lookup && f.type && f.type !== "Reference")
        .slice(0, 20).map((f) => `${f.label} (${f.type})`)
      : [];
    const parts = [
      `- ${o.labelPlural ?? o.label} (object ${o.api}${o.records !== undefined ? `, ${o.records} records` : ""})`,
      o.createable ? `  create form: ${createForm}` : "",
      o.createable && rts.length ? `  record types (each has its own create form): ${rts.join(", ")}` : "",
      req.length ? `  required on create: ${req.join(", ")}` : "",
      picks.length ? `  picklists: ${picks.join("; ")}` : "",
      looks.length ? `  lookups: ${looks.join("; ")}` : "",
      o.calculated?.length ? `  calculated by the org (read-only, on the record page after a save; never filled): ${o.calculated.map((c) => `${c.label} (${c.type})`).join(", ")}` : "",
      typed.length ? `  field types: ${typed.join(", ")}` : "",
      o.listViews?.length ? `  list views: ${o.listViews.join(", ")}` : "",
      ...(o.validationRules ?? []).map((r) => `  validation rule ${r.name}${r.field ? ` (on ${r.field})` : ""}: "${r.message}"`
        + (r.condition ? `\n    fires when: ${r.condition}` : "")),
    ].filter(Boolean);
    lines.push(parts.join("\n"));
  }
  if (org.apps?.length) lines.unshift(`apps in this org: ${org.apps.join(", ")}`);
  // Phase B: what runs by itself after a save. A case about it saves the record so the flow's
  // conditions hold, then asserts the effect on the record page (or the record it creates).
  const flows = (org.flows ?? []).map((f) => `- flow "${f.label}" (${f.type}${f.object ? ` on ${f.object}` : ""}${f.when ? `, on ${f.when}` : ""})`
    + (f.effects?.length ? `: ${f.effects.join("; ")}` : ""));
  if (flows.length) lines.push(`automation (active flows; a record-triggered flow's effect shows on the record page after the Save):\n${flows.join("\n")}`);
  let body = lines.join("\n");
  if (body.length > maxChars) body = body.slice(0, maxChars).replace(/\n[^\n]*$/, "") + "\n- (more objects not shown)";
  return `

Salesforce org model (read from the org's own metadata API${org.app ? ` for the app "${org.app}"` : ""} — authoritative):
${body}
The run is already signed in to this org through its connection (no login page exists in the model): write no login, username or password steps.
Use it: name objects, fields, list views and picklist values exactly as written above; to create a record, open its "create form" path above directly by URL (its fields are in the application model on that page; never route through the App Launcher or the navigation to reach it); a case that creates a record fills every "required on create" field with a realistic value and the fields a validation rule reads, and NO other field unless the request names it (a lookup needs an existing record and is left alone unless required); when the request names several objects, write one create case PER object, never one case that creates them all; a picklist step picks only a value listed for it, and a picklist that "depends on" another is set AFTER its controlling field, to a value offered under the controlling value chosen; a case about one record type opens THAT record type's create form path above (the plain create form opens only the default one), and a case that does not name one uses the plain create form; a case that must SAVE successfully also keeps every validation rule's condition FALSE (a rule that fires when Email and Phone are both blank means the case fills one of them); each validation rule above deserves a negative case whose expected result is its exact message, and that case must make its condition true ("fires when": fill every field the formula reads, e.g. Country as well as Phone) while filling every required field.${org.validationRulesRead ? "" : " (Validation rules could not be read in this org, so their absence above means nothing.)"}`;
}

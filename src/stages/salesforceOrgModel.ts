import { createHash } from "node:crypto";
import { testDataEnabled } from "./testData.js";
import { deepDiscoveryEnabled, readDeepFacts } from "./salesforceOrgDeep.js";
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
/** Values kept per picklist. */
const MAX_PICKLIST_VALUES = 200;
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
        // ponytail: 200 values covers every standard picklist (Industry has 30+; 25 cut "Technology" and a
        // test picked "Biotechnology", run 2026-11-10T05-05-39-201Z-52ce7aed). A huge global value set
        // would need the prompt to show only the values a request names.
        ...(values?.length ? { picklist: values.slice(0, MAX_PICKLIST_VALUES) } : {}),
        ...(lookup ? { lookup } : {}),
        ...dependency,
        // What a typed value must fit (testData.fitToField): Opportunity's Tracking Number takes 12 characters.
        ...(f.length > 0 && /^(String|TextArea|Email|Phone|Url|EncryptedString)$/.test(f.dataType) ? { length: f.length } : {}),
        ...(f.precision > 0 && /^(Currency|Double|Percent|Int)$/.test(f.dataType) ? { precision: f.precision, scale: f.scale ?? 0 } : {}),
        ...(f.unique || f.externalId ? { unique: true } : {}),
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
  for (const c of meta?.recordCreates ?? []) out.push(createdLine(c, meta));
  // A subflow does the work of the screen that calls it (TB New Contact Screen creates its Contact through
  // TB Create Contact); readFlows adds what that flow creates.
  for (const s of meta?.subflows ?? []) if (typeof s?.flowName === "string") out.push(`runs the flow ${s.flowName}`);
  for (const e of meta?.customErrors ?? []) {
    const msg = (Array.isArray(e?.customErrorMessages) ? e.customErrorMessages : [e?.customErrorMessages])
      .map((m: any) => m?.errorMessage).find((m: any) => typeof m === "string" && m.trim());
    if (msg) out.push(`can block the save with the error "${msg}"`);
  }
  if ((meta?.decisions ?? []).length) {
    const branches = flowBranches(meta);
    out.push(...(branches.length ? branches : [`branches on ${meta.decisions.length} decision(s): what it does depends on the record's values`]));
  }
  return out.slice(0, 12);
}

/** "creates a Task "TB Review large deal"": the record's Subject or Name when the flow gives it as text. */
function createdLine(c: any, meta?: any): string {
  const named = (c?.inputAssignments ?? []).find((a: any) => /^(Subject|Name)$/.test(a?.field) && a?.value?.stringValue);
  if (named) {
    // Its due date ("ActivityDate = Tomorrow", a formula "TODAY() + 1") and its link to the record that ran the
    // flow ("WhoId = $Record.Id"): what the API check confirms (salesforceOracles.createdChecks), H3's due date.
    const due = (c.inputAssignments ?? []).find((a: any) => a?.field === "ActivityDate");
    const ref = due?.value?.elementReference;
    const expr = ref ? (meta?.formulas ?? []).find((f: any) => f?.name === ref)?.expression : undefined;
    const days = /^\s*TODAY\(\)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(String(expr ?? ""));
    const dueText = days ? ` due today${days[2] ? ` ${days[1]} ${days[2]}` : ""}` : "";
    const link = (c.inputAssignments ?? []).find((a: any) => /^(WhoId|WhatId|ParentId|AccountId)$/.test(a?.field) && a?.value?.elementReference === "$Record.Id");
    return `creates a ${c?.object ?? "record"} "${named.value.stringValue}"${dueText}${link ? `, linked to the record by ${link.field}` : ""}`;
  }
  // Named from the triggering record or event ("Name = $Record.Message__c"): seeding fills it in.
  const from = (c?.inputAssignments ?? []).find((a: any) => /^(Subject|Name)$/.test(a?.field) && /^\$Record\.\w+$/.test(a?.value?.elementReference ?? ""));
  return `creates a ${c?.object ?? "record"}${from ? ` with ${from.field} = the triggering record's ${from.value.elementReference.slice(8)}` : ""}`;
}

/** A flow condition as plain words: "$Record.AnnualRevenue >= 1000000"; a lookup's null test as found / not found. */
function conditionText(c: any, lookups: Map<string, any>): string {
  const left = String(c?.leftValueReference ?? "");
  const lookup = lookups.get(left.split(".")[0]);
  if (lookup && c?.operator === "IsNull") {
    const found = c?.rightValue?.booleanValue === false || c?.rightValue?.booleanValue === "false";
    const where = (lookup.filters ?? []).map((f: any) => `${f.field} ${FLOW_OPS[f.operator] ?? f.operator} ${flowValue(f.value).replace(/^\$Record\./, "the record's ")}`).join(" and ");
    return `${found ? "a" : "no"} ${lookup.object ?? "record"}${where ? ` with ${where}` : ""} exists`;
  }
  return `${left.replace(/^\$Record\./, "")} ${FLOW_OPS[c?.operator] ?? c?.operator} ${flowValue(c?.rightValue)}`.trim();
}

/**
 * Phase B: what each branch of a flow's decisions does, as one line per branch: the branch's conditions,
 * then the effects on the path it leads to (field updates, records created with their Subject or Name,
 * the error that blocks the save), up to the next decision. So a case can set the values that take each
 * branch and check that branch's own outcome, rather than "it depends" (TB Lead Qualification Routing:
 * Hot, Warm and Cold looked alike). Follows connectors only; screens and loops are walked through once.
 */
export function flowBranches(meta: any): string[] {
  const byName = new Map<string, { kind: string; el: any }>();
  for (const kind of ["assignments", "recordUpdates", "recordCreates", "recordLookups", "customErrors", "decisions", "loops", "screens", "subflows"]) {
    for (const el of meta?.[kind] ?? []) if (el?.name) byName.set(el.name, { kind, el });
  }
  const lookups = new Map([...byName.values()].filter((n) => n.kind === "recordLookups").map((n) => [n.el.name, n.el] as [string, any]));
  const nextOf = (el: any): string[] => [el?.connector, el?.nextValueConnector, el?.noMoreValuesConnector]
    .map((c) => c?.targetReference).filter((t): t is string => typeof t === "string");
  const effectsFrom = (start: string | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = start ? [start] : [];
    while (queue.length && out.length < 6) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const node = byName.get(name);
      if (!node || node.kind === "decisions") continue;
      const el = node.el;
      if (node.kind === "recordUpdates") {
        const sets = (el.inputAssignments ?? []).map((a: any) => `${a.field} = ${flowValue(a.value)}`);
        if (sets.length) out.push(`sets ${sets.join(", ")}${el.object && el.inputReference !== "$Record" ? ` on ${el.object}` : ""}`);
      } else if (node.kind === "assignments") {
        const sets = (el.assignmentItems ?? []).filter((it: any) => String(it?.assignToReference ?? "").startsWith("$Record."))
          .map((it: any) => `${String(it.assignToReference).slice(8)} = ${flowValue(it.value)}`);
        if (sets.length) out.push(`sets ${sets.join(", ")}`);
      } else if (node.kind === "recordCreates") {
        out.push(createdLine(el, meta));
      } else if (node.kind === "customErrors") {
        const msg = (Array.isArray(el.customErrorMessages) ? el.customErrorMessages : [el.customErrorMessages])
          .map((m: any) => m?.errorMessage).find((m: any) => typeof m === "string" && m.trim());
        out.push(msg ? `blocks the save with the error "${msg}"` : "blocks the save with an error");
      }
      queue.push(...nextOf(el));
    }
    return out;
  };
  const lines: string[] = [];
  for (const d of meta?.decisions ?? []) {
    if (!(d?.rules ?? []).length) continue;   // nothing to branch on: the caller keeps its generic line
    for (const r of d?.rules ?? []) {
      const logic = String(r?.conditionLogic ?? "and").toLowerCase() === "or" ? " or " : " and ";
      const conds = (r?.conditions ?? []).map((c: any) => conditionText(c, lookups)).join(logic);
      const effects = effectsFrom(r?.connector?.targetReference);
      lines.push(`branch "${r?.label ?? r?.name}": when ${conds || "its condition holds"} -> ${effects.join("; ") || "does nothing more"}`);
    }
    const otherwise = effectsFrom(d?.defaultConnector?.targetReference);
    lines.push(`branch "${d?.defaultConnectorLabel ?? "otherwise"}" (none of the above) -> ${otherwise.join("; ") || "does nothing more"}`);
  }
  return lines;
}

const RECORD_TRIGGER: Record<string, string> = { Create: "create", Update: "update", CreateAndUpdate: "create or update", Delete: "delete" };

/** Whether the request names this flow by its label or API name (whole words). */
export function flowNamedIn(request: string, r: { Label?: unknown; ApiName?: unknown }): boolean {
  const words = (s: unknown) => ` ${String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const req = words(request);
  return [r.Label, r.ApiName].some((n) => words(n).trim() !== "" && req.includes(words(n)));
}

/** Active flows: the ones the request names first (by label or API name), then record-triggered (what a
 *  create or edit case sees happen). The cap must never drop a flow the request is about: with six
 *  record-triggered flows in the org, the screen flow a request named was cut and never opened
 *  (run 2026-11-10T05-00-45-973Z-f92a47fc). Undefined when the org refused. */
async function readFlows(apiGet: ApiGet, request = ""): Promise<SalesforceOrgModel["flows"]> {
  const q = "SELECT ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, ActiveVersionId "
    + "FROM FlowDefinitionView WHERE IsActive = true";
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(q)}`);
  if (!res || !Array.isArray(res.records)) return undefined;
  const rows = res.records
    .map((r: any) => {
      const trigger = String(r?.TriggerType ?? "");
      const type = /^Record(After|Before)(Save|Delete)$/.test(trigger) ? "record-triggered"
        : trigger === "Scheduled" ? "scheduled"
        : trigger === "PlatformEvent" ? "platform-event"
        : r?.ProcessType === "Flow" ? "screen"
        : r?.ProcessType === "AutoLaunchedFlow" ? "autolaunched" : String(r?.ProcessType ?? "flow").toLowerCase();
      return { r, type };
    })
    .sort((a: any, b: any) => Number(flowNamedIn(request, b.r)) - Number(flowNamedIn(request, a.r))
      || Number(b.type === "record-triggered") - Number(a.type === "record-triggered"))
    .slice(0, MAX_FLOWS);
  const flows: NonNullable<SalesforceOrgModel["flows"]> = [];
  for (const { r, type } of rows) {
    if (typeof r?.ApiName !== "string") continue;
    let effects: string[] = [];
    let event: string | undefined;
    if (typeof r.ActiveVersionId === "string" && /^[a-zA-Z0-9]{15,18}$/.test(r.ActiveVersionId)) {
      const one = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(`SELECT Metadata FROM Flow WHERE Id = '${r.ActiveVersionId}'`)}`);
      effects = flowEffects(one?.records?.[0]?.Metadata);
      const ev = one?.records?.[0]?.Metadata?.start?.object;
      if (type === "platform-event" && typeof ev === "string" && /^\w+__e$/.test(ev)) event = ev;
    }
    flows.push({
      label: String(r.Label ?? r.ApiName), api: r.ApiName, type,
      ...(type === "record-triggered" && r.TriggerObjectOrEventLabel ? { object: String(r.TriggerObjectOrEventLabel) } : {}),
      ...(RECORD_TRIGGER[r.RecordTriggerType] ? { when: RECORD_TRIGGER[r.RecordTriggerType] } : {}),
      ...(event ? { event } : {}),
      ...(effects.length ? { effects } : {}),
    });
  }
  // A flow that runs another one also does what that one creates (run 2026-11-12T07-29-43-159Z-23244d2a:
  // the screen flow's Contact was made by its subflow, so nothing said the screen flow creates one).
  for (const f of flows) {
    for (const l of f.effects ?? []) {
      const sub = /^runs the flow (\w+)$/.exec(l)?.[1];
      const made = sub ? flows.find((x) => x.api === sub)?.effects?.filter((e) => e.startsWith("creates ")) ?? [] : [];
      for (const m of made) if (!f.effects!.includes(m)) f.effects!.push(m);
    }
  }
  return flows;
}

/** Custom objects (`__c`) a user can create and query — the org's own data model, nav or no nav.
 *  Shares, history, metadata types (`__mdt`) and platform events (`__e`) are not `__c`. */
function customObjects(sobjects: any[]): string[] {
  return sobjects
    // ponytail: no `custom` check — every `__c` object is custom, so it could never decide anything.
    .filter((s: any) => s?.createable && s.queryable && /__c$/.test(String(s.name)))
    .map((s: any) => String(s.name));
}

/**
 * Objects the request names by label ("Work Order", "Operating Hours") that a user can create and open
 * in Lightning, nav or no nav. Field Service objects sit outside the Sales app's tabs, so a "Work Order"
 * request was built as a Case and an "Operating Hours" one went to Setup (runs
 * 2026-11-13T17-50-56-653Z-989d3c23, 17-51-15-443Z-6b6d9b04). Longest label first, and a matched label
 * leaves the text, so "Work Order" does not also bring Order.
 */
export function requestedObjects(sobjects: any[], request: string): string[] {
  let text = ` ${request.toLowerCase()} `;
  const out: string[] = [];
  const named = sobjects
    .filter((s: any) => s?.createable && s.queryable && s.layoutable && typeof s.label === "string")
    .flatMap((s: any) => [s.label, s.labelPlural].filter((l: unknown): l is string => typeof l === "string" && l.length > 2)
      .map((l: string) => ({ api: String(s.name), label: l.toLowerCase() })))
    .sort((a: { label: string }, b: { label: string }) => b.label.length - a.label.length);
  for (const n of named) {
    const re = new RegExp(`(^|[^a-z0-9])${n.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^a-z0-9]|$)`, "g");
    if (!re.test(text)) continue;
    text = text.replace(re, "$1 ");
    if (!out.includes(n.api)) out.push(n.api);
  }
  return out;
}

/** Records the object holds, or undefined when SOQL refused (no access, not queryable). */
async function countRecords(apiGet: ApiGet, api: string): Promise<number | undefined> {
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${api}`)}`);
  return typeof res?.totalSize === "number" ? res.totalSize : undefined;
}

/** The org model, or null when the connection cannot read even the app. */
export async function readSalesforceOrgModel(
  session: Pick<FrontdoorSession, "apiGet">,
  /** The person's request: the objects it names get the Phase 1 deep read (flag on only). */
  request = "",
): Promise<SalesforceOrgModel | null> {
  const apiGet = session.apiGet;
  if (!apiGet) return null;
  const app = await readApp(apiGet);
  if (!app) return null;
  const apps = ((await tryGet(apiGet, "/ui-api/apps?formFactor=Large"))?.apps ?? [])
    .map((a: any) => a?.label).filter((l: unknown): l is string => typeof l === "string" && !!l);
  // The objects the request names first (so the cap never drops them), then the app's own tabs, then
  // custom objects no nav shows (where an org's real model lives).
  const sobjects: any[] = (await tryGet(apiGet, "/sobjects"))?.sobjects ?? [];
  const names = [...requestedObjects(sobjects, request)];
  for (const o of app.objects) if (!names.includes(o)) names.push(o);
  for (const c of customObjects(sobjects)) if (!names.includes(c)) names.push(c);
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
  const flows = await readFlows(apiGet, request);
  // Phase C (SALESFORCE_APPROVALS_ENABLED, default off): the active approval processes, by object.
  const approvals = approvalsEnabled() ? await readApprovals(apiGet) : undefined;
  const customLinks = customLinksEnabled() ? await readCustomLinks(apiGet, objects.map((o) => o.api)) : undefined;
  if (deepDiscoveryEnabled()) {
    const deep = await readDeepFacts(apiGet, { objects, validationRulesRead: rules !== null }, request).catch(() => null);
    if (deep) console.log(`[org model] deep read: ${deep.objects} object(s), ${deep.calls} API call(s), ${(deep.ms / 1000).toFixed(1)} s`);
  }
  return {
    ...(app.label ? { app: app.label } : {}),
    ...(apps.length ? { apps } : {}),
    objects, validationRulesRead: rules !== null,
    ...(userLocale ? { userLocale } : {}),
    ...(flows?.length ? { flows } : {}),
    ...(approvals?.length ? { approvals } : {}),
    ...(customLinks?.length ? { customLinks } : {}),
  };
}

/** Custom links and buttons in the org model. Off unless asked for. */
export function customLinksEnabled(): boolean {
  return process.env.SALESFORCE_CUSTOM_LINKS_ENABLED === "true";
}

/** The org's own URL custom links and buttons (Tooling WebLink, no managed packages) on the modelled
 *  objects. JavaScript and Visualforce ones are left out: their address is not in the setup. */
async function readCustomLinks(apiGet: ApiGet, objects: string[]): Promise<NonNullable<SalesforceOrgModel["customLinks"]>> {
  const q = "SELECT Name, EntityDefinition.QualifiedApiName, Metadata FROM WebLink WHERE NamespacePrefix = null LIMIT 50";
  const res = await tryGet(apiGet, `/tooling/query?q=${encodeURIComponent(q)}`);
  return (res?.records ?? []).flatMap((r: any) => {
    const m = r?.Metadata, object = r?.EntityDefinition?.QualifiedApiName;
    if (!m || m.linkType !== "url" || typeof m.url !== "string" || !objects.includes(object)) return [];
    const kind = m.displayType === "link" ? "link" : m.displayType === "button" ? "button" : null;
    if (!kind) return [];   // "massActionButton": a list view's, not a record's
    return [{ object, label: String(m.masterLabel ?? r.Name), url: m.url.trim(), kind, newWindow: m.openType === "newWindow" }];
  });
}

/** Phase C: approvals in the org model and the API checks of them. Off unless asked for. */
export function approvalsEnabled(): boolean {
  return process.env.SALESFORCE_APPROVALS_ENABLED === "true";
}

/** The active approval processes (ProcessDefinition, a plain SOQL object): label, API name, object. */
async function readApprovals(apiGet: ApiGet): Promise<NonNullable<SalesforceOrgModel["approvals"]>> {
  const q = "SELECT Id, Name, DeveloperName, TableEnumOrId FROM ProcessDefinition WHERE Type = 'Approval' AND State = 'Active' LIMIT 20";
  const res = await tryGet(apiGet, `/query?q=${encodeURIComponent(q)}`);
  // Each process's steps (ProcessNode), for a multi-step approval: one decision per step.
  const nodes = await tryGet(apiGet, `/query?q=${encodeURIComponent("SELECT Name, ProcessDefinitionId FROM ProcessNode LIMIT 200")}`);
  const stepsOf = (id: unknown) => (nodes?.records ?? []).filter((n: any) => n?.ProcessDefinitionId === id && typeof n?.Name === "string").map((n: any) => String(n.Name));
  return (res?.records ?? []).filter((r: any) => typeof r?.Name === "string" && typeof r?.TableEnumOrId === "string")
    .map((r: any) => {
      const steps = stepsOf(r.Id);
      return { label: String(r.Name), api: String(r.DeveloperName ?? r.Name), object: String(r.TableEnumOrId), ...(steps.length ? { steps } : {}) };
    });
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

/** Screen-flow run pages discovery opens per run. */
const MAX_SCREEN_FLOWS = 2;

/**
 * Phase B: the run page (`/flow/<ApiName>`) of each screen flow the request names, by its label or
 * API name. A screen flow has no link or button a crawl follows to it, so without this its screens
 * were never modelled and the case wrote a plain record create instead of running the flow
 * (run 2026-11-10T04-44-28-274Z-0142c5f5, "TB New Contact Screen": reported incomplete).
 */
export function screenFlowUrls(lightningOrigin: string, org: Pick<SalesforceOrgModel, "flows">, request = ""): string[] {
  const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const req = words(request);
  return (org.flows ?? [])
    .filter((f) => f.type === "screen" && /^\w+$/.test(f.api)
      && (req.includes(words(f.label)) || req.includes(words(f.api)) || request.includes(`/flow/${f.api}`)))
    .slice(0, MAX_SCREEN_FLOWS)
    .map((f) => `${lightningOrigin.replace(/\/$/, "")}/flow/${f.api}`);
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
  for (const o of objectsNamedIn(request, org, true).slice(0, MAX_RECORD_PAGES)) {
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
  request: string, org: { objects: O[] } | undefined, anyCase = false,
): O[] {
  if (!org?.objects.length || !request.trim()) return [];
  // anyCase, for what discovery opens only: people write "a high priority account" (run
  // 2026-11-10T10-08-27-191Z-4830927e: the capitalised-only match modelled no record page). An extra
  // page from "test cases" costs one load; dropping cases (testCases) stays case-sensitive.
  const words = (s: string) => ` ${(anyCase ? s.toLowerCase() : s).replace(/[^\p{L}\p{N}_]+/gu, " ").trim()} `;
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
/** Characters the flows block may take, on top of the objects' ceiling. */
const MAX_FLOWS_CHARS = 5000;

export function orgModelForCases(org: SalesforceOrgModel | undefined, maxChars = 9000): string {
  if (!org?.objects.length) return "";
  const lines: string[] = [];
  // Phase 1: objects carrying deep facts (the request's own) first, so the character ceiling below
  // never cuts them. Without the flag none has any, and the stable sort keeps the order as it was.
  const deep = (o: typeof org.objects[number]) => !!(o.visibilityRules?.length || o.calculated?.some((c) => c.definition)
    || o.recordTypes?.some((r) => r.onlyFields || r.picklists));
  for (const o of [...org.objects].sort((a, b) => Number(deep(b)) - Number(deep(a)))) {
    const req = o.fields.filter((f) => f.required).map((f) => f.label);
    const label = (api: string) => o.fields.find((x) => x.api === api)?.label ?? api;
    const picks = o.fields.filter((f) => f.picklist?.length)
      .map((f) => `${f.label} = ${f.picklist!.join(" | ")}` + (f.controlledBy && f.validFor
        ? ` (depends on ${label(f.controlledBy)}: ${Object.entries(f.validFor).map(([v, under]) => `${v} only when ${under.join(" or ")}`).join("; ")})`
        : ""));
    const createForm = `/lightning/o/${o.api}/new`;
    const rts = (o.recordTypes ?? []).map((rt) => rt.default
      ? `${rt.name} (default: ${createForm})` : `${rt.name} (${recordTypeFormUrl(createForm, rt)})`);
    const looks = o.fields.filter((f) => f.lookup).map((f) => `${f.label} -> ${f.lookup}${f.lookupFilter ? ` (only records where ${f.lookupFilter})` : ""}`);
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
      o.calculated?.length ? `  calculated by the org (read-only, on the record page after a save; never filled): ${o.calculated.map((c) => `${c.label} (${c.type})${c.definition ? ` ${c.definition.startsWith("=") ? "" : "= "}${c.definition}` : ""}`).join(", ")}` : "",
      // Phase 1: a case about a record type checks what only that type shows; one about a visibility
      // rule sets the controlling value and expects the field or section to appear without a reload.
      ...(o.recordTypes ?? []).filter((r) => r.onlyFields?.length || r.picklists).map((r) => `  record type ${r.name} differs from the default:`
        + (r.onlyFields?.length ? ` only its form shows ${r.onlyFields.join(", ")};` : "")
        + Object.entries(r.picklists ?? {}).map(([f, v]) => ` ${f} offers ${v.join(" | ")}`).join(";")),
      o.visibilityRules?.length ? `  shown only when (Dynamic Forms; appears on the page without a reload once the condition holds): ${o.visibilityRules.map((v) => `${v.target} when ${v.when}`).join("; ")}` : "",
      typed.length ? `  field types: ${typed.join(", ")}` : "",
      o.listViews?.length ? `  list views: ${o.listViews.join(", ")}` : "",
      ...(o.validationRules ?? []).map((r) => `  validation rule ${r.name}${r.field ? ` (on ${r.field})` : ""}: "${r.message}"`
        + (r.condition ? `\n    fires when: ${r.condition}` : "")
        + (r.condition && ruleBoundaries(r.condition).length ? `\n    boundary: ${ruleBoundaries(r.condition).join("; ")}` : "")),
    ].filter(Boolean);
    lines.push(parts.join("\n"));
  }
  if (org.apps?.length) lines.unshift(`apps in this org: ${org.apps.join(", ")}`);
  // Phase B: what runs by itself after a save. A case about it saves the record so the flow's
  // conditions hold, then asserts the effect on the record page (or the record it creates).
  const flows = (org.flows ?? []).map((f) => `- flow "${f.label}" (${f.type}${f.object ? ` on ${f.object}` : ""}${f.when ? `, on ${f.when}` : ""})`
    + (f.type === "screen" ? `, runs at /flow/${f.api}` : "")
    + (f.effects?.length ? `: ${f.effects.join("; ")}` : ""));
  // Outside the objects' character ceiling, with its own: the flows came last and the ceiling cut them
  // off on every org with several objects, so no case ever saw a flow (run 2026-11-10T08-12-42-083Z-1eb7bfea
  // invented branches the flow does not have). The flows a request names are first in org.flows.
  let flowsBlock = "";
  if (flows.length) flowsBlock = (`automation (active flows; a record-triggered flow's effect shows on the record page after the Save):\n${flows.join("\n")}`
    // Phase B: a request about a flow ("test the TB Lead Qualification Routing flow", "every branch of")
    // gets a case per branch listed above, each with the values that take THAT branch.
    + `\nA request that asks to test one of these flows (by its name, or "every branch" / "all paths" of it) gets ONE case per branch listed for it: the case sets the record's values so that branch's "when" holds and no earlier branch's does, saves, and checks that branch's own effects (the field values it sets, the record it creates by its Subject or Name, or, for a branch that blocks the save, its exact error message). A flow with no branches gets one case that meets its "only when" and one that does not (the effect must then be absent).`);
  if (flowsBlock.length > MAX_FLOWS_CHARS) flowsBlock = flowsBlock.slice(0, MAX_FLOWS_CHARS).replace(/\n[^\n]*$/, "") + "\n- (more flows not shown)";
  let body = lines.join("\n");
  if (body.length > maxChars) body = body.slice(0, maxChars).replace(/\n[^\n]*$/, "") + "\n- (more objects not shown)";
  if (flowsBlock) body += `\n${flowsBlock}`;
  // Phase C: approval processes, and how Lightning drives one, for a case about an approval.
  if (org.approvals?.length) {
    body += `\napproval processes (active): ${org.approvals.map((a) => `"${a.label}" on ${a.object}${(a.steps?.length ?? 0) > 1 ? ` (${a.steps!.length} steps: ${a.steps!.join(", ")}; each is decided in turn)` : ""}`).join(", ")}.`
      + ` A case about one: create a record that meets its entry criteria (the request's values) and save it; on the record page`
      + ` click "Submit for Approval" (in the header or under "Show more actions"), type a comment, click "Submit"; Salesforce`
      + ` shows "was submitted for approval" and the record is locked. To decide it, open the record's Related tab, the`
      + ` "Approval History" list, click "Approve" or "Reject", type a comment, and click the dialog's "Approve" or "Reject".`
      + ` Then check what the approval changes on the record (its final field update) on the Details tab.`;
  }
  if (org.customLinks?.length) {
    body += `\ncustom links and buttons (on a record page; a link sits at the bottom of the Details tab, a button in the header or under "Show more actions"): `
      + org.customLinks.map((l) => `${l.object} ${l.kind} "${l.label}" opens ${l.url}${l.newWindow ? " in a new tab" : ""}`).join("; ")
      + `. The {!…} parts are filled from the record's own fields. A case about one: create the record with those fields set, save, open the record, and check where the ${org.customLinks.some((l) => l.kind === "link") ? "link" : "button"} goes.`;
  }
  // Phase D: records made through the API before the test, for a case about an "existing" one.
  if (org.seeded?.length) body += `\nrecords Testbench ALREADY CREATED for this test, through the API (use them as the "existing" record the request means; pick them in a lookup by this exact name; never create them again): ${org.seeded.map((r) => `${r.label} "${r.name}"`).join(", ")}`;
  return `

Salesforce org model (read from the org's own metadata API${org.app ? ` for the app "${org.app}"` : ""} — authoritative):
${body}
The run is already signed in to this org through its connection (no login page exists in the model): write no login, username or password steps.
Use it: name objects, fields, list views and picklist values exactly as written above; to create a record, open its "create form" path above directly by URL (its fields are in the application model on that page; never route through the App Launcher or the navigation to reach it); a case that creates a record fills every "required on create" field with a realistic value and the fields a validation rule reads, and NO other field unless the request names it (a lookup needs an existing record and is left alone unless required); when the request names several objects, write one create case PER object, never one case that creates them all; a picklist step picks only a value listed for it, and a picklist that "depends on" another is set AFTER its controlling field, to a value offered under the controlling value chosen; a case about one record type opens THAT record type's create form path above (the plain create form opens only the default one), and a case that does not name one uses the plain create form; a case that must SAVE successfully also keeps every validation rule's condition FALSE (a rule that fires when Email and Phone are both blank means the case fills one of them); each validation rule above deserves a negative case whose expected result is its exact message, and that case must make its condition true ("fires when": fill every field the formula reads, e.g. Country as well as Phone) while filling every required field; a request about boundaries, limits or edge values gets, for each "boundary" line, TWO cases: one at the value that fires the rule (expected: its exact message) and one at the value that does not (expected: the record saves).${org.validationRulesRead ? "" : " (Validation rules could not be read in this org, so their absence above means nothing.)"}`;
}

/**
 * Phase A gap "validation boundaries": the edge of each simple comparison in a rule's formula, as plain
 * words for the case writer: "AnnualRevenue = -1 fires the rule, AnnualRevenue = 0 does not". Read from
 * `<Field> <op> <number>` and `LEN(<Field>) <op> <number>`; anything else (REGEX, BEGINS, ISBLANK) has no
 * single edge and gives nothing. `<>` / `!=` give both sides of the one allowed length.
 */
export function ruleBoundaries(condition: string): string[] {
  const out: string[] = [];
  const re = /(LEN\(\s*)?\b([A-Za-z_][\w.]*)\s*\)?\s*(<=|>=|<>|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of condition.matchAll(re)) {
    const len = !!m[1], field = m[2], op = m[3], n = Number(m[4]);
    if (/^(LEN|ISBLANK|NOT|AND|OR)$/i.test(field)) continue;
    const step = len || Number.isInteger(n) ? 1 : 0.01;
    const say = (v: number) => len ? `${field} with ${v} characters` : `${field} = ${v}`;
    const pair = (fires: number, ok: number) => out.push(`${say(fires)} fires the rule, ${say(ok)} does not`);
    if (op === "<") pair(n - step, n);
    else if (op === "<=") pair(n, n + step);
    else if (op === ">") pair(n + step, n);
    else if (op === ">=") pair(n, n - step);
    else if (op === "<>" || op === "!=") { pair(n - step, n); pair(n + step, n); }
    else if (op === "=") pair(n, n + step);
  }
  return out;
}

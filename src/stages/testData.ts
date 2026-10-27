/**
 * Test data generator (Session 102, behind TEST_DATA_ENABLED, default off).
 *
 * The values a case types came from the model's text alone, so runs repeated the same
 * "Acme Corporation" / "Doe" (the org's duplicate rule then blocked the save — run
 * 2026-10-24T14-53-11-800Z-86059d19), left required fields empty, picked picklist values the org
 * does not have ("Working" for "Working - Contacted", run 14-30-05), typed text into lookups (run
 * 21-26-12: "Review the following fields: Account Name") and filled fields nobody asked for. The
 * Salesforce org model knows each field's type, whether it is required, its picklist values, which
 * fields are lookups and which a validation rule reads — so this pass fixes values deterministically,
 * the way data-driven tools generate by field type instead of asking a model to invent strings.
 *
 * THE FILL POLICY for a positive create case (user, 2026-10-25): fill the required fields and the
 * fields a validation rule reads; fill another field only when the REQUEST names it. Everything else
 * the model typed is dropped. Values that must stay unique per run (names, emails, phones) carry run
 * tokens (text.ts) that are resolved where the value is typed, never here.
 *
 * NEGATIVE cases: only picklist values are snapped (a non-existent option is never what a test
 * means). A blank, a 7-digit phone or an "info@" address IS the test there. A field any validation
 * rule reads (other than an all-blank rule) is never changed in any case.
 */
import type { IR } from "../schema/ir.js";
import type { AppModel, SalesforceOrgModel } from "../schema/appModel.js";
import type { TestCase } from "./testCases.js";
import { isPositiveCase } from "./hollowPassGuards.js";
import { isEnvValueRef } from "./credentials.js";
import { UNIQUE_TOKEN, PHONE_TOKEN, dateToken, hasRunToken, lineKey } from "../text.js";

export function testDataEnabled(): boolean {
  return process.env.TEST_DATA_ENABLED === "true";
}

/** Case categories whose point is a bad or missing value: their fields are never rewritten. */
const DATA_IS_THE_TEST = new Set(["invalid-input", "empty-boundary"]);

type OrgObject = SalesforceOrgModel["objects"][number];
type OrgField = OrgObject["fields"][number];
type Step = IR["steps"][number];

// ---- realistic values ------------------------------------------------------------------------
// Chosen by a stable hash of the field label, so a field gets the same kind of value on every run
// while two fields differ; uniqueness per run comes from the tokens, not from these words.
const FIRST = ["Asha", "Rohan", "Maya", "Dev", "Priya", "Arjun", "Sara", "Kabir", "Nina", "Omar"];
const LAST = ["Mehta", "Kapoor", "Iyer", "Verma", "Shah", "Rao", "Khan", "Nair", "Bose", "Das"];
const FIRM = ["Northwind", "Bluepeak", "Granite", "Harbor", "Lumen", "Cedar", "Summit", "Orchid"];
const FIRM_KIND = ["Labs", "Industries", "Logistics", "Studio", "Partners", "Systems", "Retail", "Energy"];
const TITLE = ["Operations Manager", "Sales Director", "QA Lead", "Product Manager", "Finance Analyst"];
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const pick = <T,>(arr: T[], seed: string) => arr[hash(seed) % arr.length];

/** A realistic value for a field, by its label first and its Salesforce type second. Undefined when
 *  nothing can be typed (a lookup, a checkbox, a date-time's split inputs). */
export function valueFor(f: OrgField, locale = "en-US"): string | undefined {
  const l = f.label.toLowerCase();
  if (f.lookup || f.type === "Reference" || f.type === "Boolean" || f.type === "DateTime") return undefined;
  if (f.type === "Picklist") return f.picklist?.[0];
  if (f.type === "Email") return `${pick(FIRST, l).toLowerCase()}.${pick(LAST, l + "x").toLowerCase()}+${UNIQUE_TOKEN}@example.com`;
  if (f.type === "Phone") return PHONE_TOKEN;
  if (f.type === "Url") return `https://${pick(FIRM, l).toLowerCase()}.example.com`;
  if (f.type === "Date") return dateToken(30, locale);
  if (f.type === "Currency" || f.type === "Double" || f.type === "Int") return /revenue|amount|budget|cost|value|price/.test(l) ? "25000" : "12";
  if (f.type === "Percent") return "10";
  if (f.type === "TextArea") return `Created by an automated test ${UNIQUE_TOKEN}.`;
  // Strings, by what the label says the field is.
  if (/first ?name/.test(l)) return pick(FIRST, l);
  if (/last ?name|surname/.test(l)) return `${pick(LAST, l)} ${UNIQUE_TOKEN}`;
  if (/company|account name|^name$|opportunity name|campaign name|subject|title$/.test(l) && !/job title/.test(l)) {
    return /title$/.test(l) && !/campaign|opportunity|account/.test(l)
      ? pick(TITLE, l)
      : `${pick(FIRM, l)} ${pick(FIRM_KIND, l + "k")} ${UNIQUE_TOKEN}`;
  }
  if (/title/.test(l)) return pick(TITLE, l);
  if (/street/.test(l)) return "221 Market Street";
  if (/city/.test(l)) return "Austin";
  if (/state|province/.test(l)) return "Texas";
  if (/zip|postal/.test(l)) return "73301";
  if (/country/.test(l)) return "United States";
  if (/website|url/.test(l)) return "https://example.com";
  if (/description|notes|comment/.test(l)) return `Created by an automated test ${UNIQUE_TOKEN}.`;
  return `Test ${f.label} ${UNIQUE_TOKEN}`;
}

// ---- org model lookups -----------------------------------------------------------------------

const apiRe = (f: OrgField) => new RegExp(`\\b${f.api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
/** True when any validation rule's condition names this field: the policy keeps such a field. */
function ruleMentions(o: OrgObject, f: OrgField): boolean {
  return (o.validationRules ?? []).some((r) => r.condition && apiRe(f).test(r.condition));
}
/** True when a validation rule reads this field — other than an all-blank rule, which a value of
 *  the field's own type always keeps false. Such a value is never CHANGED. */
function ruleReads(o: OrgObject, f: OrgField): boolean {
  return (o.validationRules ?? []).some((r) => r.condition && !allBlankRuleFields(r.condition).length && apiRe(f).test(r.condition));
}

/**
 * A rule that fires when EVERY one of some fields is blank ("ISBLANK(Phone) && ISBLANK(Email)"), as
 * the field api names it reads. Only this shape: run 2026-10-24T18-15-55-156Z-9e5d75c0's happy path
 * filled the metadata-required fields and the org's either/or rule blocked the save.
 * ponytail: other formula shapes (OR, NOT, comparisons) are left to the case writer.
 */
function allBlankRuleFields(condition: string): string[] {
  const parts = condition.split("&&").map((p) => p.trim());
  const apis: string[] = [];
  for (const p of parts) {
    const m = /^ISBLANK\(\s*([A-Za-z0-9_]+)\s*\)$/i.exec(p);
    if (!m) return [];
    apis.push(m[1]);
  }
  return apis;
}

/** The org option a picklist value means: itself, else the one option it starts or is part of. */
function snapPicklist(o: OrgObject, value: string, field?: OrgField): string | undefined {
  let v = lineKey(value);
  if (!v) return undefined;
  // The select's own field when it is known; every picklist of the object only when it is not.
  const options = field?.picklist?.length ? field.picklist : o.fields.flatMap((f) => f.picklist ?? []);
  if (options.some((p) => lineKey(p) === v)) return undefined;   // already a real option
  // The field's own label written into the value: "TB Territory South West" for "South West"
  // (run 2026-10-25T15-42-33-903Z-d11ab7a2 then picked "South East").
  const label = field ? lineKey(field.label) : "";
  if (label && v.startsWith(`${label} `)) {
    v = v.slice(label.length + 1);
    const exact = options.find((p) => lineKey(p) === v);
    if (exact) return exact;
  }
  const starts = [...new Set(options.filter((p) => lineKey(p).startsWith(v)))];
  if (starts.length === 1) return starts[0];
  const contains = [...new Set(options.filter((p) => lineKey(p).includes(v)))];
  if (contains.length === 1) return contains[0];
  // The value holds one option as whole words ("Region South" for "South"): the longest, if alone.
  const inside = options.filter((p) => lineKey(p) && ` ${v} `.includes(` ${lineKey(p)} `))
    .sort((a, b) => lineKey(b).length - lineKey(a).length);
  return inside.length && (inside.length === 1 || lineKey(inside[0]).length > lineKey(inside[1]).length) ? inside[0] : undefined;
}

/** The names a lookup field goes by on the form: "<X> ID" in the metadata is "<X> Name" or "<X>"
 *  on the page (Contact's "Account ID" is the form's "Account Name"). */
function formNamesOf(f: OrgField): string[] {
  if (!f.lookup && !/ id$/i.test(f.label)) return [f.label];
  const base = f.label.replace(/ id$/i, "");
  return [f.label, `${base} Name`, base];
}

/** The org field a form control names. */
function fieldOf(o: OrgObject, name: string): OrgField | undefined {
  const k = lineKey(name);
  if (!k) return undefined;
  return o.fields.find((f) => k === lineKey(f.label) || k === lineKey(`${o.label} ${f.label}`))
    ?? o.fields.find((f) => formNamesOf(f).some((n) => lineKey(n) === k));
}

/** The label the create form actually shows for a field, from the discovered page; the first form
 *  name otherwise. */
function formLabel(appModel: AppModel, o: OrgObject, f: OrgField): string {
  const page = appModel.pages.find((p) => new RegExp(`/lightning/o/${o.api}/new(\\?|$)`).test(p.url));
  // "Status" is "Lead Status" on the Lead form; tried first so a bare "Status" never grounds to
  // another field that merely contains it ("SLA Status", run 2026-10-25T05-01-36-627Z-b0d6a138).
  const names = [`${o.label} ${f.label}`, ...formNamesOf(f)];
  if (!page) return names[names.length - 1];
  const shown = new Set(page.elements.map((e) => lineKey(e.name ?? "")));
  return names.find((n) => shown.has(lineKey(n))) ?? names[names.length - 1];
}

/** Words that describe a record without naming one ("an existing Account", "any Account"). */
const GENERIC_RECORD_WORDS = new Set(["a", "an", "the", "any", "some", "existing", "current", "new", "test", "sample",
  "valid", "random", "default", "first", "one", "record", "name", "id", "linked", "related", "parent", "to", "of", "with"]);
/** True when a lookup value names a specific record, not just the object it points at in generic
 *  words: "Existing Account" (copied from "linked to an existing Account") names nothing. */
function namesARecord(value: string, f: OrgField): boolean {
  const objectWords = new Set(lineKey([...formNamesOf(f), f.lookup ?? ""].join(" ")).split(" "));
  return lineKey(value).split(" ").some((w) => w && !objectWords.has(w) && !GENERIC_RECORD_WORDS.has(w));
}

/** The run-token values (record names) typed into the create forms of `objects` before step `before`. */
function createdBefore(ir: IR, before: number, objects: string[]): Set<string> {
  const out = new Set<string>();
  let form: string | undefined;
  for (const s of ir.steps.slice(0, before)) {
    const m = s.action === "navigate" ? /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "") : null;
    if (m) form = m[1];
    else if (s.action === "fill" && form && objects.includes(form) && hasRunToken(s.value)) out.add(s.value!);
  }
  return out;
}

/** Whole-word, case-insensitive: the request names this field, or carries this value. */
const mentions = (request: string, s: string) => {
  const k = lineKey(s);
  return !!k && ` ${lineKey(request)} `.includes(` ${k} `);
};

// ---- the pass -----------------------------------------------------------------------------------

/**
 * Fix this IR's typed values in place from the org model. Returns one note per change, for the log.
 * `request` is the person's own words: a field or value they named is kept even when optional.
 */
export function applyTestData(ir: IR, testCase: Pick<TestCase, "category">, appModel: AppModel, request = ""): string[] {
  const org = appModel.salesforceOrg;
  if (!org) return [];
  const notes: string[] = [];
  // One section per create form the flow opens, each with its own object (run
  // 2026-10-24T21-26-12-355Z-15cbc64f created four objects; only the first was handled). Last first,
  // so steps inserted into a later section do not move an earlier one's indices.
  const sections: { o: OrgObject | undefined; from: number; to: number }[] = [];
  ir.steps.forEach((s, i) => {
    const m = s.action === "navigate" ? /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "") : null;
    if (!m) return;
    if (sections.length) sections[sections.length - 1].to = i;
    sections.push({ o: org.objects.find((x) => x.api === m[1]), from: i, to: ir.steps.length });
  });
  let n = 0;
  for (const sec of sections.reverse()) {
    if (!sec.o) continue;
    const before = ir.steps.length;
    n = applyToSection(ir, sec.o, sec.from, sec.to, testCase, appModel, request, notes, n);
    // Last, on the section as the policy and the required fields left it.
    if (!DATA_IS_THE_TEST.has(testCase.category ?? "")) {
      n = fixDependentPicklists(ir, sec.o, sec.from, sec.to + ir.steps.length - before, appModel, request, notes, n);
    }
  }
  return notes;
}

/**
 * A dependent picklist offers a value only under its controlling value, and is disabled until the
 * controlling field has one: a step picking it with the controller unset, set after it, or set to
 * a value it is not offered under can never succeed. Per dependent select: the controlling step is
 * added when missing (the first controlling value that offers it), moved before the dependent one,
 * and given a value that offers it. A controlling value the REQUEST names wins: then the dependent
 * value is changed to one offered under it.
 */
function fixDependentPicklists(
  ir: IR, o: OrgObject, from: number, to: number, appModel: AppModel, request: string, notes: string[], n: number,
): number {
  const nameOf = (s: Step) => s.target?.name ?? s.target?.label ?? "";
  for (let i = from; i < to; i++) {
    const s = ir.steps[i];
    if (s.action !== "select" || !s.value || isEnvValueRef(s.value)) continue;
    const f = fieldOf(o, nameOf(s));
    const c = f?.controlledBy ? o.fields.find((x) => x.api === f.controlledBy) : undefined;
    if (!f?.validFor || !c?.picklist?.length) continue; // ponytail: checkbox controllers are left alone
    let ci = -1;
    for (let j = from; j < to && ci < 0; j++) {
      if (j !== i && ir.steps[j].action === "select" && fieldOf(o, nameOf(ir.steps[j]))?.api === c.api) ci = j;
    }
    if (ci < 0) {
      const under = f.validFor[s.value];
      if (!under?.length) continue;
      ir.steps.splice(i, 0, { id: `td-${++n}`, action: "select", target: { role: "combobox", name: formLabel(appModel, o, c) }, value: under[0] });
      notes.push(`td-${n}: "${f.label}" depends on "${c.label}" -> selects "${under[0]}" first`);
      i++; to++;
      continue;
    }
    const cs = ir.steps[ci];
    if (!f.validFor[s.value]?.includes(cs.value ?? "")) {
      // The dependent value to switch to: one the request names, else the first offered.
      const under = Object.keys(f.validFor).filter((v) => f.validFor![v].includes(cs.value ?? ""));
      const offered = under.find((v) => mentions(request, v)) ?? under[0];
      if (mentions(request, cs.value ?? "") && offered) {
        notes.push(`${s.id}: "${s.value}" is not offered under ${c.label} "${cs.value}" -> "${offered}"`);
        s.value = offered;
      } else if (f.validFor[s.value]?.length) {
        notes.push(`${cs.id}: ${c.label} "${cs.value}" does not offer ${f.label} "${s.value}" -> "${f.validFor[s.value][0]}"`);
        cs.value = f.validFor[s.value][0];
      }
    }
    if (ci > i) {
      ir.steps.splice(ci, 1);
      ir.steps.splice(i, 0, cs);
      notes.push(`${cs.id}: "${c.label}" moved before the "${f.label}" it controls`);
      i++;
    }
  }
  return n;
}

function applyToSection(
  ir: IR, o: OrgObject, from: number, to: number,
  testCase: Pick<TestCase, "category">, appModel: AppModel, request: string, notes: string[], n: number,
): number {
  const locale = (appModel.salesforceOrg?.userLocale ?? "en-US").replace("_", "-");
  const steps = () => ir.steps.slice(from, to);
  const nameOf = (s: Step) => s.target?.name ?? s.target?.label ?? "";
  const fieldFor = (name: string) => fieldOf(o, name);

  // Every case: a field the org computes (formula, roll-up) has no input to type into.
  for (let i = to - 1; i >= from; i--) {
    const s = ir.steps[i];
    if ((s.action !== "fill" && s.action !== "select") || !o.calculated?.some((c) => lineKey(c.label) === lineKey(nameOf(s)))) continue;
    notes.push(`${s.id}: dropped "${nameOf(s)}" — the org calculates it; a case checks it, never types it`);
    ir.steps.splice(i, 1);
    to--;
  }
  // Every case: a picklist offers only its options, so a value that is not one is never what a test
  // means ("Working" for "Working - Contacted", run 2026-10-24T20-37-00-424Z-410671c2).
  for (const s of steps()) {
    if (s.action !== "select" || !s.value || isEnvValueRef(s.value)) continue;
    const snapped = snapPicklist(o, s.value, fieldFor(nameOf(s)));
    if (snapped) { notes.push(`${s.id}: "${s.value}" -> "${snapped}" (the org's picklist option)`); s.value = snapped; }
  }
  // Every case but those whose point is a bad or missing value: a lookup holds a RECORD, picked from
  // its suggestions. Typed text with no pick blocks the save (run 2026-10-25T06-38-05-138Z-dfdd0d4f
  // case-3), and a `select` on it is not a picklist (case-2). The record named is the request's own
  // — the model invents names ("Existing Account", case-0) — or the one THIS case created earlier
  // under the name it typed ("Test Account {{uid}}" for an Opportunity's Account, Phase A), else the
  // first record the org offers.
  if (!DATA_IS_THE_TEST.has(testCase.category ?? "")) {
    for (const s of steps()) {
      const f = fieldFor(nameOf(s));
      if (!f?.lookup || (s.action !== "fill" && s.action !== "select") || s.target?.lookup) continue;
      s.action = "select";
      s.target = { ...s.target, role: "combobox", lookup: true };
      const own = !!s.value && hasRunToken(s.value) && createdBefore(ir, from, f.lookup.split("/")).has(s.value);
      if (!own && (!s.value || hasRunToken(s.value) || !mentions(request, s.value) || !namesARecord(s.value, f))) s.value = "";
      notes.push(`${s.id}: "${nameOf(s)}" is a lookup -> picks the ${s.value ? `record matching "${s.value}"` : "first record offered"}`);
    }
  }
  // Typed values: positive cases only. In a negative case a blank or wrong value IS the test.
  // A case whose point is a bad or missing value is left as written from here on.
  if (DATA_IS_THE_TEST.has(testCase.category ?? "")) return n;
  // The fill POLICY and value rewriting are for positive cases only: a security case's "<script>"
  // Subject or SQL Description IS its test. Every case that expects a save still gets the required
  // fields it never touches, below (run 2026-10-25T10-28-59-649Z-7acbedab: XSS and SQL Case cases
  // blocked by "Review the following fields: Case Origin").
  const positive = isPositiveCase(testCase);

  // A value an assertion quotes stays as typed, or the assertion stops matching it.
  const asserted = ir.steps.filter((s) => s.action === "assert")
    .map((s) => `${s.target?.text ?? ""}\n${s.value ?? ""}`).join("\n");
  const quoted = (v: string | undefined) => !!v?.trim() && asserted.includes(v.trim());
  const wanted = (f: OrgField, s: Step) => !!f.required || ruleMentions(o, f) || mentions(request, f.label)
    || formNamesOf(f).some((nm) => mentions(request, nm)) || mentions(request, nameOf(s))
    || (!!s.value && !hasRunToken(s.value) && mentions(request, s.value)) || quoted(s.value);

  // THE POLICY: a fill or select on a field that is neither required, nor read by a rule, nor named
  // by the request is dropped. A lookup typed as text is dropped even when named, unless the step
  // can become a real lookup pick below.
  for (let i = to - 1; i >= from && positive; i--) {
    const s = ir.steps[i];
    if (s.action !== "fill" && s.action !== "select") continue;
    const f = fieldFor(nameOf(s));
    // A control the org model does not list is still a field of this create form, and an optional
    // one: the model keeps the required fields first and only the first 40 (run
    // 2026-10-25T05-01-36-627Z-b0d6a138 kept an unrequested Phone that way).
    const keep = f ? wanted(f, s)
      : mentions(request, nameOf(s)) || (!!s.value && !hasRunToken(s.value) && mentions(request, s.value)) || quoted(s.value);
    if (keep) continue;
    notes.push(`${s.id}: dropped "${nameOf(s)}" — optional, no rule reads it and the request does not name it`);
    ir.steps.splice(i, 1);
    to--;
  }

  for (const s of positive ? steps() : []) {
    const name = nameOf(s);
    if (!name || isEnvValueRef(s.value)) continue;
    if (s.action !== "fill") continue;
    const f = fieldFor(name);
    if (!f || ruleReads(o, f) || quoted(s.value)) continue;
    if (!s.value?.trim()) {
      const v = f.required ? valueFor(f, locale) : undefined;
      if (v) { notes.push(`${s.id}: empty required "${f.label}" -> "${v}"`); s.value = v; }
    } else if (f.type === "Email" && !hasRunToken(s.value) && !mentions(request, s.value) && /^[^@\s]+@[^@\s]+$/.test(s.value)) {
      // Duplicate rules match on email, required or not (replay 2026-10-24T21-16-14-645Z-b254fab3):
      // plus-addressing keeps it a valid address and unique per run.
      notes.push(`${s.id}: "${f.label}" made unique per run`);
      s.value = s.value.replace("@", `+${UNIQUE_TOKEN}@`);
    } else if (f.type === "Phone" && !hasRunToken(s.value) && !mentions(request, s.value)) {
      notes.push(`${s.id}: "${f.label}" -> a phone unique per run`);
      s.value = PHONE_TOKEN;
    } else if (f.type === "Date" && !hasRunToken(s.value) && !mentions(request, s.value)) {
      notes.push(`${s.id}: "${f.label}" -> a date computed when the test runs`);
      s.value = dateToken(30, locale);
    } else if (f.required && f.type === "String" && !hasRunToken(s.value)) {
      notes.push(`${s.id}: "${f.label}" made unique per run`);
      s.value = `${s.value} ${UNIQUE_TOKEN}`;
    }
  }

  // Added steps go just before this section's Save click; with none, nothing is added — anywhere
  // else they would land after the final assertion, on a page that no longer has the field.
  const rel = steps().findIndex((s) => s.action === "click" && /\bsave\b/i.test(s.target?.name ?? ""));
  if (rel <= 0) return n;
  let saveIdx = from + rel;
  const touched = new Set(steps().filter((s) => s.action === "fill" || s.action === "select").map((s) => fieldFor(nameOf(s))?.api));
  const filled = new Set(steps().filter((s) => (s.action === "fill" || s.action === "select") && (s.value?.trim() || s.target?.lookup))
    .map((s) => fieldFor(nameOf(s))?.api));
  const add = (step: Step, note: string) => {
    ir.steps.splice(saveIdx++, 0, step);
    notes.push(`${step.id}: ${note}`);
  };

  // Required fields the case never touches: a typed value, a picklist's first option, or — for a
  // required lookup — the first suggestion the org offers.
  for (const f of o.fields) {
    if (!f.required || touched.has(f.api)) continue;
    const label = formLabel(appModel, o, f);
    if (f.lookup) {
      add({ id: `td-${++n}`, action: "select", target: { role: "combobox", name: label, lookup: true }, value: "" },
        `required lookup "${label}" had no step -> picks the first suggestion`);
    } else if (f.type === "Picklist") {
      if (!f.picklist?.length) continue;
      add({ id: `td-${++n}`, action: "select", target: { role: "combobox", name: label }, value: f.picklist[0] },
        `required picklist "${label}" had no step -> "${f.picklist[0]}"`);
    } else {
      const v = valueFor(f, locale);
      if (!v) continue;
      add({ id: `td-${++n}`, action: "fill", target: { role: "textbox", name: label }, value: v },
        `required "${label}" had no step -> filled "${v}"`);
    }
    filled.add(f.api);
  }

  // Every "all of these blank" rule: fill the first of its fields a value can be typed into.
  for (const r of o.validationRules ?? []) {
    const apis = allBlankRuleFields(r.condition ?? "");
    if (!apis.length || apis.some((a) => filled.has(a))) continue;
    const f = apis.map((a) => o.fields.find((x) => x.api === a)).find((x) => x && !x.lookup && x.type !== "Picklist" && valueFor(x, locale));
    if (!f) continue;
    const v = valueFor(f, locale)!;
    add({ id: `td-${++n}`, action: "fill", target: { role: "textbox", name: formLabel(appModel, o, f) }, value: v },
      `rule ${r.name} fires when ${apis.join(" and ")} are blank -> filled "${f.label}" with "${v}"`);
    filled.add(f.api);
  }
  return n;
}

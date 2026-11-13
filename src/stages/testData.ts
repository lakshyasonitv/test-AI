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
import { recordRefObject } from "./salesforceFrontdoor.js";

export function testDataEnabled(): boolean {
  return process.env.TEST_DATA_ENABLED === "true";
}

/** Case categories whose point is a bad or missing value: their fields are never rewritten. */
const DATA_IS_THE_TEST = new Set(["invalid-input", "empty-boundary"]);
/** Roles of a form's own input controls. */
const FORM_CONTROL_ROLE = /^(textbox|combobox|spinbutton|checkbox|searchbox|listbox|radiogroup)$/;

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
  const v = rawValueFor(f, locale);
  return v === undefined ? undefined : fitToField(v, f, locale);
}

/** How long a run token is once typed ({{uid}} is a 6-character code, {{phone}} 10 digits). */
const typedLength = (v: string) => v.replace(/\{\{uid\}\}/g, "xxxxxx").replace(/\{\{phone\}\}/g, "0000000000").replace(/\{\{date:[^}]*\}\}/g, "00/00/0000").length;

/**
 * A value made to fit its field, as the org would accept it: no longer than the field's maximum (Opportunity's
 * Tracking Number takes 12 characters; "Test Tracking Number <code>" would not save), a number within its
 * digits and decimals, written with the user's decimal mark (Lightning reads "25000,50" in German), and a
 * run code on a unique field so a second run does not collide. The run code is kept whole when shortening:
 * it is what makes the value unique.
 */
export function fitToField(value: string, f: Pick<OrgField, "type" | "length" | "precision" | "scale" | "unique">, locale = "en-US"): string {
  let v = value;
  if (/^(Currency|Double|Percent|Int)$/.test(f.type) && /^-?\d+([.,]\d+)?$/.test(v.trim())) {
    let [whole, dec = ""] = v.trim().replace(",", ".").split(".");
    const scale = f.type === "Int" ? 0 : f.scale ?? (dec ? dec.length : 0);
    const digits = f.precision ? Math.max(1, f.precision - scale) : undefined;
    const neg = whole.startsWith("-");
    whole = whole.replace("-", "");
    if (digits && whole.length > digits) whole = "9".repeat(digits);
    if (f.type === "Percent" && Number(whole) > 100) whole = "100";
    dec = dec.slice(0, scale);
    v = (neg ? "-" : "") + whole + (dec ? decimalMark(locale) + dec : "");
  }
  if (f.unique && /^(String|TextArea)$/.test(f.type) && !v.includes(UNIQUE_TOKEN)) v = `${v} ${UNIQUE_TOKEN}`;
  if (f.length && typedLength(v) > f.length) {
    const hasCode = v.includes(UNIQUE_TOKEN);
    const room = f.length - (hasCode ? 6 : 0);
    const text = v.replace(UNIQUE_TOKEN, "").replace(/\s+/g, " ").trim();
    // Only the run code, when nothing else fits beside it (a 6- or 8-character field).
    v = room < 3 ? (hasCode ? UNIQUE_TOKEN : text.slice(0, f.length))
      : hasCode ? `${text.slice(0, room - 1).trim()} ${UNIQUE_TOKEN}`.replace(/^ /, "") : text.slice(0, f.length).trim();
  }
  return v;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * A calendar date written in words ("15 March 1990", "March 15, 1990") or as ISO ("1990-03-15"), in the
 * user's short format ("3/15/1990" in en-US, "15.3.1990" in de-DE). Undefined when it is not such a date:
 * a value already in a numeric short format is left to the user, since 03/04 could be either way round.
 */
export function localeDate(value: string, locale = "en-US"): string | undefined {
  const date = parseDay(value);
  if (!date) return undefined;
  try { return new Intl.DateTimeFormat(locale.replace("_", "-"), { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(date); } catch { return undefined; }
}

/** The calendar day a value names, or undefined: words ("15 March 1990", "March 15, 1990"), ISO, or a
 *  numeric date that reads only one way (15/03/1990: no month 15). 03/04/1990 could be either: undefined. */
export function parseDay(value: string): Date | undefined {
  const v = value.trim();
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  if (y === undefined && (r = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(v))) { d = +r[1]; m = MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1; y = +r[3]; }
  if (y === undefined && (r = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v))) { m = MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1; d = +r[2]; y = +r[3]; }
  if (y === undefined && (r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v))) {
    const a = +r[1], b = +r[2];
    if (a > 12 && b <= 12) { d = a; m = b; y = +r[3]; } else if (b > 12 && a <= 12) { m = a; d = b; y = +r[3]; }
  }
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCDate() === d ? date : undefined;
}

/** The days a request names ("born 15 March 1990", "closing 2026-12-01"). */
function requestDays(request: string): number[] {
  const re = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/g;
  return (request.match(re) ?? []).map((t) => parseDay(t)?.getTime()).filter((t): t is number => t !== undefined);
}

/** "yesterday", "today", "tomorrow" (also as a made-up {{yesterday}} token): days from today. */
function relativeDay(value: string): number | undefined {
  const k = value.trim().replace(/^\{\{\s*|\s*\}\}$/g, "").toLowerCase();
  return k === "yesterday" ? -1 : k === "today" ? 0 : k === "tomorrow" ? 1 : undefined;
}

/** The decimal mark the user's locale writes ("." in en-US, "," in de-DE). */
function decimalMark(locale: string): string {
  try { return new Intl.NumberFormat(locale.replace("_", "-")).format(1.5).replace(/\d/g, "") || "."; } catch { return "."; }
}

/** A time of day the way the user's locale writes one ("10:30 AM", "10:30"). */
function localTime(locale: string, h = 10, m = 30): string {
  try { return new Intl.DateTimeFormat(locale.replace("_", "-"), { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, h, m)); }
  catch { return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; }
}

/** Days from the run a phrase names: today/tomorrow/yesterday, "in 3 days", "3 days from now", "+3 days", "next week". */
function daysAhead(text: string): number | undefined {
  const t = text.trim().replace(/^\{\{\s*|\s*\}\}$/g, "").toLowerCase();
  const rel = relativeDay(t);
  if (rel !== undefined) return rel;
  let r = /^(?:in\s+|\+\s*)?(\d{1,3})\s+days?(?:\s+from\s+(?:now|today))?$/.exec(t);
  if (r) return +r[1];
  if ((r = /^(?:in\s+)?(?:a|one|1)\s+week(?:\s+from\s+(?:now|today))?$|^next\s+week$/.exec(t))) return 7;
  return undefined;
}

/**
 * A date-time value: "<date> <time>", each in the user's format, the date relative to the run unless the request
 * names that exact day. `asked` is what the request says for this field ("tomorrow", "in 3 days"), if anything.
 * Due/end fields default a little later than start fields, so a pair is never back to front.
 */
export function dateTimeValue(raw: string, label: string, locale: string, request = "", asked?: string): string {
  const v = raw.trim();
  const tm = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?/i.exec(v.replace(/^\d{4}-\d{2}-\d{2}T/, "x "));
  let h = tm ? +tm[1] : 10;
  if (tm?.[3]) h = (h % 12) + (/p/i.test(tm[3]) ? 12 : 0);
  const time = localTime(locale, h, tm ? +tm[2] : 30);
  const dayText = v.replace(/T?\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[ap]\.?m\.?)?(?:Z|[+-]\d{2}:?\d{2})?$/i, "").trim();
  const token = /^\{\{date:[+-]?\d+:[^}]+\}\}$/.test(dayText) ? dayText : undefined;
  const ahead = (asked !== undefined ? daysAhead(asked) : undefined) ?? daysAhead(dayText);
  const day = parseDay(dayText);
  const date = ahead !== undefined ? dateToken(ahead, locale)
    : token ? token
    : day && requestDays(request).includes(day.getTime()) ? localeDate(dayText, locale)!
    : dateToken(/\b(due|end|finish|close|expir)/i.test(label) ? 3 : 1, locale);
  return `${date} ${time}`;
}

/**
 * A date-time field is two boxes, "Date" and "Time", and a form has several (a Service Appointment's
 * Earliest Start Permitted and Due Date): a step naming the field, or a box named just "Date", could not be
 * found (runs 2026-11-13T18-30-28-619Z-653368f1, 18-35-51-793Z-df1af5e4). Each fill of a DateTime field on a
 * create form becomes one "sf-dt-" step naming the field, with "<date> <time>" (dateTimeValue); the spec and the
 * replay fill its boxes (generator.ts sfDateTime). Returns notes.
 */
export function dateTimeFills(ir: IR, org: AppModel["salesforceOrg"], request = ""): string[] {
  const notes: string[] = [];
  if (!org) return notes;
  const locale = (org.userLocale ?? "en-US").replace("_", "-");
  let o: OrgObject | undefined;
  for (const s of ir.steps) {
    const m = s.action === "navigate" ? /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "") : null;
    if (m) { o = org.objects.find((x) => x.api === m[1]); continue; }
    if (!o || (s.action !== "fill" && s.action !== "select") || s.id.startsWith("sf-dt-")) continue;
    const name = (s.target?.name ?? s.target?.label ?? "").split("*").join("").trim().toLowerCase();
    const f = o.fields.find((x) => x.type === "DateTime" && x.label.toLowerCase() === name);
    if (!f) continue;
    const esc = f.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asked = new RegExp(`\\b${esc}\\b\\s*(?:of|on|at|as|to|=|:)?\\s*((?:in\\s+)?\\d{1,3}\\s+days?(?:\\s+from\\s+(?:now|today))?|today|tomorrow|yesterday|next\\s+week)`, "i").exec(request)?.[1];
    const was = s.value ?? "";
    s.id = `sf-dt-${s.id}`;
    s.action = "fill";
    s.target = { role: "group", name: f.label };
    s.value = dateTimeValue(was, f.label, locale, request, asked);
    notes.push(`${s.id}: date-time "${f.label}" "${was}" -> "${s.value}", typed into its Date and Time boxes`);
  }
  return notes;
}

function rawValueFor(f: OrgField, locale: string): string | undefined {
  const l = f.label.toLowerCase();
  // A required date-time: the field's Date and Time boxes (dateTimeFills marks the step).
  if (f.type === "DateTime") return dateTimeValue("", f.label, locale);
  // A multi-select picklist is a dual list box, a geolocation two number boxes: neither takes one typed value.
  if (f.lookup || f.type === "Reference" || f.type === "Boolean" || f.type === "MultiPicklist" || f.type === "Location") return undefined;
  if (f.type === "Picklist") return f.picklist?.[0];
  if (f.type === "Email") return `${pick(FIRST, l).toLowerCase()}.${pick(LAST, l + "x").toLowerCase()}+${UNIQUE_TOKEN}@example.com`;
  if (f.type === "Phone") return PHONE_TOKEN;
  if (f.type === "Url") return `https://${pick(FIRM, l).toLowerCase()}.example.com`;
  if (f.type === "Date") return dateToken(30, locale);
  if (f.type === "Time") {
    // A fixed working-hours time, written the way the user's locale writes one ("10:30 AM", "10:30").
    try { return new Intl.DateTimeFormat(locale.replace("_", "-"), { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, 10, 30)); } catch { return "10:30 AM"; }
  }
  if (f.type === "Currency" || f.type === "Double" || f.type === "Int") {
    const big = /revenue|amount|budget|cost|value|price/.test(l);
    // A currency with decimals gets some (".50"): a value with none never tests the decimals at all.
    return f.type === "Currency" && (f.scale ?? 0) >= 2 ? (big ? "25000.50" : "12.50") : big ? "25000" : "12";
  }
  if (f.type === "Percent") return "10";
  if (f.type === "TextArea") return `Created by an automated test ${UNIQUE_TOKEN}.`;
  // A short code-like field (a tracking or order number, a SKU, 12 characters or fewer): digits and the run code.
  if (f.length && f.length <= 20 && /number|code|id\b|sku|no\b|#/.test(l)) return f.length >= 8 ? `TB${UNIQUE_TOKEN}` : UNIQUE_TOKEN;
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
/** The flows triggered on this object, from the org model (their `effects` lines: conditions, sets, creates). */
function flowsOn(o: OrgObject, org: SalesforceOrgModel | undefined): { effects?: string[] }[] {
  return (org?.flows ?? []).filter((fl) => !!fl.object && (fl.object === o.label || fl.object === o.api));
}
/**
 * Phase B: a flow's condition (its "only when", or a branch's "when") reads this field: the policy keeps it,
 * as it keeps a field a validation rule reads. "Test every branch of the lead routing flow" names no field,
 * and Industry and Annual Revenue, the fields that pick the branch, were dropped as optional: every case
 * took the default branch (run 2026-11-10T08-56-13-526Z-86865e92).
 */
function flowReads(o: OrgObject, f: OrgField, org: SalesforceOrgModel | undefined): boolean {
  return flowsOn(o, org).some((fl) => (fl.effects ?? []).some((e) => {
    const cond = /^only when (.*)$/.exec(e)?.[1] ?? /\bwhen (.*?) ->/.exec(e)?.[1];
    return !!cond && apiRe(f).test(cond);
  }));
}
/** The values a flow on this object sets this field to, from "sets Rating = Hot, Status = Working - Contacted"
 *  (not "... on <another object>"): a case must not set them itself, or its check proves nothing. */
function flowSetValues(o: OrgObject, f: OrgField, org: SalesforceOrgModel | undefined): string[] {
  const out: string[] = [];
  for (const fl of flowsOn(o, org)) {
    for (const e of fl.effects ?? []) {
      for (const m of e.matchAll(/\bsets (.+?)(?=;|$)/g)) {
        if (/ on [A-Z][\w ]*$/.test(m[1])) continue;
        for (const part of m[1].split(/,\s+(?=\w+ = )/)) {
          const a = /^(\w+) = (.+)$/.exec(part.trim());
          if (a && a[1].toLowerCase() === f.api.toLowerCase()) out.push(a[2].trim());
        }
      }
    }
  }
  return out;
}

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

/**
 * A value that is no option of its picklist and resembles none (the model's "Region A" for TB Region
 * North/South, run 2026-11-03T04-29-50-846Z-c820d0e1): the field's first option, or for a controlling
 * picklist the first one a dependent field offers values under, so fixDependentPicklists can then
 * fix the dependent step. A value the request names is kept: then the missing option is the test.
 */
function inventedOption(o: OrgObject, value: string, field: OrgField | undefined, request: string): string | undefined {
  const options = field?.picklist ?? [];
  // A dependent field's value is fixed by fixDependentPicklists, under its controlling value.
  if (!options.length || field!.controlledBy || options.some((p) => lineKey(p) === lineKey(value)) || mentions(request, value)) return undefined;
  const offered = new Set(o.fields.filter((d) => d.controlledBy === field!.api && d.validFor)
    .flatMap((d) => Object.values(d.validFor!).flat()));
  return options.find((p) => offered.has(p)) ?? options[0];
}

/** The names a lookup field goes by on the form: "<X> ID" in the metadata is "<X> Name" or "<X>"
 *  on the page (Contact's "Account ID" is the form's "Account Name"). */
function formNamesOf(f: OrgField): string[] {
  if (!f.lookup && !/ id$/i.test(f.label)) return [f.label];
  const base = f.label.replace(/ id$/i, "");
  return [f.label, `${base} Name`, base];
}

/** A lookup the form labels in its own words: Opportunity's "Primary Campaign Source" is the field
 *  "Campaign ID" (run 2026-11-03T05-42-52-539Z-8f96a6d6). The one lookup whose target object the
 *  control's name contains as a word; none when two lookups could be meant. */
function lookupNamedFor(o: OrgObject, name: string): OrgField | undefined {
  const k = ` ${lineKey(name)} `;
  const hits = o.fields.filter((f) => f.lookup?.split("/").some((obj) => lineKey(obj) && k.includes(` ${lineKey(obj)} `)));
  return hits.length === 1 ? hits[0] : undefined;
}

/** The org field a form control names. */
function fieldOf(o: OrgObject, name: string): OrgField | undefined {
  const k = lineKey(name);
  if (!k) return undefined;
  return o.fields.find((f) => k === lineKey(f.label) || k === lineKey(`${o.label} ${f.label}`))
    ?? o.fields.find((f) => formNamesOf(f).some((n) => lineKey(n) === k))
    // The form says "Phone" where the metadata label is "Account Phone" (also Fax, Type, Rating,
    // Description on Account): without this their values were never fixed (run 2026-11-03T05-07-28).
    ?? o.fields.find((f) => lineKey(f.label) === lineKey(`${o.label} ${name}`));
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

/**
 * The part of a request that says what to DO: everything before its first check ("verify", "check that",
 * "confirm", "ensure", "make sure", "assert", "expect"). A request with no check is all actions.
 */
export function requestedActions(request: string): string {
  const m = /\b(verify|verifies|check that|checks that|check the|check its|confirm|ensure|make sure|assert|expect)\b/i.exec(request);
  return m ? request.slice(0, m.index) : request;
}

/** Whole-word, case-insensitive: the request names this field, or carries this value. */
const mentions = (request: string, s: string) => {
  const k = lineKey(s);
  return !!k && ` ${lineKey(request)} `.includes(` ${k} `);
};

/**
 * True when the person's request asks for the whole form ("each and every field", "all the fields",
 * "full details", "fill everything") rather than a create that only has to save. Read from their own
 * words, never the model's, like `mentions`. A phrase that narrows itself to the required ones ("all
 * required fields", "full of the fields which are required") does not count. Before this, such a
 * request named no field, so the fill policy dropped every optional one: 33 fields filled with the pass
 * off (run 2026-10-28T05-42-18-894Z-a951424e), 1 with it on. That request was typed "each and every
 * componet", so the nouns are matched by stem, typos included ("feild", "filds", "componet").
 */
export function asksForEveryField(request: string): boolean {
  const text = ` ${request.toLowerCase().replace(/\s+/g, " ")} `;
  if (/\bfill(?:ing|ed)?(?: in| out| up)? everything\b/.test(text)) return true;
  const whole = /\b(?:each and every|every|all|full|complete|whole)\b(?: \S+){0,3}? (?:f\w{0,2}ld\w{0,2}|compo\w*|detai\w*|input\w*|column\w*|attribut\w*)\b/g;
  for (const m of text.matchAll(whole)) {
    const around = text.slice(m.index!, m.index! + m[0].length + 30);
    if (!/\b(?:required|mandatory)\b/.test(around)) return true;
  }
  return false;
}

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
    sections.push({ o: forRecordType(org.objects.find((x) => x.api === m[1]), s.target?.url ?? ""), from: i, to: ir.steps.length });
  });
  // A create form ends at its Save. Steps after it are on the saved record, or in another object's form
  // opened from there (the Account page's "New Opportunity" action): judged as this form's fields,
  // "Opportunity Name *" and "Close Date *" were no Account field and were dropped as optional, and the
  // Opportunity could not save (run 2026-11-10T06-22-41-469Z-3fe92274).
  for (const sec of sections) {
    const save = ir.steps.findIndex((s, i) => i > sec.from && i < sec.to && s.action === "click" && /^save$/i.test((s.target?.name ?? "").trim()));
    if (save > 0) sec.to = save + 1;
  }
  // Edit forms too: a date typed on an existing record's Edit form ("31 December 2026", run
  // 2026-11-13T13-59-40-225Z-73d6d7c6) was typed as words and the save was refused. Only dates are fixed
  // there: the fill policy is about what a NEW record needs, an edit types what it was asked to.
  if (isPositiveCase(testCase)) {
    const locale = (org.userLocale ?? "en-US").replace("_", "-");
    let object: OrgObject | undefined;
    let inCreate = false;
    for (const s of ir.steps) {
      if (s.action === "navigate") {
        const m = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "");
        inCreate = !!m;
        const api = m?.[1] ?? recordRefObject(s.target?.url);
        if (api) object = org.objects.find((x) => x.api === api);
        continue;
      }
      if (inCreate) { if (s.action === "click" && /^save$/i.test((s.target?.name ?? "").trim())) inCreate = false; continue; }
      if (s.action !== "fill" || !s.value || !object) continue;
      const f = fieldOf(object, s.target?.name ?? s.target?.label ?? "");
      if (f?.type !== "Date") continue;
      const rel = relativeDay(s.value);
      const v = rel !== undefined ? dateToken(rel, locale) : localeDate(s.value, locale);
      if (!v || v === s.value) continue;
      const was = s.value;
      const day = parseDay(was)?.getTime();
      s.value = v;
      for (const a of ir.steps) {
        if (a.action !== "assert") continue;
        if (a.value === was || (day !== undefined && a.value && parseDay(a.value)?.getTime() === day)) a.value = v;
        if (a.target?.text === was || (day !== undefined && a.target?.text && parseDay(a.target.text)?.getTime() === day)) a.target = { ...a.target, text: v };
      }
      notes.push(`${s.id}: "${f.label}" on the edit form "${was}" -> "${v}", the user's date format`);
    }
  }
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
 * The object as a record type's form shows it: a form opened with ?recordTypeId= offers that record
 * type's picklist values (deep discovery reads them per record type), not the default one's. A value
 * snapped to the default's options could be absent from this form.
 */
function forRecordType(o: OrgObject | undefined, url: string): OrgObject | undefined {
  const id = /[?&]recordTypeId=([A-Za-z0-9]{15,18})/.exec(url)?.[1];
  const rt = id ? o?.recordTypes?.find((r) => r.id === id || r.id.slice(0, 15) === id.slice(0, 15)) : undefined;
  if (!o || !rt?.picklists) return o;
  const own = rt.picklists;
  return { ...o, fields: o.fields.map((f) => own[f.label]?.length ? { ...f, picklist: own[f.label] } : f) };
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
      } else if (offered && !mentions(request, s.value)) {
        // Not an option of the field under ANY controlling value (the model's "Territory 1"): the
        // first value offered under the controlling one, as for a dependent step added above.
        notes.push(`${s.id}: "${s.value}" is no ${f.label} option -> "${offered}" (offered under ${c.label} "${cs.value}")`);
        s.value = offered;
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
  // Every case: a date is typed, never picked from the calendar. "Select a date for Close Date" then
  // "Today" opens a popup no screen captured (run 2026-11-03T08-32-47-277Z-249e547b truncated there);
  // the clicks go, with the day pick and waits after them, and a required date is then filled below.
  for (let i = to - 1; i >= from; i--) {
    const s = ir.steps[i];
    if (s.action !== "click" || !/^select a date\b/i.test(s.target?.name ?? "")) continue;
    let end = i + 1;
    while (end < to && (ir.steps[end].action === "wait"
      || (ir.steps[end].action === "click" && /^(today|\d{1,2})$/i.test(ir.steps[end].target?.name?.trim() ?? "")))) end++;
    notes.push(`${s.id}: dropped the date picker clicks — the date is typed instead`);
    ir.steps.splice(i, end - i);
    to -= end - i;
  }
  // Every case: the record type is the form's own (chosen by its URL), never a value of another picklist:
  // run 2026-11-13T14-13-11-352Z-7c8d6c62 picked "TB Partner" in the Account's Type, which offers no such
  // option, and stopped there. The step goes when the field does not offer that name.
  for (let i = to - 1; i >= from; i--) {
    const s = ir.steps[i];
    if (s.action !== "select" || !s.value) continue;
    const f = fieldFor(nameOf(s));
    const rt = o.recordTypes?.find((r) => lineKey(r.name) === lineKey(s.value!));
    if (!rt || f?.picklist?.some((p) => lineKey(p) === lineKey(s.value!))) continue;
    notes.push(`${s.id}: "${s.value}" is the record type, not a "${nameOf(s)}" option -> dropped (the form's URL already chooses it)`);
    ir.steps.splice(i, 1);
    to--;
  }
  // Every case: a picklist offers only its options, so a value that is not one is never what a test
  // means ("Working" for "Working - Contacted", run 2026-10-24T20-37-00-424Z-410671c2).
  for (const s of steps()) {
    if (s.action !== "select" || !s.value || isEnvValueRef(s.value)) continue;
    const f = fieldFor(nameOf(s));
    const snapped = snapPicklist(o, s.value, f) ?? inventedOption(o, s.value, f, request);
    // A value the request names may be completed ("Working" -> "Working - Contacted": the option begins
    // with it), never swapped for another option that only contains it: "Technology" became
    // "Biotechnology" when the model's option list was cut short (run 2026-11-10T05-05-39-201Z-52ce7aed).
    if (snapped && mentions(request, s.value) && !mentions(request, snapped)
      && !`${lineKey(snapped)} `.startsWith(`${lineKey(s.value)} `)) {
      notes.push(`${s.id}: kept "${s.value}" (the request names it), not the option "${snapped}"`);
      continue;
    }
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
      const f = fieldFor(nameOf(s)) ?? (s.action === "select" ? lookupNamedFor(o, nameOf(s)) : undefined);
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
  // Not a value the request only CHECKS ("verify its Rating shows Hot"): keeping it because the check
  // quotes it is the test setting the very value it then checks (run 2026-11-10T05-51-13-444Z-c5882e76).
  const checksPart = request.slice(requestedActions(request).length);
  const quoted = (v: string | undefined) => !!v?.trim() && asserted.includes(v.trim())
    && !(mentions(checksPart, v) && !mentions(requestedActions(request), v));
  // "Each and every field": every field the case fills is wanted; values are still fixed below.
  const everyField = asksForEveryField(request);
  // "Each and every field": a check on one of the form's own controls before Save is a field the
  // model skipped, not a check the request asked for ("Private" asserted hidden, run
  // 2026-11-03T10-42-46-258Z-6b58f976, failed there). A checkbox is ticked; any other goes.
  if (everyField && positive) {
    for (let i = from; i < to; i++) {
      const s = ir.steps[i];
      if (s.action === "click" && /\bsave\b/i.test(s.target?.name ?? "")) break;
      if (s.action !== "assert" || !FORM_CONTROL_ROLE.test(s.target?.role ?? "")) continue;
      if (s.target!.role === "checkbox") {
        notes.push(`${s.id}: a check on the "${nameOf(s)}" checkbox -> ticks it (every field)`);
        ir.steps[i] = { id: s.id, action: "check", target: s.target };
        continue;
      }
      notes.push(`${s.id}: dropped a check on the "${nameOf(s)}" field mid-form (every field)`);
      ir.steps.splice(i--, 1);
      to--;
    }
  }
  // A step with no value fills nothing (the model leaving a field blank on purpose): not kept for this.
  // Nor does "None" or "N/A": the model's way of saying the same (Primary Campaign Source "None", run
  // 2026-11-03T05-36-38-368Z-379eb1ea, which then found no such option).
  const blank = (v: string) => /^(-+\s*)?(none|n\/?a|null|blank|empty)(\s*-+)?$/i.test(v.trim());
  const fills = (s: Step) => s.value?.trim() ? !blank(s.value) : !!s.target?.lookup;
  // What the request asks the test to DO, without what it asks it to check: a field named only after
  // "verify" is the expected RESULT. The case set the Account's Type to "Customer - Direct" itself, the
  // value a flow was to set, so the check could prove nothing (run 2026-11-10T05-11-20-593Z-6f9640b8).
  const asks = requestedActions(request);
  const org = appModel.salesforceOrg;
  // A value a flow on this object sets the field to, the request not asking for it: the flow's to set.
  const flowSets = (f: OrgField, s: Step) => !!s.value && !mentions(asks, s.value)
    && flowSetValues(o, f, org).some((v) => lineKey(v) === lineKey(s.value!));
  const wanted = (f: OrgField, s: Step) => !(flowSets(f, s) && !f.required) && ((everyField && fills(s)) || !!f.required
    || ruleMentions(o, f) || flowReads(o, f, org) || mentions(asks, f.label)
    || formNamesOf(f).some((nm) => mentions(asks, nm)) || mentions(asks, nameOf(s))
    || (!!s.value && !hasRunToken(s.value) && mentions(asks, s.value)) || quoted(s.value));

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
      : (everyField && fills(s)) || mentions(asks, nameOf(s)) || (!!s.value && !hasRunToken(s.value) && mentions(asks, s.value)) || quoted(s.value);
    if (keep) continue;
    notes.push(`${s.id}: dropped "${nameOf(s)}" — optional, no rule reads it and the request does not name it`);
    ir.steps.splice(i, 1);
    to--;
  }

  // A required picklist must be set, but not to the value the request only CHECKS: a flow is to set
  // Lead Status to "Working - Contacted", so the case starts it on another option, or the check proves
  // nothing (run 2026-11-10T05-51-13-444Z-c5882e76).
  for (const s of positive ? steps() : []) {
    if (s.action !== "select" || !s.value) continue;
    const f = fieldFor(nameOf(s));
    // Also a value a flow on this object sets it to (the flow-branch case set Lead Status to the Hot
    // branch's "Working - Contacted" itself, run 2026-11-10T08-56-13-526Z-86865e92).
    const flowValue = !!f && !mentions(requestedActions(request), s.value)
      && flowSetValues(o, f, appModel.salesforceOrg).some((v) => lineKey(v) === lineKey(s.value!));
    if (!(mentions(checksPart, s.value) && !mentions(requestedActions(request), s.value)) && !flowValue) continue;
    const other = f?.required && !f.controlledBy ? f.picklist?.find((p) => lineKey(p) !== lineKey(s.value!)) : undefined;
    if (!other) continue;
    notes.push(`${s.id}: "${nameOf(s)}" starts as "${other}", not "${s.value}", the value the request checks it changes to`);
    s.value = other;
  }
  // A full name typed into First Name too ("Ana Lopez" there and "Lopez" in Last Name, run
  // 2026-11-13T12-25-46-923Z-8b85bfb3): First Name keeps only its own words.
  {
    const first = steps().find((s) => s.action === "fill" && /^first ?name$/i.test(nameOf(s).replace(/^\*\s*|\s*\*$/g, "").trim()));
    const last = steps().find((s) => s.action === "fill" && /^last ?name$/i.test(nameOf(s).replace(/^\*\s*|\s*\*$/g, "").trim()));
    const lastWords = (last?.value ?? "").replace(/\{\{uid\}\}/g, "").trim();
    if (first?.value && lastWords && first.value.trim().toLowerCase().endsWith(` ${lastWords.toLowerCase()}`)) {
      const was = first.value;
      first.value = first.value.trim().slice(0, -lastWords.length).trim();
      notes.push(`${first.id}: First Name "${was}" also held the Last Name -> "${first.value}"`);
    }
  }
  // A value that starts with its own field's label ("Last Name Sato" in Last Name, "Company Kintsugi Labs" in
  // Company, run 2026-11-13T15-19-02-592Z-1e01cacf saved them so): the label goes, unless the request writes it so.
  for (const s of positive ? steps() : []) {
    if (s.action !== "fill" || !s.value) continue;
    const label = nameOf(s).replace(/^\*\s*|\s*\*$/g, "").trim();
    if (!label || !s.value.toLowerCase().startsWith(`${label.toLowerCase()} `)) continue;
    const rest = s.value.slice(label.length).trim();
    if (!rest || mentions(request, s.value.replace(/\s*\{\{uid\}\}/g, ""))) continue;
    // The checks that quote it change with it.
    const was = s.value;
    s.value = rest;
    for (const a of ir.steps) {
      if (a.action !== "assert") continue;
      if (a.value === was) a.value = rest;
      if (a.target?.text === was) a.target = { ...a.target, text: rest };
    }
    notes.push(`${s.id}: "${was}" held its own field label -> "${rest}"`);
  }
  for (const s of positive ? steps() : []) {
    const name = nameOf(s);
    if (!name || isEnvValueRef(s.value)) continue;
    if (s.action !== "fill") continue;
    const f = fieldFor(name);
    if (!f || ruleReads(o, f)) continue;
    if (f.type === "Date" && s.value) {
      // "Yesterday", "today", "tomorrow", or the model's own {{yesterday}} (typed as is, it refused the save,
      // run 2026-11-13T12-43-46-655Z-6cd531ab): a day relative to the run.
      const rel = relativeDay(s.value);
      if (rel !== undefined) {
        notes.push(`${s.id}: "${f.label}" "${s.value}" -> ${rel === 0 ? "today" : rel < 0 ? "yesterday" : "tomorrow"}, worked out when the test runs`);
        const was = s.value;
        s.value = dateToken(rel, locale);
        // A check quoting it too (run 2026-11-13T12-56-03-736Z-5e8f62bc looked for "{{yesterday}}" on the page), or
        // naming that day as a fixed date ("11/12/2026", run 2026-11-13T13-30-41-541Z-6d66f06e): right today, wrong
        // on tomorrow's replay of a saved suite. Both follow the field, relative to the run.
        const now = new Date();
        const thatDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + rel);
        const sameDay = (t?: string) => !!t && (t === was || parseDay(t)?.getTime() === thatDay
          || new RegExp(`^${new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(thatDay)).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`).test(t.trim()));
        for (const a of ir.steps) {
          if (a.action !== "assert") continue;
          if (sameDay(a.value)) a.value = s.value;
          if (sameDay(a.target?.text)) a.target = { ...a.target, text: s.value };
        }
        continue;
      }
      // The day the request names, however the model wrote it ("15/03/1990" for "15 March 1990", run
      // 2026-11-13T12-43-28-833Z-72d3e52b, was taken for a made-up date and replaced): that day, in the user's
      // format, and every check of that day in the same format.
      const day = parseDay(s.value);
      if (day && requestDays(request).includes(day.getTime())) {
        const v = localeDate(s.value, locale)!;
        const was = s.value;
        s.value = v;
        for (const a of ir.steps) {
          if (a.action !== "assert") continue;
          if (a.value && parseDay(a.value)?.getTime() === day.getTime()) a.value = v;
          if (a.target?.text && parseDay(a.target.text)?.getTime() === day.getTime()) a.target = { ...a.target, text: v };
        }
        if (v !== was) notes.push(`${s.id}: "${f.label}" "${was}" -> "${v}", the requested day in the user's format`);
        continue;
      }
    }
    if (quoted(s.value)) {
      // A value a later check quotes stays as typed, except that it must still fit the field: Salesforce
      // cut "TRACK-PLAN-001" to 12 characters (run 2026-11-13T12-02-09-298Z-fc1e4b67), so the save and the
      // check disagreed. Shortened here, the checks that quote it are changed the same way.
      const was = s.value!;
      // A date in words is the same day in the user's format (the record page shows it that way too).
      const fitted = f.type === "Date" ? localeDate(was, locale) ?? was
        : mentions(request, was) ? was : fitToField(was, f, locale);
      if (fitted !== was) {
        s.value = fitted;
        for (const a of ir.steps) {
          if (a.action !== "assert") continue;
          if (a.value === was) a.value = fitted;
          if (a.target?.text === was) a.target = { ...a.target, text: fitted };
        }
        notes.push(`${s.id}: "${f.label}" fitted to the field: "${was}" -> "${fitted}", and the checks quoting it`);
      }
      continue;
    }
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
    } else if (f.type === "Url" && !hasRunToken(s.value) && !mentions(request, s.value)) {
      // Duplicate rules match on website and address too: an earlier run's Account with the same
      // ones raised "Similar Records Exist" (run 2026-11-03T05-07-28-369Z-388aa153).
      notes.push(`${s.id}: "${f.label}" -> a website unique per run`);
      s.value = `https://${UNIQUE_TOKEN}.example.com`;
    } else if (/\b(street|city)\b/i.test(f.label) && !hasRunToken(s.value) && !mentions(request, s.value)) {
      notes.push(`${s.id}: "${f.label}" made unique per run`);
      s.value = `${s.value} ${UNIQUE_TOKEN}`;
    } else if (f.type === "Date" && !hasRunToken(s.value) && mentions(request, s.value) && localeDate(s.value, locale)) {
      // A date the request gives in words ("15 March 1990") or as ISO: Lightning's date box takes only the
      // user's short format, and refused the save (run 2026-11-13T12-25-46-923Z-8b85bfb3: "Review the
      // following fields: Birthdate"). Same day, the user's way of writing it.
      const v = localeDate(s.value, locale)!;
      if (v !== s.value) { notes.push(`${s.id}: "${f.label}" "${s.value}" -> "${v}", the user's date format`); s.value = v; }
    } else if (f.type === "Date" && !hasRunToken(s.value) && !mentions(request, s.value)) {
      notes.push(`${s.id}: "${f.label}" -> a date computed when the test runs`);
      s.value = dateToken(30, locale);
    } else if (f.required && f.type === "String" && !hasRunToken(s.value)) {
      notes.push(`${s.id}: "${f.label}" made unique per run`);
      s.value = `${s.value} ${UNIQUE_TOKEN}`;
    }
    // Whatever the value now is, it must fit the field (length, digits, decimals, decimal mark, unique). A
    // value the request gives is left as written: an over-long one is then the test.
    if (s.value && !mentions(request, s.value.replace(/\s*\{\{uid\}\}/g, ""))) {
      const fitted = fitToField(s.value, f, locale);
      if (fitted !== s.value) { notes.push(`${s.id}: "${f.label}" fitted to the field: "${s.value}" -> "${fitted}"`); s.value = fitted; }
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

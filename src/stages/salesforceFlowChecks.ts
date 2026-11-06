/**
 * Record-triggered flows that update the record's own fields — Salesforce's "fast field updates"
 * (before-save) and an after-save flow's "update the triggering record" — CHECKED, not just asked
 * for (SALESFORCE_FLOW_CHECKS_ENABLED, default off, `DECISIONS.md` D-78).
 *
 * WHAT WAS THERE. The org model already read each active flow and described it in plain lines
 * ("only when Rating = Hot", "sets Tier__c = Gold"), and the case-writing prompt asked the model to
 * write a case that meets the conditions and checks the field on the record page. Both prompt lines
 * said "(No deterministic check.)": whether the case met the conditions, and whether it checked the
 * right field for the right value, was whatever the model wrote. A before-save flow has no screen,
 * no toast and no page of its own; the only evidence it ran is a field value on the saved record.
 *
 * WHAT THIS ADDS, IN TWO HALVES.
 *  1. `flowFieldUpdates` reads, from the same flow metadata the org model already fetches, what the
 *     flow sets as DATA: its object, before- or after-save, its start conditions, and every
 *     assignment to `$Record.<Field>` with a fixed value on the path from the start element up to the
 *     first decision. An assignment behind a decision, from a variable or formula, or one that adds
 *     to the field's own value, is listed under `skipped` with why: no check is ever made up for it.
 *  2. `flowFieldChecks` (an IR pass, before grounding, like the other Salesforce passes) finds each
 *     create form a case saves, evaluates the flow's start conditions against the values the case
 *     itself typed — structure: the org field each step names and the literal it types — and only
 *     when they hold adds one assertion per field the flow sets: `{ field, recordField }`, "text_equals"
 *     the flow's value. The generated spec reads that field of the saved record through the run's
 *     org connection (`sfSavedField`, generator.ts), not off the page: a field the page layout does
 *     not show is still checked, and a checkbox's `true` is compared as data, not as page text.
 *
 * WHEN IT ADDS NOTHING, IT SAYS SO. A condition on a field the case never sets (its value then
 * comes from a default this code cannot see), a value with a run token, an operator it cannot judge
 * on a new record: the flow is "undecided" and a note names the field. A condition the case breaks:
 * the flow does not run, nothing is checked, and the note says that too. Missing a check is the safe
 * direction here; asserting a flow's effect on a record it never ran for would fail a healthy org.
 */
import type { IR, Step } from "../schema/ir.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";
import { hasRunToken } from "../text.js";
import { fieldOf } from "./testData.js";

export function flowChecksEnabled(): boolean {
  return process.env.SALESFORCE_FLOW_CHECKS_ENABLED === "true";
}

type Flow = NonNullable<SalesforceOrgModel["flows"]>[number];
export type FlowFieldUpdates = NonNullable<Flow["fieldUpdates"]>;
type OrgObject = SalesforceOrgModel["objects"][number];

/** A fixed value in flow metadata, as a string; undefined for a reference, a formula or nothing. */
function literal(v: any): string | undefined {
  for (const k of ["stringValue", "numberValue", "booleanValue", "dateValue", "dateTimeValue"]) {
    if (v?.[k] !== undefined && v[k] !== null) return String(v[k]);
  }
  return undefined;
}

/** Element arrays a flow's metadata may hold, by the key the Tooling API uses. */
const ELEMENT_KINDS = [
  "assignments", "recordUpdates", "decisions", "recordLookups", "recordCreates", "recordDeletes", "loops",
  "actionCalls", "subflows", "screens", "waits", "collectionProcessors", "customErrors", "transforms",
];
/** How far the walk from the start element goes before it gives up (a flow is not this long). */
const MAX_WALK = 60;

/**
 * What a record-triggered flow sets on its own record, as data a check can use. Undefined for a flow
 * that is not record-triggered on save, or whose metadata names no object.
 *
 * The walk follows `connector` only — never a fault path, never a scheduled path (those run later,
 * asynchronously) — from `start` through assignments, "update the triggering record" elements and
 * the record lookups, creates and deletes of OTHER records (which do not branch), and stops at
 * anything else: past a decision, which
 * assignments run depends on the record's values. A later assignment to the same field wins, as it
 * does when the flow runs.
 */
export function flowFieldUpdates(meta: any, triggerType: string): FlowFieldUpdates | undefined {
  const timing = triggerType === "RecordBeforeSave" ? "before-save" : triggerType === "RecordAfterSave" ? "after-save" : null;
  const object = typeof meta?.start?.object === "string" ? meta.start.object : "";
  if (!timing || !object) return undefined;

  const conditions = (Array.isArray(meta.start.filters) ? meta.start.filters : []).map((f: any) => ({
    field: String(f?.field ?? ""), op: String(f?.operator ?? ""), value: literal(f?.value) ?? "",
  }));
  const formula = typeof meta.start.filterFormula === "string" && meta.start.filterFormula.trim();
  const logic = formula ? "formula"
    : conditions.length ? String(meta.start.filterLogic ?? "and").trim().toLowerCase() || "and" : "none";

  const byName = new Map<string, { kind: string; el: any }>();
  for (const kind of ELEMENT_KINDS) {
    for (const el of Array.isArray(meta[kind]) ? meta[kind] : []) if (typeof el?.name === "string") byName.set(el.name, { kind, el });
  }
  const sets = new Map<string, string>();
  const skipped: string[] = [];
  const set = (field: string, value: unknown, operator?: string) => {
    if (operator && operator !== "Assign") { skipped.push(`${field}: "${operator}" changes it relative to its own value`); return; }
    if (field.includes(".")) { skipped.push(`${field}: a field of a related record`); return; }
    const v = literal(value);
    if (v === undefined) {
      const ref = (value as any)?.elementReference;
      skipped.push(`${field}: set from ${ref ? `"${ref}"` : "a formula or another element"}, not a fixed value`);
      sets.delete(field);
      return;
    }
    sets.set(field, v);
  };
  const seen = new Set<string>();
  let at: unknown = meta.start?.connector?.targetReference;
  while (typeof at === "string" && !seen.has(at) && seen.size < MAX_WALK) {
    seen.add(at);
    const node = byName.get(at);
    if (!node) break;
    if (node.kind === "assignments") {
      for (const it of Array.isArray(node.el.assignmentItems) ? node.el.assignmentItems : []) {
        const ref = String(it?.assignToReference ?? "");
        if (ref.startsWith("$Record.")) set(ref.slice("$Record.".length), it?.value, it?.operator);
      }
    } else if (node.kind === "recordUpdates") {
      // Only "update the triggering record"; an update of other records found by filters is not this record.
      if (node.el.inputReference === "$Record") {
        for (const a of Array.isArray(node.el.inputAssignments) ? node.el.inputAssignments : []) {
          if (typeof a?.field === "string") set(a.field, a.value);
        }
      }
    } else if (!["recordLookups", "recordCreates", "recordDeletes"].includes(node.kind)) {
      // Reading, creating or deleting OTHER records does not branch: the path goes on through them.
      skipped.push(node.kind === "decisions"
        ? `anything after the decision "${node.el.label ?? node.el.name}" depends on the record's values`
        : `the flow goes on through a ${node.kind.replace(/s$/, "")} element, which is not followed`);
      break;
    }
    at = node.el.connector?.targetReference;
  }
  return {
    object, timing, conditions, logic,
    sets: [...sets].map(([field, value]) => ({ field, value })),
    ...(skipped.length ? { skipped: skipped.slice(0, 8) } : {}),
  };
}

// ---- deciding whether the flow runs for a case ------------------------------------------------

/** Three-valued: true / false / undefined = cannot be decided from the case's own inputs. */
type Tri = boolean | undefined;
const and = (xs: Tri[]): Tri => xs.some((x) => x === false) ? false : xs.every((x) => x === true) ? true : undefined;
const or = (xs: Tri[]): Tri => xs.some((x) => x === true) ? true : xs.every((x) => x === false) ? false : undefined;
const not = (x: Tri): Tri => x === undefined ? undefined : !x;

const num = (s: string): number | null => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);

/** One start condition against the value the case typed (undefined: the case did not set the field). */
export function conditionHolds(c: { op: string; value: string }, typed: string | undefined, picklist: boolean): Tri {
  if (typed === undefined) return undefined;
  const v = typed.trim();
  // A run token resolves when the test runs: only its non-blankness is known now.
  if (hasRunToken(v)) return c.op === "IsNull" ? (c.value.toLowerCase() === "true" ? false : true) : undefined;
  const want = c.value.trim();
  const a = num(v);
  const b = num(want);
  const eq = a !== null && b !== null ? a === b
    : /^(true|false)$/i.test(want) ? v.toLowerCase() === want.toLowerCase() : v === want;
  switch (c.op) {
    case "EqualTo": return eq;
    // A picklist's option is shown by its LABEL and compared by its API value: a label that differs
    // is not proof the value differs, so "not equal" is undecided unless they are the same.
    case "NotEqualTo": return eq ? false : picklist ? undefined : true;
    case "GreaterThan": return a !== null && b !== null ? a > b : undefined;
    case "LessThan": return a !== null && b !== null ? a < b : undefined;
    case "GreaterThanOrEqualTo": return a !== null && b !== null ? a >= b : undefined;
    case "LessThanOrEqualTo": return a !== null && b !== null ? a <= b : undefined;
    case "Contains": return v.includes(want);
    case "StartsWith": return v.startsWith(want);
    case "EndsWith": return v.endsWith(want);
    case "IsNull": return want.toLowerCase() === "true" ? v === "" : v !== "";
    default: return undefined; // IsChanged and anything new: not judged on a record being created
  }
}

/**
 * Custom filter logic ("1 AND (2 OR NOT 3)") over the conditions' results. Undefined when it does not
 * parse: an expression this cannot read is never guessed at.
 */
export function evalLogic(logic: string, results: Tri[]): Tri | "unparsed" {
  if (logic === "none") return true;
  if (logic === "and") return and(results);
  if (logic === "or") return or(results);
  const tokens = logic.toUpperCase().match(/\d+|AND|OR|NOT|\(|\)|\S/g) ?? [];
  let i = 0;
  let bad = false;
  const primary = (): Tri => {
    const t = tokens[i++];
    if (t === "NOT") return not(primary());
    if (t === "(") { const r = expr(); if (tokens[i++] !== ")") bad = true; return r; }
    if (t !== undefined && /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= results.length) return results[Number(t) - 1];
    bad = true;
    return undefined;
  };
  const conj = (): Tri => { const xs = [primary()]; while (tokens[i] === "AND") { i++; xs.push(primary()); } return and(xs); };
  const expr = (): Tri => { const xs = [conj()]; while (tokens[i] === "OR") { i++; xs.push(conj()); } return or(xs); };
  const r = expr();
  return bad || i !== tokens.length ? "unparsed" : r;
}

const isSave = (s: Step) => s.action === "click" && /^save$/i.test(s.target?.name ?? "");
const nameOf = (s: Step) => s.target?.name ?? s.target?.label ?? "";

/** The value each org field gets from the steps of one create form, by API name. */
function typedValues(steps: Step[], o: OrgObject): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of steps) {
    if (s.action !== "fill" && s.action !== "select" && s.action !== "check") continue;
    const f = fieldOf(o, nameOf(s));
    if (!f) continue;
    out.set(f.api, s.action === "check" ? "true" : s.value ?? "");
  }
  return out;
}

/**
 * Add, after each create form a case saves, one check per field a record-triggered flow on that
 * object sets — when, and only when, the case's own inputs meet the flow's start conditions. In
 * place; returns one note per decision, checked or not. See the header for what is never checked.
 */
export function flowFieldChecks(ir: IR, org: SalesforceOrgModel | undefined): string[] {
  const notes: string[] = [];
  const flows = (org?.flows ?? []).filter((f) => f.type === "record-triggered" && f.fieldUpdates && /\bcreate\b/.test(f.when ?? ""));
  if (!org || !flows.length) return notes;
  const steps = ir.steps;
  const saved = new Map<string, number>();
  let form: string | null = null;
  let from = -1;
  let opaque = false;
  let k = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.action === "navigate") {
      const m = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "");
      form = m ? decodeURIComponent(m[1]) : null;
      from = i;
      continue;
    }
    // A create form opened by a click is counted by the running test but not by this pass, so the
    // record numbers would no longer agree. From there on, nothing is checked.
    if (s.action === "click" && /^(new\b.*|clone)$/i.test(s.target?.name ?? "")) opaque = true;
    if (!isSave(s) || !form) continue;
    const object = form;
    form = null;
    const n = (saved.get(object) ?? 0) + 1;
    saved.set(object, n);
    const mine = flows.filter((f) => f.fieldUpdates!.object === object);
    if (!mine.length) continue;
    let end = i + 1;
    while (end < steps.length && (steps[end].action === "wait" || steps[end].action === "assert")) end++;
    const created = steps.slice(i + 1, end).some((x) => x.action === "assert" && x.assertion !== "hidden"
      && /\bwas created\b/.test(x.target?.text ?? ""));
    if (!created || opaque) {
      for (const f of mine) {
        notes.push(`flow "${f.label}" on ${object}: not checked — ${opaque ? "a create form earlier in the case was opened by a click, so which saved record is which cannot be told apart"
          : "the case does not show this save succeeding (no \"was created\" after it)"}`);
      }
      continue;
    }
    const o = org.objects.find((x) => x.api === object);
    const values = o ? typedValues(steps.slice(from + 1, i), o) : new Map<string, string>();
    for (const f of mine) {
      const fu = f.fieldUpdates!;
      if (!fu.sets.length) {
        notes.push(`flow "${f.label}" on ${object}: nothing it sets can be checked${fu.skipped?.length ? ` (${fu.skipped.join("; ")})` : ""}`);
        continue;
      }
      if (fu.logic === "formula") {
        notes.push(`flow "${f.label}" on ${object}: not checked — it starts on a formula, which is not evaluated here`);
        continue;
      }
      const results = fu.conditions.map((c) => {
        const field = o?.fields.find((x) => x.api === c.field);
        return conditionHolds(c, values.get(c.field), !!field?.picklist?.length);
      });
      const runs = evalLogic(fu.logic, results);
      if (runs === "unparsed") {
        notes.push(`flow "${f.label}" on ${object}: not checked — its condition logic "${fu.logic}" could not be read`);
        continue;
      }
      if (runs === false) {
        notes.push(`flow "${f.label}" on ${object}: does not run for this case (its start conditions are not met), so nothing is checked`);
        continue;
      }
      if (runs === undefined) {
        const open = fu.conditions.filter((_c, j) => results[j] === undefined).map((c) => c.field);
        notes.push(`flow "${f.label}" on ${object}: not checked — whether it runs depends on ${open.join(", ")}, which the case does not set to a fixed value`);
        continue;
      }
      const added: Step[] = fu.sets.map((st) => ({
        id: `sf-flow-${++k}`,
        action: "assert",
        assertion: "text_equals",
        target: { field: o?.fields.find((x) => x.api === st.field)?.label ?? st.field, recordField: { object, n, api: st.field } },
        value: st.value,
      }));
      steps.splice(end, 0, ...added);
      end += added.length;
      notes.push(`flow "${f.label}" (${fu.timing}) on ${object}: the case meets its start conditions -> checks the saved record's ${fu.sets.map((st) => `${st.field} = "${st.value}"`).join(", ")}`
        + (fu.skipped?.length ? `; not checked: ${fu.skipped.join("; ")}` : ""));
    }
  }
  return notes;
}

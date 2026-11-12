import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IR } from "../schema/ir.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";
import { resolveRunTokens, shownNumber, type RunTokenContext } from "../text.js";
import { flowOutcome } from "./salesforceGuidance.js";

/**
 * Phase D, API checks (SALESFORCE_API_CHECKS_ENABLED, default off): after a case ran, read each record
 * it created through the REST API and compare the stored values with the ones its create form typed.
 * The screen can show a value the org did not store (a picklist label, a formatted number); the API
 * cannot. Read-only: one SOQL query per created record. Never fails the run: a check that cannot run
 * says why.
 *
 * Compared: text, picklist, number, currency, percent, email, phone (digits only). Skipped: dates (the
 * form types the user's locale), lookups (the form types a name, the API holds an id), checkboxes.
 */
export function apiChecksEnabled(): boolean {
  return process.env.SALESFORCE_API_CHECKS_ENABLED === "true";
}

type Org = Pick<SalesforceOrgModel, "objects"> & Partial<Pick<SalesforceOrgModel, "flows">>;

/** API names a flow on this object sets ("sets Rating = Hot, Status = Working"): the stored value is the
 *  flow's, not the typed one (run 2026-11-10T13-15-37-189Z-a808851f: Lead Status typed Open, flow made it Working). */
function flowSet(org: Org, o: { api: string; label: string }): Set<string> {
  const out = new Set<string>();
  for (const f of org.flows ?? []) {
    if (f.object !== o.label && f.object !== o.api) continue;
    // Only what it SETS: "when Industry = Technology" is a condition it reads, not a value it writes.
    for (const line of f.effects ?? []) for (const set of line.matchAll(/\bsets (.+?)(?=;|$)/g)) {
      if (/ on [A-Z][\w ]*$/.test(set[1])) continue;
      for (const m of set[1].matchAll(/(\w+) = /g)) out.add(m[1].toLowerCase());
    }
  }
  return out;
}
export interface Typed { object: string; n: number; values: { label: string; api: string; type: string; value: string }[] }

const COMPARED = /^(string|textarea|picklist|multipicklist|double|currency|percent|int|long|email|phone|url)$/i;

/** What each saved create form typed, in order; n = the how-many-th record of that object this case made. */
export function typedValues(ir: Pick<IR, "steps">, org: Org): Typed[] {
  const out: Typed[] = [];
  const count = new Map<string, number>();
  let form: string | null = null;
  let values: Typed["values"] = [];
  for (const s of ir.steps) {
    if (s.action === "navigate") {
      form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
      values = [];
      continue;
    }
    if (!form) continue;
    if ((s.action === "fill" || s.action === "select") && s.value !== undefined) {
      const o = org.objects.find((x) => x.api === form);
      const name = (s.target?.name ?? s.target?.label ?? "").trim().toLowerCase();
      const f = o?.fields.find((x) => x.label.toLowerCase() === name || `${o.label} ${x.label}`.toLowerCase() === name);
      if (o && f && COMPARED.test(f.type) && !f.lookup && !flowSet(org, o).has(f.api.toLowerCase())) {
        values = values.filter((v) => v.api !== f.api).concat({ label: f.label, api: f.api, type: f.type, value: s.value });
      }
    } else if (s.action === "click" && /^save$/i.test(s.target?.name ?? "")) {
      // Only a save the case confirms ("was created" before it leaves the page): a negative case's
      // save is refused on purpose, and no record exists to read (run 2026-11-10T20-26-17-929Z-6c3320d0,
      // the Company "AB" case, reported two "mismatches" against a record that was never made).
      const i = ir.steps.indexOf(s);
      let confirmed = false;
      for (let j = i + 1; j < ir.steps.length && ir.steps[j].action !== "navigate"; j++) {
        if (ir.steps[j].action === "assert" && /\bwas (created|saved)\b/.test(ir.steps[j].target?.text ?? "")) { confirmed = true; break; }
      }
      if (confirmed) {
        const n = (count.get(form) ?? 0) + 1;
        count.set(form, n);
        if (values.length) out.push({ object: form, n, values });
      }
      form = null;
    }
  }
  // The path moved the stage on after the Save (run 2026-11-10T18-39-39-550Z-d1f269ff): the typed
  // Stage / Status is no longer the record's, by design.
  if (ir.steps.some((s) => s.action === "click" && /^mark (as current stage|stage as complete)$/i.test(s.target?.name ?? ""))) {
    for (const t of out) t.values = t.values.filter((v) => !/^(StageName|Status)$/.test(v.api));
    return out.filter((t) => t.values.length);
  }
  return out;
}

/** Stored vs typed, as the type reads: digits for a phone, the number for numbers, else trimmed text. */
export function sameValue(type: string, typed: string, stored: unknown): boolean {
  if (stored === null || stored === undefined) return typed.trim() === "";
  const s = String(stored);
  if (/^phone$/i.test(type)) return typed.replace(/\D/g, "") === s.replace(/\D/g, "");
  if (/^(double|currency|percent|int|long)$/i.test(type)) {
    const a = shownNumber(typed), b = Number(stored);
    return a !== null && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
  }
  return typed.trim().toLowerCase() === s.trim().toLowerCase();
}

export interface ApiCheck { object: string; id?: string; field: string; expected: string; actual?: string; ok: boolean; note?: string }

/**
 * Compare each typed record with the org. `created` = the record ids the spec saw this case create,
 * per object in order (the "sf-created" annotation); `ctx` resolves the run tokens ({{uid}}) the way
 * the spec typed them.
 */
export async function apiChecks(
  apiGet: (p: string) => Promise<any>, typed: Typed[], created: Record<string, string[]>, ctx: RunTokenContext,
): Promise<ApiCheck[]> {
  const out: ApiCheck[] = [];
  for (const t of typed) {
    const id = created[t.object]?.[t.n - 1];
    if (!id || !/^[A-Za-z0-9]{15,18}$/.test(id) || !/^[A-Za-z0-9_]+$/.test(t.object)) {
      for (const v of t.values) out.push({ object: t.object, field: v.label, expected: v.value, ok: false, note: "the case never reached the record it created" });
      continue;
    }
    let rec: any;
    try {
      const q = `SELECT ${t.values.map((v) => v.api).join(", ")} FROM ${t.object} WHERE Id = '${id}'`;
      rec = (await apiGet(`/query?q=${encodeURIComponent(q)}`))?.records?.[0];
    } catch (err) {
      for (const v of t.values) out.push({ object: t.object, id, field: v.label, expected: v.value, ok: false, note: `the API refused: ${(err as Error)?.message ?? err}` });
      continue;
    }
    for (const v of t.values) {
      const expected = resolveRunTokens(v.value, ctx);
      if (!rec) { out.push({ object: t.object, id, field: v.label, expected, ok: false, note: "the record is not in the org" }); continue; }
      const actual = rec[v.api];
      out.push({ object: t.object, id, field: v.label, expected, actual: actual === null || actual === undefined ? "" : String(actual), ok: sameValue(v.type, expected, actual) });
    }
  }
  return out;
}

/** One case's annotations from its results.json: the run tokens and the records it created. */
export function caseRunFacts(resultsPath: string): { ctx: RunTokenContext; created: Record<string, string[]> } | null {
  if (!existsSync(resultsPath)) return null;
  let ctx: RunTokenContext | null = null;
  let created: Record<string, string[]> = {};
  const visit = (s: any) => {
    for (const sp of s?.specs ?? []) for (const t of sp.tests ?? []) {
      for (const a of [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])]) {
        try {
          if (a?.type === "run-tokens") ctx = JSON.parse(a.description);
          if (a?.type === "sf-created") created = JSON.parse(a.description);
        } catch { /* a broken annotation reads as absent */ }
      }
    }
    for (const c of s?.suites ?? []) visit(c);
  };
  try { for (const s of JSON.parse(readFileSync(resultsPath, "utf8"))?.suites ?? []) visit(s); } catch { return null; }
  // A spec that types no run token writes no "run-tokens" annotation (run 2026-11-12T07-16-11-742Z-c2ab98b6
  // picked only picklist values and got no API check at all): nothing to resolve, so an empty context.
  return ctx || Object.keys(created).length ? { ctx: ctx ?? { uid: "", phone: "" }, created } : null;
}

/** Every case of a run: its IR and its results.json (case 0's results sit at the run's root). */
export function runCases(runDir: string): { caseDir: string; ir: Pick<IR, "steps">; results: string }[] {
  const out: { caseDir: string; ir: Pick<IR, "steps">; results: string }[] = [];
  const casesDir = path.join(runDir, "cases");
  for (let i = 0; existsSync(path.join(casesDir, `case-${i}`)); i++) {
    const caseDir = path.join(casesDir, `case-${i}`);
    let ir: any;
    try { ir = JSON.parse(readFileSync(path.join(caseDir, "04-ir.json"), "utf8")); } catch { continue; }
    ir = ir?.ir ?? ir;
    if (!Array.isArray(ir?.steps)) continue;
    const own = path.join(caseDir, "results.json");
    out.push({ caseDir, ir, results: existsSync(own) ? own : path.join(runDir, "results.json") });
  }
  return out;
}

/**
 * Phase A gap "formula values": a check of a calculated field on the screen (a formula, a roll-up: "TB
 * Total Opportunity Amount shows 5,000") is also read through the API, so the value Salesforce computed
 * and the one the page showed are compared. No formula is evaluated here: the org computes, the page
 * shows, the two must agree. The record is the one the case was on: the last it saved, or one it opened
 * again by reference (${record:Obj:n}).
 */
export function calculatedChecks(ir: Pick<IR, "steps">, org: Org): Typed[] {
  const out: Typed[] = [];
  const count = new Map<string, number>();
  let form: string | null = null;
  let on: { object: string; n: number } | null = null;
  for (const s of ir.steps) {
    if (s.action === "navigate") {
      const url = s.target?.url ?? "";
      form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(url)?.[1] ?? null;
      const ref = /^\$\{record:([A-Za-z][A-Za-z0-9_]*):(\d+)\}$/.exec(url);
      if (ref) on = { object: ref[1], n: Number(ref[2]) };
      continue;
    }
    if (s.action === "click" && /^save$/i.test(s.target?.name ?? "") && form) {
      const n = (count.get(form) ?? 0) + 1;
      count.set(form, n);
      on = { object: form, n };
      form = null;
      continue;
    }
    const label = s.target?.field;
    if (s.action !== "assert" || !label || !on || !s.value || !/^text_(contains|equals)$/.test(s.assertion ?? "")) continue;
    const o = org.objects.find((x) => x.api === on!.object);
    const c = (o as any)?.calculated?.find((x: any) => x.label.toLowerCase() === label.toLowerCase());
    if (!c || !COMPARED.test(c.type)) continue;
    const entry = out.find((t) => t.object === on!.object && t.n === on!.n) ?? (out.push({ object: on.object, n: on.n, values: [] }), out[out.length - 1]);
    entry.values = entry.values.filter((v) => v.api !== c.api).concat({ label: c.label, api: c.api, type: c.type, value: s.value });
  }
  return out;
}

/**
 * Phase B through the API: what each record-triggered flow on a saved record should have set, given the
 * values the form typed (the branch logic of salesforceGuidance.flowOutcome), compared with what the org
 * stored. This is where a checkbox the flow ticks is checked: a page layout may not show it (run
 * 2026-11-10T18-12-48-531Z-ba5c15e9: the Case page had no Escalated box). Unknown values = no check.
 */
export function flowSetChecks(ir: Pick<IR, "steps">, org: Org): Typed[] {
  const out: Typed[] = [];
  const count = new Map<string, number>();
  let form: string | null = null;
  let typed = new Map<string, string>();
  for (const s of ir.steps) {
    if (s.action === "navigate") {
      form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
      typed = new Map();
      continue;
    }
    if (!form) continue;
    const o = org.objects.find((x) => x.api === form);
    if ((s.action === "fill" || s.action === "select") && s.value !== undefined && o) {
      const name = (s.target?.name ?? s.target?.label ?? "").trim().toLowerCase();
      const f = o.fields.find((x) => x.label.toLowerCase() === name || `${o.label} ${x.label}`.toLowerCase() === name);
      if (f) typed.set(f.api.toLowerCase(), s.value);
    } else if (s.action === "click" && /^save$/i.test(s.target?.name ?? "")) {
      const n = (count.get(form) ?? 0) + 1;
      count.set(form, n);
      if (o) {
        const values: Typed["values"] = [];
        for (const fl of (org.flows ?? []).filter((x) => x.object === o.label || x.object === o.api)) {
          const r = flowOutcome(o, fl.effects ?? [], (api) => typed.get(api.toLowerCase()));
          for (const x of r?.sets ?? []) {
            const type = /^(true|false)$/.test(x.value) ? "boolean" : (o.fields.find((f) => f.api === x.api)?.type ?? "string");
            values.push({ label: x.label, api: x.api, type, value: x.value });
          }
        }
        if (values.length) out.push({ object: form, n, values });
      }
      form = null;
    }
  }
  return out;
}

/**
 * What a record-triggered flow made on a saved record, through the API (Phase B gaps): the task the branch
 * taken creates exists ON that record with its due date ("due today + 1": run 2026-11-10T20-52-16-029Z-1228df7d
 * never checked it), and the records other branches create do NOT (Warm/Cold: no call task; nothing checked
 * that). Only records the flow links to the record (WhoId/WhatId = $Record.Id), found by name. The due date
 * is compared with the run's day, one day either way (the org's user may sit in another time zone).
 */
export async function flowRecordChecks(
  apiGet: (p: string) => Promise<any>, ir: Pick<IR, "steps">, org: Org, created: Record<string, string[]>, now = Date.now(),
): Promise<ApiCheck[]> {
  const out: ApiCheck[] = [];
  const count = new Map<string, number>();
  let form: string | null = null;
  let typed = new Map<string, string>();
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; typed = new Map(); continue; }
    if (!form) continue;
    const o = org.objects.find((x) => x.api === form);
    if ((s.action === "fill" || s.action === "select") && s.value !== undefined && o) {
      const name = (s.target?.name ?? s.target?.label ?? "").trim().toLowerCase();
      const f = o.fields.find((x) => x.label.toLowerCase() === name || `${o.label} ${x.label}`.toLowerCase() === name);
      if (f) typed.set(f.api.toLowerCase(), s.value);
      continue;
    }
    if (s.action !== "click" || !/^save$/i.test(s.target?.name ?? "")) continue;
    let confirmed = false;
    for (let j = i + 1; j < ir.steps.length && ir.steps[j].action !== "navigate"; j++) {
      if (ir.steps[j].action === "assert" && /\bwas (created|saved)\b/.test(ir.steps[j].target?.text ?? "")) { confirmed = true; break; }
    }
    const thisForm = form;
    form = null;
    if (!confirmed || !o) continue;
    const n = (count.get(thisForm) ?? 0) + 1;
    count.set(thisForm, n);
    const id = created[thisForm]?.[n - 1];
    if (!id || !/^[A-Za-z0-9]{15,18}$/.test(id)) continue;
    for (const fl of (org.flows ?? []).filter((x) => x.object === o.label || x.object === o.api)) {
      const r = flowOutcome(o, fl.effects ?? [], (api) => typed.get(api.toLowerCase()));
      if (!r) continue;
      for (const [rec, want] of [...r.made.map((x) => [x, true] as const), ...r.notMade.map((x) => [x, false] as const)]) {
        if (!rec.link || !/^\w+$/.test(rec.object) || !/^\w+$/.test(rec.link) || /'/.test(rec.name)) continue;
        const nameField = rec.object === "Task" || rec.object === "Event" ? "Subject" : "Name";
        const label = `${fl.label}: ${rec.object} "${rec.name}"${want ? "" : " (not on this branch)"}`;
        try {
          const q = `SELECT Id${rec.dueDays !== undefined ? ", ActivityDate" : ""} FROM ${rec.object} WHERE ${nameField} = '${rec.name}' AND ${rec.link} = '${id}'`;
          const rows: any[] = (await apiGet(`/query?q=${encodeURIComponent(q)}`))?.records ?? [];
          if (!want) { out.push({ object: o.api, id, field: label, expected: "none", actual: String(rows.length), ok: rows.length === 0 }); continue; }
          out.push({ object: o.api, id, field: label, expected: "exists", actual: rows.length ? "exists" : "missing", ok: rows.length > 0 });
          if (rows.length && rec.dueDays !== undefined) {
            const day = (d: number) => new Date(now + d * 86400000).toISOString().slice(0, 10);
            const got = String(rows[0]?.ActivityDate ?? "");
            out.push({ object: o.api, id, field: `${label} due date`, expected: day(rec.dueDays), actual: got,
              ok: [-1, 0, 1].some((k) => day(rec.dueDays! + k) === got) });
          }
        } catch (err) {
          out.push({ object: o.api, id, field: label, expected: want ? "exists" : "none", ok: false, note: `the API refused: ${(err as Error)?.message ?? err}` });
        }
      }
    }
  }
  return out;
}

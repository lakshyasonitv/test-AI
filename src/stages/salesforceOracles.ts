import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IR } from "../schema/ir.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";
import { resolveRunTokens, shownNumber, type RunTokenContext } from "../text.js";

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
    for (const line of f.effects ?? []) for (const m of line.matchAll(/(\w+) = /g)) out.add(m[1].toLowerCase());
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
      const n = (count.get(form) ?? 0) + 1;
      count.set(form, n);
      if (values.length) out.push({ object: form, n, values });
      form = null;
    }
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
  return ctx ? { ctx, created } : null;
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

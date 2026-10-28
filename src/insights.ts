import { writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { extendedLoggingEnabled } from "./logging.js";
import { currentRunId } from "./runContext.js";
import { onlyChecksLogin } from "./stages/salesforceOrgLogin.js";
import type { AppModel } from "./schema/appModel.js";
import type { IR } from "./schema/ir.js";
import type { SpecModel } from "./schema/spec.js";

/**
 * Run insight logging (D-69) — what a person developing this project needs to judge a run's
 * quality and cost: how much discovery found, how big the models got, why compiles retried, where
 * the time went. Behind EXTENDED_LOGGING (default off): off, `insight()` returns before doing
 * anything, so no line is printed and no file is written.
 *
 * TWO OUTPUTS, ONE SOURCE. Each call prints one greppable line,
 *     [insight] run=<id> stage=<stage> key=value key=value …
 * and keeps the same fields for the run, written at the end as `runs/<id>/10-insights.json` —
 * because Azure's log stream samples lines away and does not keep them (llmBudget.ts records the
 * same problem), the run's own folder is the only copy that is sure to survive.
 *
 * WHAT IS NEVER LOGGED. Credentials, page text, AI prose (case titles, step text) and URL query
 * strings (a Salesforce redirect can carry a session id). Callers pass numbers, enum-like labels
 * and URLs; `safeUrl` keeps origin + path only; any free string is cut at MAX_STRING. Error lines
 * come from Playwright's report AFTER executor.ts's `scrubServedSecrets` has redacted it.
 */

export type InsightValue = string | number | boolean | null | undefined
  | Record<string, number | string | boolean>
  | Array<string | number>;
export type InsightFields = Record<string, InsightValue>;

interface InsightRecord { stage: string; ts: number; fields: InsightFields }

const MAX_STRING = 200;
const MAX_RECORDS_PER_RUN = 2000;

/** Per-run collector. Keyed by run id (not a module-level list) because MAX_CONCURRENT_RUNS lets
 *  several runs share the process; flushed and deleted by `writeInsights`. */
const collected = new Map<string, InsightRecord[]>();
/** Per-run cache counters: namespace -> [hits, misses]. */
const cacheCounts = new Map<string, Map<string, [number, number]>>();

export function insightsEnabled(): boolean {
  return extendedLoggingEnabled();
}

/** Origin + path only — never the query or fragment. Unparseable input is replaced, not echoed. */
export function safeUrl(url: string | undefined | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "(unparseable url)";
  }
}

function clean(v: InsightValue): InsightValue {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => typeof x === "string" ? (clean(x) as string) : x);
  if (v && typeof v === "object") {
    const out: Record<string, number | string | boolean> = {};
    for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = typeof x === "string" ? (clean(x) as string) : x;
    return out;
  }
  return v;
}

/** One `key=value` token. Pure and exported so the line format is pinned by a test. */
export function formatValue(v: InsightValue): string {
  if (v === undefined || v === null) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length ? v.join(",") : "-";
  if (typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${k}:${x}`);
    return parts.length ? parts.join(",") : "-";
  }
  return /[\s"]/.test(v) ? JSON.stringify(v) : v || '""';
}

/** The full `[insight]` line. Pure and exported for the same reason. */
export function insightLine(runId: string | null, stage: string, fields: InsightFields): string {
  const tokens = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`);
  return `[insight] run=${runId ?? "-"} stage=${stage}${tokens.length ? " " + tokens.join(" ") : ""}`;
}

/**
 * Record one insight. No-op unless EXTENDED_LOGGING is on. `runId` defaults to the ambient run
 * (runContext.ts); pass it explicitly where that rail is not entered (the server's queue).
 */
export function insight(stage: string, fields: InsightFields, runId: string | null = currentRunId()): void {
  if (!insightsEnabled()) return;
  const cleaned: InsightFields = {};
  for (const [k, v] of Object.entries(fields)) cleaned[k] = clean(v);
  console.log(insightLine(runId, stage, cleaned));
  if (!runId) return;
  const list = collected.get(runId) ?? [];
  if (list.length < MAX_RECORDS_PER_RUN) list.push({ stage, ts: Date.now(), fields: cleaned });
  collected.set(runId, list);
}

/** Count one cache read for the ambient run. Called by llmCache.ts on every read; free when off. */
export function countCacheRead(ns: string, hit: boolean): void {
  if (!insightsEnabled()) return;
  const runId = currentRunId();
  if (!runId) return;
  const byNs = cacheCounts.get(runId) ?? new Map<string, [number, number]>();
  const c = byNs.get(ns) ?? [0, 0];
  c[hit ? 0 : 1]++;
  byNs.set(ns, c);
  cacheCounts.set(runId, byNs);
}

/** `{ ns: "hits/misses" }` for a run, for the run-end summary. */
export function cacheSummary(runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ns, [h, m]] of cacheCounts.get(runId) ?? []) out[ns] = `${h}/${m}`;
  return out;
}

/** Total bytes under a directory, recursively. Best effort: unreadable entries count as 0. */
export function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? dirBytes(p) : st.size;
    } catch { /* skip */ }
  }
  return total;
}

/** Write `runs/<id>/10-insights.json` and forget the run. No-op when off or nothing was recorded. */
export function writeInsights(runId: string, runDir: string): void {
  const records = collected.get(runId);
  collected.delete(runId);
  cacheCounts.delete(runId);
  if (!insightsEnabled() || !records?.length) return;
  try {
    writeFileSync(path.join(runDir, "10-insights.json"), JSON.stringify({ runId, insights: records }, null, 2));
  } catch (err) {
    console.error(`[insight] could not write 10-insights.json for ${runId}:`, (err as Error)?.message ?? err);
  }
}

/** Test seam. */
export function _collectedFor(runId: string): InsightRecord[] | undefined { return collected.get(runId); }

// ---------------------------------------------------------------------------------------------
// Summaries — pure functions from the pipeline's own objects to loggable numbers.
// ---------------------------------------------------------------------------------------------

const bytesOf = (v: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8"); } catch { return 0; }
};

/** Top `n` keys of a count map, as `{key: count}`, largest first. */
function top(counts: Map<string, number>, n = 8): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
}

/** Element facts for one page (or a whole model's pages). Names and text are never read. */
export function elementStats(elements: AppModel["pages"][number]["elements"]): InsightFields {
  const roles = new Map<string, number>();
  let visible = 0, hidden = 0, unknownVisibility = 0, stable = 0, framed = 0, shadow = 0, proximity = 0;
  for (const e of elements) {
    roles.set(e.role || "(none)", (roles.get(e.role || "(none)") ?? 0) + 1);
    if (e.visible === true) visible++;
    else if (e.visible === false) hidden++;
    else unknownVisibility++;
    if (e.css || e.testId) stable++;
    if (e.frame) framed++;
    if (e.inShadow) shadow++;
    if (e.nameFromProximity) proximity++;
  }
  const total = elements.length;
  return {
    elements: total,
    visible, hidden, visibilityUnknown: unknownVisibility,
    stableLocator: stable,
    stableLocatorPct: total ? Math.round((stable / total) * 100) : 0,
    inFrame: framed, inShadow: shadow, nameFromProximity: proximity,
    roles: top(roles),
  };
}

/** One line's worth of facts per discovered page. */
export function pageInsights(model: AppModel): InsightFields[] {
  return model.pages.map((p, i) => ({
    page: i + 1,
    url: safeUrl(p.url),
    method: p.discoveryMethod ?? "-",
    crawlMs: p.crawlTimeMs,
    needsVision: p.needsVision ?? false,
    screen: p.screen ? "captured" : undefined,
    forms: p.forms?.length,
    formFields: p.forms?.reduce((n, f) => n + (f.fields?.length ?? 0), 0),
    links: p.domLinks?.length,
    headings: p.headings?.length,
    tables: p.tables?.length,
    concepts: p.concepts?.length ?? 0,
    domDepth: p.domDepth,
    ...elementStats(p.elements ?? []),
  }));
}

/** Whole-site facts: totals, sizes, login. */
export function appModelInsights(model: AppModel): InsightFields {
  const all = model.pages.flatMap((p) => p.elements ?? []);
  const methods = new Map<string, number>();
  for (const p of model.pages) methods.set(p.discoveryMethod ?? "-", (methods.get(p.discoveryMethod ?? "-") ?? 0) + 1);
  const auth = model.auth;
  return {
    baseUrl: safeUrl(model.baseUrl),
    pages: model.pages.length,
    screensCaptured: model.pages.filter((p) => p.screen).length,
    methods: top(methods),
    crawlMsTotal: model.pages.reduce((n, p) => n + (p.crawlTimeMs ?? 0), 0),
    appModelBytes: bytesOf(model),
    ...elementStats(all),
    authStatus: auth?.status ?? "none",
    loginUrl: auth?.loginUrl ? safeUrl(auth.loginUrl) : undefined,
    loginSteps: auth?.loginSteps?.length,
  };
}

/** Pro's distilled rules — the "spec model": how many of each list, and its size. */
export function specModelInsights(spec: SpecModel): InsightFields {
  return {
    actors: spec.actors.length, entities: spec.entities.length, actions: spec.actions.length,
    rules: spec.rules.length, criteria: spec.criteria.length, outOfScope: spec.outOfScope.length,
    openQuestions: spec.unresolved.length, answered: spec.answers.length,
    specModelBytes: bytesOf(spec),
  };
}

/** Case counts by priority and category (no titles). */
export function caseInsights(cases: Array<{ priority?: string; category?: string; fromPrompt?: boolean }>): InsightFields {
  const byPriority = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const c of cases) {
    byPriority.set(c.priority ?? "-", (byPriority.get(c.priority ?? "-") ?? 0) + 1);
    byCategory.set(c.category ?? "-", (byCategory.get(c.category ?? "-") ?? 0) + 1);
  }
  return {
    cases: cases.length,
    fromPrompt: cases.filter((c) => c.fromPrompt).length,
    byPriority: top(byPriority), byCategory: top(byCategory, 12),
  };
}

/** Compiled-steps facts for one case. `retries` are llmBudget's retry records for this case. */
export function irInsights(ir: IR, retries: Array<{ kind: string }> = []): InsightFields {
  const actions = new Map<string, number>();
  let css = 0, roleName = 0, text = 0;
  for (const s of ir.steps) {
    actions.set(s.action, (actions.get(s.action) ?? 0) + 1);
    if (s.target?.css || s.target?.testId) css++;
    else if (s.target?.role) roleName++;
    else if (s.target?.text) text++;
  }
  const kinds = new Map<string, number>();
  for (const r of retries) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  return {
    steps: ir.steps.length,
    loginSteps: ir.steps.filter((s) => /^auth-\d+$/.test(s.id)).length,
    fixedLogin: ir.meta.fixedLogin ?? undefined,
    actions: top(actions),
    targets: { stable: css, roleName, text },
    loginOnly: onlyChecksLogin(ir) || undefined,
    truncated: !!ir.meta.truncated,
    truncationKind: ir.meta.truncationKind,
    terminalAssertion: ir.meta.hasTerminalAssertion,
    rejectedAttempts: retries.length,
    rejectedBy: top(kinds),
    irBytes: bytesOf(ir),
  };
}

/** Helper routines a generated spec can contain, by the function name the generator emits. */
const SPEC_HELPERS = [
  "shot", "locate", "scope", "field", "choose", "safeClick", "assertChoice", "assertGone",
  "waitForAuthSettle", "salesforceLogin",
];

/** Generated Playwright file facts. */
export function specInsights(spec: string): InsightFields {
  return {
    specBytes: Buffer.byteLength(spec, "utf8"),
    specLines: spec.split("\n").length,
    testSteps: (spec.match(/await test\.step\(/g) ?? []).length,
    helpers: SPEC_HELPERS.filter((h) => spec.includes(`function ${h}(`)),
    partial: spec.includes("// PARTIAL:"),
  };
}

/** Execution facts from Playwright's (already scrubbed) JSON report. */
export function execInsights(raw: any, failure: { failedStep?: number; error?: string } = {}): InsightFields {
  const stepMs: number[] = [];
  let durationMs = 0;
  let status = "-";
  const visit = (suite: any) => {
    for (const child of suite?.suites ?? []) visit(child);
    for (const spec of suite?.specs ?? []) {
      for (const t of spec?.tests ?? []) {
        for (const r of t?.results ?? []) {
          if (Number.isFinite(r?.duration)) durationMs = Math.max(durationMs, Number(r.duration));
          if (typeof r?.status === "string") status = r.status;
          for (const s of r?.steps ?? []) if (Number.isFinite(s?.duration)) stepMs.push(Number(s.duration));
        }
      }
    }
  };
  for (const s of raw?.suites ?? []) visit(s);
  const slowest = stepMs.length ? stepMs.indexOf(Math.max(...stepMs)) + 1 : undefined;
  return {
    playwrightStatus: status,
    durationMs,
    steps: stepMs.length,
    stepMs,
    slowestStep: slowest,
    failedStep: failure.failedStep,
    error: failure.error,
  };
}

/** What a case left on disk: screenshots, video, total artifact bytes. */
export function artifactInsights(artifactsDir: string): InsightFields {
  let names: string[] = [];
  try { names = readdirSync(artifactsDir); } catch { /* none */ }
  return {
    screenshots: names.filter((n) => n.endsWith(".png")).length,
    video: names.some((n) => n.endsWith(".webm")),
    artifactBytes: dirBytes(artifactsDir),
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IR, Remembered } from "../schema/ir.js";
import { hasRunToken } from "../text.js";

/**
 * Regression testing, step 1 "Remember" (D-76, REGRESSION_MEMORY_ENABLED, default off).
 *
 * A saved case used to keep only its steps and their exact locators. When the site changes there
 * was nothing to repair FROM, and the hollow-pass guards could not protect it because they read
 * the plain-English case, which was not saved. This module decides, when a case is saved from a
 * run, what it also remembers: its meaning, the org's setup for the objects it touches, and the
 * values that cannot be replayed as saved. Everything here is read from the run's own artifacts,
 * in code; the model writes none of it (toIR drops a model-written `remembered`).
 *
 * One more rule from the design: a case that only passed after a self-heal is not saved without a
 * person saying so, because an unreviewed heal can hide a broken check.
 */

export function regressionMemoryEnabled(): boolean {
  return process.env.REGRESSION_MEMORY_ENABLED === "true";
}

/** The plain-English case a run compiled `case-N` from. `03-cases.json` holds the run's cases in
 *  the order the suite ran them as case-0, case-1, ...; the title is the cross-check. */
export function caseFromRun(runDir: string, caseId: string, title?: string): Record<string, unknown> | null {
  const file = path.join(runDir, "03-cases.json");
  if (!existsSync(file)) return null;
  let list: Record<string, unknown>[];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    list = Array.isArray(raw) ? raw : (raw?.cases ?? raw?.finalCases ?? []);
  } catch { return null; }
  const n = Number(/^case-(\d+)$/.exec(caseId)?.[1] ?? -1);
  const byIndex = n >= 0 ? list[n] : undefined;
  if (byIndex && (!title || byIndex.title === title)) return byIndex;
  return (title ? list.find((c) => c.title === title) : undefined) ?? null;
}

/** The Salesforce objects a case works on: create forms, record pages, and records it returns to. */
export function touchedObjects(ir: IR): string[] {
  const out = new Set<string>();
  for (const s of ir.steps) {
    const url = s.target?.url ?? "";
    const page = /\/lightning\/[or]\/([A-Za-z][A-Za-z0-9_]*)(?:\/|$|\?)/.exec(url);
    if (page) out.add(page[1]);
    const ref = /\$\{record:([A-Za-z][A-Za-z0-9_]*)/.exec(url);
    if (ref) out.add(ref[1]);
  }
  return [...out];
}

/** The org's setup for the objects this case touches, from the run's own org model. */
export function orgSnapshot(appModel: unknown, objects: string[], baseUrl: string): Remembered["org"] | undefined {
  const org = (appModel as { salesforceOrg?: Record<string, any> } | null)?.salesforceOrg;
  if (!org || !Array.isArray(org.objects) || !objects.length) return undefined;
  const picked = org.objects.filter((o: any) => objects.includes(o?.api));
  if (!picked.length) return undefined;
  const labels = new Set(picked.map((o: any) => o.label));
  const flows = Array.isArray(org.flows) ? org.flows.filter((f: any) => f?.object && labels.has(f.object)) : [];
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* left empty */ }
  return {
    host,
    ...(org.userLocale ? { userLocale: org.userLocale } : {}),
    ...(org.release?.label ? { release: { label: String(org.release.label), version: String(org.release.version ?? "") } } : {}),
    validationRulesRead: !!org.validationRulesRead,
    objects: picked,
    ...(flows.length ? { flows } : {}),
  };
}

/** An org record id (15 or 18 characters, letters and digits, a key prefix like 001 or a0B). */
const RECORD_ID = /^(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[0a][A-Za-z0-9]{14}(?:[A-Za-z0-9]{3})?$/;
const FIXED_DATE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})$/;

/** Values that cannot be replayed as saved: an org record id (another org, or a deleted record,
 *  has none) and a fixed calendar date (it goes stale, or a "future" date becomes past). */
export function oneTimeValues(ir: IR): NonNullable<Remembered["oneTimeValues"]> {
  const out: NonNullable<Remembered["oneTimeValues"]> = [];
  for (const s of ir.steps) {
    const url = s.target?.url ?? "";
    const rec = /\/lightning\/r\/[A-Za-z][A-Za-z0-9_]*\/([A-Za-z0-9]{15,18})(?:\/|$|\?)/.exec(url);
    if (rec && RECORD_ID.test(rec[1])) out.push({ stepId: s.id, kind: "record-id", value: rec[1] });
    const v = (s.value ?? "").trim();
    if (!v || hasRunToken(v) || s.action === "assert") continue;
    if (RECORD_ID.test(v)) out.push({ stepId: s.id, kind: "record-id", value: v });
    else if (FIXED_DATE.test(v)) out.push({ stepId: s.id, kind: "fixed-date", value: v });
  }
  return out;
}

/** One sentence per value that cannot be replayed, for the save response. */
export function oneTimeWarnings(values: NonNullable<Remembered["oneTimeValues"]>): string[] {
  return values.map((v) => v.kind === "record-id"
    ? `Step ${v.stepId} uses the record id ${v.value}, which exists only in this org: a replay elsewhere, or after that record is deleted, will fail.`
    : `Step ${v.stepId} types the fixed date ${v.value}: it will go stale. A date computed when the test runs replays reliably.`);
}

export class HealedNeedsReviewError extends Error {
  readonly status = 409;
  readonly code = "healed-needs-review";
  constructor() {
    super("This case only passed after it was healed automatically. Review the healed steps before saving it: an unreviewed heal can hide a broken check. Save again to confirm you have.");
    this.name = "HealedNeedsReviewError";
  }
}

/** How a case ended in its run, from the run's suite summary; null when the run has none. */
export function caseStatusInRun(runDir: string, caseId: string): string | null {
  try {
    const s = JSON.parse(readFileSync(path.join(runDir, "07-suite-summary.json"), "utf8"));
    const c = (s?.cases ?? []).find((x: { caseId?: string }) => x?.caseId === caseId);
    return typeof c?.status === "string" ? c.status : null;
  } catch { return null; }
}

/**
 * The element details the generated spec recorded (step 1B), for the steps this IR still has. Only
 * from a PASSING run: a failing run's details describe the page that broke the test, which is not
 * what a later repair should look for. The case's own artifacts first; the run-level artifacts for
 * the primary case of a single-case run.
 */
export function passedElements(runDir: string, caseId: string, ir: IR): {
  elements?: NonNullable<Remembered["elements"]>; why?: "not-passed" | "not-recorded";
} {
  if (caseStatusInRun(runDir, caseId) !== "passed") return { why: "not-passed" };
  const candidates = [
    path.join(runDir, "cases", caseId, "artifacts", "elements.json"),
    ...(caseId === "case-0" ? [path.join(runDir, "artifacts", "elements.json")] : []),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return { why: "not-recorded" };
  let raw: Record<string, any>;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { why: "not-recorded" }; }
  const ids = new Set(ir.steps.map((s) => s.id));
  const elements: NonNullable<Remembered["elements"]> = {};
  for (const [id, e] of Object.entries(raw ?? {})) {
    if (!ids.has(id) || !e || typeof e.path !== "string" || typeof e.matches !== "number") continue;
    elements[id] = {
      path: e.path, matches: e.matches,
      ...(typeof e.tag === "string" ? { tag: e.tag } : {}),
      ...(typeof e.role === "string" ? { role: e.role } : {}),
      ...(typeof e.type === "string" ? { type: e.type } : {}),
      ...(typeof e.name === "string" ? { name: e.name } : {}),
      ...(typeof e.sfField === "string" ? { sfField: e.sfField } : {}),
    };
  }
  return Object.keys(elements).length ? { elements } : { why: "not-recorded" };
}

/**
 * What a case remembers when it is saved. `irFile` is the file the save read (a healed IR lives
 * under `healed/`). Throws HealedNeedsReviewError for a healed case unless `acceptHealed`.
 */
export function rememberForSave(opts: {
  runsRoot: string; runId: string; caseId: string; ir: IR; irFile: string; acceptHealed?: boolean; now?: Date;
}): { ir: IR; warnings: string[] } {
  const healed = opts.irFile.split(/[\\/]/).includes("healed");
  if (healed && !opts.acceptHealed) throw new HealedNeedsReviewError();

  const runDir = path.join(opts.runsRoot, opts.runId);
  const tc = caseFromRun(runDir, opts.caseId, opts.ir.meta.title);
  const steps = Array.isArray(tc?.steps) ? (tc!.steps as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const meaning: Remembered["meaning"] = tc ? {
    title: String(tc.title ?? opts.ir.meta.title),
    steps,
    ...(typeof tc.expected === "string" ? { expected: tc.expected } : {}),
    ...(typeof tc.intent === "string" ? { intent: tc.intent } : {}),
    ...(typeof tc.category === "string" ? { category: tc.category } : {}),
  } : undefined;

  let appModel: unknown = null;
  try { appModel = JSON.parse(readFileSync(path.join(runDir, "02-appmodel.json"), "utf8")); } catch { /* none */ }
  const org = orgSnapshot(appModel, touchedObjects(opts.ir), opts.ir.meta.baseUrl);
  const once = oneTimeValues(opts.ir);
  // A healed case's recorded details came from the run that FAILED; never keep those.
  const seen = healed ? { why: "not-passed" as const } : passedElements(runDir, opts.caseId, opts.ir);
  const several = Object.entries(seen.elements ?? {}).filter(([, e]) => e.matches > 1).map(([id]) => id);

  const remembered: Remembered = {
    savedFrom: opts.runId,
    at: (opts.now ?? new Date()).toISOString(),
    ...(meaning ? { meaning } : {}),
    ...(org ? { org } : {}),
    ...(seen.elements ? { elements: seen.elements } : {}),
    ...(once.length ? { oneTimeValues: once } : {}),
  };
  const warnings = [
    ...(meaning ? [] : ["The plain-English case this was compiled from was not found in the run, so it was saved without it."]),
    ...(seen.why === "not-passed" ? ["What each element looked like was not kept: the case did not pass in this run, so a later repair has less to go on."] : []),
    ...(several.length ? [`Step${several.length === 1 ? "" : "s"} ${several.join(", ")} matched more than one element when the case passed: the test used the first, which may not stay the right one.`] : []),
    ...oneTimeWarnings(once),
  ];
  return { ir: { ...opts.ir, meta: { ...opts.ir.meta, remembered } }, warnings };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { IR, Step, Target } from "../schema/ir.js";
import { classify, type FailureCategory } from "./classify.js";
import { diffTargets, type TargetDiff } from "./deterministicHeal.js";
import { formatIrStep } from "./stepText.js";
import { runStepLive, prepareReplayPage } from "./liveExtend.js";
import { generateSpec } from "./generator.js";
import { runSpec, extractFailureDetail, findScreenshot, type FailureDetail } from "./executor.js";
import { cacheNamespaceDir } from "../kb/llmCache.js";
import { credentialEnvVars, type Credentials } from "./credentials.js";
import { chromiumLaunchOptions, browserContextOptions } from "../browserLaunch.js";
import { currentFrontdoor, type FrontdoorSession } from "./salesforceFrontdoor.js";
import { recordsFromResults } from "./salesforceCleanup.js";
import { hasRunToken, lineKey, resolveRunTokens } from "../text.js";

/**
 * Regression testing, step 3 "Safe repair" (D-76, REGRESSION_REPAIR_ENABLED, default off).
 *
 * The saved test always runs first, unchanged (a replay). Only when a CLICK, FILL, SELECT or PRESS
 * could not find or use its element is a repair tried, and only two ways, in this order, never by a
 * model:
 *   1. the Salesforce field binding: the same field by its API name (remembered from the passing run,
 *      step 1B), found by the label the org gives it NOW;
 *   2. an exact, unique match on the page the test actually reached: the same role and the exact same
 *      name, matching exactly one element. Two matches = no repair.
 * A repair is ACCEPTED only when: only that one step's locator changes; it is a real change (the old
 * locator does not still find the same element: that was a slow page, not a change); the whole test
 * then passes again from step 1; and on Salesforce the record it saved reads back with the typed
 * values. A later "is gone" check on the old element sends both edits to a person. When most of a
 * suite fails at once, nothing is repaired: the app or the login changed. A failed CHECK is never
 * repaired: the site gave a different result, which may be a real bug.
 *
 * The outcome is a PROPOSAL written next to the run (step 4 approves it); the saved case is never
 * changed here, and the case still counts as failed ("Healed, needs review" is not green).
 */

export function regressionRepairEnabled(): boolean {
  return process.env.REGRESSION_REPAIR_ENABLED === "true";
}

// ---- pure rules -------------------------------------------------------------------------------

/** Actions that act on an element. A failure on one of these is the element changing. */
const ELEMENT_ACTIONS = new Set(["click", "fill", "select", "check", "press"]);
const SITE_CATEGORIES = new Set<FailureCategory>(["navigation_error", "network"]);

export type FailureKind = "element-changed" | "result-changed" | "site-unreachable" | "unknown";

export interface FailureVerdict {
  kind: FailureKind;
  stepIndex?: number;
  stepId?: string;
  category?: FailureCategory;
  reason: string;
}

/**
 * Which kind of failure a replayed case had, from its own IR and Playwright's report. Decided by the
 * failing step's ACTION (structure), never by the wording of the error; the classifier only separates
 * "the site could not be reached". `failedStep` is 1-based in IR order: the spec wraps each step in
 * exactly one `test.step`.
 */
export function failureKindFor(ir: IR, detail: FailureDetail): FailureVerdict {
  const index = typeof detail.failedStep === "number" ? detail.failedStep - 1 : -1;
  const step: Step | undefined = index >= 0 ? ir.steps[index] : undefined;
  if (!step) return { kind: "unknown", reason: "No failing step was reported for this case." };
  const category = classify(`${detail.errorDetail ?? detail.error ?? ""}`)?.category;
  const at = { stepIndex: index, stepId: step.id, ...(category ? { category } : {}) };
  const words = formatIrStep(step);
  if ((category && SITE_CATEGORIES.has(category)) || step.action === "navigate") {
    return { kind: "site-unreachable", ...at, reason: `The site could not be reached at "${words}".` };
  }
  if (step.action === "assert") {
    return { kind: "result-changed", ...at, reason: `The check "${words}" no longer holds: the site gave a different result. That may be a real bug, so the test is left as it is.` };
  }
  if (ELEMENT_ACTIONS.has(step.action)) {
    return { kind: "element-changed", ...at, reason: `"${words}" could not find or use its element.` };
  }
  return { kind: "unknown", ...at, reason: `Step "${words}" failed in a way a repair does not cover.` };
}

/** Most of a suite failing at once (3+ cases, more than half) is the app or the login changing,
 *  not many separate locators: nothing is repaired then. */
export function isMassFailure(total: number, elementChanged: number): boolean {
  return total >= 3 && elementChanged >= 3 && elementChanged * 2 > total;
}

/** A later "is gone" (`hidden`) check aimed at the element this step used: repairing the step
 *  alone would leave that check pointing at nothing, which passes vacuously. Both go to a person. */
export function laterHiddenCheckOnSameElement(ir: IR, index: number): string | null {
  const t = ir.steps[index]?.target;
  if (!t) return null;
  for (const s of ir.steps.slice(index + 1)) {
    if (s.action !== "assert" || s.assertion !== "hidden" || !s.target) continue;
    const sameCss = !!t.css && s.target.css === t.css;
    const sameName = !!t.role && !!t.name && s.target.role === t.role && s.target.name === t.name;
    if (sameCss || sameName) return s.id;
  }
  return null;
}

/** Locator fields a repair may change. Everything else on the step stays exactly as it was. */
const LOCATOR_FIELDS = ["css", "testId", "nth", "label", "placeholder", "groundedAt"] as const;

/** The step with only its locator replaced: meaning fields (role, name) from the repair, every other
 *  field of the target (frame, lookup, field) and of the step (value, preAction) untouched. */
export function withNewLocator(step: Step, found: { role: string; name: string }): Step {
  const target = { ...(step.target ?? {}) } as Record<string, unknown>;
  for (const f of LOCATOR_FIELDS) delete target[f];
  target.role = found.role;
  target.name = found.name;
  return { ...step, target: target as Target };
}

export interface RepairProposal {
  /** "proposed": verified and waiting for a person (step 4). "needs-person": a repair was found but
   *  must not be applied alone. Otherwise no repair, with the reason. */
  state: "proposed" | "needs-person" | "no-repair" | "approved" | "rejected";
  reason: string;
  kind: FailureKind;
  stepId?: string;
  stepText?: string;
  rung?: "field-binding" | "exact-match";
  before?: Target;
  after?: Target;
  changes?: TargetDiff[];
  verification?: { passed: boolean; artifacts?: string; screenshot?: string; error?: string };
  readBack?: { checked: number; matched: number; mismatches: string[]; skipped: string[]; record?: string };
  /** The library case and version the proposal applies to (step 4 needs both). */
  caseId?: string;
  fromVersion?: number;
  /** Step 4: who decided, when, and the version an approval saved. */
  decidedBy?: string;
  decidedAt?: string;
  newVersion?: number;
}

// ---- live repair --------------------------------------------------------------------------------

/** Exactly how many elements a role + exact name matches on the live page. */
async function countExact(page: Page, role: string, name: string): Promise<number> {
  try { return await page.getByRole(role as any, { name, exact: true }).count(); } catch { return 0; }
}

/** True when the saved locator still finds the very element the candidate found: nothing changed,
 *  the page was slow. */
async function oldStillFindsSame(page: Page, t: Target, role: string, name: string): Promise<boolean> {
  try {
    const cand = await page.getByRole(role as any, { name, exact: true }).first().elementHandle({ timeout: 2000 });
    if (!cand) return false;
    if (t.css) {
      const old = await page.locator(t.css).first().elementHandle({ timeout: 2000 }).catch(() => null);
      if (!old) return false;
      return await page.evaluate((pair) => pair[0] === pair[1], [cand, old] as const);
    }
    // No css: the saved target WAS this role + name, so finding it now is not a change.
    return t.role === role && t.name === name;
  } catch { return false; }
}

/** The label the org gives `Object.Field` now, through the org connection's read-only API. */
async function labelNow(session: FrontdoorSession | null, sfField: string): Promise<string | null> {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(sfField);
  if (!m || !session?.apiGet) return null;
  try {
    const info = await session.apiGet(`/ui-api/object-info/${encodeURIComponent(m[1])}`);
    const label = info?.fields?.[m[2]]?.label;
    return typeof label === "string" && label ? label : null;
  } catch { return null; }
}

export interface RepairInput {
  ir: IR;
  stepIndex: number;
  creds?: Credentials;
  /** The case's folder in the replay run; the repair writes under `<caseDir>/repair/`. */
  caseDir: string;
  /** For tests: the org connection to read labels and records with. Default: the run's own rail. */
  session?: FrontdoorSession | null;
  /** The library case: a repair a person rejected for it is never proposed again (step 4), and the
   *  case an approval saves to. */
  caseId?: string;
  /** The saved version that ran: an approval is refused if the case moved on since (step 4). */
  fromVersion?: number;
}

/**
 * Find a repair for the one broken step, verify it, and return the proposal (also written to
 * `<caseDir>/repair/proposal.json`). Never throws: a repair that cannot be made reports why.
 */
export async function attemptRepair(input: RepairInput): Promise<RepairProposal> {
  const { ir, stepIndex } = input;
  const step = ir.steps[stepIndex];
  const session = input.session === undefined ? currentFrontdoor() : input.session;
  // The library case and version go into EVERY proposal written to disk: approving reads them there.
  const base: Pick<RepairProposal, "kind" | "stepId" | "stepText" | "before" | "caseId" | "fromVersion"> = {
    kind: "element-changed", stepId: step?.id, stepText: step ? formatIrStep(step) : undefined, before: step?.target,
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(typeof input.fromVersion === "number" ? { fromVersion: input.fromVersion } : {}),
  };
  const none = (reason: string): RepairProposal => ({ state: "no-repair", reason, ...base });
  if (!step?.target || !ELEMENT_ACTIONS.has(step.action)) return none("Only a click, fill, select or press is ever repaired.");
  if (step.target.frame) return none("The element is inside an iframe; repairs there are not supported yet.");

  const t = step.target;
  const remembered = ir.meta.remembered;
  const sfField = remembered?.elements?.[step.id]?.sfField ?? null;
  const role = t.role || remembered?.elements?.[step.id]?.role || "";

  // Walk the steps before the broken one, in a fresh browser, to the page the test actually reached.
  const browser = await chromium.launch(chromiumLaunchOptions());
  let found: { role: string; name: string; rung: "field-binding" | "exact-match"; why: string } | null = null;
  try {
    const page = await browser.newPage(browserContextOptions());
    const prefix = ir.steps.slice(0, stepIndex);
    prepareReplayPage(page, prefix);
    for (const s of prefix) {
      if (s.action === "assert") continue;
      try { await runStepLive(page, s, ir.meta.baseUrl, input.creds); }
      catch (err: any) { return none(`Could not reach step ${step.id} to look for its element: step ${s.id} failed (${String(err?.message ?? err).split("\n")[0]}).`); }
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);

    // Rung 1: the same Salesforce field, by the label the org gives it now.
    if (sfField && role) {
      const now = await labelNow(session, sfField);
      if (now && lineKey(now) !== lineKey(t.name ?? "")) {
        const n = await countExact(page, role, now);
        if (n === 1) found = { role, name: now, rung: "field-binding", why: `Same Salesforce field ${sfField}; the org now labels it "${now}".` };
        else if (n > 1) return none(`The field ${sfField} is now labelled "${now}", but ${n} elements carry that name: no repair when it is not certain.`);
      }
    }
    // Rung 2: an exact, unique match of the same role and the exact same name.
    if (!found && role && t.name) {
      const n = await countExact(page, role, t.name);
      if (n === 1) found = { role, name: t.name, rung: "exact-match", why: `Exactly one ${role} named "${t.name}" is on the page the test reached.` };
      else if (n > 1) return none(`${n} elements are a ${role} named "${t.name}": no repair when it is not certain.`);
    }
    if (!found) return none(`No ${role || "element"} named "${t.name ?? ""}" is on the page the test reached${sfField ? `, and the field ${sfField} was not found by its current label` : ""}. A person needs to look.`);

    if (await oldStillFindsSame(page, t, found.role, found.name)) {
      return none("The saved locator still finds the same element: the page was slow, nothing changed. Not a repair; run it again.");
    }
  } catch (err: any) {
    return none(`The repair walk failed: ${String(err?.message ?? err).split("\n")[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const after = withNewLocator(step, found);
  // Step 4: a person already rejected exactly this repair for this case: never proposed again.
  if (input.caseId && isRejected(input.caseId, step.id, after.target)) {
    return none(`A person rejected this repair before (${found.role} "${found.name}" for step ${step.id}); it is not proposed again.`);
  }
  const repaired: IR = { ...ir, steps: ir.steps.map((s, i) => (i === stepIndex ? after : s)) };
  const proposalBase = {
    ...base, rung: found.rung, after: after.target,
    changes: diffTargets(step.target, after.target!).filter((d) => d.field !== "target"),
  };

  const hidden = laterHiddenCheckOnSameElement(ir, stepIndex);
  if (hidden) {
    return write(input.caseDir, {
      state: "needs-person", ...proposalBase,
      reason: `${found.why} But the later check ${hidden} expects the old element to be gone; repairing this step alone would leave that check passing on nothing. A person must update both.`,
    });
  }

  // The whole test again, from step 1, with only that one locator changed.
  const dir = path.join(input.caseDir, "repair");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "ir.json"), JSON.stringify(repaired, null, 2));
  const artifacts = path.join(dir, "artifacts");
  let verification: RepairProposal["verification"];
  let results: any = null;
  try {
    const res = await runSpec(generateSpec(repaired, artifacts), dir, credentialEnvVars(input.creds));
    results = res.raw;
    const detail = res.passed ? {} : extractFailureDetail(res.raw);
    const shot = res.passed ? findScreenshot(artifacts) : null;
    verification = {
      passed: res.passed, artifacts: "/" + path.relative(".", artifacts).replace(/\\/g, "/"),
      // The screenshot of the passing re-run, shown with the proposal (step 4).
      ...(shot ? { screenshot: "/" + path.relative(".", shot).replace(/\\/g, "/") } : {}),
      ...(detail.error ? { error: detail.error } : {}),
    };
  } catch (err: any) {
    verification = { passed: false, error: String(err?.message ?? err).split("\n")[0] };
  }
  if (!verification.passed) {
    return write(input.caseDir, {
      state: "no-repair", ...proposalBase, verification,
      reason: `${found.why} With that change the test still does not pass from step 1${verification.error ? ` (${verification.error})` : ""}, so it is not proposed.`,
    });
  }

  // Salesforce: the record the re-run saved must hold what the test typed.
  const readBack = session?.apiGet ? await readBackRecord(session, repaired, results) : undefined;
  if (readBack && readBack.mismatches.length) {
    return write(input.caseDir, {
      state: "no-repair", ...proposalBase, verification, readBack,
      reason: `${found.why} The re-run passed, but the record it saved does not hold what the test typed (${readBack.mismatches.join("; ")}): the repaired step may type into the wrong field.`,
    });
  }
  return write(input.caseDir, {
    state: "proposed", ...proposalBase, verification, ...(readBack ? { readBack } : {}),
    reason: `${found.why} The whole test passed again from step 1${readBack?.checked ? `, and the saved record read back with ${readBack.matched} of ${readBack.checked} typed values` : ""}. Waiting for a person to approve.`,
  });
}

function write(caseDir: string, p: RepairProposal): RepairProposal {
  try {
    mkdirSync(path.join(caseDir, "repair"), { recursive: true });
    writeFileSync(path.join(caseDir, "repair", "proposal.json"), JSON.stringify(p, null, 2));
  } catch { /* the proposal still returns */ }
  return p;
}

/** The run tokens the spec used ({{uid}} and friends), from its "run-tokens" annotation. */
function runTokensFrom(results: any): { uid: string; phone: string; now?: number } | null {
  let out: { uid: string; phone: string; now?: number } | null = null;
  const visit = (s: any) => {
    for (const sp of s?.specs ?? []) for (const t of sp.tests ?? []) {
      for (const a of [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])]) {
        if (a?.type !== "run-tokens") continue;
        try { out = JSON.parse(a.description); } catch { /* skip */ }
      }
    }
    for (const c of s?.suites ?? []) visit(c);
  };
  for (const s of results?.suites ?? []) visit(s);
  return out;
}

/** Field types whose typed text the API returns as the same text. Dates, lookups and picklists come
 *  back in another form, so they are listed as not compared instead of guessed at. */
const COMPARABLE = /^(String|TextArea|Email|Phone|Url|EncryptedString)$/;

/**
 * Read back the record the verification run created and compare each value a fill typed into a field
 * the passing run bound (step 1B). Only the org's own confirmation counts: the newest record of that
 * object the run's pages reached.
 */
export async function readBackRecord(session: FrontdoorSession, ir: IR, results: any): Promise<RepairProposal["readBack"]> {
  const tokens = runTokensFrom(results);
  const fills = ir.steps
    .map((s) => ({ s, field: ir.meta.remembered?.elements?.[s.id]?.sfField ?? null }))
    .filter((x) => x.s.action === "fill" && x.field && typeof x.s.value === "string" && !/^\$\{env:/.test(x.s.value));
  const records = recordsFromResults(results);
  const out: NonNullable<RepairProposal["readBack"]> = { checked: 0, matched: 0, mismatches: [], skipped: [] };
  if (!fills.length || !records.length) return out;
  const byObject = new Map<string, string[]>();
  for (const f of fills) {
    const [obj, field] = f.field!.split(".");
    byObject.set(obj, [...(byObject.get(obj) ?? []), field]);
  }
  for (const [obj, fields] of byObject) {
    const rec = [...records].reverse().find((r) => r.object === obj);
    if (!rec) continue;
    let info: any = null;
    let row: any = null;
    try {
      info = await session.apiGet!(`/ui-api/object-info/${encodeURIComponent(obj)}`);
      const cols = [...new Set(fields)].filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(f)).join(", ");
      row = await session.apiGet!(`/sobjects/${encodeURIComponent(obj)}/${rec.id}?fields=${encodeURIComponent(cols)}`);
    } catch { out.skipped.push(`${obj}: the saved record could not be read`); continue; }
    out.record = `${obj}/${rec.id}`;
    for (const f of fills.filter((x) => x.field!.startsWith(`${obj}.`))) {
      const field = f.field!.split(".")[1];
      const type = String(info?.fields?.[field]?.dataType ?? "");
      if (!COMPARABLE.test(type)) { out.skipped.push(`${f.field} (${type || "unknown type"}) not compared`); continue; }
      const typed = hasRunToken(f.s.value) && tokens ? resolveRunTokens(f.s.value!, tokens) : f.s.value!;
      if (hasRunToken(typed)) { out.skipped.push(`${f.field}: its run value is unknown`); continue; }
      out.checked++;
      const saved = row?.[field];
      if (String(saved ?? "").trim() === typed.trim()) out.matched++;
      else out.mismatches.push(`${f.field} holds "${String(saved ?? "")}", the test typed "${typed}"`);
    }
  }
  return out;
}

/** The failure detail Playwright reported for a case, from its saved result. */
export function failureDetailOf(caseDir: string): FailureDetail {
  try {
    const saved = JSON.parse(readFileSync(path.join(caseDir, "05-result.json"), "utf8"));
    return extractFailureDetail(saved?.raw ?? saved);
  } catch { return {}; }
}

// ---- step 4: decisions ----------------------------------------------------------------------------

/**
 * Rejected repairs, per library case, so the same repair is never proposed again. A small JSON file
 * per case under the cache root (namespace "repair-decisions"): the design's "proposals on disk first".
 * The key is the step and the locator it would have become, so a DIFFERENT repair of the same step can
 * still be proposed after the page changes again.
 */
const DECISIONS_NS = "repair-decisions";
const decisionsFile = (caseId: string) => path.join(cacheNamespaceDir(DECISIONS_NS), `${caseId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const signature = (stepId: string, t: Target | undefined) => `${stepId}|${t?.role ?? ""}|${t?.name ?? ""}`;

interface Rejection { signature: string; stepId: string; by?: string; at: string }

function readRejections(caseId: string): Rejection[] {
  try { return JSON.parse(readFileSync(decisionsFile(caseId), "utf8")).rejected ?? []; } catch { return []; }
}

export function isRejected(caseId: string, stepId: string, after: Target | undefined): boolean {
  const sig = signature(stepId, after);
  return readRejections(caseId).some((r) => r.signature === sig);
}

export function recordRejection(caseId: string, stepId: string, after: Target | undefined, by?: string, at = new Date()): void {
  const list = readRejections(caseId);
  const sig = signature(stepId, after);
  if (list.some((r) => r.signature === sig)) return;
  list.push({ signature: sig, stepId, ...(by ? { by } : {}), at: at.toISOString() });
  mkdirSync(path.dirname(decisionsFile(caseId)), { recursive: true });
  writeFileSync(decisionsFile(caseId), JSON.stringify({ caseId, rejected: list }, null, 2));
}

/** A run case's proposal and the IR it verified, or null when the run has none. */
export function loadProposal(runDir: string, runCaseId: string): { proposal: RepairProposal; ir: IR | null } | null {
  const dir = path.join(runDir, "cases", runCaseId, "repair");
  if (!existsSync(path.join(dir, "proposal.json"))) return null;
  try {
    const proposal = JSON.parse(readFileSync(path.join(dir, "proposal.json"), "utf8")) as RepairProposal;
    const ir = existsSync(path.join(dir, "ir.json")) ? JSON.parse(readFileSync(path.join(dir, "ir.json"), "utf8")) as IR : null;
    return { proposal, ir };
  } catch { return null; }
}

/** Record a decision on the run's own files: the proposal, and the suite summary the run page reads. */
export function recordDecision(runDir: string, runCaseId: string, update: Partial<RepairProposal>): RepairProposal | null {
  const file = path.join(runDir, "cases", runCaseId, "repair", "proposal.json");
  let p: RepairProposal;
  try { p = { ...JSON.parse(readFileSync(file, "utf8")), ...update }; } catch { return null; }
  writeFileSync(file, JSON.stringify(p, null, 2));
  const summaryFile = path.join(runDir, "07-suite-summary.json");
  try {
    const s = JSON.parse(readFileSync(summaryFile, "utf8"));
    const c = (s.cases ?? []).find((x: { caseId?: string }) => x.caseId === runCaseId);
    if (c?.repair) { c.repair = { ...c.repair, ...update }; writeFileSync(summaryFile, JSON.stringify(s, null, 2)); }
  } catch { /* the summary is a convenience copy; the proposal is the record */ }
  return p;
}

/** The repaired IR to save on approval: the verified one, with the case's pins kept. */
export function irToApprove(verified: IR, current: IR): IR {
  return { ...verified, meta: { ...verified.meta, ...(current.meta.pinnedSteps ? { pinnedSteps: current.meta.pinnedSteps } : {}) } };
}

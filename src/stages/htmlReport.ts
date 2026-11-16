import { onlyChecksLogin } from "./salesforceOrgLogin.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { IR, Step } from "../schema/ir.js";
import { extractFailureDetail } from "./executor.js";
import { resolveRunTokens, type RunTokenContext } from "../text.js";
import { chromiumLaunchOptions } from "../browserLaunch.js";

/**
 * The test report for a WHOLE RUN, one file, as HTML or PDF (renderReportPdf prints the same page).
 *
 * WHY IT IS BUILT THIS WAY (2026-11-16 rewrite). The earlier report was called "incorrect, vague and
 * misleading", and on real runs it was:
 *  - a PASS repeated the case's goal ("the record shows the Due Date 5 days out") as if it had been
 *    checked, while the test's last check was a "was saved" message, and the one real proof (the
 *    Salesforce API check) was not in the report at all;
 *  - a test Testbench could not finish read "1 other · truncated no assertion", with no reason, under a
 *    goal it never reached;
 *  - it showed `Recheck {{uid}}`, `{{date:+5:en-US}}` and `${env:SF_FRONTDOOR_URL}` instead of what was
 *    typed, stack traces with our file paths, and step ids inside the explanation.
 * So: three honest results (Passed, Failed, Incomplete, the last never counted as a failure of the app),
 * each test lists what was ACTUALLY checked, on screen and in Salesforce, with the real values, then a
 * technical appendix for testers. Two layers: page one for a manager, the appendix for a tester.
 *
 * Screenshots are embedded (data URIs) so the file can be sent as is; only the key ones (after each
 * check, and where it failed or stopped). PURE CODE, NO MODEL: presentation over the run's own files.
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const secs = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  return v >= 60_000 ? `${Math.floor(v / 60_000)} min ${Math.round((v % 60_000) / 1000)} s` : `${(v / 1000).toFixed(1)} s`;
};

/** Ceiling on embedded images across the whole run. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
/** Key screenshots per test, beyond the one where it failed. */
const MAX_KEY_SHOTS = 6;

export interface ApiCheckRow { object: string; field: string; expected: string; actual?: string; ok: boolean; note?: string }

export interface ReportCase {
  caseId: string;
  title: string;
  /** From the suite summary: passed | failed | blocked | truncated | truncated_no_assertion. */
  status: string;
  /** The plain-English stake, written for someone who has never read a test. */
  whyItMatters?: string;
  /** What this case set out to show. NOT proof: what was checked is listed separately. */
  expected?: string;
  /** Why a blocked case could not go on, when the run recorded it. */
  blockedBy?: string;
  /** Parsed `05-result.json`. */
  saved: any;
  ir?: IR | null;
  diagnosis?: any | null;
  /** What the Salesforce API read back for this case (`11-api-checks.json`). */
  apiChecks?: ApiCheckRow[];
  /** Absolute path to this case's `artifacts/` dir, for reading screenshots. */
  artifactsDir?: string;
  artifactFiles?: string[];
}

export interface RunReportInput {
  runId: string;
  /** The natural-language request that started the run. */
  prompt?: string;
  baseUrl?: string;
  startedAt?: number;
  llmCalls?: number;
  llmTokens?: number;
  /** D-68: a sentence shown in a warning box under the header (a production Salesforce org). */
  orgWarning?: string;
  /** `10-cleanup.json`: the test records deleted from the org after the run. */
  cleanup?: { deleted?: unknown[]; failed?: unknown[] } | null;
  cases: ReportCase[];
}

// ---------------------------------------------------------------------------------------------
// Reading a run from disk (shared by the HTML and the PDF route)
// ---------------------------------------------------------------------------------------------

/** Everything the report shows, read from the run's own files. Null when the run recorded no case. */
export function loadRunReport(runId: string, runsRoot = "runs"): RunReportInput | null {
  const runDir = path.join(runsRoot, runId);
  const readJson = (...seg: string[]): any | null => {
    try { return JSON.parse(readFileSync(path.join(runDir, ...seg), "utf8")); } catch { return null; }
  };
  const summary = readJson("07-suite-summary.json");
  const input = readJson("00-input.json");
  const usage = readJson("08-llm-usage.json");
  const apiByCase = new Map<string, ApiCheckRow[]>(
    (readJson("11-api-checks.json") ?? []).map((c: any) => [String(c.case), c.checks ?? []]));

  // The suite summary is the only place that knows a case's HONEST status (blocked, truncated).
  const rootIr = readJson("04-ir.json");
  const entries: any[] = summary?.cases?.length
    ? summary.cases
    : rootIr || readJson("05-result.json")
      ? [{ caseId: "case-0", title: rootIr?.ir?.meta?.title ?? rootIr?.meta?.title ?? "Test case",
           status: readJson("05-result.json")?.passed ? "passed" : "failed", resultPath: "" }]
      : [];
  if (!entries.length) return null;

  const cases: ReportCase[] = entries.map((e: any) => {
    // A suite case lives in cases/<id>/; the primary case's artifacts sit at the run root.
    const dir = e.resultPath ? path.join(runDir, "cases", e.caseId) : runDir;
    const rd = (name: string): any | null => {
      try { return JSON.parse(readFileSync(path.join(dir, name), "utf8")); } catch { return null; }
    };
    const irRaw = rd("04-ir.json");
    let artifactFiles: string[] = [];
    const artifactsDir = path.join(dir, "artifacts");
    try { artifactFiles = readdirSync(artifactsDir); } catch { /* cleared or never written */ }
    return {
      caseId: e.caseId, title: e.title ?? e.caseId, status: e.status ?? "failed",
      whyItMatters: e.whyItMatters, expected: e.expected, blockedBy: e.blockedBy,
      saved: rd("05-result.json") ?? {}, ir: irRaw?.ir ?? irRaw ?? null, diagnosis: rd("06-diagnosis.json"),
      apiChecks: apiByCase.get(e.caseId), artifactsDir, artifactFiles,
    };
  });

  return {
    runId, prompt: input?.prompt, baseUrl: input?.url ?? cases[0]?.ir?.meta?.baseUrl,
    // A runId is makeRunId()'s ISO stamp with : and . swapped for -.
    startedAt: Date.parse(runId.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*$/, "$1T$2:$3:$4.$5Z")) || undefined,
    llmCalls: usage?.calls, llmTokens: usage?.totalTokens,
    cleanup: readJson("10-cleanup.json"),
    cases,
  };
}

// ---------------------------------------------------------------------------------------------
// Turning a run's records into plain words
// ---------------------------------------------------------------------------------------------

type Outcome = "passed" | "failed" | "incomplete";
const outcomeOf = (status: string): Outcome => {
  const s = (status || "failed").toLowerCase();
  return s === "passed" ? "passed" : s === "failed" ? "failed" : "incomplete";
};
const OUTCOME_WORD: Record<Outcome, string> = { passed: "Passed", failed: "Failed", incomplete: "Incomplete" };

/** "WorkOrder" -> "Work Order", "Zq_Total__c" -> "Zq Total". */
const objectLabel = (api: string): string =>
  api.replace(/__c$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");

/** The values the run actually used for {{uid}}, {{date:..}}: the spec's "run-tokens" annotation. */
function runContext(raw: any): RunTokenContext | null {
  let ctx: RunTokenContext | null = null;
  const visit = (s: any): void => {
    for (const c of s?.suites ?? []) visit(c);
    for (const sp of s?.specs ?? []) for (const t of sp?.tests ?? []) {
      for (const a of [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])]) {
        if (a?.type === "run-tokens") { try { ctx = JSON.parse(a.description); } catch { /* absent */ } }
      }
    }
  };
  for (const s of raw?.suites ?? []) visit(s);
  return ctx;
}

/** Text with the run's real values in place of its tokens; a token the run never resolved stays readable. */
function real(text: unknown, ctx: RunTokenContext | null): string {
  let t = String(text ?? "");
  if (ctx) t = resolveRunTokens(t, ctx);
  return t
    .replace(/\{\{date:([+-]?\d+):[^}]+\}\}/g, (_m, d) => (Number(d) === 0 ? "today's date" : `the date ${Math.abs(Number(d))} day(s) ${Number(d) > 0 ? "from" : "before"} the run`))
    .replace(/\s*\{\{uid\}\}/g, "")
    .replace(/\{\{phone\}\}/g, "a test phone number");
}

/** One check as a sentence ("The text "was created" appears"), or null for a step that checks nothing. */
function checkSentence(s: Step, ctx: RunTokenContext | null): string | null {
  if (s.action !== "assert") return null;
  const t = s.target ?? {};
  const what = real(t.field ?? t.name ?? t.text ?? t.label ?? "", ctx);
  const value = real(s.value ?? "", ctx);
  switch (s.assertion ?? "visible") {
    case "text_contains": return t.field ? `"${what}" shows "${value}"` : `"${what}" contains "${value}"`;
    case "text_equals": return `"${what}" reads exactly "${value}"`;
    case "url_contains": return `The page address contains "${value}"`;
    case "title_contains": return `The page title contains "${value}"`;
    case "title_equals": return `The page title is "${value}"`;
    case "opens_url_contains": return `"${what}" opens an address containing "${value}"`;
    case "hidden": return `"${what}" is no longer shown`;
    default: return t.text ? `The text "${what}" appears` : `"${what}" is shown`;
  }
}

/** A step as a person would say it; waits are not steps a reader needs. */
function plainStep(pwTitle: string, s: Step | undefined, ctx: RunTokenContext | null): string {
  if (s?.action === "assert") return `Check: ${checkSentence(s, ctx)}`;
  const url = s?.action === "navigate" ? String(s.target?.url ?? "") : "";
  if (url) {
    if (/^\$\{env:SF_FRONTDOOR_URL_2\}$/.test(url)) return "Sign in to Salesforce as the second user";
    if (/^\$\{env:[A-Z_]+\}$/.test(url)) return "Sign in to Salesforce";
    const created = /^\$\{record:([A-Za-z0-9_]+):(\d+)\}$/.exec(url);
    if (created) return `Go back to the ${objectLabel(created[1])} record this test created`;
    const form = /\/lightning\/o\/([A-Za-z0-9_]+)\/new\b/.exec(url);
    if (form) return `Open the "New ${objectLabel(form[1])}" form`;
    const list = /\/lightning\/o\/([A-Za-z0-9_]+)\/(list|home)\b/.exec(url);
    if (list) return `Open the ${objectLabel(list[1])} list`;
    try { return `Open ${new URL(url, "https://x.invalid").pathname}`; } catch { return `Open ${url}`; }
  }
  return real(pwTitle, ctx).replace(/^Navigate to https?:\/\/[^/\s]+/, "Open ");
}

/** A diagnosis sentence without pipeline notes ("(Note: this explanation blames ...)") or step ids. */
const cleanExplanation = (text: unknown, ctx: RunTokenContext | null): string =>
  real(text, ctx).replace(/\s*\(Note:[^)]*\)/g, "").replace(/\s+/g, " ").trim();

/** An error as one readable message: no "Error:" prefix, no stack, no source frame. */
function cleanError(text: unknown, ctx: RunTokenContext | null): string {
  return real(text, ctx).split("\n")
    .filter((l) => !/^\s*(at\s|>?\s*\d+\s*\||\|\s*\^|\s*\^)/.test(l))
    .join("\n").replace(/^Error:\s*/, "").replace(/\n{2,}/g, "\n").trim();
}

function inlineImage(dir: string | undefined, file: string, budget: { left: number }): string | null {
  if (!dir) return null;
  try {
    const buf = readFileSync(path.join(dir, file));
    if (buf.length > budget.left) return null;
    budget.left -= buf.length;
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

/** Everything one case's report needs, worked out once. */
function caseFacts(c: ReportCase) {
  let steps: any[] = [];
  let durationMs = 0;
  const visit = (suite: any): void => {
    for (const child of suite?.suites ?? []) visit(child);
    for (const spec of suite?.specs ?? []) for (const t of spec?.tests ?? []) for (const r of t?.results ?? []) {
      if (!steps.length && Array.isArray(r?.steps)) steps = r.steps;
      if (Number.isFinite(r?.duration)) durationMs = Math.max(durationMs, Number(r.duration));
    }
  };
  for (const s of c.saved?.raw?.suites ?? []) visit(s);
  const ctx = runContext(c.saved?.raw);
  const outcome = outcomeOf(c.status);
  const detail = extractFailureDetail(c.saved?.raw ?? c.saved);
  const failedIdx = outcome === "failed"
    ? (typeof detail.failedStep === "number" ? detail.failedStep - 1 : steps.findIndex((s) => !!s?.error))
    : -1;
  const irSteps: Step[] = (c.ir?.steps ?? []) as Step[];
  // Playwright records one step per IR step, in order (the generator emits a test.step for each).
  const rows = steps.map((s, i) => ({ i, title: plainStep(String(s?.title ?? ""), irSteps[i], ctx), ir: irSteps[i],
    isWait: irSteps[i]?.action === "wait" || /^Wait \d+ ?ms$/i.test(String(s?.title ?? "")), durationMs: Number(s?.duration) || 0 }));
  // Each check, and whether it was reached: before the failing step it held, at it it failed.
  const ran = steps.length;
  const checks = irSteps.map((s, i) => ({ i, sentence: checkSentence(s, ctx) })).filter((x) => x.sentence)
    .map((x) => ({ ...x, state: x.i === failedIdx ? "failed" : (failedIdx >= 0 && x.i > failedIdx) || x.i >= ran ? "not-reached" : "held" }));
  const api = (c.apiChecks ?? []).map((a) => ({ ...a, expected: real(a.expected, ctx), actual: a.actual === undefined ? undefined : real(a.actual, ctx) }));
  return { steps, rows, ctx, outcome, detail, failedIdx, checks, api, durationMs, ran };
}

const MARK = { held: "&#10003;", failed: "&#10007;", "not-reached": "&#8211;" } as const;

/** One line for the summary table. */
function oneLine(c: ReportCase, f: ReturnType<typeof caseFacts>): string {
  if (f.outcome === "failed") {
    const at = f.failedIdx >= 0 ? f.rows[f.failedIdx] : undefined;
    return at ? `Failed at step ${at.i + 1}: ${at.title}` : "Failed before its first step";
  }
  if (f.outcome === "incomplete") return incompleteReason(c, f).short;
  const ui = f.checks.filter((x) => x.state === "held").length;
  const sf = f.api.filter((a) => a.ok).length;
  if (!ui && !sf) return "Passed, but it made no check of the result";
  return [ui ? `${ui} check${ui === 1 ? "" : "s"} on screen` : "", sf ? `${sf} value${sf === 1 ? "" : "s"} confirmed in Salesforce` : ""]
    .filter(Boolean).join(", ");
}

function incompleteReason(c: ReportCase, f: ReturnType<typeof caseFacts>): { short: string; long: string } {
  const status = (c.status || "").toLowerCase();
  const last = [...f.rows].reverse().find((r) => !r.isWait);
  const where = last ? ` It ran ${f.ran} step${f.ran === 1 ? "" : "s"}; the last was "${last.title}".` : "";
  if (status === "blocked") {
    return { short: "Stopped by a screen automation cannot pass",
      long: `The app showed a screen automation cannot get past${c.blockedBy ? ` (${c.blockedBy})` : ""}, such as a verification code.${where}` };
  }
  if (status === "truncated") {
    return { short: "Only part of the request was tested",
      long: `Testbench could not work out every step of this test. The steps it ran passed, but the rest of the request was not tested.${where}` };
  }
  return { short: "Testbench could not finish building this test",
    long: `Testbench could not work out every step of this test, so it stopped before checking the result.${where}` };
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef0f4; color: #16181c;
         font: 14.5px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .page { max-width: 940px; margin: 0 auto; padding: 28px 20px 56px; }
  .card { background: #fff; border: 1px solid #dfe2e8; border-radius: 12px; padding: 22px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2.part { font-size: 18px; margin: 28px 0 12px; }
  h3 { font-size: 16px; margin: 0; flex: 1; }
  .sub { color: #5a5f68; margin: 4px 0 0; word-break: break-word; }
  .counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; }
  .pill { border-radius: 999px; padding: 4px 13px; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
  .o-passed { background: #e4f4ea; color: #10603a; }
  .o-failed { background: #fce9e9; color: #8a1b1b; }
  .o-incomplete { background: #fff3dc; color: #7a4b00; }
  .o-none { background: #eceff3; color: #414750; }
  table.sum { width: 100%; border-collapse: collapse; }
  table.sum th { text-align: left; font-size: 12px; color: #5a5f68; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; border-bottom: 1px solid #dfe2e8; }
  table.sum td { padding: 10px 8px; border-bottom: 1px solid #eceff3; vertical-align: top; }
  .head { display: flex; align-items: flex-start; gap: 12px; }
  .label { color: #5a5f68; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 18px 0 4px; }
  .box { border-radius: 10px; padding: 12px 14px; margin: 14px 0 0; border: 1px solid; border-left-width: 4px; }
  .box.passed { background: #f6fbf8; border-color: #bfe3cc; }
  .box.failed { background: #fffafa; border-color: #f2c4c4; }
  .box.incomplete { background: #fffbf2; border-color: #f0d9a8; }
  .box p { margin: 0 0 6px; } .box p:last-child { margin: 0; }
  ul.checks { list-style: none; margin: 4px 0 0; padding: 0; }
  ul.checks li { padding: 4px 0 4px 26px; position: relative; }
  ul.checks li .m { position: absolute; left: 0; width: 18px; text-align: center; font-weight: 700; }
  .held .m { color: #10603a; } .failed .m { color: #b42318; } .not-reached { color: #767b84; }
  .note { color: #5a5f68; font-size: 13px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 6px; }
  figure { margin: 0; } figure img { width: 100%; border: 1px solid #e2e5ea; border-radius: 8px; display: block; }
  figcaption { color: #5a5f68; font-size: 12px; margin-top: 4px; }
  ol.steps { margin: 6px 0 0; padding-left: 22px; } ol.steps li { padding: 2px 0; }
  ol.steps li.bad { color: #b42318; font-weight: 600; }
  .dur { color: #767b84; font-size: 12px; }
  .err { background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 8px; padding: 10px 12px;
         font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dl.facts dt { color: #5a5f68; } dl.facts dd { margin: 0; word-break: break-word; }
  footer { color: #767b84; font-size: 12px; text-align: center; margin-top: 24px; }
  @page { size: A4; margin: 14mm 12mm; }
  @media print { body { background: #fff; } .page { padding: 0; max-width: none; }
    .card { break-inside: avoid-page; } .appendix { break-before: page; } figure { break-inside: avoid; }
    h2.part { break-after: avoid-page; } }
`;

function caseDetail(c: ReportCase, f: ReturnType<typeof caseFacts>, budget: { left: number }): string {
  const o = f.outcome;
  let box = "";
  if (o === "passed") {
    const nothing = !f.checks.length && !f.api.length;
    box = `<div class="box passed"><p><b>Passed.</b> ${nothing
      ? "Every step ran, but this test made no check of the result, so the pass proves only that the steps could be done."
      : "Every check listed below held."}</p>${onlyChecksLogin(c.ir)
      ? `<p>Only checked that login works; this test made no check after logging in.</p>` : ""}</div>`;
  } else if (o === "failed") {
    const at = f.failedIdx >= 0 ? f.rows[f.failedIdx] : undefined;
    const msg = cleanError(f.detail.error, f.ctx).split("\n")[0];
    const why = c.diagnosis?.explanation ? cleanExplanation(c.diagnosis.explanation, f.ctx) : "";
    box = `<div class="box failed"><p><b>Failed${at ? ` at step ${at.i + 1}:</b> ${esc(at.title)}` : ".</b>"}</p>` +
      (msg ? `<p><b>What the test saw.</b> ${esc(msg)}</p>` : "") +
      (why ? `<p><b>What happened.</b> ${esc(why)}</p>` : "") + `</div>`;
  } else {
    box = `<div class="box incomplete"><p><b>Incomplete.</b> ${esc(incompleteReason(c, f).long)}</p>` +
      `<p>This is not a finding about your app: the test did not get as far as checking it.</p></div>`;
  }

  const checksHtml = f.checks.length ? `<p class="label">Checked on screen</p><ul class="checks">${f.checks.map((x) =>
    `<li class="${x.state}"><span class="m">${MARK[x.state as keyof typeof MARK]}</span>${esc(x.sentence)}${
      x.state === "not-reached" ? ` <span class="note">(not reached)</span>` : x.state === "failed" ? ` <span class="note">(failed)</span>` : ""}</li>`).join("")}</ul>` : "";
  const apiHtml = f.api.length ? `<p class="label">Confirmed in Salesforce</p><ul class="checks">${f.api.map((a) =>
    `<li class="${a.ok ? "held" : "failed"}"><span class="m">${a.ok ? MARK.held : MARK.failed}</span>${esc(objectLabel(a.object))} &middot; ${esc(a.field)}: expected "${esc(a.expected)}"${
      a.actual !== undefined ? `, Salesforce has "${esc(a.actual)}"` : ""}${a.note ? ` <span class="note">(${esc(a.note)})</span>` : ""}</li>`).join("")}</ul>` : "";

  // Key screenshots: after each check, where it failed (or the step before, when the failing step took
  // none), and the last step it reached.
  const files = new Set(c.artifactFiles ?? []);
  const shotOf = (i: number) => files.has(`step-${i + 1}.png`) ? i : -1;
  const want: { i: number; caption: string }[] = [];
  const add = (i: number, caption: string) => { if (i >= 0 && !want.some((w) => w.i === i)) want.push({ i, caption }); };
  if (f.failedIdx >= 0) {
    const i = shotOf(f.failedIdx) >= 0 ? f.failedIdx : shotOf(f.failedIdx - 1);
    add(i, i === f.failedIdx ? `Step ${i + 1}, where it failed` : `Just before step ${f.failedIdx + 1} failed`);
  }
  for (const x of f.checks) if (x.state === "held" && want.length < MAX_KEY_SHOTS) add(shotOf(x.i), `After step ${x.i + 1}: ${x.sentence}`);
  const lastRun = [...f.rows].reverse().find((r) => !r.isWait);
  if (lastRun && want.length < MAX_KEY_SHOTS + 1) add(shotOf(lastRun.i), `Step ${lastRun.i + 1}, the last step run`);
  want.sort((a, b) => a.i - b.i);
  const shots = want.map((w) => ({ ...w, src: inlineImage(c.artifactsDir, `step-${w.i + 1}.png`, budget) })).filter((w) => w.src);
  const shotsHtml = shots.length ? `<p class="label">Key screenshots</p><div class="shots">${shots.map((s) =>
    `<figure><img src="${s.src}" alt="${esc(s.caption)}" /><figcaption>${esc(s.caption)}</figcaption></figure>`).join("")}</div>` : "";

  return `
  <section class="card" id="${esc(c.caseId)}">
    <div class="head"><h3>${esc(c.title)}</h3><span class="pill o-${o}">${OUTCOME_WORD[o]}</span></div>
    ${box}
    ${c.expected ? `<p class="label">What this test set out to show</p><div>${esc(real(c.expected, f.ctx))}</div>` : ""}
    ${checksHtml}${apiHtml}
    ${!f.checks.length && !f.api.length && o !== "passed" ? `<p class="label">Checks</p><p class="note">No check was reached.</p>` : ""}
    ${c.whyItMatters ? `<p class="label">Why it matters</p><div class="note">${esc(c.whyItMatters)}</div>` : ""}
    ${shotsHtml}
  </section>`;
}

function caseAppendix(c: ReportCase, f: ReturnType<typeof caseFacts>): string {
  const visible = f.rows.filter((r) => !r.isWait);
  const steps = f.steps.length
    ? `<ol class="steps">${visible.map((r) => `<li value="${r.i + 1}" class="${r.i === f.failedIdx ? "bad" : ""}">${esc(r.title)} <span class="dur">${esc(secs(r.durationMs))}</span></li>`).join("")}</ol>`
    : `<p class="note">No step record: the run ended before the browser test started.</p>`;
  const err = f.outcome === "failed" ? cleanError(f.detail.errorDetail ?? f.detail.error, f.ctx) : "";
  return `
  <section class="card">
    <div class="head"><h3>${esc(c.title)}</h3><span class="pill o-${f.outcome}">${OUTCOME_WORD[f.outcome]}</span></div>
    <p class="label">Steps${f.steps.length ? ` (${visible.length}, waits left out)` : ""}${f.durationMs ? ` &middot; ${esc(secs(f.durationMs))}` : ""}</p>
    ${steps}
    ${err ? `<p class="label">Error message</p><div class="err">${esc(err)}</div>` : ""}
    ${f.outcome === "failed" && c.diagnosis?.suggestedFix ? `<p class="label">Technical note</p><div class="note">${esc(cleanExplanation(c.diagnosis.suggestedFix, f.ctx))}</div>` : ""}
    ${c.diagnosis?.verifiedText ? `<p class="note">Seen on the page when it failed: <code>${esc(c.diagnosis.verifiedText)}</code></p>` : ""}
  </section>`;
}

export function buildRunReportHtml(input: RunReportInput): string {
  const budget = { left: MAX_INLINE_BYTES };
  const facts = input.cases.map((c) => caseFacts(c));
  const n = (o: Outcome) => facts.filter((f) => f.outcome === o).length;
  const passed = n("passed"), failed = n("failed"), incomplete = n("incomplete");
  const total = input.cases.length;
  const when = input.startedAt ? new Date(input.startedAt).toUTCString().replace(" GMT", " UTC") : "";
  const deleted = input.cleanup?.deleted?.length ?? 0;
  const notDeleted = input.cleanup?.failed?.length ?? 0;

  const verdict = !total ? "This run recorded no cases."
    : failed ? `${failed} of ${total} test${total === 1 ? "" : "s"} failed.`
    : incomplete ? `${passed} of ${total} test${total === 1 ? "" : "s"} passed; ${incomplete} could not be finished.`
    : total === 1 ? "The test passed." : `All ${total} tests passed.`;

  const summary = total ? `<table class="sum"><thead><tr><th>Test</th><th>Result</th><th>In one line</th></tr></thead><tbody>${
    input.cases.map((c, i) => `<tr><td>${esc(c.title)}</td><td><span class="pill o-${facts[i].outcome}">${OUTCOME_WORD[facts[i].outcome]}</span></td><td>${esc(oneLine(c, facts[i]))}</td></tr>`).join("")
  }</tbody></table>` : `<p class="note">This run recorded no cases.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Test report — ${esc(input.baseUrl || input.runId)}</title>
<style>${STYLE}</style></head>
<body><div class="page">
  <header class="card">
    <h1>Test report</h1>
    ${input.prompt ? `<p class="sub"><b>Request:</b> ${esc(input.prompt)}</p>` : ""}
    ${input.baseUrl ? `<p class="sub"><b>Tested on:</b> ${esc(input.baseUrl)}</p>` : ""}
    ${when ? `<p class="sub"><b>Run on:</b> ${esc(when)}</p>` : ""}
    <p class="sub" style="color:#16181c;font-size:16px;margin-top:12px"><b>${esc(verdict)}</b></p>
    <div class="counts">
      <span class="pill ${passed ? "o-passed" : "o-none"}">${passed} passed</span>
      <span class="pill ${failed ? "o-failed" : "o-none"}">${failed} failed</span>
      <span class="pill ${incomplete ? "o-incomplete" : "o-none"}">${incomplete} incomplete</span>
    </div>
  </header>${input.orgWarning ? `
  <div class="box failed"><p><b>Not a test org.</b> ${esc(input.orgWarning)}</p></div>` : ""}
  <section class="card"><h2 style="font-size:16px;margin:0 0 8px">Summary</h2>${summary}
    <p class="note" style="margin:10px 0 0">Passed: every check held. Failed: a check did not hold, or a step could not be done. Incomplete: Testbench could not finish the test, so it says nothing about the app.</p>
  </section>
  ${total ? `<h2 class="part">Test details</h2>${input.cases.map((c, i) => caseDetail(c, facts[i], budget)).join("")}` : ""}
  <div class="appendix">
  <h2 class="part">Technical appendix</h2>
  ${input.cases.map((c, i) => caseAppendix(c, facts[i])).join("")}
  <section class="card"><dl class="facts">
    <dt>Run</dt><dd>${esc(input.runId)}</dd>
    ${input.cleanup ? `<dt>Test records</dt><dd>${deleted} deleted from the org after the run${notDeleted ? `, ${notDeleted} could not be deleted` : ""}</dd>` : ""}
    ${input.llmCalls ? `<dt>AI use</dt><dd>${input.llmCalls} calls${input.llmTokens ? `, ${Math.round(input.llmTokens / 1000)}k tokens` : ""}</dd>` : ""}
  </dl></section>
  </div>
  <footer>Built from this run's own records, without AI. Screenshots are embedded, so this file can be sent as it is.</footer>
</div></body></html>`;
}

/** The same report as a PDF: the page printed by the Chromium Testbench already runs its tests in. */
export async function renderReportPdf(html: string): Promise<Buffer> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

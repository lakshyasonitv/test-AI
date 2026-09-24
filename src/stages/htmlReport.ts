import { readFileSync } from "node:fs";
import path from "node:path";
import type { IR } from "../schema/ir.js";
import { extractFailureDetail } from "./executor.js";

/**
 * A readable report for a WHOLE RUN — every case, in one self-contained file.
 *
 * WHY. "Download full result" handed the user Playwright's raw reporter JSON; a QA tester noted you
 * "must have vs code or other IDE installed" to open it. The first attempt at this fixed the format
 * but not the shape: one page per CASE, with screenshots linked by relative path. Run four cases and
 * you got four separate downloads, each showing broken images the moment the file left the run
 * folder. Reported bluntly, and fairly.
 *
 * So: ONE file per run. It opens with the verdict and the counts, then gives every case in full —
 * what it was checking, what should have happened, where it stopped, and the step-by-step.
 *
 * SCREENSHOTS ARE INLINED as data URIs. Measured on a real 4-case run: ~3 MB. That is an email
 * attachment, not a problem — and the relative-path alternative is precisely what was broken. A
 * report you cannot send to somebody is not a report. Bounded by MAX_INLINE_BYTES so a pathological
 * run degrades to text rather than producing a file nothing can open.
 *
 * PURE CODE, NO MODEL — presentation over artifacts already on disk, generator.ts's side of D-06.
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const ms = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
};

/** Ceiling on embedded images across the whole run. ~3MB is typical for four cases. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export interface ReportCase {
  caseId: string;
  title: string;
  /** From the suite summary: passed | failed | blocked | truncated | truncated_no_assertion. */
  status: string;
  /** The plain-English stake, written for someone who has never read a test. */
  whyItMatters?: string;
  /** What this case was supposed to prove. */
  expected?: string;
  /** Parsed `05-result.json`. */
  saved: any;
  ir?: IR | null;
  diagnosis?: any | null;
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
  cases: ReportCase[];
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #eef0f4; color: #16181c;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .page { max-width: 940px; margin: 0 auto; padding: 32px 20px 64px; }
  header.run { background: #fff; border: 1px solid #dfe2e8; border-radius: 14px; padding: 24px; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: #5a5f68; font-size: 14px; margin: 0 0 6px; word-break: break-word; }
  .counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 0; }
  .count { border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 600; }
  .c-pass { background: #e4f4ea; color: #10603a; }
  .c-fail { background: #fce9e9; color: #8a1b1b; }
  .c-other { background: #eceff3; color: #414750; }
  .facts { margin: 16px 0 0; padding: 0; list-style: none; color: #5a5f68; font-size: 13px; }
  .facts li { display: inline-block; margin-right: 18px; }
  .facts b { color: #16181c; font-weight: 600; }

  section.case { background: #fff; border: 1px solid #dfe2e8; border-radius: 14px;
                 padding: 22px; margin-bottom: 18px; }
  section.case.is-failed { border-color: #f2c4c4; }
  .case-head { display: flex; align-items: flex-start; gap: 12px; }
  .case-head h2 { font-size: 17px; margin: 0; flex: 1; letter-spacing: -0.01em; }
  .verdict { flex: none; border-radius: 999px; padding: 4px 13px; font-size: 12px;
             font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .v-passed { background: #e4f4ea; color: #10603a; }
  .v-failed { background: #fce9e9; color: #8a1b1b; }
  .v-other  { background: #eceff3; color: #414750; }
  .kv { margin: 14px 0 0; }
  .kv dt { color: #5a5f68; font-size: 12px; text-transform: uppercase;
           letter-spacing: .05em; margin-top: 12px; }
  .kv dd { margin: 3px 0 0; }
  .label { color: #5a5f68; font-size: 12px; text-transform: uppercase;
           letter-spacing: .05em; margin: 20px 0 0; }

  .failbox { background: #fffafa; border: 1px solid #f2c4c4; border-left-width: 4px;
             border-radius: 10px; padding: 14px 16px; margin: 16px 0 0; }
  .failbox h3 { margin: 0 0 8px; font-size: 14px; color: #8a1b1b; }
  .err { background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 8px; padding: 10px 12px;
         font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         white-space: pre-wrap; word-break: break-word; margin-top: 8px; }

  ol.steps { list-style: none; margin: 10px 0 0; padding: 0; }
  ol.steps > li { border: 1px solid #e4e7ec; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  ol.steps > li.bad { border-color: #f2c4c4; background: #fffafa; }
  .st-head { display: flex; align-items: baseline; gap: 10px; }
  .st-n { flex: none; min-width: 24px; height: 24px; line-height: 24px; text-align: center;
          border-radius: 7px; background: #eceff3; color: #414750; font-size: 12px; font-weight: 700; }
  li.bad .st-n { background: #d13f3f; color: #fff; }
  .st-title { flex: 1; font-weight: 600; }
  .st-dur { flex: none; color: #767b84; font-size: 12px; }
  .st-sub { color: #5a5f68; font-size: 13px; margin: 4px 0 0 34px; }
  figure { margin: 10px 0 0 34px; }
  figure img { max-width: 100%; border: 1px solid #e2e5ea; border-radius: 8px; display: block; }
  figcaption { color: #767b84; font-size: 12px; margin-top: 5px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: #414750; font-size: 13px; }
  .note { color: #5a5f68; font-size: 13px; }
  footer { color: #767b84; font-size: 12px; text-align: center; margin-top: 28px; }
  @media print { body { background: #fff; } section.case { break-inside: avoid; } }
`;

/** One screenshot as a data URI, within the run's remaining image budget. */
function inlineImage(dir: string | undefined, file: string, budget: { left: number }): string | null {
  if (!dir) return null;
  try {
    const buf = readFileSync(path.join(dir, file));
    if (buf.length > budget.left) return null;
    budget.left -= buf.length;
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

function renderCase(c: ReportCase, budget: { left: number }): string {
  let steps: any[] = [];
  let durationMs = 0;
  const visit = (suite: any): void => {
    for (const child of suite?.suites ?? []) visit(child);
    for (const spec of suite?.specs ?? []) {
      for (const t of spec?.tests ?? []) {
        for (const r of t?.results ?? []) {
          if (!steps.length && Array.isArray(r?.steps)) steps = r.steps;
          if (Number.isFinite(r?.duration)) durationMs = Math.max(durationMs, Number(r.duration));
        }
      }
    }
  };
  for (const s of c.saved?.raw?.suites ?? []) visit(s);

  const detail = extractFailureDetail(c.saved?.raw ?? c.saved);
  const status = (c.status || "failed").toLowerCase();
  const isFail = status === "failed";
  const vClass = status === "passed" ? "v-passed" : isFail ? "v-failed" : "v-other";
  const files = c.artifactFiles ?? [];
  const failedIdx = typeof detail.failedStep === "number" ? detail.failedStep - 1 : -1;

  const stepsHtml = steps.length ? `<ol class="steps">${steps.map((s, i) => {
    const bad = i === failedIdx || !!s?.error;
    const irStep = c.ir?.steps?.[i];
    const sub = irStep
      ? [irStep.action, irStep.target?.name ?? irStep.target?.text ?? irStep.target?.url]
          .filter(Boolean).join(" · ")
      : "";
    const name = `step-${i + 1}.png`;
    const src = files.includes(name) ? inlineImage(c.artifactsDir, name, budget) : null;
    return `<li class="${bad ? "bad" : ""}">` +
      `<div class="st-head"><span class="st-n">${i + 1}</span>` +
      `<span class="st-title">${esc(s?.title ?? name)}</span>` +
      `<span class="st-dur">${esc(ms(s?.duration))}</span></div>` +
      (sub ? `<div class="st-sub">${esc(sub)}</div>` : "") +
      (src ? `<figure><img src="${src}" alt="After step ${i + 1}" />` +
             `<figcaption>After step ${i + 1}</figcaption></figure>` : "") +
      `</li>`;
  }).join("")}</ol>`
    : `<p class="note">No per-step record — the run ended before Playwright wrote one.</p>`;

  const failHtml = !isFail || !detail.error ? "" : `
    <div class="failbox">
      <h3>Where it stopped</h3>
      ${detail.failedStep
        ? `<p style="margin:0"><b>Step ${detail.failedStep}</b>${
            detail.failedStepTitle ? ` — ${esc(detail.failedStepTitle)}` : ""}</p>` : ""}
      <div class="err">${esc(detail.error)}</div>
      ${detail.errorDetail && detail.errorDetail !== detail.error
        ? `<details><summary>Full error</summary><div class="err">${esc(detail.errorDetail)}</div></details>` : ""}
      ${c.diagnosis?.explanation ? `<p style="margin:12px 0 0"><b>What happened.</b> ${esc(c.diagnosis.explanation)}</p>` : ""}
      ${c.diagnosis?.suggestedFix ? `<p style="margin:6px 0 0"><b>What you can do.</b> ${esc(c.diagnosis.suggestedFix)}</p>` : ""}
      ${c.diagnosis?.verifiedText
        ? `<p class="note" style="margin:6px 0 0">Confirmed against the page's own captured state: <code>${esc(c.diagnosis.verifiedText)}</code></p>` : ""}
    </div>`;

  return `
  <section class="case ${isFail ? "is-failed" : ""}">
    <div class="case-head">
      <h2>${esc(c.title)}</h2>
      <span class="verdict ${vClass}">${esc(status.replace(/_/g, " "))}</span>
    </div>
    <dl class="kv">
      ${c.whyItMatters ? `<dt>Why this matters</dt><dd>${esc(c.whyItMatters)}</dd>` : ""}
      ${c.expected ? `<dt>What should happen</dt><dd>${esc(c.expected)}</dd>` : ""}
    </dl>
    ${failHtml}
    <p class="label">Steps${steps.length ? ` (${steps.length})` : ""}${durationMs ? ` · ${esc(ms(durationMs))}` : ""}</p>
    ${stepsHtml}
  </section>`;
}

export function buildRunReportHtml(input: RunReportInput): string {
  const budget = { left: MAX_INLINE_BYTES };
  const countOf = (s: string) => input.cases.filter((c) => (c.status || "").toLowerCase() === s).length;
  const passed = countOf("passed");
  const failed = countOf("failed");
  const other = input.cases.length - passed - failed;

  const when = input.startedAt ? new Date(input.startedAt).toLocaleString() : "";
  const casesHtml = input.cases.map((c) => renderCase(c, budget)).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Test report — ${esc(input.baseUrl || input.runId)}</title>
<style>${STYLE}</style></head>
<body><div class="page">
  <header class="run">
    <h1>Test report</h1>
    ${input.baseUrl ? `<p class="sub">${esc(input.baseUrl)}</p>` : ""}
    ${input.prompt ? `<p class="sub"><b>You asked:</b> ${esc(input.prompt)}</p>` : ""}
    <div class="counts">
      <span class="count ${passed ? "c-pass" : "c-other"}">${passed} passed</span>
      <span class="count ${failed ? "c-fail" : "c-other"}">${failed} failed</span>
      ${other ? `<span class="count c-other">${other} other</span>` : ""}
    </div>
    <ul class="facts">
      ${when ? `<li><b>${esc(when)}</b></li>` : ""}
      <li>Run <b>${esc(input.runId)}</b></li>
      ${input.llmCalls ? `<li><b>${input.llmCalls}</b> AI calls</li>` : ""}
      ${input.llmTokens ? `<li><b>${Math.round(input.llmTokens / 1000)}k</b> tokens</li>` : ""}
    </ul>
  </header>
  ${casesHtml || `<section class="case"><p class="note">This run recorded no cases.</p></section>`}
  <footer>Generated from this run's own artifacts — no AI call. Screenshots are embedded, so this
  file works offline and can be sent as-is.</footer>
</div></body></html>`;
}

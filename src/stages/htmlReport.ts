import type { IR } from "../schema/ir.js";
import { extractFailureDetail } from "./executor.js";

/**
 * A readable HTML report for one case, from artifacts that already exist.
 *
 * WHY THIS EXISTS. "Download full result" handed the user `05-result.json` — Playwright's raw
 * reporter output. A QA tester's report put it plainly: opening it "the user must have vs code or
 * other IDE installed", which for a test *product* means the evidence is unreadable by the person
 * it is for. Items 1 and 6 both improved what the system KNOWS about a failure (the correct failing
 * step; honest timeouts); this is what makes that knowledge visible.
 *
 * PURE CODE, NO MODEL. Presentation over data already on disk, so it sits on `generator.ts`'s side
 * of DECISIONS.md D-06 — deterministic, reviewable, reproducible, and free to regenerate.
 *
 * SELF-CONTAINED BY CONSTRUCTION. No external CSS, no script, no font or CDN reference: the file
 * has to open from `file://` after being downloaded, with no network. Screenshots are referenced by
 * RELATIVE path (`artifacts/step-3.png`) so it works in place under `runs/<id>/…`; a downloaded
 * copy shows the text and simply has no images, which is the honest degradation — inlining 15 PNGs
 * as data URIs would turn a readable page into a multi-megabyte one.
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** ms → "1.1s" / "642ms". Durations are the one number a reader scans for. */
const ms = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
};

export interface ReportInput {
  caseId: string;
  title: string;
  /** The status the suite summary recorded — passed | failed | blocked | truncated | … */
  status?: string;
  /** Parsed `05-result.json`. */
  saved: any;
  /** Parsed `04-ir.json`, if present — gives each step its intent. Optional by design: an old run
   *  may not have one, and the report must still render. */
  ir?: IR | null;
  /** Parsed `06-diagnosis.json`, if the case failed AND a model call was made. A replay never
   *  makes one (TD-80), so its absence is normal, not an error. */
  diagnosis?: any | null;
  /** Names of files in the case's `artifacts/` dir, used to link `step-N.png`. */
  artifactFiles?: string[];
}

/**
 * The one place the page's look is defined. Deliberately plain: a report is read once, usually in
 * a hurry, often by someone who did not write the test. No theme switching, no interactivity.
 */
const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f6f7f9; color: #17181a;
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  .meta { color: #5b5f66; font-size: 13px; margin-bottom: 18px; }
  .card { background: #fff; border: 1px solid #e3e5e9; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .verdict { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; }
  .v-passed { background: #e6f5ec; color: #12653a; }
  .v-failed { background: #fdeaea; color: #8c1c1c; }
  .v-other  { background: #eef0f3; color: #44484f; }
  .fail-head { border-left: 3px solid #d14343; }
  .err { background: #f7f8fa; border: 1px solid #e3e5e9; border-radius: 8px; padding: 10px 12px;
         font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  ol.steps { list-style: none; margin: 0; padding: 0; counter-reset: s; }
  ol.steps li { counter-increment: s; border: 1px solid #e3e5e9; border-radius: 8px;
                background: #fff; padding: 10px 12px; margin-bottom: 8px; }
  ol.steps li::before { content: counter(s); display: inline-block; min-width: 22px; height: 22px;
                        line-height: 22px; text-align: center; border-radius: 6px;
                        background: #eef0f3; color: #44484f; font-size: 12px; font-weight: 600;
                        margin-right: 8px; }
  li.failed { border-color: #f0b4b4; background: #fffafa; }
  li.failed::before { background: #d14343; color: #fff; }
  .dur { float: right; color: #74787f; font-size: 12px; }
  .intent { color: #5b5f66; font-size: 13px; margin: 6px 0 0 30px; }
  figure { margin: 10px 0 0 30px; }
  figure img { max-width: 100%; border: 1px solid #e3e5e9; border-radius: 6px; display: block; }
  figcaption { color: #74787f; font-size: 12px; margin-top: 4px; }
  details { margin-top: 10px; } summary { cursor: pointer; color: #44484f; font-size: 13px; }
  .note { color: #5b5f66; font-size: 13px; }
  .tag { display: inline-block; background: #eef0f3; color: #44484f; border-radius: 5px;
         padding: 1px 7px; font-size: 12px; margin-left: 6px; }
`;

export function buildCaseReportHtml(input: ReportInput): string {
  const { caseId, title, saved, ir, diagnosis } = input;
  const files = input.artifactFiles ?? [];

  // Playwright nests the run arbitrarily deep; walk to the first result that carries steps.
  let steps: any[] = [];
  let totalMs = 0;
  const visit = (suite: any): void => {
    for (const child of suite?.suites ?? []) visit(child);
    for (const spec of suite?.specs ?? []) {
      for (const t of spec?.tests ?? []) {
        for (const r of t?.results ?? []) {
          if (!steps.length && Array.isArray(r?.steps)) steps = r.steps;
          if (Number.isFinite(r?.duration)) totalMs = Math.max(totalMs, Number(r.duration));
        }
      }
    }
  };
  for (const s of saved?.raw?.suites ?? []) visit(s);

  const detail = extractFailureDetail(saved?.raw ?? saved);
  const status = (input.status ?? (saved?.passed ? "passed" : "failed")).toLowerCase();
  const vClass = status === "passed" ? "v-passed" : status === "failed" ? "v-failed" : "v-other";

  // A step's own error wins; otherwise the one step extractFailureDetail named. Both come from the
  // report, never from prose — the same ground truth `recordedFailingStepId` uses for diagnosis.
  const failedIdx = typeof detail.failedStep === "number" ? detail.failedStep - 1 : -1;

  const stepsHtml = steps.length
    ? `<ol class="steps">${steps.map((s, i) => {
        const bad = i === failedIdx || !!s?.error;
        const shot = files.includes(`step-${i + 1}.png`) ? `artifacts/step-${i + 1}.png` : null;
        // The IR step's own action/target, when we have one — Playwright's title is the rendered
        // sentence, this is what the step was compiled to do. No `intent` on a Step: that lives on
        // the test case, not here.
        const irStep = ir?.steps?.[i];
        const sub = irStep
          ? [irStep.action, irStep.target?.name ?? irStep.target?.text ?? irStep.target?.url]
              .filter(Boolean).join(" · ")
          : "";
        return `<li class="${bad ? "failed" : ""}">` +
          `<span class="dur">${esc(ms(s?.duration))}</span>` +
          `<strong>${esc(s?.title ?? `step ${i + 1}`)}</strong>` +
          (bad ? `<span class="tag">failed here</span>` : "") +
          (sub ? `<div class="intent">${esc(sub)}</div>` : "") +
          (shot ? `<figure><img src="${esc(shot)}" alt="Screenshot after step ${i + 1}" loading="lazy" />` +
                  `<figcaption>After step ${i + 1}</figcaption></figure>` : "") +
          `</li>`;
      }).join("")}</ol>`
    : `<p class="note">No per-step record — the run ended before Playwright wrote one.</p>`;

  const failHtml = status === "passed" || !detail.error ? "" :
    `<div class="card fail-head">
      <h2 style="margin-top:0">What failed</h2>
      ${detail.failedStep ? `<p><strong>Step ${detail.failedStep}</strong>${
        detail.failedStepTitle ? ` — ${esc(detail.failedStepTitle)}` : ""}</p>` : ""}
      <div class="err">${esc(detail.error)}</div>
      ${detail.errorDetail && detail.errorDetail !== detail.error
        ? `<details><summary>Full error</summary><div class="err" style="margin-top:8px">${esc(detail.errorDetail)}</div></details>`
        : ""}
    </div>`;

  // verifiedText is kept visibly separate from the model's own words — TD-38 drew that line
  // deliberately: "the model's guess" and "independently confirmed against captured DOM state"
  // must not blur together wherever a Diagnosis is rendered.
  const diagHtml = !diagnosis ? "" :
    `<div class="card">
      <h2 style="margin-top:0">Diagnosis</h2>
      ${diagnosis.category ? `<p class="note">Category: <strong>${esc(diagnosis.category)}</strong>${
        diagnosis.failingStepId ? ` · step <strong>${esc(diagnosis.failingStepId)}</strong>` : ""}</p>` : ""}
      ${diagnosis.explanation ? `<p>${esc(diagnosis.explanation)}</p>` : ""}
      ${diagnosis.suggestedFix ? `<p><strong>Suggested fix.</strong> ${esc(diagnosis.suggestedFix)}</p>` : ""}
      ${diagnosis.verifiedText
        ? `<p class="note">Confirmed against the page's own captured state: <code>${esc(diagnosis.verifiedText)}</code></p>`
        : ""}
    </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title || caseId)} — test report</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
  <h1>${esc(title || caseId)}</h1>
  <div class="meta">
    <span class="verdict ${vClass}">${esc(status)}</span>
    ${totalMs ? `<span class="tag">${esc(ms(totalMs))}</span>` : ""}
    ${steps.length ? `<span class="tag">${steps.length} steps</span>` : ""}
    ${ir?.meta?.baseUrl ? `<span class="tag">${esc(ir.meta.baseUrl)}</span>` : ""}
  </div>
  ${failHtml}
  ${diagHtml}
  <h2>Steps</h2>
  ${stepsHtml}
  <p class="note" style="margin-top:22px">
    Generated from this run's own artifacts — no AI call. Screenshots load when this file is opened
    from inside the run folder.
  </p>
</div></body></html>`;
}

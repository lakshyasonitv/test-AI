import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatIrStep } from "../stages/stepText.js";
import { irFileForRunCase } from "./library.js";

/**
 * "Create Jira bug" (D-85): the prefilled form for one case of one run, and the record of the
 * issues created from it.
 *
 * READ FROM THE RUN'S OWN FILES, AFTER THEY WERE SCRUBBED. Every file read here was written by the
 * pipeline after its secret scrub: credentials appear as `${env:...}` references in the IR, and the
 * results and error text went through `scrubServedSecrets` when the case ran (executor.ts). So the
 * draft can only contain what the run's report already shows anyone allowed to open the run. The
 * prompt (00-input.json) is deliberately NOT copied: it is the one input a user may have typed a
 * password into.
 *
 * The draft is a starting point. The person edits or deletes any of it before anything is sent.
 */

/** The outcomes a bug can be filed for. A passed case has nothing to report. */
const REPORTABLE = new Set(["failed", "blocked", "truncated", "truncated_no_assertion"]);

const STATUS_WORDS: Record<string, string> = {
  failed: "failed",
  blocked: "couldn't finish",
  truncated: "was cut short",
  truncated_no_assertion: "ran but couldn't confirm the result",
};

const MAX_STEPS = 60;
const MAX_ERROR_CHARS = 1500;
const SUMMARY_MAX = 255;

export interface BugDraft {
  caseTitle: string;
  status: string;
  summary: string;
  description: string;
  hasScreenshot: boolean;
}

export interface FiledBug {
  key: string;
  link: string;
  siteName: string;
  createdAt: string;
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** Playwright's error text carries terminal colour codes; Jira would show them as junk. */
function plain(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

function caseOf(root: string, runId: string, caseId: string): any {
  const summary = readJson(path.join(root, runId, "07-suite-summary.json"));
  const cases: any[] = Array.isArray(summary?.cases) ? summary.cases : [];
  return cases.find((c) => c && c.caseId === caseId) ?? null;
}

/**
 * The case's screenshot file, or null. The path comes from the run's summary, so it is checked to
 * be a .png inside THIS run's directory before it is ever read — the summary is a file on disk, not
 * a promise about where it points.
 */
export function bugScreenshotFile(runId: string, caseId: string, root = "runs"): string | null {
  const c = caseOf(root, runId, caseId);
  const url = typeof c?.screenshotUrl === "string" ? c.screenshotUrl : "";
  if (!url) return null;
  const runDir = path.resolve(root, runId);
  const abs = path.resolve(url.replace(/^\/+/, ""));
  if (!abs.startsWith(runDir + path.sep) || !/\.png$/i.test(abs) || !existsSync(abs)) return null;
  return abs;
}

/** The prefilled bug for a case: null when the run has no result for it, "passed" when it passed. */
export function buildBugDraft(runId: string, caseId: string, root = "runs"): BugDraft | "passed" | null {
  const c = caseOf(root, runId, caseId);
  if (!c) return null;
  const status = String(c.status ?? "");
  if (!REPORTABLE.has(status)) return "passed";

  const title = String(c.title ?? "").trim() || "Untitled test";
  const input = readJson(path.join(root, runId, "00-input.json"));
  const url = typeof input?.url === "string" ? input.url : "";

  const irFile = irFileForRunCase(runId, caseId, root);
  const irRaw = irFile ? readJson(irFile) : null;
  const ir = irRaw?.ir ?? irRaw;
  const steps: unknown[] = Array.isArray(ir?.steps) ? ir.steps : [];

  const diagnosis = status === "failed" ? readJson(path.join(root, runId, "cases", caseId, "06-diagnosis.json")) : null;

  const what = c.whyItMatters || c.intent || "";
  const failedAt = Number.isInteger(c.failedStep)
    ? `Stopped at step ${c.failedStep}${c.failedStepTitle ? `: ${plain(c.failedStepTitle, 300)}` : ""}.`
    : "";
  const error = plain(c.errorDetail || c.error, MAX_ERROR_CHARS);

  const sections: string[] = [
    `Testbench ran an automated test${url ? ` on ${url}` : ""} and it ${STATUS_WORDS[status] ?? status}.`,
    ...(what ? [`What the test checks:\n${plain(what, 1000)}`] : []),
    ...(c.expected ? [`Expected:\n${plain(c.expected, 1000)}`] : []),
    `What happened:\n${[
      c.blockedBy ? `Couldn't finish: ${plain(c.blockedBy, 500)}.` : "",
      failedAt,
      error,
    ].filter(Boolean).join("\n") || `The test ${STATUS_WORDS[status] ?? status}.`}`,
    ...(steps.length
      ? [`Steps the test took:\n${steps.slice(0, MAX_STEPS).map((s, i) => `${i + 1}. ${formatIrStep(s as any)}`).join("\n")}` +
        (steps.length > MAX_STEPS ? `\n… and ${steps.length - MAX_STEPS} more` : "")]
      : []),
    ...(typeof diagnosis?.explanation === "string" && diagnosis.explanation.trim()
      ? [`Testbench's diagnosis (written by AI; check it before relying on it):\n${plain(diagnosis.explanation, 1500)}`]
      : []),
  ];

  const lead = status === "failed" ? "Test failed" : status === "blocked" ? "Test couldn't finish" : "Test incomplete";
  const summary = `${lead}: ${title}`.replace(/\s+/g, " ");
  return {
    caseTitle: title,
    status,
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    description: sections.join("\n\n"),
    hasScreenshot: !!bugScreenshotFile(runId, caseId, root),
  };
}

function bugsFile(root: string, runId: string, caseId: string): string {
  return path.join(root, runId, "cases", caseId, "jira-bugs.json");
}

/** The issues already created from this case, oldest first. */
export function filedBugs(runId: string, caseId: string, root = "runs"): FiledBug[] {
  const list = readJson(bugsFile(root, runId, caseId));
  return Array.isArray(list) ? list.filter((b) => b && typeof b.key === "string") : [];
}

/** Remember an issue created from this case, so the next click says "already reported". */
export function recordFiledBug(runId: string, caseId: string, bug: FiledBug, root = "runs"): void {
  const file = bugsFile(root, runId, caseId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...filedBugs(runId, caseId, root), bug], null, 2));
}

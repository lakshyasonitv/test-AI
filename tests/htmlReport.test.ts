import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunReportHtml, type ReportCase } from "../src/stages/htmlReport.js";

/**
 * The whole-run HTML report.
 *
 * WHY IT LOOKS LIKE THIS. "Download full result" used to hand over Playwright's raw reporter JSON —
 * a QA tester noted you "must have vs code or other IDE installed" to open it. The first fix
 * produced one page per CASE with screenshots linked by relative path, which meant four downloads
 * for a four-case run, each with broken images the moment the file left the run folder. One file
 * per run, with images embedded, is what makes it something you can actually send to someone.
 */

let dir: string;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "report-"));
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  writeFileSync(path.join(dir, "artifacts", "step-1.png"), PNG);
  writeFileSync(path.join(dir, "artifacts", "step-2.png"), PNG);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const raw = (steps: any[], errors: any[] = []) => ({
  suites: [{ specs: [{ ok: errors.length === 0, tests: [{ results: [{ steps, errors, duration: 4200 }] }] }] }],
});
const step = (title: string, duration = 100, error?: string) =>
  ({ title, duration, ...(error ? { error: { message: error } } : {}) });

const aCase = (over: Partial<ReportCase> = {}): ReportCase => ({
  caseId: "case-0",
  title: "Complete checkout",
  status: "passed",
  whyItMatters: "If this breaks, customers cannot buy anything.",
  expected: "The order confirmation appears.",
  saved: { passed: true, raw: raw([step("Navigate to /"), step("Click Checkout", 640)]) },
  artifactsDir: path.join(dir, "artifacts"),
  artifactFiles: ["step-1.png", "step-2.png"],
  ...over,
});

describe("buildRunReportHtml", () => {
  it("covers EVERY case in one file, with a summary at the top", () => {
    // The reported problem: four cases run, one case in the report. All of them, or it is not a
    // report of the run.
    const html = buildRunReportHtml({
      runId: "2026-09-24T10-00-00-000Z-abcd1234",
      prompt: "check this website", baseUrl: "https://qa-practice.com",
      cases: [
        aCase({ caseId: "case-0", title: "Alpha", status: "passed" }),
        aCase({ caseId: "case-1", title: "Beta", status: "failed",
                saved: { passed: false, raw: raw([step("Go", 10, "boom")], [{ message: "boom" }]) } }),
        aCase({ caseId: "case-2", title: "Gamma", status: "truncated_no_assertion" }),
        aCase({ caseId: "case-3", title: "Delta", status: "passed" }),
      ],
    });

    for (const t of ["Alpha", "Beta", "Gamma", "Delta"]) expect(html).toContain(t);
    expect(html).toContain("2 passed");
    expect(html).toContain("1 failed");
    expect(html).toContain("1 other");          // truncated_no_assertion is neither
    expect(html).toContain("check this website");
    expect(html).toContain("https://qa-practice.com");
  });

  it("EMBEDS screenshots, so the file works after it is downloaded", () => {
    // The whole point of the rewrite. A relative path shows a broken image everywhere except the
    // run folder, which is where nobody reads it.
    const html = buildRunReportHtml({ runId: "r", cases: [aCase()] });
    expect(html).toContain("data:image/png;base64,");
    expect((html.match(/data:image\/png;base64/g) ?? []).length).toBe(2);
    // Nothing may load from anywhere else — not a path, not a CDN.
    expect(html.match(/(?:src|href)="(?!data:)/g) ?? []).toHaveLength(0);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("still renders when the artifacts are gone", () => {
    // Azure clears the container filesystem on scale-to-zero, so this is the normal case for an
    // older run, not an edge case.
    const html = buildRunReportHtml({
      runId: "r", cases: [aCase({ artifactsDir: path.join(dir, "nope"), artifactFiles: ["step-1.png"] })],
    });
    expect(html).toContain("Complete checkout");
    expect(html).not.toContain("data:image/png");
  });

  it("gives a failure its step, its error and the diagnosis", () => {
    const html = buildRunReportHtml({
      runId: "r",
      cases: [aCase({
        status: "failed",
        saved: { passed: false, raw: raw(
          [step("Navigate to /"), step("Assert URL contains '/x'", 620, "Timed out 10000ms")],
          [{ message: "Timed out 10000ms waiting for expect(locator).toHaveURL(expected)\n  at line 9" }],
        ) },
        diagnosis: { category: "navigation_error", explanation: "The URL did not match.",
                     suggestedFix: "Confirm the navigation completed.", verifiedText: "Not Found" },
      })],
    });
    expect(html).toContain("Where it stopped");
    expect(html).toContain("Step 2");
    expect(html).toContain("Timed out 10000ms");
    expect(html).toContain("The URL did not match.");
    expect(html).toContain("Confirm the navigation completed.");
    expect(html).toContain("Not Found");
    expect(html).toContain("Full error");        // the rest is behind a disclosure
  });

  it("shows what each case was for, not just its verdict", () => {
    // A report read by someone who did not write the test has to say what was being checked.
    const html = buildRunReportHtml({ runId: "r", cases: [aCase()] });
    expect(html).toContain("Why this matters");
    expect(html).toContain("If this breaks, customers cannot buy anything.");
    expect(html).toContain("What should happen");
    expect(html).toContain("The order confirmation appears.");
  });

  it("ESCAPES everything page-derived — the security case", () => {
    // Case titles, step titles, error text and diagnosis prose all originate from the TESTED SITE
    // or from a model. A page whose heading is a <script> tag must not execute in the report.
    const nasty = `<script>alert('xss')</script>`;
    const html = buildRunReportHtml({
      runId: "r", prompt: nasty, baseUrl: nasty,
      cases: [aCase({
        title: nasty, whyItMatters: nasty, expected: nasty, status: "failed",
        saved: { passed: false, raw: raw([step(nasty, 10, nasty)], [{ message: nasty }]) },
        diagnosis: { explanation: nasty, suggestedFix: nasty, verifiedText: nasty },
      })],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a run with no cases rather than throwing", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [] });
    expect(html).toContain("no cases");
    expect(html).toContain("0 passed");
  });

  it("does not claim a step record it never had", () => {
    const html = buildRunReportHtml({
      runId: "r", cases: [aCase({ status: "failed", saved: { passed: false, raw: { suites: [] } } })],
    });
    expect(html).toContain("No per-step record");
  });
});

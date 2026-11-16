import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRunReportHtml, loadRunReport, type ReportCase } from "../src/stages/htmlReport.js";

/**
 * The whole-run report (HTML, and the PDF printed from it).
 *
 * WHY IT LOOKS LIKE THIS (2026-11-16). The report was called incorrect, vague and misleading: a pass
 * repeated the goal as if it had been checked, an unfinished test read "1 other", and the steps showed
 * `{{uid}}` tokens and stack traces. So: Passed / Failed / Incomplete, the checks that were ACTUALLY made
 * (on screen and in Salesforce) with real values, and the technical detail in an appendix.
 * Canary names (Zq) throughout.
 */

let dir: string;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "report-"));
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  for (let i = 1; i <= 5; i++) writeFileSync(path.join(dir, "artifacts", `step-${i}.png`), PNG);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const raw = (steps: any[], errors: any[] = [], annotations: any[] = []) => ({
  suites: [{ specs: [{ ok: errors.length === 0, tests: [{ annotations, results: [{ steps, errors, duration: 4200 }] }] }] }],
});
const step = (title: string, duration = 100, error?: string) =>
  ({ title, duration, ...(error ? { error: { message: error } } : {}) });
const shots = (html: string) => (html.match(/data:image\/png;base64/g) ?? []).length;

const aCase = (over: Partial<ReportCase> = {}): ReportCase => ({
  caseId: "case-0",
  title: "Complete checkout",
  status: "passed",
  whyItMatters: "If this breaks, customers cannot buy anything.",
  expected: "The order confirmation appears.",
  saved: { passed: true, raw: raw([step("Navigate to /"), step("Click Checkout", 640)]) },
  artifactsDir: path.join(dir, "artifacts"),
  artifactFiles: ["step-1.png", "step-2.png", "step-3.png", "step-4.png", "step-5.png"],
  ...over,
});

/** A Salesforce-shaped case: sign in, open a form, type with a run token, save, check, wait. */
const zqIr = { steps: [
  { id: "auth-0", action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } },
  { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Deal__c/new?count=1" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Big {{uid}}" },
  { id: "s3", action: "click", target: { role: "button", name: "Save" } },
  { id: "s4", action: "wait", value: "500" },
  { id: "s5", action: "assert", target: { field: "Zq Close" }, assertion: "text_contains", value: "{{date:+5:en-US}}" },
] } as any;
const zqSteps = [step("Sign in through the Salesforce org connection"), step("Navigate to https://zq.my.salesforce.com/lightning/o/Zq_Deal__c/new?count=1"),
  step("Fill 'Zq Name' with 'Zq Big {{uid}}'"), step("Click 'Save'"), step("Wait 500ms"), step("Assert 'Zq Close' contains '{{date:+5:en-US}}'")];
const tokens = { type: "run-tokens", description: JSON.stringify({ uid: "ab12cd", phone: "4155550000", now: Date.UTC(2026, 10, 15, 12) }) };

describe("buildRunReportHtml", () => {
  it("covers EVERY case in one file, with a summary at the top and three honest results", () => {
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
    expect(html).toContain("1 incomplete");     // an unfinished test is not a failure of the app
    expect(html).toContain("1 of 4 tests failed.");
    expect(html).toContain("check this website");
    expect(html).toContain("https://qa-practice.com");
    expect(html).toContain("Technical appendix");
  });

  it("EMBEDS only the key screenshots, so the file works after it is downloaded", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase({ ir: zqIr,
      saved: { passed: true, raw: raw(zqSteps, [], [tokens]) },
      artifactFiles: ["step-1.png", "step-2.png", "step-3.png", "step-4.png", "step-5.png", "step-6.png"] })] });
    // step-6.png (after the check) is not on disk here; the others are, but only a check, a failure or
    // the last step earns a screenshot.
    expect(shots(html)).toBe(0);
    const withShot = buildRunReportHtml({ runId: "r", cases: [aCase({ ir: zqIr,
      saved: { passed: true, raw: raw(zqSteps.slice(0, 5), [], [tokens]) } })] });
    expect(shots(withShot)).toBe(1);             // the last step run (step 4), not every step
    expect(withShot.match(/(?:src|href)="(?!data:)/g) ?? []).toHaveLength(0);
    expect(withShot).not.toMatch(/<script\b/i);
  });

  it("still renders when the artifacts are gone", () => {
    const html = buildRunReportHtml({
      runId: "r", cases: [aCase({ artifactsDir: path.join(dir, "nope"), artifactFiles: ["step-1.png"] })],
    });
    expect(html).toContain("Complete checkout");
    expect(html).not.toContain("data:image/png");
  });

  it("shows the run's REAL values, never {{uid}}, {{date}} or ${env:...}", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase({ ir: zqIr, saved: { passed: true, raw: raw(zqSteps, [], [tokens]) } })] });
    expect(html).toContain("Zq Big ab12cd");
    expect(html).toContain("Sign in to Salesforce");
    expect(html).toContain("Open the &quot;New Zq Deal&quot; form");
    expect(html).toContain("&quot;Zq Close&quot; shows &quot;11/20/2026&quot;");
    expect(html).not.toMatch(/\{\{|\$\{env:/);
    expect(html).not.toContain("Wait 500ms");     // waits are not steps a reader needs
  });

  it("a pass lists what was actually checked, on screen and in Salesforce", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase({ ir: zqIr, saved: { passed: true, raw: raw(zqSteps, [], [tokens]) },
      apiChecks: [{ object: "Zq_Deal__c", field: "Zq Name", expected: "Zq Big {{uid}}", actual: "Zq Big ab12cd", ok: true }] })] });
    expect(html).toContain("Checked on screen");
    expect(html).toContain("Confirmed in Salesforce");
    expect(html).toContain("Zq Deal &middot; Zq Name: expected \"Zq Big ab12cd\", Salesforce has \"Zq Big ab12cd\"");
    expect(html).toContain("1 check on screen, 1 value confirmed in Salesforce");
    // The goal is labelled as a goal, not stated as the result.
    expect(html).toContain("What this test set out to show");
  });

  it("a pass that checked nothing says so instead of implying the goal was met", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase()] });
    expect(html).toContain("made no check of the result");
  });

  it("gives a failure its step in plain words, the message, and the explanation without pipeline notes", () => {
    const html = buildRunReportHtml({
      runId: "r",
      cases: [aCase({
        status: "failed", ir: zqIr,
        saved: { passed: false, raw: raw(
          [...zqSteps.slice(0, 5), step("Assert 'Zq Close' contains '{{date:+5:en-US}}'", 620, "Error: The \"Zq Close\" field does not show it")],
          [{ message: "Error: The \"Zq Close\" field does not show it\n  589 | await x;\n  > 591 | throw y;\n    at sfFieldValue (C:\\runs\\x\\test.spec.ts:591:9)" }],
          [tokens]) },
        diagnosis: { category: "assertion_failed", explanation: "The date is shown in another format. (Note: this explanation blames \"Zq Close\", which belongs to step s9, not to s5.)",
                     suggestedFix: "Compare the date, not the words.", verifiedText: "Not Found" },
      })],
    });
    expect(html).toContain("Failed at step 6:");
    expect(html).toContain("What the test saw.");
    expect(html).toContain("The date is shown in another format.");
    expect(html).not.toContain("(Note:");
    expect(html).not.toContain("belongs to step");
    expect(html).toContain("Technical note");
    expect(html).toContain("Compare the date, not the words.");
    expect(html).not.toContain("test.spec.ts:591");  // no stack trace, no source frame
    expect(html).not.toContain("589 |");
    expect(html).toContain("(failed)");
  });

  it("an incomplete test says why, and that it is not a finding about the app", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase({ status: "truncated_no_assertion", ir: zqIr,
      saved: { passed: true, raw: raw(zqSteps.slice(0, 4), [], [tokens]) } })] });
    expect(html).toContain("Incomplete.");
    expect(html).toContain("could not work out every step");
    expect(html).toContain("not a finding about your app");
    expect(html).toContain("the last was &quot;Click &#39;Save&#39;&quot;");
    expect(html).toContain("(not reached)");     // the check it never got to
  });

  it("shows what each case was for, labelled as its goal", () => {
    const html = buildRunReportHtml({ runId: "r", cases: [aCase()] });
    expect(html).toContain("Why it matters");
    expect(html).toContain("If this breaks, customers cannot buy anything.");
    expect(html).toContain("The order confirmation appears.");
  });

  it("ESCAPES everything page-derived — the security case", () => {
    const nasty = `<script>alert('xss')</script>`;
    const html = buildRunReportHtml({
      runId: "r", prompt: nasty, baseUrl: nasty,
      cases: [aCase({
        title: nasty, whyItMatters: nasty, expected: nasty, status: "failed",
        saved: { passed: false, raw: raw([step(nasty, 10, nasty)], [{ message: nasty }]) },
        diagnosis: { explanation: nasty, suggestedFix: nasty, verifiedText: nasty },
        apiChecks: [{ object: "Zq", field: nasty, expected: nasty, actual: nasty, ok: false, note: nasty }],
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
    expect(html).toContain("No step record");
  });
});

describe("loadRunReport", () => {
  it("reads a run's summary, results, API checks and clean-up from disk", () => {
    const root = mkdtempSync(path.join(tmpdir(), "runs-"));
    const run = path.join(root, "2026-11-15T12-00-00-000Z-zq000001");
    mkdirSync(path.join(run, "cases", "case-0"), { recursive: true });
    writeFileSync(path.join(run, "07-suite-summary.json"), JSON.stringify({ cases: [{ caseId: "case-0", title: "Zq case", status: "passed", resultPath: "cases/case-0" }] }));
    writeFileSync(path.join(run, "00-input.json"), JSON.stringify({ prompt: "Zq request", url: "https://zq.example" }));
    writeFileSync(path.join(run, "11-api-checks.json"), JSON.stringify([{ case: "case-0", checks: [{ object: "Zq", field: "Name", expected: "a", actual: "a", ok: true }] }]));
    writeFileSync(path.join(run, "10-cleanup.json"), JSON.stringify({ deleted: [{}, {}], skipped: [], failed: [] }));
    writeFileSync(path.join(run, "cases", "case-0", "05-result.json"), JSON.stringify({ passed: true, raw: raw([step("Go")]) }));
    const report = loadRunReport(path.basename(run), root)!;
    expect(report.prompt).toBe("Zq request");
    expect(report.cases[0].apiChecks).toHaveLength(1);
    expect(buildRunReportHtml(report)).toContain("2 deleted from the org after the run");
    expect(loadRunReport("2026-11-15T12-00-00-000Z-nothing0", root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("HTML is the tester's copy, the PDF the short one", () => {
  it("the HTML appendix carries every step's screenshot; without the option (the PDF) only key ones", () => {
    const c = aCase({ ir: zqIr, saved: { passed: true, raw: raw(zqSteps.slice(0, 5), [], [tokens]) } });
    const html = buildRunReportHtml({ runId: "r", cases: [c] }, { everyStepScreenshot: true });
    expect(html).toContain("Screenshot after step 3");      // a fill: no key screenshot, but the tester's copy has it
    expect(shots(html)).toBe(1 + 4);                        // the key one, plus steps 1-4 (the wait, step 5, is left out)
    expect(buildRunReportHtml({ runId: "r", cases: [c] })).not.toContain("Screenshot after step");
  });
});

describe("a check's screenshot is taken the moment it passes", () => {
  it("assert steps call shot(..., true); other steps settle first", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/" } },
        { id: "s2", action: "click", target: { role: "button", name: "Zq Save" } },
        { id: "s3", action: "assert", target: { text: "was created" }, assertion: "visible" },
      ] } as any);
    expect(spec).toMatch(/step-3\.png", true\);/);
    expect(spec).toMatch(/step-2\.png"\);/);
    expect(spec).toContain("async function shot(page, path, now)");
  });
});

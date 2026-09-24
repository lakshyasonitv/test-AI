import { describe, it, expect } from "vitest";
import { buildCaseReportHtml } from "../src/stages/htmlReport.js";
import type { IR } from "../src/schema/ir.js";

/**
 * The readable HTML report that replaced handing the user Playwright's raw reporter JSON.
 *
 * WHY IT EXISTS. A QA tester's report put it plainly: to open "Download full result" the user
 * "must have vs code or other IDE installed". For a testing product, that means the evidence is
 * unreadable by the person it is produced for. Items 1 and 6 improved what the system KNOWS about
 * a failure; this is what makes it visible.
 *
 * Pure code, no model call — presentation over artifacts already on disk (D-06's side of the line),
 * so it is cheap to test exhaustively and free to regenerate.
 */

const raw = (steps: any[], errors: any[] = []) => ({
  suites: [{ specs: [{ ok: errors.length === 0, tests: [{ results: [{ steps, errors, duration: 4200 }] }] }] }],
});

const step = (title: string, duration = 100, error?: string) =>
  ({ title, duration, ...(error ? { error: { message: error } } : {}) });

const ir = (over: Partial<IR["meta"]> = {}): IR => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p",
          baseUrl: "https://shop.example", ...over },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Checkout" } },
  ],
} as unknown as IR);

const base = {
  caseId: "case-0",
  title: "Complete checkout",
  saved: { passed: true, raw: raw([step("Navigate to /"), step("Click Checkout", 640)]) },
};

describe("buildCaseReportHtml", () => {
  it("renders every step with its duration", () => {
    const html = buildCaseReportHtml({ ...base, status: "passed" });
    expect(html).toContain("Navigate to /");
    expect(html).toContain("Click Checkout");
    expect(html).toContain("640ms");
    expect((html.match(/<li class=/g) ?? []).length).toBe(2);
  });

  it("calls out the failing step, from the report rather than from prose", () => {
    // Same ground truth recordedFailingStepId uses for the diagnosis (item 1): the position of the
    // first step carrying an error, which maps 1:1 onto IR steps because generateSpec emits one
    // test.step() each.
    const html = buildCaseReportHtml({
      caseId: "case-0", title: "Checkout", status: "failed",
      saved: { passed: false, raw: raw(
        [step("Navigate to /"), step("Click Checkout", 300, "locator.click: Timeout 10000ms exceeded")],
        [{ message: "locator.click: Timeout 10000ms exceeded\n  waiting for getByRole('button')" }],
      ) },
    });
    expect(html).toContain("What failed");
    expect(html).toContain("Step 2");
    expect(html).toContain("failed here");
    expect(html).toContain("locator.click: Timeout 10000ms exceeded");
    // The first line is the summary; the rest is behind a disclosure rather than dumped inline.
    expect(html).toContain("Full error");
  });

  it("ESCAPES page-derived text — the security case", () => {
    // Step titles, error text and diagnosis prose all originate from the TESTED SITE or from a
    // model. A page whose heading is a <script> tag must not execute when someone opens the
    // report. This is the one assertion here that is not cosmetic.
    const nasty = `<script>alert('xss')</script>`;
    const html = buildCaseReportHtml({
      caseId: "case-0", title: nasty, status: "failed",
      saved: { passed: false, raw: raw([step(nasty, 10, nasty)], [{ message: nasty }]) },
      diagnosis: { category: "other", explanation: nasty, suggestedFix: nasty, verifiedText: nasty },
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links a screenshot only when the file actually exists", () => {
    const withShots = buildCaseReportHtml({ ...base, artifactFiles: ["step-1.png", "step-2.png"] });
    expect(withShots).toContain('src="artifacts/step-1.png"');
    expect(withShots).toContain('src="artifacts/step-2.png"');

    // A run whose artifacts were cleared (ephemeral storage on Azure) must still render its text.
    const without = buildCaseReportHtml({ ...base, artifactFiles: [] });
    expect(without).not.toContain("artifacts/step-");
    expect(without).toContain("Navigate to /");
  });

  it("loads nothing from the network, so it works from file://", () => {
    // Downloaded and opened offline is the whole point. Only relative screenshot paths may appear
    // as resource references; a site URL rendered as TEXT is fine.
    const html = buildCaseReportHtml({ ...base, ir: ir(), artifactFiles: ["step-1.png"] });
    for (const ref of html.match(/(?:src|href)="([^"]*)"/g) ?? []) {
      expect(ref, `external resource reference: ${ref}`).toMatch(/^(?:src|href)="artifacts\//);
    }
    expect(html).not.toMatch(/<script\b/i);
  });

  it("shows the diagnosis, keeping verifiedText visibly separate", () => {
    // TD-38 drew that line deliberately: "the model's guess" and "independently confirmed against
    // captured DOM state" must not blur together wherever a Diagnosis is rendered.
    const html = buildCaseReportHtml({
      ...base, status: "failed",
      diagnosis: { category: "element_not_found", failingStepId: "s2",
                   explanation: "The button was missing.", suggestedFix: "Wait for it.",
                   verifiedText: "Out of stock" },
    });
    expect(html).toContain("element_not_found");
    expect(html).toContain("The button was missing.");
    expect(html).toContain("Confirmed against the page");
    expect(html).toContain("Out of stock");
  });

  it("renders without an IR or a diagnosis — both are optional on an older run", () => {
    const html = buildCaseReportHtml({ ...base, ir: null, diagnosis: null });
    expect(html).toContain("Complete checkout");
    expect(html).toContain("<ol class=\"steps\">");
  });

  it("says so plainly when the run recorded no steps at all", () => {
    const html = buildCaseReportHtml({
      caseId: "case-0", title: "Crashed", status: "failed",
      saved: { passed: false, raw: { suites: [] } },
    });
    expect(html).toContain("No per-step record");
    expect(html).not.toContain("<ol class=\"steps\">");
  });

  it("uses the suite summary's honest status when it has one", () => {
    // 05-result.json only knows passed/failed; blocked and truncated_no_assertion live in the
    // summary, and rendering one of those as "failed" is the thing item 2 exists to prevent.
    const html = buildCaseReportHtml({ ...base, status: "blocked" });
    expect(html).toContain("blocked");
    expect(html).toContain("v-other");
  });
});

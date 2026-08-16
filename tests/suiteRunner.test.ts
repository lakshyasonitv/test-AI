import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSuiteSummary } from "../src/stages/suiteRunner.js";
import type { CaseRunResult } from "../src/stages/suiteRunner.js";

// Regression test for a real bug: whyItMatters was on TestCase and on CaseRunResult, but the
// summary-mapping step (the one that actually ships to the frontend as suite.cases[]) never
// copied it across at three separate results.push() call sites. Nothing caught it because
// public/preview.js hardcodes whyItMatters in its fixtures instead of exercising this mapping —
// so the UI looked correct in every screenshot while silently falling back to `intent` (the
// QA-toned text the field was added to replace) in every real run.
const baseResult = (o: Partial<CaseRunResult>): CaseRunResult =>
  ({ caseId: "case-0", title: "t", status: "passed", irPath: "irPath", resultPath: "resultPath", ...o });

describe("buildSuiteSummary", () => {
  it("carries whyItMatters from CaseRunResult through to SuiteSummary.cases[]", () => {
    const results = [baseResult({ whyItMatters: "If this breaks, real customers can't sign in.", intent: "proves login works", expected: "account page shown" })];
    const summary = buildSuiteSummary(results, "runs/fake-run");
    expect(summary.cases[0].whyItMatters).toBe("If this breaks, real customers can't sign in.");
  });

  it("still carries intent and expected (the pre-existing fields)", () => {
    const results = [baseResult({ intent: "proves login works", expected: "account page shown" })];
    const summary = buildSuiteSummary(results, "runs/fake-run");
    expect(summary.cases[0].intent).toBe("proves login works");
    expect(summary.cases[0].expected).toBe("account page shown");
  });

  it("computes per-status counts correctly", () => {
    const results = [
      baseResult({ caseId: "case-0", status: "passed" }),
      baseResult({ caseId: "case-1", status: "failed" }),
      baseResult({ caseId: "case-2", status: "blocked" }),
    ];
    const summary = buildSuiteSummary(results, "runs/fake-run");
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it("carries healed from CaseRunResult through to SuiteSummary.cases[]", () => {
    const results = [baseResult({ status: "passed", healed: true })];
    const summary = buildSuiteSummary(results, "runs/fake-run");
    expect(summary.cases[0].healed).toBe(true);
  });

  describe("screenshotUrl — real files on disk", () => {
    let runDir: string;
    afterEach(() => { if (runDir) rmSync(runDir, { recursive: true, force: true }); });

    it("prefers the healed run's screenshot over the original failed attempt's", () => {
      runDir = mkdtempSync(path.join(os.tmpdir(), "suite-summary-test-"));
      const caseDir = path.join(runDir, "cases", "case-0");
      mkdirSync(path.join(caseDir, "artifacts"), { recursive: true });
      mkdirSync(path.join(caseDir, "healed", "artifacts"), { recursive: true });
      writeFileSync(path.join(caseDir, "artifacts", "step-1.png"), "original-failure-frame");
      writeFileSync(path.join(caseDir, "healed", "artifacts", "step-1.png"), "healed-passing-frame");

      const results = [baseResult({ caseId: "case-0", status: "passed", healed: true })];
      const summary = buildSuiteSummary(results, runDir);
      // The screenshotUrl is a "/"-prefixed path relative to cwd — assert it points at the
      // healed copy, not the original.
      expect(summary.cases[0].screenshotUrl).toContain(path.join("healed", "artifacts", "step-1.png").replace(/\\/g, "/"));
    });

    it("uses the original artifacts directory when the case was never healed", () => {
      runDir = mkdtempSync(path.join(os.tmpdir(), "suite-summary-test-"));
      const caseDir = path.join(runDir, "cases", "case-0");
      mkdirSync(path.join(caseDir, "artifacts"), { recursive: true });
      writeFileSync(path.join(caseDir, "artifacts", "step-1.png"), "original-passing-frame");

      const results = [baseResult({ caseId: "case-0", status: "passed", healed: false })];
      const summary = buildSuiteSummary(results, runDir);
      expect(summary.cases[0].screenshotUrl).toContain(path.join("case-0", "artifacts", "step-1.png").replace(/\\/g, "/"));
      expect(summary.cases[0].screenshotUrl).not.toContain("healed");
    });
  });
});

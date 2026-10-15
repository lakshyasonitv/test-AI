import { describe, it, expect } from "vitest";
import { primaryCaseStatus, computeCaseStatus } from "../src/stages/suiteRunner.js";

// TD-130: the REUSED primary case of a truncated-without-assertion run showed "failed" although
// every step passed. orchestrator.ts overrides such a result to `passed: false, status:
// "truncated_no_assertion"`; computeCaseStatus read the `false` as a runtime failure.

/** Run 2026-10-15T16-39-13's shapes: 6 grounded steps, no terminal assertion, Playwright exit 0. */
const truncatedIr = { meta: { truncated: true, hasTerminalAssertion: false } };
const overridden = (exitCode: number) => ({ passed: false, status: "truncated_no_assertion", exitCode });

describe("primaryCaseStatus (the reused primary case)", () => {
  it("an override whose steps all passed is truncated_no_assertion, not failed", () => {
    expect(computeCaseStatus(truncatedIr, overridden(0), null)).toBe("failed"); // the bug, as it was
    expect(primaryCaseStatus(truncatedIr, overridden(0), null)).toBe("truncated_no_assertion");
  });

  it("a real Playwright failure on a truncated IR is still failed (TD-101 kept)", () => {
    expect(primaryCaseStatus(truncatedIr, overridden(1), null)).toBe("failed");
  });

  it("blocked still outranks everything", () => {
    expect(primaryCaseStatus(truncatedIr, overridden(0), { reason: "captcha" })).toBe("blocked");
  });

  it("anything not overridden is exactly computeCaseStatus", () => {
    const cases: [any, any][] = [
      [{ meta: {} }, { passed: true, exitCode: 0 }],
      [{ meta: {} }, { passed: false, exitCode: 1 }],
      [{ meta: { truncated: true, hasTerminalAssertion: true } }, { passed: true, exitCode: 0 }],
      // A healed result is never overridden (orchestrator: `truncatedNoAssertion && !healed`).
      [truncatedIr, { passed: true, exitCode: 0 }],
    ];
    for (const [ir, r] of cases) expect(primaryCaseStatus(ir, r, null)).toBe(computeCaseStatus(ir, r, null));
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeCaseStatus } from "../src/stages/suiteRunner.js";

/**
 * The verdict ladder — TECH_DEBT.md TD-101.
 *
 * WHAT IT WAS. The ladder checked `ir.meta.truncated` BEFORE it ever read `result.passed`, so a
 * case that genuinely failed in the browser was labelled `truncated`. Twelve lines below,
 * `passed: status === "passed" || status === "truncated"` then wrote it to `05-result.json` as
 * **passed**. A real failure was not downgraded or flagged — it was discarded.
 *
 * Observed on run `2026-09-28T05-35-47-348Z-3effa6c7`: the run banner said Failed, a diagnosis
 * existed (`failure_analysis` only runs on `!result.passed`), step 4 took 9.1s against ~900ms for
 * the same click elsewhere and was the only step in the entire run with no post-step screenshot —
 * and the summary read "2 passed, 0 failed".
 *
 * THE DISTINCTION THE FIX RESTS ON. `blocked` genuinely outranks pass/fail: a captcha is not the
 * application's fault. `truncated` does NOT, and that is where the reasoning was over-extended.
 * Truncation describes WHAT WAS BUILT — ungroundable steps were dropped. It says nothing about
 * whether the steps that ran passed. Conflating "we could not build all of it" with "what we built
 * was fine" is how a red run reports green.
 *
 * `truncated_no_assertion` still sits BELOW the failure check, not above, and still catches the
 * false positive it was built for: Playwright PASSED but the dropped tail may have held the only
 * assertion.
 */

const truncated = { meta: { truncated: true, hasTerminalAssertion: true } };
const truncatedNoAssert = { meta: { truncated: true, hasTerminalAssertion: false } };
const whole = { meta: { truncated: false, hasTerminalAssertion: true } };

const PASS = { passed: true };
const FAIL = { passed: false };

/** The accounting line both `05-result.json` writers use. If this can be true for a case that
 *  failed in the browser, the bug is back. */
const writtenAsPassed = (status: string) => status === "passed" || status === "truncated";

describe("computeCaseStatus", () => {
  it("reports a case that FAILED in the browser as failed, even when its IR was truncated", () => {
    // THE regression. Both truncation flavours, because the old ladder had two branches above
    // the failure check and either one could swallow it.
    expect(computeCaseStatus(truncated, FAIL, null)).toBe("failed");
    expect(computeCaseStatus(truncatedNoAssert, FAIL, null)).toBe("failed");
  });

  it("never writes a browser failure to disk as passed", () => {
    for (const ir of [truncated, truncatedNoAssert, whole]) {
      const status = computeCaseStatus(ir, FAIL, null);
      expect(writtenAsPassed(status), `a failed run was recorded as passed (${status})`).toBe(false);
    }
  });

  it("still labels a truncated run that PASSED as truncated — unchanged", () => {
    expect(computeCaseStatus(truncated, PASS, null)).toBe("truncated");
  });

  it("keeps truncated_no_assertion for its real case: Playwright passed, nothing was verified", () => {
    // This is the false-positive guard. It must survive the reordering — a passing run whose
    // dropped tail held the only assertion cannot be reported as a pass.
    expect(computeCaseStatus(truncatedNoAssert, PASS, null)).toBe("truncated_no_assertion");
    expect(writtenAsPassed("truncated_no_assertion")).toBe(false);
  });

  it("lets blocked outrank everything, including a failure — a wall is not the site's fault", () => {
    const blocked = { reason: "captcha", screenshot: "/s.png" };
    expect(computeCaseStatus(whole, FAIL, blocked)).toBe("blocked");
    expect(computeCaseStatus(truncatedNoAssert, PASS, blocked)).toBe("blocked");
  });

  it("is unchanged for the two ordinary outcomes", () => {
    expect(computeCaseStatus(whole, PASS, null)).toBe("passed");
    expect(computeCaseStatus(whole, FAIL, null)).toBe("failed");
  });

  it("tolerates a missing meta rather than throwing on a legacy IR", () => {
    expect(computeCaseStatus({}, PASS, null)).toBe("passed");
    expect(computeCaseStatus({ meta: {} }, FAIL, null)).toBe("failed");
  });
});

describe("the ladder exists exactly once", () => {
  const SUITE = readFileSync(new URL("../src/stages/suiteRunner.ts", import.meta.url), "utf8");
  const REPLAY = readFileSync(new URL("../src/stages/replay.ts", import.meta.url), "utf8");

  it("has no second copy left in suiteRunner or replay", () => {
    // It lived in THREE places — a closure in runSuite, an inlined copy for the reused primary
    // case, and replay.ts, whose comment said "Same verdict rules the suite runner applies, in
    // the same order". That is TD-07's shape: one rule, several copies, kept in step by hand.
    // A re-duplication would make every assertion above pass while a call site drifts.
    for (const [name, src] of [["suiteRunner", SUITE], ["replay", REPLAY]] as const) {
      expect(src, `${name} reintroduced an inline truncated-before-passed branch`)
        .not.toMatch(/truncated\s*&&\s*!\w*\.?meta\??\.?hasTerminalAssertion.*\n.*truncated\s*\?/);
      expect(src.match(/hasTerminalAssertion/g)?.length ?? 0,
        `${name} should reference hasTerminalAssertion only inside the shared ladder`)
        .toBeLessThanOrEqual(name === "suiteRunner" ? 2 : 0);
    }
  });

  it("wires all three call sites through the shared function", () => {
    expect(SUITE.match(/computeCaseStatus\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3); // decl + 2 calls
    expect(REPLAY).toContain("computeCaseStatus(c.ir, result, blocked)");
  });
});

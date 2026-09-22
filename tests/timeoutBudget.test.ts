import { describe, it, expect, afterEach } from "vitest";
import { perTestTimeoutMs, killTimeoutMs } from "../src/stages/executor.js";

/**
 * Per-test and kill timeouts: configurable, and scaled by step count.
 *
 * WHAT WAS WRONG. A 3-step case and a 25-step case both got 50s for the whole `test()`. A long
 * case can exhaust that purely by having more steps, with every individual step healthy — and it
 * surfaces as `Test timeout of 50000ms exceeded`, which `executor.ts` itself notes is the
 * CONSEQUENCE of the first error rather than a second failure.
 *
 * THE TRAP THIS ALSO GUARDS. `TEST_RUN` (100s) is a SIGKILL backstop that must stay comfortably
 * above Playwright's own per-test timeout, so the JSON reporter's `onEnd()` can still write
 * results.json. TECH_DEBT.md TD-02 measured a too-tight gap killing the child on both the attempt
 * and its retry, leaving the diagnosis with no error text — it "guessed the wrong step every
 * time". Scaling the per-test budget while leaving the kill timer at a fixed 100s would reproduce
 * that on any case long enough to pass it, which is why the backstop is derived, not fixed.
 */

const spec = (steps: number) =>
  `import { test } from "@playwright/test";\n` +
  Array.from({ length: steps }, (_, i) => `  await test.step("s${i + 1}", async () => {});`).join("\n");

const ENV = ["PLAYWRIGHT_TIMEOUT", "PLAYWRIGHT_STEP_BUDGET_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
for (const k of ENV) delete process.env[k];

describe("perTestTimeoutMs", () => {
  it("keeps the old 50s floor for short cases", () => {
    // Behaviour must be unchanged for everything that already fitted in 50s.
    expect(perTestTimeoutMs(spec(1))).toBe(50_000);
    expect(perTestTimeoutMs(spec(8))).toBe(50_000);   // 8 × 6s = 48s, still under the floor
  });

  it("scales past the floor once the step count warrants it", () => {
    expect(perTestTimeoutMs(spec(10))).toBe(60_000);
    expect(perTestTimeoutMs(spec(25))).toBe(150_000);
  });

  it("counts test.step() calls, which map one-to-one onto IR steps", () => {
    // generateSpec emits exactly one test.step() per IR step, which is why counting the text is
    // equivalent to counting the IR and needs no signature change.
    expect(perTestTimeoutMs(spec(0))).toBe(50_000);
    expect(perTestTimeoutMs("no steps here at all")).toBe(50_000);
  });

  it("an explicit PLAYWRIGHT_TIMEOUT wins outright", () => {
    // "Configurable" has to mean the operator's value is honoured, not treated as a floor.
    process.env.PLAYWRIGHT_TIMEOUT = "20000";
    expect(perTestTimeoutMs(spec(25))).toBe(20_000);   // lower than the scaled value
    process.env.PLAYWRIGHT_TIMEOUT = "300000";
    expect(perTestTimeoutMs(spec(1))).toBe(300_000);   // higher than the floor
  });

  it("ignores a junk or non-positive PLAYWRIGHT_TIMEOUT rather than producing nonsense", () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.PLAYWRIGHT_TIMEOUT = bad;
      expect(perTestTimeoutMs(spec(10)), `PLAYWRIGHT_TIMEOUT=${JSON.stringify(bad)}`).toBe(60_000);
    }
  });

  it("honours a custom per-step allowance", () => {
    process.env.PLAYWRIGHT_STEP_BUDGET_MS = "10000";
    expect(perTestTimeoutMs(spec(12))).toBe(120_000);
  });
});

describe("killTimeoutMs — the SIGKILL backstop (TD-02)", () => {
  it("stays above the per-test budget at every step count", () => {
    // The invariant that matters. If this ever inverts, the child is killed before its reporter
    // can write results.json and the diagnosis has no error text to work from.
    for (const steps of [1, 8, 10, 25, 60]) {
      const perTest = perTestTimeoutMs(spec(steps));
      expect(killTimeoutMs(spec(steps)), `${steps} steps`).toBeGreaterThan(perTest);
    }
  });

  it("preserves TD-02's 50s finalization slack", () => {
    // Trace/video finalization on a failing test was measured at 7-20MB to zip; the gap is what
    // pays for it. Kept as a difference so it survives the budget changing.
    expect(killTimeoutMs(spec(1)) - perTestTimeoutMs(spec(1))).toBe(50_000);
    expect(killTimeoutMs(spec(25)) - perTestTimeoutMs(spec(25))).toBe(50_000);
  });

  it("still clears the budget when PLAYWRIGHT_TIMEOUT is set very high", () => {
    process.env.PLAYWRIGHT_TIMEOUT = "300000";
    expect(killTimeoutMs(spec(3))).toBe(350_000);
  });
});

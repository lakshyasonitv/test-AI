import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every way the gate's round loop ends must SAY SO on screen.
 *
 * THE BUG. `runCaseSelectionGate` has four exits: the reviewer presses done, the pool fills, the
 * model stops producing anything new, and `MAX_CASE_REGEN_ATTEMPTS` is reached. Three of them
 * emitted an event the UI rendered. The fourth — `case_regen_limit_reached` — had **no handler in
 * `public/` at all**, so after the third refine the panel simply closed and the run carried on.
 *
 * From the reviewer's side that is indistinguishable from "refine is broken": they pressed a
 * button, the panel went away, and no new cases ever appeared. Reported exactly that way.
 *
 * Source-level because these handlers write into module-scope DOM handles that cannot be
 * evaluated in isolation — the same technique as `appJsTruncationMessage.test.ts`. The durable
 * assertion is that no exit is left unhandled, which is a property of the SET, not of one branch.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const GATE = readFileSync(new URL("../src/stages/caseSelectionGate.ts", import.meta.url), "utf8");

/** Strip `//` comments so a match is code, not the prose explaining it. */
const code = (s: string) =>
  s.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

const APP_CODE = code(APP);

describe("the pool cap is stated honestly", () => {
  it("reads the server's real cap, not this file's copy of the default", () => {
    // MAX_ACCUMULATED_CASES is env-configurable (`caseAccumulator.ts`). The panel used to print a
    // literal 5, so raising it on the server made the UI state the wrong limit while the server
    // enforced the right one. GET /api/runs/:runId/accepted-cases already returns
    // `remainingCapacity`, so count + remainingCapacity is the cap with no extra request.
    expect(APP_CODE).toContain("remainingCapacity");
    expect(APP_CODE).toMatch(/poolCap:\s*typeof remainingCapacity === "number"\s*\?\s*count \+ remainingCapacity/);
    expect(APP_CODE).toMatch(/const poolCap = opts\?\.poolCap \?\? CASE_POOL_CAP/);
  });

  it("warns that a full pool makes this the last round", () => {
    // Ticking every case fills the pool, and `runCaseSelectionGate` BREAKS on a full pool — so
    // refine after that does nothing at all. That trap is what "round 2 stopped working" looks
    // like from the outside, so the panel says it before the round is spent.
    expect(APP_CODE).toContain("acceptedSoFarCount >= poolCap");
    expect(APP_CODE).toContain("refining will not offer another");
  });
});

describe("gate round-loop exits are visible to the reviewer", () => {
  it("handles case_regen_limit_reached — the exit that was silent", () => {
    expect(APP_CODE).toContain('event.data?.action === "case_regen_limit_reached"');
  });

  it("says something, rather than just returning", () => {
    const i = APP_CODE.indexOf('=== "case_regen_limit_reached"');
    const branch = APP_CODE.slice(i, i + 500);
    expect(branch).toContain("showNotice");
    // The real round count rides on the event; the constant is only a fallback.
    expect(branch).toContain("event.data.attempt");
  });

  it("every action the round loop emits has a handler in the UI", () => {
    // The whole point: a NEW exit added to the gate must not be able to ship unhandled. This reads
    // the actions out of the gate itself rather than hardcoding a list that would drift.
    const emitted = new Set(
      [...code(GATE).matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(emitted.size).toBeGreaterThan(2); // guard against the regex silently matching nothing
    const unhandled = [...emitted].filter(
      (a) => a !== "case_round_resolved" && !APP_CODE.includes(`"${a}"`),
    );
    // case_round_resolved is a ledger record, not a message — it is deliberately not rendered.
    expect(unhandled, `gate emits these with no UI handler: ${unhandled.join(", ")}`).toEqual([]);
  });
});

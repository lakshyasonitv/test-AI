import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Done" at the gate must stop case GENERATION, not just the current batch.
 *
 * THE BUG, reported from a real run against qa-practice.com (5 pages discovered): the reviewer
 * picked 4 cases and pressed Done, and a second review round appeared anyway — "even after
 * selecting the test cases in round 1 why am I getting round 2… creating new test cases consumes
 * more tokens".
 *
 * It was not the refine button. Two different generations exist: the gate's own rounds, and a
 * REACTIVE generation in orchestrator.ts that fires when discovery turns up pages it had not seen
 * while the IR was being compiled. That second one ran unconditionally — it never consulted the
 * gate — then offered its output as another round via runReactiveCaseRound. By the time the user
 * saw round 2, the tokens for it had already been spent.
 *
 * The gate's stated premise is that nothing RUNS without being shown first. This is the other half:
 * nothing is GENERATED after the reviewer has said they are finished. With the gate off there is no
 * decision to contradict, so reactive generation is unchanged there.
 *
 * Source-level, because the alternative is standing up the whole orchestrator with a live model.
 * The assertion is narrow and behavioural: the reactive block must be reachable ONLY when the gate
 * was not used.
 */

const SRC = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");

/** Strip `//` comments so a search finds CODE, not the prose explaining it. */
const stripComments = (s: string) =>
  s.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

describe("the case-selection gate closes generation, not just the round", () => {
  it("guards the reactive generation on the gate NOT having been used", () => {
    const code = stripComments(SRC);
    // The block that calls generateCasesForNewPages must sit behind !gateUsed.
    expect(code).toMatch(/if\s*\(\s*!gateUsed\s*&&\s*newPages\.length\s*>\s*0\s*\)/);
    // And the unguarded form must be gone.
    expect(code).not.toMatch(/if\s*\(\s*newPages\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,400}?generateCasesForNewPages/);
  });

  it("no longer offers reactive cases as another review round", () => {
    // runReactiveCaseRound was the thing the user actually saw. With generation gated it is
    // unreachable from the orchestrator; it stays in caseSelectionGate.ts for a possible opt-in
    // return, but nothing here may call it.
    expect(stripComments(SRC)).not.toContain("runReactiveCaseRound");
  });

  it("still says what it skipped, rather than silently doing less", () => {
    // A run that found new pages and deliberately ignored them should be legible afterwards —
    // otherwise "why did it not test that page" has no answer in the event log.
    expect(SRC).toContain("gate_closed");
  });

  it("leaves reactive generation intact when the gate is OFF", () => {
    // With no gate there is no "done" to respect, and this is the behaviour every pre-gate run
    // had. Narrowing it there would be an unrelated regression.
    const code = stripComments(SRC);
    expect(code).toContain("generateCasesForNewPages");
    expect(code).toMatch(/allCases\s*=\s*\[\s*\.\.\.allCases,\s*\.\.\.reactiveCases\s*\]/);
  });
});

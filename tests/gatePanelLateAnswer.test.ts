import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Opening a finished run replays its whole event stream at once. The case-selection round draws its
 * panel only when GET /accepted-cases answers, and that answer arrived after "finalized" and "done"
 * had hidden it, so every finished run showed "Round 1 — review the test cases / Action needed"
 * (reported 2026-10-25). Both draw paths must check the round is still the open, newest one.
 */
describe("a late accepted-cases answer never redraws a closed case round", () => {
  const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  it("guards both the answer and the fallback", () => {
    expect(APP.match(/stillOpen\(\) && renderCaseSelectionPanel\(/g)?.length).toBe(2);
    expect(APP).toMatch(/const stillOpen = \(\) => caseRunId === runId && round === caseRoundSeq;/);
  });

  it("the hide that closes a round is what stillOpen reads", () => {
    const hide = APP.slice(APP.indexOf("function hideCaseSelectionPanel()"), APP.indexOf("function getCheckedCaseIndexes()"));
    expect(hide).toContain("caseRunId = null;");
  });
});

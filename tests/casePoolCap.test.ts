import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";

// The case pool holds MAX_ACCUMULATED_CASES (5). A pick past it used to be accepted by the panel and
// the route, then silently dropped by appendAcceptedCases as "did not fit — pool was full". Now the
// route refuses it (400, the route's existing { error } shape) and the panel never lets it be ticked.

const { app } = await import("../src/server/index.js");
const { awaitCaseSelection, getPendingSelection, resolveCaseSelection } = await import("../src/server/pendingCaseSelection.js");
const request = (await import("supertest")).default;

// The route checks the run-id shape (index.ts RUN_ID): a timestamp, "Z-", 8 hex digits.
const RUN = `2026-11-17T09-00-00-000Z-${Date.now().toString(16).slice(-8).padStart(8, "0")}`;
const tc = (i: number) => ({ title: `Case ${i}`, priority: "high", feature: "F", steps: ["s"], expected: "e", category: "valid" });
const batch = Array.from({ length: 8 }, (_, i) => tc(i)) as any[];

afterEach(() => {
  // Close a round a test left parked, so its timer does not hold the process open.
  if (getPendingSelection(RUN)) resolveCaseSelection(RUN, { action: "done", selectedIndexes: [0] } as any);
});

describe("POST /api/runs/:runId/case-selection refuses more cases than the pool holds", () => {
  it("6 picks with room for 5 -> 400 naming the limit, and the round stays open", async () => {
    void awaitCaseSelection(RUN, batch, 1);
    const res = await request(app).post(`/api/runs/${RUN}/case-selection`)
      .send({ action: "done", selectedIndexes: [0, 1, 2, 3, 4, 5] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 5 cases/);
    expect(getPendingSelection(RUN)).toBeTruthy();
  });

  it("5 picks -> accepted", async () => {
    const decided = awaitCaseSelection(RUN, batch, 1);
    const res = await request(app).post(`/api/runs/${RUN}/case-selection`)
      .send({ action: "done", selectedIndexes: [0, 1, 2, 3, 4] });
    expect(res.status).toBe(200);
    expect((await decided).selectedIndexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("refine with too many picks is refused the same way", async () => {
    void awaitCaseSelection(RUN, batch, 1);
    const res = await request(app).post(`/api/runs/${RUN}/case-selection`)
      .send({ action: "not_satisfied", selectedIndexes: [0, 1, 2, 3, 4, 5, 6], newPrompt: "more" });
    expect(res.status).toBe(400);
  });
});

describe("the review panel enforces the same cap", () => {
  const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  it("disables the unticked boxes once the room is used up", () => {
    const fn = APP.slice(APP.indexOf("function updateDoneButtonState()"), APP.indexOf("function refineHintEl()"));
    expect(fn).toContain("const full = getCheckedCaseIndexes().length >= gateRoomLeft();");
    expect(fn).toContain("cb.disabled = full && !cb.checked;");
  });

  it("puts back a tick past the cap, and Select all stops at it", () => {
    expect(APP).toMatch(/if \(e\.target\.checked && getCheckedCaseIndexes\(\)\.length > gateRoomLeft\(\)\) \{\r?\n\s+e\.target\.checked = false;/);
    const all = APP.slice(APP.indexOf("caseSelectAllBtnEl.addEventListener"), APP.indexOf("caseSelectNoneBtnEl.addEventListener"));
    expect(all).toContain("if (room <= 0) { skipped++; return; }");
  });

  it("refuses to send more than the room left, with the reason", () => {
    const fn = APP.slice(APP.indexOf("function gateValidationError("), APP.indexOf("async function postCaseSelectionDecision("));
    expect(fn).toContain("if (picked.size > gateRoomLeft())");
  });

  it("takes the cap from the server's numbers for this round", () => {
    expect(APP).toContain("gatePoolCap = poolCap;");
  });
});

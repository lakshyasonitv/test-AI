import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import type { TestCase } from "../src/stages/testCases.js";

const tc = (title: string, fromPrompt = false): TestCase => ({
  title, priority: "high", feature: "f", steps: ["s"], expected: "e",
  fromPrompt, category: "valid", generatedFrom: "upfront",
} as TestCase);

const { toTestCasesMock } = vi.hoisted(() => ({ toTestCasesMock: vi.fn() }));
vi.mock("../src/stages/testCases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/stages/testCases.js")>();
  return { ...actual, toTestCases: toTestCasesMock };
});

const { awaitCaseSelectionMock } = vi.hoisted(() => ({ awaitCaseSelectionMock: vi.fn() }));
vi.mock("../src/server/pendingCaseSelection.js", () => ({
  awaitCaseSelection: awaitCaseSelectionMock,
}));

const { runCaseSelectionGate, runReactiveCaseRound } = await import("../src/stages/caseSelectionGate.js");

const plan = { goal: "g", steps: [], testTypeScope: ["functional"], coverage: "standard" } as any;
const appModel = { baseUrl: "https://example.com", pages: [] } as any;

describe("runCaseSelectionGate", () => {
  const runId = "test-run-caseSelectionGate";
  afterEach(() => {
    rmSync(path.join("runs", runId), { recursive: true, force: true });
    toTestCasesMock.mockReset();
    awaitCaseSelectionMock.mockReset();
  });

  it("finalizes on the first round when the user picks and says done", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true), tc("Invalid password")]);
    awaitCaseSelectionMock.mockResolvedValueOnce({ action: "done", selectedIndexes: [0, 1] });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "test the login" });

    expect(finalCases.map((c) => c.title).sort()).toEqual(["Invalid password", "Login"]);
    expect(toTestCasesMock).toHaveBeenCalledTimes(1);
  });

  it("regenerates on 'not satisfied' and excludes the rejected title from round 2's context", async () => {
    toTestCasesMock
      .mockResolvedValueOnce([tc("Login", true), tc("Rejected case")])
      .mockResolvedValueOnce([tc("Better case")]);
    awaitCaseSelectionMock
      .mockResolvedValueOnce({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "focus on X" })
      .mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "test the login" });

    expect(finalCases.map((c) => c.title).sort()).toEqual(["Better case", "Login"]);
    expect(toTestCasesMock).toHaveBeenCalledTimes(2);
    // Round 2's extend context must carry the round-1 rejected title as a hard exclusion.
    const round2Extend = toTestCasesMock.mock.calls[1][2];
    expect(round2Extend.rejectedTitles).toContain("Rejected case");
    expect(round2Extend.latestPrompt).toBe("focus on X");
  });

  it("throws if the user never accepts a primary case", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Not primary", false)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });

    await expect(
      runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "test the login" })
    ).rejects.toThrow(/No primary case accepted/);
  });

  // Regression: a round timing out (CASE_SELECTION_WAIT_MS) resolves awaitCaseSelection with
  // {action:"done", selectedIndexes:[]} — exactly what a real timeout looks like from the
  // caller's side. With nothing ever accepted, this used to throw and crash the whole run;
  // it must now report a clean, distinguishable "nothing selected" outcome instead.
  it("reports a clean outcome, not a throw, when nothing was ever accepted (timeout)", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true), tc("Invalid password")]);
    awaitCaseSelectionMock.mockResolvedValueOnce({ action: "done", selectedIndexes: [] });

    const result = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "test the login" });

    expect(result.finalCases).toEqual([]);
    expect(result.noCasesSelected).toBe(true);
  });
});

// Regression: cases generated reactively for a page live-extend discovered during the primary
// case used to be merged into the final list silently, with no review — the gate's whole
// premise ("nothing runs without being shown to you first") only held for the upfront batch.
describe("runReactiveCaseRound", () => {
  const runId = "test-run-reactiveCaseRound";
  afterEach(() => {
    rmSync(path.join("runs", runId), { recursive: true, force: true });
    awaitCaseSelectionMock.mockReset();
  });

  it("offers reactive cases as a review round and returns only what was accepted", async () => {
    const { appendAcceptedCases } = await import("../src/server/caseAccumulator.js");
    appendAcceptedCases(runId, 1, "original prompt", [tc("Login", true)], [0]);

    awaitCaseSelectionMock.mockResolvedValueOnce({ action: "done", selectedIndexes: [1] });

    const reactive = [tc("View cart contents"), tc("Remove item from cart")];
    const accepted = await runReactiveCaseRound(runId, reactive);

    expect(accepted.map((c) => c.title)).toEqual(["Remove item from cart"]);
    expect(awaitCaseSelectionMock).toHaveBeenCalledTimes(1);
  });

  it("returns nothing and never parks a round when every reactive case was already seen", async () => {
    const { appendAcceptedCases } = await import("../src/server/caseAccumulator.js");
    appendAcceptedCases(runId, 1, "original prompt", [tc("View cart contents", true)], [0]);

    const accepted = await runReactiveCaseRound(runId, [tc("View cart contents")]);

    expect(accepted).toEqual([]);
    expect(awaitCaseSelectionMock).not.toHaveBeenCalled();
  });

  it("does not touch anything the upfront gate already accepted", async () => {
    const { appendAcceptedCases, getAllAcceptedCases } = await import("../src/server/caseAccumulator.js");
    appendAcceptedCases(runId, 1, "original prompt", [tc("Login", true)], [0]);

    awaitCaseSelectionMock.mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });
    await runReactiveCaseRound(runId, [tc("View cart contents")]);

    const all = getAllAcceptedCases(runId).map((c) => c.title);
    expect(all).toEqual(["Login", "View cart contents"]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
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
const { applyGateEdits } = await import("../src/server/gateCaseEdits.js");
const { TestCase: TestCaseSchema } = await import("../src/stages/testCases.js");
const { MAX_ACCUMULATED_CASES } = await import("../src/server/caseAccumulator.js");
const { CaseSelectionDecisionSchema } = await import("../src/schema/caseSelection.js");

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

/**
 * Editing cases AT the gate, before anything is compiled or grounded.
 *
 * These run the real gate against the real accumulator and the real ledger, with only case
 * generation and the wait-for-a-human promise mocked. That matters: the whole design claim is
 * that folding a reviewer's edits into the batch makes persistence, the pool cap and the history
 * ledger correct WITHOUT changing any of them, and only an end-to-end assertion can show that.
 */
describe("case-selection gate — reviewer edits", () => {
  const runId = "test-run-gate-edits";
  const readAccepted = () =>
    JSON.parse(readFileSync(path.join("runs", runId, "accepted-cases.json"), "utf8"));
  const readHistory = () =>
    JSON.parse(readFileSync(path.join("runs", runId, "case-history.json"), "utf8"));

  afterEach(() => {
    rmSync(path.join("runs", runId), { recursive: true, force: true });
    toTestCasesMock.mockReset();
    awaitCaseSelectionMock.mockReset();
  });

  it("persists the EDITED case, not the one the model proposed", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0],
      editedCases: [{ index: 0, title: "Login with a valid account", steps: ["Open /login", "Sign in"] }],
    });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    expect(finalCases).toHaveLength(1);
    expect(finalCases[0].title).toBe("Login with a valid account");
    expect(finalCases[0].steps).toEqual(["Open /login", "Sign in"]);
    // ...and it is what actually hit disk, not just what the function returned.
    expect(readAccepted().rounds[0].acceptedCases[0].steps).toEqual(["Open /login", "Sign in"]);
  });

  it("leaves fields the reviewer did not touch exactly as the model wrote them", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0],
      editedCases: [{ index: 0, steps: ["Only the steps changed"] }],
    });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    expect(finalCases[0].title).toBe("Login");
    expect(finalCases[0].expected).toBe("e");
    expect(finalCases[0].fromPrompt).toBe(true);
  });

  it("runs a case the reviewer wrote, and it is indistinguishable from a generated one", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0, 1],                       // index 1 is the added case, appended
      addedCases: [{
        title: "Password reset link expires",
        steps: ["Request a reset link", "Wait an hour", "Open the link"],
        expected: "The link is refused as expired",
        whyItMatters: "A stale link that still works is an account takeover.",
      }],
    });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    const mine = finalCases.find((c) => c.title === "Password reset link expires")!;
    expect(mine).toBeDefined();
    // The shape a later stage sees. No origin field exists for anything downstream to branch on,
    // and a user-written case carries exactly the keys a model-written one does. Compared against
    // the real schema rather than this file's `tc()` helper, which is a loose `as TestCase` cast
    // that omits the required `intent` and `whyItMatters` — measuring against the stub would
    // measure the stub.
    const modelShaped = TestCaseSchema.parse({
      title: "x", priority: "high", feature: "f", steps: ["s"], expected: "e",
      category: "valid", intent: "i", whyItMatters: "w",
    });
    expect(Object.keys(mine).sort()).toEqual(Object.keys(modelShaped).sort());
    expect(mine.category).toBe("functional-other");
    expect(mine.priority).toBe("medium");
    expect(mine.generatedFrom).toBe("upfront");
  });

  it("counts written cases against the pool cap", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true), tc("Second")]);
    const added = ["A", "B", "C", "D"].map((t) => ({
      title: t, steps: ["do something"], expected: "something happens",
    }));
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0, 1, 2, 3, 4, 5],           // 2 generated + 4 written = 6, cap is 5
      addedCases: added,
    });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    expect(finalCases).toHaveLength(MAX_ACCUMULATED_CASES);
    expect(readAccepted().rounds[0].overflowIndexes).toEqual([5]);
  });

  it("records the EDITED title in the history ledger, so the pool and the ledger agree", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true), tc("Throwaway")]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0],
      editedCases: [{ index: 0, title: "Renamed by the reviewer" }],
    });

    await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    const entries = readHistory().rounds[0].entries;
    const selected = entries.find((e: any) => e.status === "selected");
    expect(selected.originalTitle).toBe("Renamed by the reviewer");
    // The trade-off this pins, stated so a future change has to argue with it: the model's
    // original wording is NOT separately blocked, so a later round could propose "Login" again.
    // One record per case is the point — a second entry would let the ledger and the accepted
    // pool tell different stories about the same case.
    expect(entries.map((e: any) => e.originalTitle)).not.toContain("Login");
    // A case left unticked is still recorded as rejected, which is what stops it coming back.
    expect(entries.find((e: any) => e.originalTitle === "Throwaway").status).toBe("rejected");
  });

  it("promotes a written case to primary when the reviewer drops the model's", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Model's primary", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [1],                          // the generated primary is NOT selected
      addedCases: [{ title: "What I actually wanted", steps: ["do it"], expected: "it works" }],
    });

    // Without the promotion this throws "No primary case accepted" AFTER the reviewer has already
    // approved the round — the run would die at the finish line rather than at the gate.
    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    expect(finalCases).toHaveLength(1);
    expect(finalCases[0].title).toBe("What I actually wanted");
    expect(finalCases[0].fromPrompt).toBe(true);
  });

  it("does not promote anything when the model's primary is kept", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Model's primary", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0, 1],
      addedCases: [{ title: "Extra", steps: ["do it"], expected: "it works" }],
    });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });

    expect(finalCases.filter((c) => c.fromPrompt).map((c) => c.title)).toEqual(["Model's primary"]);
  });

  it("ignores an edit aimed at an index that is not in the batch", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Login", true)]);
    awaitCaseSelectionMock.mockResolvedValueOnce({
      action: "done",
      selectedIndexes: [0],
      editedCases: [{ index: 0, title: "Kept" }, { index: 99, title: "Nowhere" }],
    });

    // A stale client must not be able to fail a live run that a person is waiting on.
    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });
    expect(finalCases.map((c) => c.title)).toEqual(["Kept"]);
  });

  it("carries edits through a refine round too", async () => {
    toTestCasesMock
      .mockResolvedValueOnce([tc("Login", true)])
      .mockResolvedValueOnce([tc("Second round case")]);
    awaitCaseSelectionMock
      .mockResolvedValueOnce({
        action: "not_satisfied", selectedIndexes: [0], newPrompt: "more edge cases",
        editedCases: [{ index: 0, title: "Edited in round 1" }],
      })
      .mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });

    const { finalCases } = await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });
    expect(finalCases.map((c) => c.title).sort()).toEqual(["Edited in round 1", "Second round case"]);
  });
});

/**
 * The back-compatibility guarantee, pinned rather than asserted in prose: a client that predates
 * case editing sends exactly what it always sent, and gets exactly what it always got.
 */
describe("case-selection gate — an older client is unaffected", () => {
  it("accepts a payload with neither new field", () => {
    const parsed = CaseSelectionDecisionSchema.safeParse({ action: "done", selectedIndexes: [0, 2] });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ action: "done", selectedIndexes: [0, 2] });
    expect("editedCases" in (parsed.data as any)).toBe(false);
    expect("addedCases" in (parsed.data as any)).toBe(false);
  });

  it("accepts the refine payload unchanged", () => {
    const parsed = CaseSelectionDecisionSchema.safeParse({
      action: "not_satisfied", selectedIndexes: [1], newPrompt: "focus on checkout",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ action: "not_satisfied", selectedIndexes: [1], newPrompt: "focus on checkout" });
  });

  it("returns the batch UNTOUCHED when there is nothing to apply", () => {
    const batch = [tc("Login", true), tc("Other")];
    const out = applyGateEdits(batch, { action: "done", selectedIndexes: [0] }, { alreadyHasPrimary: false });
    // Identity, not deep equality. The no-edit path must not even rebuild the array: everything
    // downstream of the gate is reached through this call, so "byte-for-byte unchanged" has to be
    // a property of the code, not a coincidence of the assertions.
    expect(out).toBe(batch);
  });

  it("never mutates the batch that was already published in the round event", () => {
    const batch = [tc("Login", true)];
    const out = applyGateEdits(
      batch,
      { action: "done", selectedIndexes: [0], editedCases: [{ index: 0, title: "Changed" }] },
      { alreadyHasPrimary: false }
    );
    expect(batch[0].title).toBe("Login");      // the event log still says what was offered
    expect(out[0].title).toBe("Changed");
  });

  it("rejects a written case with no steps", () => {
    const parsed = CaseSelectionDecisionSchema.safeParse({
      action: "done", selectedIndexes: [0],
      addedCases: [{ title: "Empty", steps: [], expected: "nothing" }],
    });
    expect(parsed.success).toBe(false);
  });
});

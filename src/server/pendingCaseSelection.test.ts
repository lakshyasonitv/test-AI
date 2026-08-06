import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  awaitCaseSelection,
  resolveCaseSelection,
  getPendingSelection,
} from "./pendingCaseSelection.js";
import type { CaseSelectionDecision } from "../schema/caseSelection.js";
import type { TestCase } from "../stages/testCases.js";

const batch = [
  { id: "c1", priority: "medium", feature: "Login", title: "t", steps: ["s"], expected: "ok", fromPrompt: false, category: "functional-other", generatedFrom: "upfront" },
] as unknown as TestCase[];

const parked: string[] = [];

function newRunId(): string {
  const id = "__test-" + randomUUID();
  parked.push(id);
  return id;
}

afterEach(() => {
  for (const runId of parked) {
    resolveCaseSelection(runId, { action: "done", selectedIndexes: [] });
  }
  parked.length = 0;
  vi.useRealTimers();
});

describe("awaitCaseSelection / resolveCaseSelection", () => {
  it("resolves the parked promise on a matching runId", async () => {
    const runId = newRunId();
    const p = awaitCaseSelection(runId, batch, 1);

    const resolved = resolveCaseSelection(runId, { action: "done", selectedIndexes: [0] });

    expect(resolved).toBe(true);
    expect(await p).toEqual({ action: "done", selectedIndexes: [0] });
  });

  it("resolves with a not_satisfied decision", async () => {
    const runId = newRunId();
    const p = awaitCaseSelection(runId, batch, 1);

    const decision: CaseSelectionDecision = { action: "not_satisfied", selectedIndexes: [0], newPrompt: "Add a case" };
    expect(resolveCaseSelection(runId, decision)).toBe(true);
    expect(await p).toEqual(decision);
  });

  it("returns false for an unknown runId", () => {
    expect(resolveCaseSelection("no-such-run", { action: "done", selectedIndexes: [] })).toBe(false);
  });

  it("returns false on a double resolve", async () => {
    const runId = newRunId();
    const p = awaitCaseSelection(runId, batch, 1);

    expect(resolveCaseSelection(runId, { action: "done", selectedIndexes: [0] })).toBe(true);
    expect(resolveCaseSelection(runId, { action: "done", selectedIndexes: [] })).toBe(false);
    await p;
  });
});

describe("timeout path", () => {
  it("resolves to done with no cases after the wait elapses and clears the park", async () => {
    vi.useFakeTimers();
    const runId = newRunId();
    const p = awaitCaseSelection(runId, batch, 1);

    expect(getPendingSelection(runId)).toBeDefined();

    vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    const decision = await p;

    expect(decision).toEqual({ action: "done", selectedIndexes: [] });
    expect(getPendingSelection(runId)).toBeUndefined();
  });
});

describe("getPendingSelection", () => {
  it("reflects park then clear state", async () => {
    const runId = newRunId();

    expect(getPendingSelection(runId)).toBeUndefined();

    const p = awaitCaseSelection(runId, batch, 2);
    const parkedEntry = getPendingSelection(runId);
    expect(parkedEntry).toBeDefined();
    expect(parkedEntry!.runId).toBe(runId);
    expect(parkedEntry!.batch).toBe(batch);
    expect(parkedEntry!.attempt).toBe(2);

    resolveCaseSelection(runId, { action: "done", selectedIndexes: [] });
    expect(getPendingSelection(runId)).toBeUndefined();
    await p;
  });
});

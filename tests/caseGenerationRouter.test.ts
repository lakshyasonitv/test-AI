import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import type { TestCase } from "../src/stages/testCases.js";
import type { SpecModel } from "../src/schema/spec.js";

/**
 * The router and the gate injection (Pro tests 9 and 10).
 *
 * Both generators are mocked: these assert WHICH generator runs and with WHAT, not what it writes.
 */

const { toTestCasesMock, proTestCasesMock, awaitCaseSelectionMock } = vi.hoisted(() => ({
  toTestCasesMock: vi.fn(), proTestCasesMock: vi.fn(), awaitCaseSelectionMock: vi.fn(),
}));
vi.mock("../src/stages/testCases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/testCases.js")>()),
  toTestCases: toTestCasesMock,
}));
vi.mock("../src/stages/proTestCases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/proTestCases.js")>()),
  proTestCases: proTestCasesMock,
}));
vi.mock("../src/server/pendingCaseSelection.js", () => ({ awaitCaseSelection: awaitCaseSelectionMock }));

const { generateCases, generatorFor } = await import("../src/stages/caseGeneration.js");
const { runCaseSelectionGate } = await import("../src/stages/caseSelectionGate.js");

const tc = (title: string, fromPrompt = false): TestCase =>
  ({ title, priority: "high", feature: "f", steps: ["s"], expected: "e", fromPrompt, category: "valid", generatedFrom: "upfront" } as TestCase);
const plan = { goal: "g", steps: ["s"], testTypeScope: ["functional"], coverage: "standard" } as any;
const appModel = { baseUrl: "https://crm.example", pages: [] } as any;
const SPEC: SpecModel = {
  actors: [], entities: [], actions: [], rules: ["A Lead needs a phone number."], criteria: [],
  outOfScope: [], unresolved: [], answers: [],
};

afterEach(() => {
  toTestCasesMock.mockReset(); proTestCasesMock.mockReset(); awaitCaseSelectionMock.mockReset();
});

describe("the router picks the generator (test 10)", () => {
  it("with a spec: proTestCases, carrying the spec", async () => {
    proTestCasesMock.mockResolvedValueOnce([tc("Pro case", true)]);
    const out = await generateCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC });
    expect(out[0].title).toBe("Pro case");
    expect(toTestCasesMock).not.toHaveBeenCalled();
    expect(proTestCasesMock).toHaveBeenCalledWith(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC });
  });

  it("without a spec: toTestCases, with EXACTLY its old arguments — no `spec` key at all", async () => {
    toTestCasesMock.mockResolvedValueOnce([tc("Standard case", true)]);
    await generateCases(plan, appModel, undefined, { sourcePrompt: "p", spec: undefined });
    expect(proTestCasesMock).not.toHaveBeenCalled();
    const opts = toTestCasesMock.mock.calls[0][3];
    expect(opts).toEqual({ sourcePrompt: "p" });
    expect(Object.keys(opts)).toEqual(["sourcePrompt"]);
  });

  it("generatorFor(undefined) IS toTestCases — a standard run's gate gets the same function as before", () => {
    expect(generatorFor(undefined)).toBe(toTestCasesMock);
  });

  it("does not catch a Pro failure — it propagates, and toTestCases is never tried", async () => {
    const boom = new Error("Pro generation failed — run again without Pro. model said no");
    proTestCasesMock.mockRejectedValueOnce(boom);
    await expect(generateCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC })).rejects.toBe(boom);
    expect(toTestCasesMock).not.toHaveBeenCalled();
  });
});

describe("the gate, round 2 (test 9)", () => {
  const runId = "test-run-proGateRound2";
  afterEach(() => rmSync(path.join("runs", runId), { recursive: true, force: true }));

  it("a 'not satisfied' round regenerates WITH the spec, not only the first round", async () => {
    proTestCasesMock
      .mockResolvedValueOnce([tc("Convert with phone", true), tc("Rejected one")])
      .mockResolvedValueOnce([tc("Refuse a lead missing its number")]);
    awaitCaseSelectionMock
      .mockResolvedValueOnce({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "more on the phone rule" })
      .mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });

    const { finalCases } = await runCaseSelectionGate({
      runId, plan, appModel, sourcePrompt: "convert a lead", generate: generatorFor(SPEC),
    });

    expect(finalCases.map((c) => c.title).sort()).toEqual(["Convert with phone", "Refuse a lead missing its number"]);
    expect(toTestCasesMock).not.toHaveBeenCalled();
    expect(proTestCasesMock).toHaveBeenCalledTimes(2);
    // The point of the injection: the SECOND call still carries the document.
    const round2 = proTestCasesMock.mock.calls[1];
    expect(round2[3].spec).toBe(SPEC);
    expect(round2[2]).toMatchObject({ rejectedTitles: ["Rejected one"], latestPrompt: "more on the phone rule" });
    expect(proTestCasesMock.mock.calls[0][3].spec).toBe(SPEC);
  });

  it("with no generator injected, the gate still uses toTestCases on every round, as before", async () => {
    toTestCasesMock
      .mockResolvedValueOnce([tc("Login", true), tc("Rejected")])
      .mockResolvedValueOnce([tc("Better")]);
    awaitCaseSelectionMock
      .mockResolvedValueOnce({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "x" })
      .mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });
    await runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: "p" });
    expect(toTestCasesMock).toHaveBeenCalledTimes(2);
    expect(proTestCasesMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Module-boundary mocks, the heal.test.ts convention: the model, the browser walk, the compiler
// and the runner are stubbed; the recovery loop's own decisions run for real.
const llmMock = vi.fn();
const toIRMock = vi.fn();
const runSpecMock = vi.fn();
const analyzeFailureMock = vi.fn();
const refreshMock = vi.fn(async (model: any) => ({ model, reachedUrl: "https://x/form" }));

vi.mock("../src/llm/client.js", () => ({ llm: llmMock }));
vi.mock("../src/stages/ir.js", () => ({ toIR: toIRMock }));
vi.mock("../src/stages/executor.js", () => ({ runSpec: runSpecMock }));
vi.mock("../src/stages/liveExtend.js", () => ({ refreshPageModelAt: refreshMock }));
vi.mock("../src/stages/failureAnalysis.js", () => ({ analyzeFailure: analyzeFailureMock }));
vi.mock("../src/stages/generator.js", () => ({ generateSpec: vi.fn(() => "// generated spec") }));

const { recoverFromDrift, isDrift, describeStep, driftRecoveryEnabled } = await import("../src/stages/driftRecovery.js");
import type { Diagnosis } from "../src/stages/failureAnalysis.js";
import type { IR } from "../src/schema/ir.js";
import type { TestCase } from "../src/stages/testCases.js";
import type { AppModel } from "../src/schema/appModel.js";

const ir = (steps: any[], meta: any = {}): IR =>
  ({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x", ...meta }, steps }) as unknown as IR;

const baseIr = ir([
  { id: "s1", action: "navigate", target: { url: "/form" } },
  { id: "s2", action: "click", target: { role: "button", name: "Save" } },
  { id: "s3", action: "assert", target: { text: "Saved" }, assertion: "visible" },
]);

const diagnosis = (o: Partial<Diagnosis> = {}): Diagnosis =>
  ({ category: "element_missing", explanation: "Save button not found", suggestedFix: "", failingStepId: "s2", ...o }) as Diagnosis;

const original = (): TestCase =>
  ({ priority: "high", feature: "Form", steps: ["Open the form", "Click Save"], generatedFrom: "upfront",
     fromPrompt: true, targetUrl: "https://x/form", category: "functional-other",
     title: "Saving the form", expected: "Saved is shown", intent: "Proves saving works", whyItMatters: "w" }) as TestCase;

const revisedJson = (o: Record<string, unknown> = {}) => JSON.stringify({
  priority: "high", feature: "Form", steps: ["Open the form", "Click Submit"], expected: "Saved is shown",
  title: "Saving the form (Submit)", intent: "Proves saving works", whyItMatters: "w",
  category: "functional-other",
  // The model must not be able to change these: they are stamped from the original.
  fromPrompt: false, targetUrl: "https://evil/",
  ...o,
});

const appModel: AppModel = { baseUrl: "https://x", pages: [{ url: "https://x/form", concepts: [], elements: [] }] } as AppModel;

const passingRun = { passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} };
const failingRun = { passed: false, exitCode: 1, artifactsDir: "a", resultsJsonPath: "r", raw: {} };

describe("isDrift", () => {
  it("is true for the page-change categories, with a step before the failing one", () => {
    for (const category of ["selector_changed", "element_missing", "multiple_matches", "detached"]) {
      expect(isDrift(diagnosis({ category } as any), baseIr)).toBe(true);
    }
  });
  it("is false for findings about the app, not the page's shape", () => {
    for (const category of ["assertion_failed", "network", "navigation_error", "timeout", "other"]) {
      expect(isDrift(diagnosis({ category } as any), baseIr)).toBe(false);
    }
  });
  it("is false on the first step (nothing to walk to) and on an unknown step", () => {
    expect(isDrift(diagnosis({ failingStepId: "s1" }), baseIr)).toBe(false);
    expect(isDrift(diagnosis({ failingStepId: "nope" }), baseIr)).toBe(false);
    expect(isDrift(null, baseIr)).toBe(false);
  });
});

describe("describeStep", () => {
  it("reads as one line a tester understands", () => {
    expect(describeStep(baseIr.steps[1])).toBe('click "Save" (button)');
    expect(describeStep(baseIr.steps[0])).toBe("navigate /form");
  });
});

describe("driftRecoveryEnabled", () => {
  afterEach(() => { delete process.env.DRIFT_RECOVERY; });
  it("is off unless exactly 'true'", () => {
    expect(driftRecoveryEnabled()).toBe(false);
    process.env.DRIFT_RECOVERY = "1";
    expect(driftRecoveryEnabled()).toBe(false);
    process.env.DRIFT_RECOVERY = "true";
    expect(driftRecoveryEnabled()).toBe(true);
  });
});

describe("recoverFromDrift", () => {
  let outDir: string;
  const progress: string[] = [];
  beforeEach(() => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
    process.env.DRIFT_SETTLE_MS = "0";
    for (const m of [llmMock, toIRMock, runSpecMock, analyzeFailureMock]) m.mockReset();
    refreshMock.mockClear();
    progress.length = 0;
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    delete process.env.DRIFT_SETTLE_MS;
    delete process.env.DRIFT_MAX_ROUNDS;
  });

  const args = (ask: any, o: Record<string, unknown> = {}) => ({
    testCase: original(), ir: baseIr, appModel, diagnosis: diagnosis(),
    sourcePrompt: "test saving", entryUrl: "https://x/", outDir,
    ask, onProgress: (phase: string, round: number) => progress.push(`${round}:${phase}`), ...o,
  });

  it("re-discovers the page BEFORE asking, then rebuilds with the tester's note and accepts a passing run", async () => {
    const ask = vi.fn(async () => ({ stop: false as const, note: "Save is now called Submit" }));
    llmMock.mockResolvedValue({ content: revisedJson() });
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps) });
    runSpecMock.mockResolvedValue(passingRun);

    const out = await recoverFromDrift(args(ask));

    expect(out).not.toBeNull();
    expect(out!.rounds).toBe(1);
    expect(progress).toEqual(["1:waiting", "1:rediscovering", "1:rebuilding", "1:running"]);
    // The walk replays only the steps BEFORE the failing one.
    expect(refreshMock.mock.calls[0][1].map((s: any) => s.id)).toEqual(["s1"]);
    // The tester sees the step, why, and the page the walk reached.
    expect(ask.mock.calls[0][0]).toMatchObject({ round: 1, failingStep: 'click "Save" (button)', pageUrl: "https://x/form" });
    // Their note reaches the model.
    expect(JSON.parse(llmMock.mock.calls[0][0]).testerNote).toBe("Save is now called Submit");
    // The model cannot demote the primary or move it to another page.
    expect(out!.testCase.fromPrompt).toBe(true);
    expect(out!.testCase.targetUrl).toBe("https://x/form");
    expect(out!.testCase.steps).toEqual(["Open the form", "Click Submit"]);
    // The record of the round, under the run's own directory.
    const log = JSON.parse(readFileSync(path.join(outDir, "recovered", "drift-recovery.json"), "utf8"));
    expect(log).toEqual([expect.objectContaining({ round: 1, outcome: "passed", note: "Save is now called Submit" })]);
    expect(existsSync(path.join(outDir, "recovered", "round-1", "generated.spec.ts"))).toBe(true);
  });

  it("stops when the tester says stop — no model call, no run", async () => {
    const out = await recoverFromDrift(args(async () => ({ stop: true as const })));
    expect(out).toBeNull();
    expect(llmMock).not.toHaveBeenCalled();
    expect(runSpecMock).not.toHaveBeenCalled();
  });

  it("an empty note still rebuilds (an unattended run gets one unsteered attempt)", async () => {
    llmMock.mockResolvedValue({ content: revisedJson() });
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps) });
    runSpecMock.mockResolvedValue(passingRun);
    const out = await recoverFromDrift(args(async () => ({ stop: false as const, note: "" })));
    expect(out).not.toBeNull();
    expect(JSON.parse(llmMock.mock.calls[0][0]).testerNote).toBeNull();
  });

  it("goes round again while the failure still looks like drift, asking each time, up to the limit", async () => {
    process.env.DRIFT_MAX_ROUNDS = "2";
    const ask = vi.fn(async () => ({ stop: false as const, note: "" }));
    llmMock.mockResolvedValue({ content: revisedJson() });
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps) });
    runSpecMock.mockResolvedValue(failingRun);
    analyzeFailureMock.mockResolvedValue(diagnosis({ category: "selector_changed" }));

    expect(await recoverFromDrift(args(ask))).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toMatchObject({ round: 2, category: "selector_changed" });
    expect(runSpecMock).toHaveBeenCalledTimes(2);
  });

  it("stops at a failure that is about the app, not the page — rebuilding would hide a real finding", async () => {
    const ask = vi.fn(async () => ({ stop: false as const, note: "" }));
    llmMock.mockResolvedValue({ content: revisedJson() });
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps) });
    runSpecMock.mockResolvedValue(failingRun);
    analyzeFailureMock.mockResolvedValue(diagnosis({ category: "assertion_failed" }));

    expect(await recoverFromDrift(args(ask))).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("rejects a rebuild that cannot be grounded on the fresh page (truncated) without running it", async () => {
    llmMock.mockResolvedValue({ content: revisedJson() });
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps.slice(0, 1), { truncated: true }) });
    expect(await recoverFromDrift(args(async () => ({ stop: false as const, note: "" })))).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled();
  });

  it("rejects a rebuild that checks fewer things than the original, without running it (TD-116)", async () => {
    llmMock.mockResolvedValue({ content: revisedJson() });
    // The original has one assert; this rebuild has none.
    toIRMock.mockResolvedValue({ ir: ir(baseIr.steps.slice(0, 2)) });
    expect(await recoverFromDrift(args(async () => ({ stop: false as const, note: "" })))).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled();
  });

  it("an unusable model answer ends recovery and keeps the original failure", async () => {
    llmMock.mockResolvedValue({ content: JSON.stringify({ title: "no steps" }) });
    expect(await recoverFromDrift(args(async () => ({ stop: false as const, note: "" })))).toBeNull();
    expect(toIRMock).not.toHaveBeenCalled();
  });

  it("does nothing at all for a non-drift diagnosis", async () => {
    const ask = vi.fn();
    expect(await recoverFromDrift(args(ask, { diagnosis: diagnosis({ category: "network" }) }))).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

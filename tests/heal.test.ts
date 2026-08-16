import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Same module-boundary mocking convention as tests/irFallback.test.ts: mock the modules that
// do real work (LLM calls, browser runs, live page snapshots), let the pure logic run for real.
const toIRMock = vi.fn();
const runSpecMock = vi.fn();
const refreshPageModelMock = vi.fn(async (model: any) => model);

vi.mock("../src/stages/ir.js", () => ({ toIR: toIRMock }));
vi.mock("../src/stages/executor.js", () => ({ runSpec: runSpecMock }));
vi.mock("../src/stages/liveExtend.js", () => ({ refreshPageModel: refreshPageModelMock }));
vi.mock("../src/stages/generator.js", () => ({ generateSpec: vi.fn(() => "// generated spec") }));

const { attemptHeal, isHealable } = await import("../src/stages/heal.js");
import type { Diagnosis } from "../src/stages/failureAnalysis.js";
import type { IR } from "../src/schema/ir.js";
import type { TestCase } from "../src/stages/testCases.js";
import type { AppModel } from "../src/schema/appModel.js";

const ir = (steps: any[]): IR =>
  ({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" }, steps }) as unknown as IR;

const diagnosis = (o: Partial<Diagnosis>): Diagnosis =>
  ({ category: "element_missing", explanation: "e", suggestedFix: "f", failingStepId: "s2", ...o }) as Diagnosis;

const tc = (): TestCase =>
  ({ priority: "high", feature: "f", steps: ["s"], generatedFrom: "upfront", fromPrompt: false,
     title: "t", expected: "e", intent: "i", whyItMatters: "w" }) as TestCase;

const appModel: AppModel = { baseUrl: "https://x", pages: [{ url: "https://x/", concepts: [], elements: [] }] };

const baseIr = ir([
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "click", target: { role: "button", name: "Go" } },
  { id: "s3", action: "assert", target: { role: "button", name: "Go" }, assertion: "hidden" },
]);

describe("isHealable", () => {
  it("is true for selector_changed with a resolvable failing step", () => {
    expect(isHealable(diagnosis({ category: "selector_changed", failingStepId: "s2" }), baseIr)).toBe(true);
  });
  it("is true for element_missing with a resolvable failing step", () => {
    expect(isHealable(diagnosis({ category: "element_missing", failingStepId: "s2" }), baseIr)).toBe(true);
  });
  it("is false for any other category", () => {
    expect(isHealable(diagnosis({ category: "assertion_failed", failingStepId: "s2" }), baseIr)).toBe(false);
  });
  it("is false when the failing step is the first step (nothing to replay)", () => {
    expect(isHealable(diagnosis({ category: "element_missing", failingStepId: "s1" }), baseIr)).toBe(false);
  });
  it("is false when the failing step id doesn't exist in the IR", () => {
    expect(isHealable(diagnosis({ category: "element_missing", failingStepId: "s99" }), baseIr)).toBe(false);
  });
});

describe("attemptHeal", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "heal-test-"));
    toIRMock.mockReset();
    runSpecMock.mockReset();
  });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  const args = (o: Partial<Parameters<typeof attemptHeal>[0]> = {}) => ({
    testCase: tc(), ir: baseIr, appModel, diagnosis: diagnosis({}),
    sourcePrompt: "p", entryUrl: "https://x/", outDir, ...o,
  });

  it("returns null without calling toIR when the category isn't healable", async () => {
    const result = await attemptHeal(args({ diagnosis: diagnosis({ category: "assertion_failed" }) }));
    expect(result).toBeNull();
    expect(toIRMock).not.toHaveBeenCalled();
  });

  it("returns null when the healed IR is truncated (would ship a false-positive prefix)", async () => {
    toIRMock.mockResolvedValue({ ir: { ...baseIr, meta: { ...baseIr.meta, truncated: true } } });
    const result = await attemptHeal(args());
    expect(result).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled(); // never even tries to run a truncated heal
  });

  it("returns null when the healed run still doesn't pass", async () => {
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: false, exitCode: 1, artifactsDir: "a", resultsJsonPath: "r", raw: {} });
    const result = await attemptHeal(args());
    expect(result).toBeNull();
    // A failed heal must not leave a healed/ directory claiming success.
    expect(existsSync(path.join(outDir, "healed", "generated.spec.ts"))).toBe(false);
  });

  it("returns the healed outcome and writes healed/ir.json + healed/generated.spec.ts when it passes", async () => {
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });
    const result = await attemptHeal(args());
    expect(result).not.toBeNull();
    expect(result!.result.passed).toBe(true);
    const writtenIr = JSON.parse(readFileSync(path.join(outDir, "healed", "ir.json"), "utf8"));
    expect(writtenIr.meta.title).toBe(baseIr.meta.title);
    expect(readFileSync(path.join(outDir, "healed", "generated.spec.ts"), "utf8")).toBe("// generated spec");
  });

  it("passes the failing-step prefix to refreshPageModel, not the whole IR", async () => {
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });
    await attemptHeal(args({ diagnosis: diagnosis({ failingStepId: "s2" }) }));
    const [, prefixArg] = refreshPageModelMock.mock.calls.at(-1)!;
    expect(prefixArg).toHaveLength(1); // only s1, the step before the failing s2
    expect((prefixArg as any[])[0].id).toBe("s1");
  });
});

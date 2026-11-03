import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Module-boundary mocks, as tests/heal.test.ts: no browser, no LLM. extractFailureDetail reads the
// mocked run's `raw`, which here simply carries the next failure.
const runSpecMock = vi.fn();
const toIRMock = vi.fn();
vi.mock("../src/stages/ir.js", () => ({ toIR: toIRMock }));
vi.mock("../src/stages/liveExtend.js", () => ({ refreshPageModel: vi.fn(async (m: any) => m) }));
vi.mock("../src/stages/generator.js", () => ({ generateSpec: vi.fn((ir: any) => JSON.stringify(ir.steps.map((s: any) => s.value ?? ""))) }));
vi.mock("../src/stages/executor.js", () => ({
  runSpec: runSpecMock,
  extractFailureDetail: (raw: any) => raw ?? {},
}));

const { attemptHeal, isValueHealable } = await import("../src/stages/heal.js");

/**
 * The value heal. Runs 2026-11-03T04-29-50-846Z-c820d0e1 ("Region A") and 05-42-52-539Z-8f96a6d6
 * ("Online Campaign" on a lookup): a pick of a value the control does not offer. The error lists the
 * real options; the step takes one and the test runs again.
 */
const ir = (steps: any[]) => ({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" }, steps }) as any;
const tc = (category = "valid") => ({ title: "t", category }) as any;
const miss = (step: number, wanted: string, offered: string[]) => ({
  failedStep: step,
  errorDetail: `Error: select: no option matching ${JSON.stringify(wanted)}. Available: ${offered.map((o) => JSON.stringify(o)).join(", ")}`,
});
const diagnosis = { category: "element_missing", explanation: "e", suggestedFix: "f", failingStepId: "s3" } as any;
const steps = [
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq A" },
  { id: "s3", action: "select", target: { role: "combobox", name: "Zq Region" }, value: "Zq Area A" },
  { id: "s4", action: "select", target: { role: "combobox", name: "Zq Source", lookup: true }, value: "Zq Online" },
  { id: "s5", action: "assert", target: { text: "was created" }, assertion: "visible" },
];

describe("value heal", () => {
  let outDir: string;
  beforeEach(() => { outDir = mkdtempSync(path.join(os.tmpdir(), "vh-")); runSpecMock.mockReset(); toIRMock.mockReset(); });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  it("recognises a 'no option matching' failure, and nothing else", () => {
    expect(isValueHealable(miss(3, "Zq Area A", ["--None--", "Zq North"]))).toBe(true);
    expect(isValueHealable({ failedStep: 3, errorDetail: "TimeoutError: locator.click: Timeout 10000ms exceeded" })).toBe(false);
    expect(isValueHealable(undefined)).toBe(false);
  });

  it("swaps an invented picklist value, then an invented lookup value, and passes", async () => {
    runSpecMock
      .mockResolvedValueOnce({ passed: false, raw: { failedStep: 4, errorDetail: miss(4, "Zq Online", ["Recent Items", "New Zq Campaign 1", "New Zq Campaign"]).errorDetail } })
      .mockResolvedValueOnce({ passed: true, raw: {} });
    const out = await attemptHeal({ testCase: tc(), ir: ir(steps), appModel: {} as any, diagnosis, sourcePrompt: "Create a Zq Thing filling each and every field",
      entryUrl: "https://zq.example", outDir, failure: miss(3, "Zq Area A", ["--None--", "Zq North", "Zq South"]) });
    expect(out?.result.passed).toBe(true);
    expect(out!.ir.steps.map((s: any) => s.value)).toEqual([undefined, "Zq A", "Zq North", "", undefined]);
    expect(out!.ir.steps[4]).toEqual(steps[4]); // the conclusion is untouched
    expect(JSON.parse(readFileSync(path.join(outDir, "healed", "value-heal.json"), "utf8")).changes).toEqual([
      { step: "s3", from: "Zq Area A", to: "Zq North" },
      { step: "s4", from: "Zq Online", to: "(first record offered)" },
    ]);
    expect(toIRMock).not.toHaveBeenCalled();
  });

  it("never heals a value the request names: then the missing option is the finding", async () => {
    runSpecMock.mockResolvedValue({ passed: true, raw: {} });
    const { attemptValueHeal } = await import("../src/stages/heal.js");
    const out = await attemptValueHeal({ testCase: tc(), ir: ir(steps), appModel: {} as any, diagnosis, sourcePrompt: "Create a Zq Thing with Zq Region Zq Area A",
      entryUrl: "https://zq.example", outDir, failure: miss(3, "Zq Area A", ["Zq North"]) });
    expect(out).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled();
  });

  it("never swaps a record this test created (a run-token value) for another one", async () => {
    runSpecMock.mockResolvedValue({ passed: true, raw: {} });
    const { attemptValueHeal } = await import("../src/stages/heal.js");
    const own = steps.map((s) => s.id === "s4" ? { ...s, value: "Zq Thing {{uid}}" } : s);
    const out = await attemptValueHeal({ testCase: tc(), ir: ir(own), appModel: {} as any, diagnosis, sourcePrompt: "p",
      entryUrl: "https://zq.example", outDir, failure: miss(4, "Zq Thing 0abc12", ["Zq Other"]) });
    expect(out).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled();
  });

  it("never heals a case whose point is a bad value", async () => {
    runSpecMock.mockResolvedValue({ passed: true, raw: {} });
    const { attemptValueHeal } = await import("../src/stages/heal.js");
    const out = await attemptValueHeal({ testCase: tc("invalid-input"), ir: ir(steps), appModel: {} as any, diagnosis, sourcePrompt: "p",
      entryUrl: "https://zq.example", outDir, failure: miss(3, "Zq Area A", ["Zq North"]) });
    expect(out).toBeNull();
    expect(runSpecMock).not.toHaveBeenCalled();
  });
});

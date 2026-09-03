import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// End-to-end proof of the DETERMINISTIC_HEAL path through attemptHeal. Unlike the unit
// tests in deterministicHeal.test.ts (which call healStepTarget directly), this exercises
// the full heal entry point: attemptHeal -> attemptDeterministicHeal -> healStepTarget ->
// generateSpec -> runSpec -> artifact write, with only the genuinely-side-effecting modules
// mocked (browser run, IR LLM generation, live page snapshot). The deterministic matching
// logic runs for real against a fixture AppModel.
const runSpecMock = vi.fn();
const toIRMock = vi.fn();
const refreshPageModelMock = vi.fn(async (model: any) => model);
let generateSpecCalls: any[] = [];

vi.mock("../src/stages/executor.js", () => ({ runSpec: runSpecMock }));
vi.mock("../src/stages/ir.js", () => ({ toIR: toIRMock }));
vi.mock("../src/stages/liveExtend.js", () => ({ refreshPageModel: refreshPageModelMock }));
vi.mock("../src/stages/generator.js", () => ({
  generateSpec: (...args: any[]) => { generateSpecCalls.push(args); return "// generated spec"; },
}));

const { attemptHeal, isDeterministicHealEnabled } = await import("../src/stages/heal.js");
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

// The AppModel reflects the CURRENT site: the button that was "Submit" is now "Submit Order"
// (a prefix rename) — still discoverable via the tiered name matcher, so deterministic heal
// can find it without an LLM.
const appModel: AppModel = {
  baseUrl: "https://x",
  pages: [{
    url: "https://x/", concepts: [],
    elements: [{ role: "button", name: "Submit Order", css: "#submit-btn" }],
  }],
};

// The IR was built against the OLD name ("Submit"), which fails to resolve on the new page.
const baseIr = ir([
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "click", target: { role: "button", name: "Submit" } },
  { id: "s3", action: "assert", target: { role: "button", name: "Submit" }, assertion: "hidden" },
]);

describe("isDeterministicHealEnabled", () => {
  afterEach(() => { delete process.env.DETERMINISTIC_HEAL; });
  it("is false when DETERMINISTIC_HEAL is unset", () => {
    delete process.env.DETERMINISTIC_HEAL;
    expect(isDeterministicHealEnabled()).toBe(false);
  });
  it("is true when DETERMINISTIC_HEAL=true", () => {
    process.env.DETERMINISTIC_HEAL = "true";
    expect(isDeterministicHealEnabled()).toBe(true);
  });
  it("is false when DETERMINISTIC_HEAL=false", () => {
    process.env.DETERMINISTIC_HEAL = "false";
    expect(isDeterministicHealEnabled()).toBe(false);
  });
});

describe("attemptHeal — deterministic path", () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "detheal-e2e-"));
    process.env.DETERMINISTIC_HEAL = "true";
    runSpecMock.mockReset();
    toIRMock.mockReset();
    refreshPageModelMock.mockClear();
    generateSpecCalls = [];
  });
  afterEach(() => {
    delete process.env.DETERMINISTIC_HEAL;
    rmSync(outDir, { recursive: true, force: true });
  });

  const args = (o: Partial<Parameters<typeof attemptHeal>[0]> = {}) => ({
    testCase: tc(), ir: baseIr, appModel, diagnosis: diagnosis({}),
    sourcePrompt: "p", entryUrl: "https://x/", outDir, ...o,
  });

  it("heals a renamed element deterministically and labels the outcome deterministic", async () => {
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });

    const result = await attemptHeal(args());

    expect(result).not.toBeNull();
    expect(result!.deterministic).toBe(true);

    // The healed IR targets the CORRECTED name ("Submit Order"), not the stale "Submit".
    const healedStep = result!.ir.steps[1];
    expect(healedStep.target!.name).toBe("Submit Order");
    expect(healedStep.target!.css).toBe("#submit-btn");

    // The deterministic path must NOT call the LLM (toIR) nor re-snapshot (refreshPageModel).
    expect(toIRMock).not.toHaveBeenCalled();
    expect(refreshPageModelMock).not.toHaveBeenCalled();

    // The healed IR was regenerated into a spec and run.
    expect(generateSpecCalls.length).toBeGreaterThanOrEqual(1);
    expect(runSpecMock).toHaveBeenCalledTimes(1);
  });

  it("writes deterministic-heal.json as the forensic record of what changed", async () => {
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });

    await attemptHeal(args());

    const recordPath = path.join(outDir, "healed", "deterministic-heal.json");
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.failingStepId).toBe("s2");
    expect(record.confidence).toBe("strong"); // "Submit Order" starts with "Submit" → prefix (tier 2)
    expect(record.matchedElement.name).toBe("Submit Order");
  });

  it("falls back to the LLM path when no deterministic match is found", async () => {
    // No element in the model matches "Submit" (empty model) — deterministic returns null, so
    // attemptHeal must fall through to the expensive LLM path (toIR + refreshPageModel + re-run).
    const emptyModel: AppModel = { baseUrl: "https://x", pages: [{ url: "https://x/", concepts: [], elements: [] }] };
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });

    const result = await attemptHeal(args({ appModel: emptyModel }));

    expect(result).not.toBeNull();
    expect(result!.deterministic).toBeFalsy();
    // The LLM path called toIR and the page snapshot.
    expect(toIRMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the LLM path when the deterministic re-run fails", async () => {
    // Deterministic finds the corrected element, but the re-run fails anyway. attemptHeal must
    // then fall through to the LLM path (toIR) rather than give up — deterministic is the cheap
    // FIRST try, not the only try.
    runSpecMock.mockResolvedValueOnce({ passed: false, exitCode: 1, artifactsDir: "a", resultsJsonPath: "r", raw: {} });
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });

    const result = await attemptHeal(args());

    // The LLM-path heal succeeded after the deterministic one failed.
    expect(result).not.toBeNull();
    expect(result!.deterministic).toBeFalsy();
    expect(toIRMock).toHaveBeenCalledTimes(1);
  });

  it("with the flag off, goes straight to the LLM path (byte-identical to pre-Phase-1)", async () => {
    // When DETERMINISTIC_HEAL is unset, attemptHeal must run exactly as before: no deterministic
    // attempt, direct toIR + refreshPageModel + re-run. Even though a deterministic match EXISTS
    // in the model, the flag-off path must ignore it.
    delete process.env.DETERMINISTIC_HEAL;
    process.env.DETERMINISTIC_HEAL = "false";
    toIRMock.mockResolvedValue({ ir: baseIr });
    runSpecMock.mockResolvedValue({ passed: true, exitCode: 0, artifactsDir: "a", resultsJsonPath: "r", raw: {} });

    const result = await attemptHeal(args());

    expect(result).not.toBeNull();
    expect(result!.deterministic).toBeFalsy();
    // The LLM path ran despite a deterministic match being available — flag-off means flag-on's
    // code never executes.
    expect(toIRMock).toHaveBeenCalledTimes(1);
    expect(refreshPageModelMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(outDir, "healed", "deterministic-heal.json"))).toBe(false);
  });
});

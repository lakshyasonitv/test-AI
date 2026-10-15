import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { SpecModel } from "../src/schema/spec.js";

/**
 * A Pro run through the real orchestrator (Pro tests 11 and 12).
 *
 * Plan and discovery are mocked (no browser); the model is mocked at `gemini()` and answers by
 * STAGE, so case generation and the spec comparison can be made to fail independently. The cache
 * is an in-memory map, so nothing is served from or written to runs/_cache.
 */

const { geminiMock, planMock, discoverSiteHybridMock, discoverPagesHybridMock, awaitCaseSelectionMock, cache } =
  vi.hoisted(() => ({
    geminiMock: vi.fn(), planMock: vi.fn(), discoverSiteHybridMock: vi.fn(), discoverPagesHybridMock: vi.fn(),
    awaitCaseSelectionMock: vi.fn(), cache: new Map<string, unknown>(),
  }));
vi.mock("../src/llm/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gemini.js")>()),
  gemini: geminiMock,
}));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kb/llmCache.js")>()),
  llmCacheGet: (k: string, ns = "llm") => (cache.get(`${ns}/${k}`) as any) ?? null,
  llmCacheSet: (k: string, d: unknown, ns = "llm") => { cache.set(`${ns}/${k}`, d); },
}));
vi.mock("../src/stages/planner.js", () => ({ plan: planMock }));
vi.mock("../src/stages/hybridDiscovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/hybridDiscovery.js")>()),
  discoverSiteHybrid: discoverSiteHybridMock,
  discoverPagesHybrid: discoverPagesHybridMock,
}));
vi.mock("../src/server/pendingCaseSelection.js", () => ({ awaitCaseSelection: awaitCaseSelectionMock }));

const { runPipeline } = await import("../src/orchestrator.js");
const { getRunSpecWarnings } = await import("../src/stages/specIntake.js");
const { PRO_FAILURE_PREFIX } = await import("../src/stages/proTestCases.js");

const URL = "https://crm.example";
const PLAN = { goal: "g", steps: ["convert a lead"], testTypeScope: ["functional"], coverage: "standard" };
const APPMODEL = {
  baseUrl: URL,
  pages: [{ url: URL, title: "Leads", concepts: ["Leads"], elements: [{ role: "button", name: "Convert" }] }],
};
const SPEC: SpecModel = {
  actors: [], entities: ["Lead"], actions: [], rules: ["A Lead cannot convert without a phone number."],
  criteria: [], outOfScope: ["Refunds"], unresolved: [], answers: [],
};
const CASES = [{
  title: "Convert a lead", priority: "high", feature: "Leads", fromPrompt: true, category: "valid",
  intent: "i", whyItMatters: "w", targetUrl: URL, steps: ["Click the 'Convert' button."], expected: "e",
}];
const ok = (o: unknown) => ({ content: JSON.stringify(o), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

/** Route the mocked model by stage: generation and comparison are controlled separately. */
function modelAnswers(byStage: Record<string, () => Promise<unknown>>) {
  geminiMock.mockImplementation((_prompt: string, opts: any) => {
    const h = byStage[opts.stage];
    if (!h) throw new Error(`unexpected model call for stage ${opts.stage}`);
    return h();
  });
}

let runId = "";
beforeEach(() => {
  runId = `test-run-pro-${Math.random().toString(16).slice(2, 10)}`;
  cache.clear();
  planMock.mockResolvedValue(PLAN);
  discoverSiteHybridMock.mockResolvedValue(APPMODEL);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(path.join("runs", runId), { recursive: true, force: true });
  geminiMock.mockReset(); planMock.mockReset(); discoverSiteHybridMock.mockReset();
  discoverPagesHybridMock.mockReset(); awaitCaseSelectionMock.mockReset();
  vi.restoreAllMocks();
});

describe("a Pro generation failure FAILS the run — no fallback (test 11)", () => {
  it("an unusable answer ends the run with the Pro message, and the standard generator is never asked", async () => {
    modelAnswers({
      testcases: async () => ({ content: "not json", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      spec_compare: async () => ok({ gaps: [] }),
    });
    const events: any[] = [];
    const err = await runPipeline({ prompt: "convert a lead", url: URL, options: { spec: SPEC } }, (e) => events.push(e), runId)
      .catch((e) => e);

    expect(String(err?.message)).toContain(PRO_FAILURE_PREFIX);
    const failed = events.filter((e) => e.stage === "testcases" && e.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error.startsWith(PRO_FAILURE_PREFIX)).toBe(true);
    // Every generation call was the Pro one — its prompt carries the spec. A fallback to
    // toTestCases would have shown up as a testcases call WITHOUT it.
    const genCalls = geminiMock.mock.calls.filter(([, o]) => o.stage === "testcases");
    expect(genCalls).toHaveLength(2); // the two attempts of ONE generator
    for (const [prompt] of genCalls) expect(prompt).toContain("A Lead cannot convert without a phone number.");
    expect(events.some((e) => e.stage === "done")).toBe(false);
  });

  it("an empty answer is still the typed no-cases failure: raw response saved, Pro message shown", async () => {
    modelAnswers({ testcases: async () => ok([]), spec_compare: async () => ok({ gaps: [] }) });
    const events: any[] = [];
    await expect(runPipeline({ prompt: "convert a lead", url: URL, options: { spec: SPEC } }, (e) => events.push(e), runId))
      .rejects.toThrow(PRO_FAILURE_PREFIX);
    expect(readFileSync(path.join("runs", runId, "03-cases-raw.txt"), "utf8")).toBe("[]");
  });
});

describe("a comparison failure does NOT fail the run (test 12)", () => {
  it("the comparison throws; the run still generates Pro cases and ends cleanly", async () => {
    modelAnswers({
      testcases: async () => ok(CASES),
      spec_compare: async () => { throw new Error("Gemini 503: overloaded"); },
    });
    // Stop the run cleanly right after generation: the review gate times out with nothing picked
    // (the documented no_cases_selected outcome), so no browser stage is reached.
    awaitCaseSelectionMock.mockResolvedValue({ action: "done", selectedIndexes: [] });

    const events: any[] = [];
    await runPipeline(
      { prompt: "convert a lead", url: URL, options: { spec: SPEC, gateReview: true } },
      (e) => events.push(e), runId, async () => ({}) as any,
    );

    expect(events.filter((e) => e.status === "failed")).toEqual([]);
    expect(events.find((e) => e.stage === "done")?.data?.status).toBe("no_cases_selected");
    await vi.waitFor(() => expect(getRunSpecWarnings(runId)).toEqual({ warnings: [], done: true }));
    // And the gate's round used the Pro generator.
    const gen = geminiMock.mock.calls.find(([, o]) => o.stage === "testcases");
    expect(gen?.[0]).toContain("A Lead cannot convert without a phone number.");
  });

  it("a successful comparison's warnings are served for the run — and never written to runs/", async () => {
    modelAnswers({
      testcases: async () => ok(CASES),
      spec_compare: async () => ok({ gaps: [{ kind: "untestable_rule", rule: 1, message: "A rule about the phone number can't be tested — no phone field was found." }] }),
    });
    awaitCaseSelectionMock.mockResolvedValue({ action: "done", selectedIndexes: [] });
    await runPipeline({ prompt: "convert a lead", url: URL, options: { spec: SPEC, gateReview: true } }, () => {}, runId, async () => ({}) as any);
    await vi.waitFor(() => expect(getRunSpecWarnings(runId).done).toBe(true));
    expect(getRunSpecWarnings(runId).warnings).toEqual(["A rule about the phone number can't be tested — no phone field was found."]);
    expect(existsSync(path.join("runs", runId, "02b-spec-warnings.json"))).toBe(false);
  });
});

describe("a standard run is untouched", () => {
  it("no spec: no comparison call, no warnings recorded, the standard prompt", async () => {
    modelAnswers({ testcases: async () => ok(CASES) });
    awaitCaseSelectionMock.mockResolvedValue({ action: "done", selectedIndexes: [] });
    await runPipeline({ prompt: "convert a lead", url: URL, options: { gateReview: true } }, () => {}, runId, async () => ({}) as any);
    expect(geminiMock.mock.calls.some(([, o]) => o.stage === "spec_compare")).toBe(false);
    expect(getRunSpecWarnings(runId)).toEqual({ warnings: [], done: false });
    const [prompt, opts] = geminiMock.mock.calls.find(([, o]) => o.stage === "testcases")!;
    expect(prompt).not.toContain("Requirements specification");
    expect(opts.systemInstruction).not.toContain("REQUIREMENTS SPECIFICATION");
  });
});

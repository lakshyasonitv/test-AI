import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * D-73 — a run's suite cases may build and execute several at a time (SUITE_CASE_CONCURRENCY),
 * under one process-wide cap (MAX_PARALLEL_CASES). The real runSuite, with the stages that need a
 * model or a browser mocked: toIR, runSpec, analyzeFailure, attemptHeal. Each mock records how many
 * cases are inside it at once, so "at most N in flight" is measured, not assumed.
 */

const { toIRMock, runSpecMock, attemptHealMock, live } = vi.hoisted(() => ({
  toIRMock: vi.fn(), runSpecMock: vi.fn(), attemptHealMock: vi.fn(),
  live: { now: 0, max: 0 },
}));
vi.mock("../src/stages/ir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/ir.js")>()), toIR: toIRMock,
}));
vi.mock("../src/stages/executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/executor.js")>()),
  runSpec: runSpecMock, detectBlocked: () => null,
}));
vi.mock("../src/stages/failureAnalysis.js", () => ({
  analyzeFailure: async () => ({ failingStepId: "s2", category: "element_missing", explanation: "e", suggestedFix: "f" }),
}));
vi.mock("../src/stages/heal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/heal.js")>()),
  attemptHeal: attemptHealMock, isHealable: () => true, isValueHealable: () => false,
}));

const { runSuite, forEachInOrder, maxParallelCases, suiteCaseConcurrency, _resetCaseSlots } =
  await import("../src/stages/suiteRunner.js");
const { LlmBudget } = await import("../src/llm/llmBudget.js");
const { generateSpec } = await import("../src/stages/generator.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = { baseUrl: "https://zq.example", pages: [] } as any;
const tcase = (i: number) => ({ title: `Zq case ${i}`, intent: "i", expected: "e", whyItMatters: "w", category: "valid", priority: "high" }) as any;
const irFor = (title: string) => ({
  meta: { feature: "f", title, priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
  steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
});

/** Runs `fn` as "one case inside a stage", tracking how many are inside at once. */
async function inside<T>(ms: number, fn: () => T): Promise<T> {
  live.now++; live.max = Math.max(live.max, live.now);
  try { await sleep(ms); return fn(); } finally { live.now--; }
}

const ENV = ["SUITE_CASE_CONCURRENCY", "MAX_PARALLEL_CASES", "MAX_CONCURRENT_RUNS", "MAX_SUITE_HEALS"];
const saved: Record<string, string | undefined> = {};
let dirs: string[] = [];
const newRunDir = () => {
  const d = path.join("runs", `test-suite-parallel-${Math.random().toString(16).slice(2, 10)}`);
  dirs.push(d);
  return d;
};
const startedOrder = (runDir: string) => readFileSync(path.join(runDir, "events.ndjson"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l)).filter((e) => e.stage === "suite" && e.status === "started" && e.data?.caseId && !e.data.healing)
  .map((e) => e.data.caseId);

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  _resetCaseSlots();
  live.now = 0; live.max = 0;
  // Later cases are FASTER, so with concurrency they finish out of order.
  toIRMock.mockImplementation(async (tc: any) => {
    const i = Number(tc.title.split(" ").pop());
    return inside(20 + (5 - i) * 10, () => ({ ir: irFor(tc.title), updatedAppModel: APP }));
  });
  runSpecMock.mockImplementation(async (_spec: string, caseDir: string) =>
    inside(10, () => ({ passed: true, exitCode: 0, artifactsDir: path.join(caseDir, "artifacts"), resultsJsonPath: "", raw: null })));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  toIRMock.mockReset(); runSpecMock.mockReset(); attemptHealMock.mockReset();
  vi.restoreAllMocks();
});

describe("settings", () => {
  it("SUITE_CASE_CONCURRENCY defaults to 1, is floored, capped at 8, and ignores garbage", () => {
    expect(suiteCaseConcurrency()).toBe(1);
    process.env.SUITE_CASE_CONCURRENCY = "4"; expect(suiteCaseConcurrency()).toBe(4);
    process.env.SUITE_CASE_CONCURRENCY = "2.9"; expect(suiteCaseConcurrency()).toBe(2);
    process.env.SUITE_CASE_CONCURRENCY = "50"; expect(suiteCaseConcurrency()).toBe(8);
    process.env.SUITE_CASE_CONCURRENCY = "0"; expect(suiteCaseConcurrency()).toBe(1);
    process.env.SUITE_CASE_CONCURRENCY = "four"; expect(suiteCaseConcurrency()).toBe(1);
  });

  it("MAX_PARALLEL_CASES defaults to MAX_CONCURRENT_RUNS, then to 3", () => {
    expect(maxParallelCases()).toBe(3);
    process.env.MAX_CONCURRENT_RUNS = "4"; expect(maxParallelCases()).toBe(4);
    process.env.MAX_PARALLEL_CASES = "2"; expect(maxParallelCases()).toBe(2);
  });
});

describe("forEachInOrder", () => {
  it("limit 1 is a plain sequential loop", async () => {
    const log: string[] = [];
    await forEachInOrder(3, 1, async (i) => { log.push(`start ${i}`); await sleep(5); log.push(`end ${i}`); });
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
  });

  it("starts in index order, never more than the limit at once, and handles zero items", async () => {
    const started: number[] = [];
    let now = 0, max = 0;
    await forEachInOrder(7, 3, async (i) => {
      started.push(i); now++; max = Math.max(max, now);
      await sleep(30 - i * 3); now--;
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(max).toBe(3);
    await forEachInOrder(0, 4, async () => { throw new Error("never called"); });
  });

  it("an escaped error is rethrown only after the other workers have finished", async () => {
    const finished: number[] = [];
    const run = forEachInOrder(4, 2, async (i) => {
      if (i === 0) throw new Error("boom");
      await sleep(20); finished.push(i);
    });
    await expect(run).rejects.toThrow("boom");
    // Worker A stopped at 0; worker B went on to take 1, 2 and 3 before the error surfaced.
    expect(finished).toEqual([1, 2, 3]);
  });
});

describe("runSuite", () => {
  it("flag off (unset): one case at a time, in order — the loop it replaced", async () => {
    const runDir = newRunDir();
    const results = await runSuite([0, 1, 2, 3].map(tcase), APP, runDir, "p", "https://zq.example");
    expect(live.max).toBe(1);
    expect(results.map((r) => r.title)).toEqual(["Zq case 0", "Zq case 1", "Zq case 2", "Zq case 3"]);
    expect(results.every((r) => r.status === "passed")).toBe(true);
    expect(startedOrder(runDir)).toEqual(["case-0", "case-1", "case-2", "case-3"]);
  });

  it("SUITE_CASE_CONCURRENCY=3: three at once, results and summary still in the suite's order", async () => {
    process.env.SUITE_CASE_CONCURRENCY = "3";
    const runDir = newRunDir();
    const results = await runSuite([0, 1, 2, 3, 4].map(tcase), APP, runDir, "p", "https://zq.example");
    expect(live.max).toBe(3);
    expect(results.map((r) => r.caseId)).toEqual(["case-0", "case-1", "case-2", "case-3", "case-4"]);
    expect(results.map((r) => r.title)).toEqual([0, 1, 2, 3, 4].map((i) => `Zq case ${i}`));
    const summary = JSON.parse(readFileSync(path.join(runDir, "07-suite-summary.json"), "utf8"));
    expect(summary.cases.map((c: any) => c.caseId)).toEqual(["case-0", "case-1", "case-2", "case-3", "case-4"]);
    expect(summary.passed).toBe(5);
    // app.js gives each "started" event the next pending row, so starts must stay in order.
    expect(startedOrder(runDir)).toEqual(["case-0", "case-1", "case-2", "case-3", "case-4"]);
  });

  it("MAX_PARALLEL_CASES caps cases across runs: two runs wanting 4 each share 2 slots", async () => {
    process.env.SUITE_CASE_CONCURRENCY = "4";
    process.env.MAX_PARALLEL_CASES = "2";
    const [a, b] = await Promise.all([
      runSuite([0, 1, 2, 3].map(tcase), APP, newRunDir(), "p", "https://zq.example"),
      runSuite([0, 1, 2, 3].map(tcase), APP, newRunDir(), "p", "https://zq.example"),
    ]);
    expect(live.max).toBe(2);
    expect([...a, ...b].every((r) => r.status === "passed")).toBe(true);
  });

  it("each case's llmCalls/llmTokens are its own, even while cases overlap", async () => {
    process.env.SUITE_CASE_CONCURRENCY = "4";
    toIRMock.mockImplementation(async (tc: any, _m: any, _p: any, _u: any, budget: InstanceType<typeof LlmBudget>) => {
      const i = Number(tc.title.split(" ").pop());
      for (let k = 0; k <= i; k++) {   // case i makes i+1 calls of 10 tokens, interleaved with the others
        await sleep(3);
        budget.record("ir", { promptTokens: 6, completionTokens: 4 }, "azure");
      }
      return { ir: irFor(tc.title), updatedAppModel: APP };
    });
    const budget = new LlmBudget();
    const results = await runSuite([0, 1, 2, 3].map(tcase), APP, newRunDir(), "p", "https://zq.example", undefined, undefined, budget);
    expect(results.map((r) => r.llmCalls)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.llmTokens)).toEqual([10, 20, 30, 40]);
    expect(budget.snapshot().calls).toBe(10);
  });

  it("the suite-wide heal budget holds when every case fails at once", async () => {
    process.env.SUITE_CASE_CONCURRENCY = "4";
    process.env.MAX_SUITE_HEALS = "1";
    runSpecMock.mockImplementation(async (_s: string, caseDir: string) =>
      inside(10, () => ({ passed: false, exitCode: 1, artifactsDir: path.join(caseDir, "artifacts"), resultsJsonPath: "", raw: null })));
    attemptHealMock.mockResolvedValue(null);
    const results = await runSuite([0, 1, 2, 3].map(tcase), APP, newRunDir(), "p", "https://zq.example", undefined, undefined, undefined, undefined, true);
    expect(attemptHealMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "failed")).toBe(true);
  });

  it("a case that throws fails in its own slot; the cases beside it still run", async () => {
    process.env.SUITE_CASE_CONCURRENCY = "3";
    const base = toIRMock.getMockImplementation()!;
    toIRMock.mockImplementation(async (tc: any, ...rest: any[]) => {
      if (tc.title === "Zq case 1") throw new Error("could not compile");
      return base(tc, ...rest);
    });
    const results = await runSuite([0, 1, 2].map(tcase), APP, newRunDir(), "p", "https://zq.example");
    expect(results.map((r) => r.status)).toEqual(["passed", "failed", "passed"]);
    expect(results[1].title).toBe("Zq case 1");
  });
});

describe("run tokens in the generated spec", () => {
  it("are random per spec run, not derived from the clock, so two cases starting together differ", () => {
    const spec = generateSpec({
      meta: { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/new" } },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name", css: "#n" }, value: "Zq Smith {{uid}} {{phone}}" },
      ],
    } as any);
    const decl = spec.match(/const RUN_CTX = [^;]+;/)?.[0];
    expect(decl).toBeTruthy();
    const ctxs = Array.from({ length: 20 }, () => new Function(`${decl} return RUN_CTX;`)() as { uid: string; phone: string });
    for (const c of ctxs) {
      expect(c.uid).toMatch(/^[a-z0-9]{6}$/);
      expect(c.phone).toMatch(/^415555[0-9]{4}$/);
    }
    // 20 contexts made within the same few milliseconds: a clock-derived uid would repeat.
    expect(new Set(ctxs.map((c) => c.uid)).size).toBeGreaterThan(15);
  });
});

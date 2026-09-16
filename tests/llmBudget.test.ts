import { describe, it, expect } from "vitest";
import { LlmBudget, enterWithBudget, recordAmbient } from "../src/llm/llmBudget.js";

describe("LlmBudget — basic accounting", () => {
  it("tracks calls and tokens across stages", () => {
    const b = new LlmBudget(10);
    b.record("plan", { promptTokens: 100, completionTokens: 20 }, "gemini");
    b.record("ir", { promptTokens: 50, completionTokens: 10 }, "gemini");
    const s = b.snapshot();
    expect(s.calls).toBe(2);
    expect(s.promptTokens).toBe(150);
    expect(s.completionTokens).toBe(30);
    expect(s.totalTokens).toBe(180);
    expect(s.exhausted).toBe(false);
  });

  it("counts a failed (usage-less) call against the ceiling, same as a successful one", () => {
    const b = new LlmBudget(10);
    b.record("ir", undefined, "gemini"); // no usage — matches ir.ts's catch-path record()
    expect(b.snapshot().calls).toBe(1);
    expect(b.snapshot().totalTokens).toBe(0);
  });

  it("reports exhausted once the call ceiling is hit", () => {
    const b = new LlmBudget(2);
    expect(b.hasBudget).toBe(true);
    b.record("ir", undefined, "gemini");
    expect(b.hasBudget).toBe(true);
    b.record("ir", undefined, "gemini");
    expect(b.hasBudget).toBe(false);
    expect(b.snapshot().exhausted).toBe(true);
  });

  it("breaks usage down per stage — the thing groq-usage.json's predecessor couldn't do", () => {
    const b = new LlmBudget(10);
    b.record("plan", { promptTokens: 100, completionTokens: 20 }, "gemini");
    b.record("ir", { promptTokens: 50, completionTokens: 10 }, "gemini");
    b.record("ir", { promptTokens: 60, completionTokens: 15 }, "gemini");
    const { byStage } = b.snapshot();
    expect(byStage.plan).toEqual({ calls: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120, provider: "gemini", reasoningTokens: 0 });
    expect(byStage.ir).toEqual({ calls: 2, promptTokens: 110, completionTokens: 25, totalTokens: 135, provider: "gemini", reasoningTokens: 0 });
  });

  it("accumulates reasoning tokens per stage when the provider reports them, else keeps them at 0", () => {
    const b = new LlmBudget(10);
    b.record("ir", { promptTokens: 10, completionTokens: 5, reasoningTokens: 30 }, "azure");
    b.record("ir", { promptTokens: 10, completionTokens: 5, reasoningTokens: 4 }, "azure");
    b.record("plan", { promptTokens: 9, completionTokens: 1 }, "azure"); // no reasoning_tokens field
    const { byStage } = b.snapshot();
    expect(byStage.ir).toEqual({ calls: 2, promptTokens: 20, completionTokens: 10, totalTokens: 30, provider: "azure", reasoningTokens: 34 });
    expect(byStage.plan).toEqual({ calls: 1, promptTokens: 9, completionTokens: 1, totalTokens: 10, provider: "azure", reasoningTokens: 0 });
  });
});

describe("enterWithBudget / recordAmbient", () => {
  it("recordAmbient is a safe no-op with no active context", () => {
    // No enterWithBudget call anywhere before this — must not throw.
    expect(() => recordAmbient("plan", { promptTokens: 5, completionTokens: 1 }, "gemini")).not.toThrow();
  });

  it("recordAmbient reaches the budget set by enterWithBudget, several async layers deep", async () => {
    const b = new LlmBudget(10);
    enterWithBudget(b);

    // Simulates discovery's real call depth (discoverSiteHybrid -> discoverHybrid ->
    // labelConceptsWithDOM -> gemini() -> recordAmbient) — several awaited layers, no explicit
    // parameter passed through any of them.
    async function layer3() { recordAmbient("discovery", { promptTokens: 30, completionTokens: 6 }, "gemini"); }
    async function layer2() { await layer3(); }
    async function layer1() { await layer2(); }
    await layer1();

    const s = b.snapshot();
    expect(s.calls).toBe(1);
    expect(s.byStage.discovery).toEqual({ calls: 1, promptTokens: 30, completionTokens: 6, totalTokens: 36, provider: "gemini", reasoningTokens: 0 });
  });

  it("two concurrent 'runs' each entering their own budget do not cross-contaminate", async () => {
    // The exact safety property the doc comment in llmBudget.ts claims: MAX_CONCURRENT_RUNS
    // lets several pipeline runs share one Node process, so one run's ambient budget must
    // never leak into a concurrently-running sibling's.
    const runA = async () => {
      const budget = new LlmBudget(10);
      enterWithBudget(budget);
      await new Promise((r) => setTimeout(r, 10)); // yield, let runB's enterWithBudget interleave
      recordAmbient("plan", { promptTokens: 111, completionTokens: 1 }, "gemini");
      await new Promise((r) => setTimeout(r, 10));
      return budget;
    };
    const runB = async () => {
      const budget = new LlmBudget(10);
      enterWithBudget(budget);
      await new Promise((r) => setTimeout(r, 5));
      recordAmbient("plan", { promptTokens: 222, completionTokens: 2 }, "gemini");
      await new Promise((r) => setTimeout(r, 15));
      return budget;
    };

    const [budgetA, budgetB] = await Promise.all([runA(), runB()]);
    expect(budgetA.snapshot().promptTokens).toBe(111);
    expect(budgetB.snapshot().promptTokens).toBe(222);
  });
});

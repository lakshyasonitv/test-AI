import { AsyncLocalStorage } from "node:async_hooks";

export interface LlmStageUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmUsageSnapshot {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  exhausted: boolean;
  /** Per-stage breakdown — "ir", "plan", "testcases", "discovery", "failure_analysis", "heal".
   *  Absent from `groq-usage.json`'s predecessor entirely; this is what makes generalizing the
   *  budget past IR-only worthwhile — you can now see which stage is actually spending. */
  byStage: Record<string, LlmStageUsage>;
}

/**
 * Hard per-run cap on LLM spend, shared across every stage within one pipeline run (plan,
 * discovery labeling, test-case generation, IR compilation, failure diagnosis, self-heal, and
 * every suite case). Must be instantiated once per run — never a module-level singleton, since
 * MAX_CONCURRENT_RUNS lets multiple runs share one Node process and a shared counter would
 * corrupt across them.
 *
 * Two ways a call gets recorded against it:
 *  1. **Explicit threading** — ir.ts/heal.ts/suiteRunner.ts take a `budget?: LlmBudget`
 *     parameter and call `.record()` directly. This is how IR compilation (the original,
 *     Groq-only use of this class) still works, unchanged.
 *  2. **Ambient, via `enterWithBudget`/`recordAmbient`** below — plan/discovery/test-case-
 *     generation/failure-analysis call `gemini()` several layers deep inside their own
 *     internal helpers (discovery in particular: discoverSiteHybrid -> discoverHybrid ->
 *     labelConceptsWithDOM -> gemini()). Threading an explicit parameter through every one of
 *     those layers would be a much larger, riskier diff for the same outcome, so those stages
 *     use Node's `AsyncLocalStorage` instead — orchestrator.ts calls `enterWithBudget(llmBudget)`
 *     once, near the top of the pipeline run, and `gemini()` calls `recordAmbient()` itself
 *     after every call. Safe across concurrent runs by construction (AsyncLocalStorage scopes
 *     to the async causal chain the call entered from, not to the process), so it doesn't
 *     reintroduce the module-level-singleton problem this class's own history already ruled out.
 *
 * Originally Groq-only (`GroqBudget`, IR compilation was the only stage that spent real,
 * metered tokens — every other stage was Gemini, which this project had no usage telemetry
 * for at all). Generalized when IR moved to Gemini too: the accounting was never actually
 * Groq-specific, just under-applied. See DECISIONS.md D-21.
 */
export class LlmBudget {
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly maxCalls: number;
  private readonly byStage = new Map<string, { calls: number; promptTokens: number; completionTokens: number }>();

  constructor(
    maxCalls = Number(process.env.MAX_LLM_CALLS_PER_RUN ?? 60)
  ) {
    this.maxCalls = maxCalls;
  }

  /** True while another LLM call is still affordable this run. */
  get hasBudget(): boolean {
    return this.calls < this.maxCalls;
  }

  /**
   * Record one completed attempt. Called after every attempt regardless of success or
   * failure — a failed/erroring call already spent the request, so it counts against the
   * ceiling too. `usage` is omitted on failure. `stage` is a short label (ir.ts's own
   * `StageName` values are the convention, e.g. "ir", "plan", "testcases", "discovery",
   * "failure_analysis", "heal") — freeform, not validated, since the budget itself doesn't
   * care which stage spent the call, only the per-stage breakdown does.
   */
  record(stage: string, usage?: { promptTokens?: number; completionTokens?: number }) {
    this.calls++;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;

    const s = this.byStage.get(stage) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
    s.calls++;
    s.promptTokens += promptTokens;
    s.completionTokens += completionTokens;
    this.byStage.set(stage, s);
  }

  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  snapshot(): LlmUsageSnapshot {
    const byStage: Record<string, LlmStageUsage> = {};
    for (const [stage, s] of this.byStage) {
      byStage[stage] = { ...s, totalTokens: s.promptTokens + s.completionTokens };
    }
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      exhausted: !this.hasBudget,
      byStage,
    };
  }
}

// ---------------------------------------------------------------------------
// Ambient budget context — see the class doc comment above for why this exists alongside
// explicit threading, not instead of it.
// ---------------------------------------------------------------------------

const budgetContext = new AsyncLocalStorage<LlmBudget>();

/** Makes `budget` available to every `gemini()` call made anywhere in the async call chain
 *  that follows — however many layers deep — for the rest of the CURRENT execution, without
 *  wrapping the caller's function body in a callback. orchestrator.ts calls this exactly once,
 *  right after constructing the run's budget, near the top of `runPipeline`.
 *
 *  `enterWith`, not `run`: `runPipeline` is one long async function (300+ lines) with the
 *  budget created partway through it — wrapping the remainder in `budgetContext.run(budget,
 *  () => {...})` would mean re-indenting the whole rest of the function for no functional
 *  gain. `enterWith` sets the context for the remainder of the current synchronous execution
 *  and everything awaited afterward, which is exactly this shape. Still safe across concurrent
 *  runs sharing one process (MAX_CONCURRENT_RUNS): each `runPipeline()` call is its own root of
 *  the async causal chain, so one call's `enterWith` cannot leak into a sibling call's — the
 *  same isolation `AsyncLocalStorage` provides to, e.g., concurrent request handlers in a
 *  server, which is exactly what concurrent runs in this process are. */
export function enterWithBudget(budget: LlmBudget): void {
  budgetContext.enterWith(budget);
}

/** Called by gemini() itself after every call. A no-op outside of `enterWithBudget` (e.g. a
 *  direct unit-test call to gemini()) — same "budget is optional, everything still works
 *  without one" contract the explicit `budget?.record()` call sites already have. */
export function recordAmbient(stage: string, usage?: { promptTokens?: number; completionTokens?: number }) {
  budgetContext.getStore()?.record(stage, usage);
}

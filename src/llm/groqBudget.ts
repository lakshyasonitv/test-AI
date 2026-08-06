export interface GroqUsageSnapshot {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  exhausted: boolean;
}

/**
 * Hard per-run cap on Groq spend, shared across every toIR() call within one pipeline
 * run (primary case, self-heal, and every suite case). Must be instantiated once per
 * run and threaded explicitly — never a module-level singleton, since
 * MAX_CONCURRENT_RUNS lets multiple runs share one Node process and a shared counter
 * would corrupt across them.
 */
export class GroqBudget {
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly maxCalls: number;

  constructor(maxCalls = Number(process.env.MAX_GROQ_CALLS_PER_RUN ?? 60)) {
    this.maxCalls = maxCalls;
  }

  /** True while another Groq call is still affordable this run. */
  get hasBudget(): boolean {
    return this.calls < this.maxCalls;
  }

  /**
   * Record one completed attempt at the top of ir.ts's retry loop. Called after every
   * attempt regardless of success or failure — a failed/erroring call already spent the
   * request, so it counts against the ceiling too. `usage` is omitted on failure.
   */
  record(usage?: { promptTokens?: number; completionTokens?: number }) {
    this.calls++;
    this.promptTokens += usage?.promptTokens ?? 0;
    this.completionTokens += usage?.completionTokens ?? 0;
  }

  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  snapshot(): GroqUsageSnapshot {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      exhausted: !this.hasBudget,
    };
  }
}

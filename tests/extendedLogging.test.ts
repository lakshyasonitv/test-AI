import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { llmCallLine } from "../src/llm/client.js";
import { runUsageLine } from "../src/orchestrator.js";
import { extendedLoggingEnabled } from "../src/logging.js";
import type { LlmUsageSnapshot } from "../src/llm/llmBudget.js";

/**
 * Guards for Phase 2 STEP 4 (gated new output) and Q3 (health/startup presence-only).
 *
 * Same two kinds of assertion as `tests/misleadingLogs.test.ts`, labelled:
 *  - BEHAVIOURAL: the pure formatter / the flag reader is called and its real output checked.
 *  - SOURCE guards: the gated call sites and `BOOLEAN_ENV_FLAGS`/`.env.example` registration,
 *    which have no pure function to call.
 * Every assertion here was mutation-tested (fix removed -> RED, restored -> GREEN).
 */

const SRC = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const CLIENT = SRC("llm/client.ts");
const ORCH = SRC("orchestrator.ts");
const INDEX = SRC("server/index.ts");
const ENV_EXAMPLE = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const origFlag = process.env.EXTENDED_LOGGING;
afterEach(() => {
  if (origFlag === undefined) delete process.env.EXTENDED_LOGGING;
  else process.env.EXTENDED_LOGGING = origFlag;
});

describe("extendedLoggingEnabled (behavioural)", () => {
  it("is true only for the exact string 'true'", () => {
    process.env.EXTENDED_LOGGING = "true";
    expect(extendedLoggingEnabled()).toBe(true);
    for (const v of ["false", "1", "TRUE", "yes", ""]) {
      process.env.EXTENDED_LOGGING = v;
      expect(extendedLoggingEnabled()).toBe(false);
    }
    delete process.env.EXTENDED_LOGGING;
    expect(extendedLoggingEnabled()).toBe(false);
  });
});

describe("llmCallLine (behavioural)", () => {
  const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };

  it("names run, role, provider:model and all three token counts on one line", () => {
    expect(llmCallLine("main", "gemini:gemini-2.5-pro", usage, "run-abc")).toBe(
      "[llm] run=run-abc role=main model=gemini:gemini-2.5-pro tokens prompt=12 completion=3 total=15",
    );
  });

  it("prints '-' for a null run id rather than inventing one", () => {
    expect(llmCallLine("lite", "gemini:gemini-2.5-flash", usage, null)).toContain("run=-");
  });
});

describe("runUsageLine (behavioural)", () => {
  const snapshot: LlmUsageSnapshot = {
    calls: 3,
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    exhausted: false,
    byStage: {
      ir: { calls: 2, promptTokens: 80, completionTokens: 30, totalTokens: 110, reasoningTokens: 0, provider: "gemini" },
      plan: { calls: 1, promptTokens: 20, completionTokens: 10, totalTokens: 30, reasoningTokens: 0, provider: "gemini" },
    },
    retries: [],
  };

  it("reports the run total and a per-stage breakdown, stages sorted deterministically", () => {
    const line = runUsageLine("run-abc", snapshot);
    expect(line).toContain("[llm] run=run-abc TOTAL calls=3 prompt=100 completion=40 total=140");
    expect(line).toContain("stages: ir=110/2c plan=30/1c");
    expect(line).not.toContain("BUDGET EXHAUSTED");
  });

  it("flags an exhausted budget so a capped run is not read as a cheap one", () => {
    expect(runUsageLine("run-abc", { ...snapshot, exhausted: true })).toContain("BUDGET EXHAUSTED");
  });

  it("omits the breakdown entirely when no stage spent anything", () => {
    const empty = { ...snapshot, byStage: {} };
    expect(runUsageLine("run-abc", empty)).not.toContain("stages:");
  });
});

describe("the gate: flag off emits none of the new output (source guard)", () => {
  it("the per-call logger returns before logging when the flag is off", () => {
    expect(CLIENT).toMatch(/if \(!extendedLoggingEnabled\(\)\) return;/);
  });

  it("both run-summary call sites are guarded, not free-standing", () => {
    const guarded = ORCH.match(/if \(extendedLoggingEnabled\(\)\) console\.log\(runUsageLine\(runId, llmUsage\)\);/g) ?? [];
    expect(guarded.length).toBe(2); // happy path + failed-run path
  });

  it("the widened startup block is behind the flag, so flag-off startup is unchanged", () => {
    expect(INDEX).toContain("if (extendedLoggingEnabled()) {");
    expect(INDEX).toContain("Provider variables (EXTENDED_LOGGING)");
    // The original six-var line is untouched, byte-for-byte, for the phase-report gates.
    expect(INDEX).toContain("SET (${val.length} chars)");
  });

  it("registers the flag as data and in .env.example, so a typo cannot read as false", () => {
    expect(INDEX).toContain('"EXTENDED_LOGGING"');
    expect(ENV_EXAMPLE).toContain("EXTENDED_LOGGING=false");
  });
});

describe("Q3: health and startup report presence only, never a length (source guard)", () => {
  it("the health check returns just `set`", () => {
    expect(INDEX).toContain("return { set: !!val };");
    expect(INDEX).not.toContain("length: val?.length ?? 0");
  });

  it("the widened startup block prints SET/NOT SET, never a char count", () => {
    const block = INDEX.slice(INDEX.indexOf("Provider variables (EXTENDED_LOGGING)"));
    const head = block.slice(0, block.indexOf("resolved provider"));
    expect(head).toContain('${val ? "SET" : "NOT SET"}');
    expect(head).not.toContain("chars");
  });
});

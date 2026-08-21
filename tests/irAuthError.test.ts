import { describe, it, expect, vi, afterEach } from "vitest";

// Regression: a 401/404 from the LLM provider (bad API key, a decommissioned/mistyped model
// id) was retried up to MAX_IR_ATTEMPTS times — re-sending the exact same doomed request —
// then reported as "IR failed schema validation after retry: Groq 401: Invalid API Key",
// indistinguishable from a genuine product test failure. Confirmed against two real runs
// (problems.md RC-D / Cross-cutting #1): `7bcbf4de` burned 8 calls on a 401, `4f582417`
// burned 4 on a 404, both with zero usable tokens and both reported to the user as failed
// tests. Fixed: a definitively non-retryable status fails fast, on the FIRST attempt, with a
// distinctly-labeled, structurally-marked error — provider-agnostic, since the bug was in
// ir.ts's own retry loop, not in groq.ts specifically (a Gemini 401 hit the identical path).

const HOST = "https://ir-auth-error.example";

const geminiMock = vi.fn();
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m),
  refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");

const appModel: any = {
  baseUrl: HOST,
  pages: [{ url: `${HOST}/`, title: "Home", concepts: [], elements: [{ role: "button", name: "Go" }] }],
};
const testCase: any = {
  title: "Simple case", priority: "high", feature: "f", category: "valid",
  steps: ["Click Go"], expected: "Something happens",
  fromPrompt: false, generatedFrom: "upfront",
};

const providerError = (status: number, message: string) => {
  const e: any = new Error(message);
  e.status = status;
  return e;
};

describe("toIR — non-retryable infrastructure errors fail fast", () => {
  // Deliberately afterEach + mockClear, not beforeEach + mockReset. Empirically, on vitest
  // 4.1.10, when a mock's implementation THROWS and the mock is cleared/reset (mockClear and
  // mockReset both reproduce it) in the NEXT test's beforeEach, that next test fails with the
  // raw provider error — even when a manual try/catch around the awaited call in the test body
  // demonstrably receives the correctly-wrapped infraErr (added console diagnostics showed the
  // catch block running with the right value; the test still failed independent of that). This
  // held even isolating the failing test alone via `.only`, so it isn't cross-test state
  // pollution in the ordinary sense. What exactly inside vitest/tinyspy attributes the failure
  // this way wasn't tracked down — only that moving the clear from beforeEach to afterEach
  // reliably avoids it, confirmed by toggling between the two repeatedly.
  afterEach(() => geminiMock.mockClear());

  it("fails on the FIRST attempt for a 401 (bad API key), not after burning the whole retry budget", async () => {
    geminiMock.mockImplementation(async () => { throw providerError(401, "Gemini 401: Invalid API Key"); });
    await expect(toIR(testCase, appModel, `prompt-${Date.now()}-a`, `${HOST}/`))
      .rejects.toThrow(/infrastructure error/i);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("marks the thrown error structurally, not just in its message text", async () => {
    geminiMock.mockImplementation(async () => { throw providerError(401, "Gemini 401: Invalid API Key"); });
    let caught: any;
    try {
      await toIR(testCase, appModel, `prompt-${Date.now()}-b`, `${HOST}/`);
    } catch (err) {
      caught = err;
    }
    expect(caught?.isInfrastructureError).toBe(true);
    expect(caught?.status).toBe(401);
  });

  it("fails fast for a 404 (decommissioned/mistyped model) the same way", async () => {
    geminiMock.mockImplementation(async () => { throw providerError(404, "Gemini 404: model not found"); });
    await expect(toIR(testCase, appModel, `prompt-${Date.now()}-c`, `${HOST}/`))
      .rejects.toThrow(/infrastructure error/i);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fail fast for a 429 — that goes through the existing rate-limit retry path instead", async () => {
    geminiMock.mockImplementation(async () => { throw providerError(429, "Gemini 429: quota exceeded"); });
    let caught: any;
    try {
      await toIR(testCase, appModel, `prompt-${Date.now()}-d`, `${HOST}/`);
    } catch (err) {
      caught = err;
    }
    expect(caught?.isInfrastructureError).toBeUndefined();
    // 3 free rate-limit retries + the normal MAX_IR_ATTEMPTS (default 4) before finally
    // giving up — meaningfully more than the 1-call fail-fast infra-error case above.
    expect(geminiMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("a genuine schema/parse error still goes through the normal per-attempt retry loop, unaffected", async () => {
    geminiMock.mockResolvedValue({ content: "not valid json{{{", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    await expect(toIR(testCase, appModel, `prompt-${Date.now()}-e`, `${HOST}/`)).rejects.toThrow();
    // Should spend (close to) the whole MAX_IR_ATTEMPTS budget, not stop at 1 like an infra error.
    expect(geminiMock.mock.calls.length).toBeGreaterThan(1);
  });
});

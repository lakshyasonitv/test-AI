import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * An unfixable grounding rejection must not be paid for four times — TECH_DEBT.md TD-74.
 *
 * THE EVIDENCE. `server.log` lines 107 / 124 / 141 show grounding rejecting
 * `Step s6 targets role="button" name="Add User", which is not present…` three times with
 * IDENTICAL feedback, then rejecting the same target again as `s8`. The element is genuinely
 * absent from that page — it sits behind an admin role the test does not have — so no amount of
 * regeneration can ground it.
 *
 * THE COST. `ir` is 12–24 calls and 70–85% of a run's spend. Measured across every run in
 * `runs/`, an IR call is a very consistent **~3,800 prompt tokens** (`toMicroModel` already scopes
 * the prompt to one page and 30 elements, so the waste is call COUNT, not call size). Two wasted
 * attempts is ~7,600 prompt tokens per stuck case, every time that case runs.
 *
 * THE KEY IS STRUCTURAL. Note the evidence: `s6` then `s8`. The message text differs between
 * those two while the thing that cannot be grounded is identical, so keying on the message would
 * miss the repeat entirely. The signature is built from the IR target's own fields and
 * deliberately excludes the step index — `CLAUDE.md`'s central design rule, and here also simply
 * the only thing that works.
 */

const HOST = "https://ir-dedup-check.example";

/** Steps 1–2 ground. `s3` targets a button the model has never seen, on every attempt. */
const IR_WITH_ABSENT_TARGET = {
  meta: { feature: "Admin", title: "Admin creates a new user", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Admin" } },
    { id: "s3", action: "click", target: { role: "button", name: "Add User" } },
  ],
};

/**
 * Same absent target, moved to a different step id — exactly the `s6` -> `s8` shift in the log.
 * Returned from the second call onward so the test proves the signature ignores the index.
 */
const IR_TARGET_MOVED = {
  ...IR_WITH_ABSENT_TARGET,
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Admin" } },
    { id: "s7", action: "click", target: { role: "button", name: "Users" } },
    { id: "s8", action: "click", target: { role: "button", name: "Add User" } },
  ],
};

const geminiCalls = { n: 0 };
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => {
    geminiCalls.n += 1;
    return {
      content: JSON.stringify(geminiCalls.n === 1 ? IR_WITH_ABSENT_TARGET : IR_TARGET_MOVED),
      usage: { promptTokens: 3800, completionTokens: 200, totalTokens: 4000 },
    };
  }),
}));

// Extension "succeeds" but never learns the missing element — the real shape of this failure,
// where replaying reaches a page discovery still cannot model. Without this the run would exit
// through a different path and the attempt count would not be what is under test.
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (model: any) => model),
  refreshPageModel: vi.fn(async (model: any) => model),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");

const appModel: any = {
  baseUrl: HOST,
  pages: [{
    url: `${HOST}/`,
    title: "Dashboard",
    concepts: ["Admin"],
    // "Add User" is deliberately absent — it is the one target that can never ground.
    // "Users" IS present, on purpose: the moved IR must fail on the SAME target as the first
    // one, or the test measures "a different rejection earns a retry" (which it should) rather
    // than "the same target at a new index does not".
    elements: [
      { role: "button", name: "Admin" },
      { role: "button", name: "Users" },
    ],
  }],
};

const testCase: any = {
  title: "Admin creates a new user via management interface",
  priority: "high", feature: "Admin", category: "state-change",
  steps: ["Open the admin panel", "Add a user"],
  expected: "The user is created",
  fromPrompt: true, generatedFrom: "upfront",
};

describe("toIR — a target that cannot ever ground is not retried to exhaustion", () => {
  beforeEach(() => { geminiCalls.n = 0; vi.clearAllMocks(); });

  it("stops after the SECOND identical rejection instead of using all 4 attempts", async () => {
    // Unique prompt per run so the on-disk IR cache cannot short-circuit the calls.
    const { ir } = await toIR(testCase, appModel, `dedup-${Date.now()}-${Math.random()}`, `${HOST}/`);

    // MAX_IR_ATTEMPTS is 4. The same absent target comes back on attempt 2, so attempts 3 and 4
    // are never spent: ~7,600 prompt tokens saved on this one case.
    expect(geminiCalls.n).toBe(2);

    // The outcome is unchanged in kind — still the grounded prefix, still flagged, still
    // carrying the reason. Only the cost of arriving at it changed.
    expect(ir.meta.truncated).toBe(true);
    expect(ir.meta.truncationNote).toContain("Add User");
    // The LONGEST grounded prefix across both attempts wins (`bestPartial`), so the second
    // attempt's extra grounded step is kept. Stopping early costs no coverage — it drops the
    // attempts that were re-deriving the same refusal, not the ones making progress.
    expect(ir.steps.map((s) => s.id)).toEqual(["s1", "s2", "s7"]);
  });

  it("records the reason on the case, using the existing field and no new status", async () => {
    const { ir } = await toIR(testCase, appModel, `dedup-${Date.now()}-${Math.random()}`, `${HOST}/`);
    // `truncationNote` is what suiteRunner and the done event already surface, so the UI shows
    // WHY without anything new to plumb through.
    expect(typeof ir.meta.truncationNote).toBe("string");
    expect(ir.meta.truncationNote).toMatch(/not present|compatible role/i);
    expect(ir.meta).not.toHaveProperty("groundingBlocked");
  });

  it("matches the target across a step-index change — the s6 -> s8 case", async () => {
    // Call 1 returns the target at s3; every later call returns it at s8. If the signature
    // included the index, or keyed on the message, this would look like a NEW rejection each
    // time and all four attempts would be spent.
    await toIR(testCase, appModel, `dedup-${Date.now()}-${Math.random()}`, `${HOST}/`);
    expect(geminiCalls.n).toBe(2);
  });
});

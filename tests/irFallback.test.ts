import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for run 2026-07-30T17-44-54-554Z-778bb247, which died with
//   "Pipeline error: IR failed schema validation after retry: Step s10 targets
//    role=textbox name=Email Address, which is not present in the application model"
// and produced no test at all.
//
// Shape of the failure: the graceful "ship the grounded prefix" return lives INSIDE toIR's
// retry loop and is only reached once live-extension stops. When every attempt ends in a
// successful extend-and-retry, the loop just runs out of attempts and falls through to a hard
// throw — reachable with the shipped defaults, since MAX_IR_ATTEMPTS (4) is lower than
// MAX_LIVE_EXTENSIONS (5). An 11-step signup+login+logout case hit it exactly.
//
// Mocked at the module boundary so this needs no network and no browser.

const HOST = "https://ir-fallback-check.example";

// Always returns the same IR: three grounded steps, then one targeting an element the model
// has never seen. Mirrors the real failure, where discovery knew one page with zero textboxes.
const UNGROUNDABLE_IR = {
  meta: { feature: "Auth", title: "Sign up then log in", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "link", name: "Sign up" } },
    { id: "s3", action: "click", target: { role: "button", name: "Continue" } },
    { id: "s4", action: "fill", target: { role: "textbox", name: "Email Address" }, value: "a@b.c" },
    { id: "s5", action: "assert", target: { role: "button", name: "Continue" }, assertion: "hidden" },
  ],
};

vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({
    content: JSON.stringify(UNGROUNDABLE_IR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));

// Extension always "succeeds" without ever learning the missing element — the real case, where
// replaying reached a page whose fields discovery still couldn't model. This is what makes
// every attempt `continue` instead of falling into the in-loop truncation path.
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (model: any) => model),
  refreshPageModel: vi.fn(async (model: any) => model),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");
const { generateSpec } = await import("../src/stages/generator.js");

const appModel: any = {
  baseUrl: HOST,
  pages: [{
    url: `${HOST}/`,
    title: "Home",
    concepts: ["Authentication"],
    elements: [
      { role: "link", name: "Sign up" },
      { role: "button", name: "Continue" },
    ],
  }],
};

const testCase: any = {
  title: "Complete user journey: Sign-up, Login, and Logout",
  priority: "high", feature: "Authentication", category: "state-change",
  steps: ["Click the 'Sign up' link", "Submit the sign-up form", "Enter the credentials"],
  expected: "The user is signed up and logged in",
  fromPrompt: true, generatedFrom: "upfront",
};

describe("toIR — attempts exhausted while still extending", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ships the grounded prefix instead of failing the whole run", async () => {
    // Unique prompt per assertion so the on-disk IR cache can't short-circuit the call.
    const { ir } = await toIR(testCase, appModel, `prompt-${Date.now()}`, `${HOST}/`);

    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.map(s => s.id)).toEqual(["s1", "s2", "s3"]);
    // The reason survives to the UI rather than being lost in a stack trace.
    expect(ir.meta.truncationNote).toMatch(/Email Address/);
  });

  it("records whether anything is actually verified, so a pass can't be claimed falsely", async () => {
    const { ir } = await toIR(testCase, appModel, `prompt-${Date.now()}-b`, `${HOST}/`);
    // The surviving prefix ends on a click, not an assertion. suiteRunner maps
    // truncated && !hasTerminalAssertion onto "truncated_no_assertion" — Incomplete, never a
    // green pass.
    expect(ir.meta.truncated).toBe(true);
    expect(ir.meta.hasTerminalAssertion).toBe(false);
  });

  // The crash was at the `ir` stage, so nothing downstream of it has ever run for this case.
  // Don't assume a prefix that ends mid-flow survives code generation — check it.
  it("produces a runnable spec from the truncated prefix", async () => {
    const { ir } = await toIR(testCase, appModel, `prompt-${Date.now()}-c`, `${HOST}/`);
    const spec = generateSpec(ir, "runs/demo/artifacts");

    expect(spec).toContain("// PARTIAL:");          // the banner explaining what was cut
    expect(spec).toContain("Email Address");         // ...and why
    expect(spec).toContain("test(");
    expect(spec.match(/await shot\(page, /g) ?? []).toHaveLength(3);
    // No step interpolated a missing value into the emitted code.
    expect(spec).not.toMatch(/\("undefined"|undefined\.|goto\(undefined/);
  });
});

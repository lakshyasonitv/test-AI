import { describe, it, expect, vi } from "vitest";

// Regression: toIR's cache key had nothing about credentials, `llmCacheSet` runs INSIDE
// finalize() (i.e. after substitution), and a cache hit returns early — bypassing finalize
// entirely. So an IR generated once WITHOUT credentials was replayed forever with none,
// silently discarding whatever the user supplied. The disk half of that cache never expires.
//
// The ordering is the test. "Two calls with different creds differ" passes against the broken
// code, because in a fresh process both calls miss the cache. Only hit-after-miss reproduces it.

const HOST = "https://ir-cred-cache.example";

const LOGIN_IR = {
  meta: { feature: "Login", title: "Log in", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email Address" }, value: "invented@example.com" },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "InventedPass1!" },
    { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
    { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
  ],
};

vi.mock("../src/llm/groq.js", () => ({
  groq: vi.fn(async () => ({
    content: JSON.stringify(LOGIN_IR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m),
  refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");
const { isEnvValueRef } = await import("../src/stages/credentials.js");

const appModel: any = {
  baseUrl: HOST,
  pages: [{
    url: `${HOST}/login`, title: "Login", concepts: ["Authentication"],
    elements: [
      { role: "textbox", name: "Email Address" },
      { role: "textbox", name: "Password" },
      { role: "button", name: "Sign In" },
    ],
  }],
};

const validCase: any = {
  title: "Log in with valid credentials", priority: "high", feature: "Login",
  category: "valid", steps: ["Fill the login form", "Click Sign In"],
  expected: "The account page is shown", fromPrompt: false, generatedFrom: "upfront",
};

const fills = (ir: any) => ir.steps.filter((s: any) => s.action === "fill").map((s: any) => s.value);

describe("toIR — the IR cache must not discard credentials", () => {
  it("does not serve a credential-free IR to a run that supplied credentials", async () => {
    // Same testCase, prompt and appModel for both calls — only the credentials differ.
    const prompt = `cache-order-${Date.now()}`;

    // 1. A run with NO credentials populates the cache with the invented values.
    const first = await toIR(validCase, appModel, prompt, `${HOST}/login`);
    expect(fills(first.ir)).toEqual(["invented@example.com", "InventedPass1!"]);

    // 2. The same case, now WITH credentials. Against the old key this was a cache hit and
    //    returned the invented values above.
    const second = await toIR(validCase, appModel, prompt, `${HOST}/login`, undefined,
      { username: "me@real.com", password: "hunter2", secret: true });

    const [user, pass] = fills(second.ir);
    expect(isEnvValueRef(user)).toBe("TEST_USERNAME");
    expect(isEnvValueRef(pass)).toBe("TEST_PASSWORD");
    expect(JSON.stringify(second.ir)).not.toContain("hunter2");
  });

  it("still caches within a single credential setting", async () => {
    const prompt = `cache-reuse-${Date.now()}`;
    const creds = { username: "me@real.com", password: "hunter2", secret: true };
    const a = await toIR(validCase, appModel, prompt, `${HOST}/login`, undefined, creds);
    const b = await toIR(validCase, appModel, prompt, `${HOST}/login`, undefined, creds);
    expect(fills(b.ir)).toEqual(fills(a.ir));
  });
});

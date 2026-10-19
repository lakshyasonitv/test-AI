import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * D-57 stage 1, through the real compiler (`toIR`) with the model mocked: the user's real
 * Salesforce login case, compiled four ways. Only a ticked run with SALESFORCE_FIXED_LOGIN=true
 * changes; the other three compile exactly the steps the model wrote.
 */

const ORG = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com";
const LIGHTNING = "https://ruby-data-2200-dev-ed.scratch.lightning.force.com/one/one.app";

const MODEL_IR = {
  meta: { feature: "Login", title: "Log in with valid credentials", priority: "high", sourcePrompt: "p", baseUrl: ORG },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Username" }, value: "u" },
    { id: "s3", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
    { id: "s4", action: "fill", target: { role: "textbox", name: "Password" }, value: "p" },
    { id: "s5", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
    { id: "s6", action: "assert", target: { role: "heading", name: "Sales" }, assertion: "visible" },
  ],
};

let nextIR: any = MODEL_IR;
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({
    content: JSON.stringify(nextIR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));
const captureCalls: any[] = [];
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m),
  refreshPageModel: vi.fn(async (m: any) => m),
  captureScreenAt: vi.fn(async (m: any, prefix: any[]) => {
    captureCalls.push(prefix.map((s: any) => s.id));
    throw new Error("no browser in this test");
  }),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");
const { withTargetApp } = await import("../src/runTarget.js");

const appModel: any = {
  baseUrl: ORG,
  pages: [
    {
      url: `${ORG}/`, title: "Login", concepts: ["Authentication"],
      elements: [
        { role: "textbox", name: "Username", css: "#username", visible: true },
        { role: "button", name: "Log In to Sandbox", css: "#Login", visible: true },
      ],
    },
    {
      url: LIGHTNING, title: "Lightning Experience", concepts: ["Navigation"],
      elements: [{ role: "heading", name: "Sales", css: "#sales", visible: true }],
    },
  ],
  auth: {
    status: "authenticated", url: LIGHTNING, loginUrl: `${ORG}/`,
    loginSteps: [
      { action: "fill", css: "#username", credential: "username" },
      { action: "click", css: "#Login" },
      { action: "waitFor", css: "#password" },
      { action: "fill", css: "#password", credential: "password" },
      { action: "click", css: "#Login" },
    ],
  },
};

const loginCase: any = {
  title: "Log in with valid credentials", priority: "high", feature: "Login",
  category: "valid", steps: ["Log in"], expected: "Lightning opens", fromPrompt: true,
  generatedFrom: "upfront", targetUrl: `${ORG}/`,
};
const CREDS = { username: "me@example.com.uat", password: "hunter2", secret: true };

const compile = (ticked: boolean, prompt: string) =>
  withTargetApp(ticked ? "salesforce" : null, () =>
    toIR(loginCase, appModel, prompt, `${ORG}/`, undefined, CREDS));

afterEach(() => { delete process.env.SALESFORCE_FIXED_LOGIN; captureCalls.length = 0; nextIR = MODEL_IR; });

describe("toIR on the real Salesforce login case", () => {
  it("ticked + SALESFORCE_FIXED_LOGIN=true: the recorded two-screen login, then the case's own check", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const { ir } = await compile(true, `fixed-on-${Date.now()}`);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["auth-0", "auth-1", "auth-2", "auth-3", "auth-4", "auth-5", "auth-6", "s6"]);
    expect(ir.steps[3]).toMatchObject({ action: "assert", target: { css: "#password" }, assertion: "visible" });
    expect(ir.steps[4]).toMatchObject({ action: "fill", target: { css: "#password" }, value: "${env:TEST_PASSWORD}" });
    expect(ir.meta.truncated).toBeFalsy();
    expect(JSON.stringify(ir)).not.toContain("hunter2");
  });

  it("ticked, flag OFF: today's result — the model's own login, cut before the password", async () => {
    const { ir } = await compile(true, `fixed-off-${Date.now()}`);
    expect(ir.steps.some((s: any) => String(s.id).startsWith("auth-"))).toBe(false);
    expect(ir.steps[0].id).toBe("s1");
    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.some((s: any) => s.target?.name === "Password")).toBe(false);
  });

  it("UNticked, flag ON: today's result — the model's own login, cut before the password", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const { ir } = await compile(false, `unticked-${Date.now()}`);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(ir.meta.truncated).toBe(true);
  });

  it("UNticked, flag OFF compiles byte-identically to UNticked, flag ON", async () => {
    const prompt = `same-${Date.now()}`;
    const off = await compile(false, prompt + "-a");
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const on = await compile(false, prompt + "-b");
    expect(JSON.stringify(on.ir.steps)).toBe(JSON.stringify(off.ir.steps));
  });

  it("a wrong-password case is never swapped, even ticked with the flag on", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const wrong = { ...loginCase, title: "Log in with an invalid password shows an error",
      category: "invalid-input", fromPrompt: false, expected: "An error is shown" };
    const { ir } = await withTargetApp("salesforce", () =>
      toIR(wrong, appModel, `wrong-${Date.now()}`, `${ORG}/`, undefined, CREDS));
    expect(ir.steps.some((s: any) => String(s.id).startsWith("auth-"))).toBe(false);
  });
});

describe("meta.fixedLogin — set only by toIR, only for a fixed-login run", () => {
  it("the swapped login case is marked, so the spec runs the fixed login", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const { ir } = await compile(true, `mark-swap-${Date.now()}`);
    expect(ir.meta.fixedLogin).toBe("salesforce");
  });

  it("an ordinary Salesforce case (login prefix added) is marked too", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    nextIR = { ...MODEL_IR, steps: [{ id: "s1", action: "assert", target: { role: "heading", name: "Sales" }, assertion: "visible" }] };
    const homeCase = { ...loginCase, title: "Sales app opens", targetUrl: LIGHTNING };
    const { ir } = await withTargetApp("salesforce", () =>
      toIR(homeCase, appModel, `mark-prefix-${Date.now()}`, `${ORG}/`, undefined, CREDS));
    expect(ir.steps[0].id).toBe("auth-0");
    expect(ir.meta.fixedLogin).toBe("salesforce");
  });

  it("flag off: never marked, even on a ticked run with a login prefix", async () => {
    nextIR = { ...MODEL_IR, steps: [{ id: "s1", action: "assert", target: { role: "heading", name: "Sales" }, assertion: "visible" }] };
    const homeCase = { ...loginCase, title: "Sales app opens", targetUrl: LIGHTNING };
    const { ir } = await withTargetApp("salesforce", () =>
      toIR(homeCase, appModel, `nomark-${Date.now()}`, `${ORG}/`, undefined, CREDS));
    expect(ir.steps[0].id).toBe("auth-0");
    expect("fixedLogin" in ir.meta).toBe(false);
  });

  it("a marker the MODEL writes is stripped", async () => {
    nextIR = { ...MODEL_IR, meta: { ...MODEL_IR.meta, fixedLogin: "salesforce" } };
    const { ir } = await compile(false, `strip-${Date.now()}`);
    expect("fixedLogin" in ir.meta).toBe(false);
  });
});

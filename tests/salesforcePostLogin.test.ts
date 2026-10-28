import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * D-70 — after a Salesforce login, a "go to the login page" step means "go to the page the login
 * landed on", which on Salesforce is ANOTHER host of the same org (lightning.force.com). Through the
 * real compiler (`toIR`) with the model mocked, on the user's real search case
 * (run 2026-10-22T09-44-02-812Z: rejected 3x for "Search not present on …my.salesforce.com/").
 */

const ORG = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com";
const LIGHTNING = "https://ruby-data-2200-dev-ed.scratch.lightning.force.com/one/one.app";

let nextIR: any;
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({ content: JSON.stringify(nextIR), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })),
}));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m),
  refreshPageModel: vi.fn(async (m: any) => m),
  captureScreenAt: vi.fn(async () => { throw new Error("no browser in this test"); }),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR, redirectPostLoginNavigate } = await import("../src/stages/ir.js");
const { withTargetApp } = await import("../src/runTarget.js");

const meta = { feature: "Search", title: "Submit the Search form with an empty query", priority: "low", sourcePrompt: "p", baseUrl: ORG };
/** What the model wrote for the search case: its own two-screen login, then "/", then Search. */
const SEARCH_IR = {
  meta,
  steps: [
    { id: "s1", action: "fill", target: { role: "textbox", name: "Username" }, value: "u" },
    { id: "s2", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "p" },
    { id: "s4", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
    { id: "s5", action: "navigate", target: { url: "/" } },
    { id: "s6", action: "assert", target: { role: "heading", name: "Seller Home" }, assertion: "visible" },
    { id: "s7", action: "click", target: { role: "button", name: "Search" } },
  ],
};

const appModel: any = {
  baseUrl: ORG,
  pages: [
    { url: `${ORG}/`, title: "Login | Salesforce", concepts: ["Authentication"], elements: [
      { role: "textbox", name: "Username", css: "#username", visible: true },
      { role: "textbox", name: "Password", css: "#password", visible: true },
      { role: "button", name: "Log In to Sandbox", css: "#Login", visible: true },
      { role: "link", name: "Forgot Your Password?", visible: true },
    ] },
    { url: LIGHTNING, title: "Home | Salesforce", concepts: ["Home"], elements: [
      { role: "button", name: "Search", css: "button.search-button", visible: true },
      { role: "heading", name: "Seller Home", css: "h1.slds-page-header__title", visible: true },
    ] },
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
  title: meta.title, priority: "low", feature: "Search", category: "valid", steps: ["Search with nothing"],
  expected: "e", fromPrompt: false, generatedFrom: "upfront", targetUrl: `${ORG}/`,
};
const CREDS = { username: "me@example.com.uat", password: "hunter2", secret: true };
const compile = (prompt: string) => withTargetApp("salesforce", () =>
  toIR(loginCase, appModel, prompt, `${ORG}/`, undefined, CREDS));

afterEach(() => { delete process.env.SALESFORCE_FIXED_LOGIN; nextIR = SEARCH_IR; });

describe("the user's search case, compiled", () => {
  it("SALESFORCE_FIXED_LOGIN on: '/' after login becomes the Lightning page, Search grounds, nothing is cut", async () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    nextIR = SEARCH_IR;
    const { ir } = await compile(`post-login-on-${Date.now()}`);
    const s5 = ir.steps.find((s: any) => s.id === "s5");
    expect(s5.target.url).toBe(LIGHTNING);
    expect(ir.meta.truncated).toBeFalsy();
    // Both Lightning-page targets are grounded against the Lightning page (a verified css is copied in).
    expect(ir.steps.find((s: any) => s.id === "s6")?.target).toMatchObject({ name: "Seller Home", css: "h1.slds-page-header__title" });
    expect(ir.steps.find((s: any) => s.id === "s7")?.target).toMatchObject({ name: "Search", css: "button.search-button" });
  });

  it("flag off: today's behaviour — '/' is the login page and the case is cut before Search", async () => {
    nextIR = SEARCH_IR;
    const { ir } = await compile(`post-login-off-${Date.now()}`);
    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.some((s: any) => s.id === "s7")).toBe(false);
  });
});

describe("redirectPostLoginNavigate", () => {
  const auth: any = { status: "authenticated", url: LIGHTNING, loginUrl: `${ORG}/` };
  const steps = () => [
    { id: "auth-0", action: "navigate", target: { url: `${ORG}/` } },
    { id: "s1", action: "navigate", target: { url: "/" } },
  ] as any[];

  it("same org, other host: moved to the absolute landed URL, only on a fixed-login Salesforce run", () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const st = steps();
    expect(withTargetApp("salesforce", () => redirectPostLoginNavigate(st, 1, auth, ORG))).toBe("s1");
    expect(st[1].target.url).toBe(LIGHTNING);
  });

  it("flag off, unticked, or another org's host: unchanged", () => {
    const off = steps();
    expect(withTargetApp("salesforce", () => redirectPostLoginNavigate(off, 1, auth, ORG))).toBeUndefined();
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const unticked = steps();
    expect(withTargetApp(null, () => redirectPostLoginNavigate(unticked, 1, auth, ORG))).toBeUndefined();
    const other = steps();
    const otherAuth = { ...auth, url: "https://another-org.scratch.lightning.force.com/one/one.app" };
    expect(withTargetApp("salesforce", () => redirectPostLoginNavigate(other, 1, otherAuth, ORG))).toBeUndefined();
    expect(other[1].target.url).toBe("/");
  });

  it("a same-host site (SauceDemo shape) keeps the old relative rewrite", () => {
    const st = [
      { id: "auth-0", action: "navigate", target: { url: "https://www.saucedemo.com/" } },
      { id: "s1", action: "navigate", target: { url: "/" } },
    ] as any[];
    const sauce: any = { status: "authenticated", url: "https://www.saucedemo.com/inventory.html", loginUrl: "https://www.saucedemo.com/" };
    expect(redirectPostLoginNavigate(st, 1, sauce, "https://www.saucedemo.com")).toBe("s1");
    expect(st[1].target.url).toBe("/inventory.html");
  });
});

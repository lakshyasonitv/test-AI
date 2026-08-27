import { describe, it, expect, vi } from "vitest";

/**
 * Regression: which page reaches the IR prompt.
 *
 * `toMicroModel` emits exactly ONE page, so the choice of lead page decides what the model can
 * see at all. Two silent fallbacks used to compound onto the same wrong answer:
 *
 *   1. ir.ts tested `p.url.includes(entryPath)` — with a bare-origin entry URL, `entryPath` is
 *      "/" and EVERY url contains "/", so the test matched whichever page happened to be first.
 *   2. `toMicroModel` was then handed the raw `entryUrl`, matched no page by `pageKey`, and fell
 *      back to `pages[0]` — the same wrong page, chosen a second time.
 *
 * Measured on three saved runs (2026-08-24T11-10-01, 2026-08-24T14-52-21, 2026-08-25T06-51-31),
 * all identical in shape: entry "https://learnvibes.vercel.app", pages /dashboard and /login,
 * case feature "Authentication". Both fallbacks picked /dashboard, so an Authentication case was
 * compiled with "Sign In", the email box and the password box absent from the prompt entirely —
 * while ir.ts's own relevance filter had correctly kept /login and then discarded it.
 *
 * The fixture below reproduces that shape exactly, including /dashboard being FIRST in the pages
 * array, because that ordering is what made the old code look correct.
 */

const HOST = "https://learnvibes.example";
const GROUNDED_IR = {
  meta: { feature: "Authentication", title: "Login with invalid credentials", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [{ id: "s1", action: "navigate", target: { url: "/login" } }],
};

const { geminiMock } = vi.hoisted(() => ({
  geminiMock: vi.fn(async () => ({
    content: JSON.stringify(GROUNDED_IR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
// The page pick happens before any browser work; live-extend would otherwise try to open one.
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m),
  refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");

/** /dashboard deliberately first — that is what the old fallback latched onto. */
const appModel: any = {
  baseUrl: HOST,
  pages: [
    {
      url: `${HOST}/dashboard`,
      title: "ThinkVibes LXP",
      concepts: ["Navigation", "Search", "User Profile"],
      elements: [
        { role: "button", name: "hamburger" },
        { role: "button", name: "Admin" },
        { role: "button", name: "Sign out" },
      ],
    },
    {
      url: `${HOST}/login`,
      title: "ThinkVibes LXP",
      concepts: ["Authentication", "Registration"],
      elements: [
        { role: "textbox", name: "you@thinkvibes.com" },
        { role: "textbox", name: "*********" },
        { role: "button", name: "Sign In" },
      ],
    },
  ],
};

const authCase: any = {
  title: "Login with invalid credentials", priority: "high", feature: "Authentication",
  steps: ["Go to /login", "Enter a wrong password", "Click Sign In"],
  expected: "An error is shown", category: "invalid-input", generatedFrom: "upfront",
  targetUrl: `${HOST}/login`,
};

/** toIR disk-caches on (testCase, sourcePrompt, appModel, creds); a static prompt would hit a
 *  previous run's entry and never call gemini, making every assertion here vacuous. */
const freshPrompt = () => `sign in check ${Date.now()}-${Math.random()}`;
const promptFor = async (testCase: any, entryUrl: string) => {
  geminiMock.mockClear();
  // The prompt is built and sent BEFORE the IR comes back and is validated, and this test is
  // about the prompt only — which page reached the model. Letting a downstream rule
  // (missingActions, grounding, assertion guards) fail the call would couple a page-pick test to
  // every validation rule in ir.ts, so the outcome is deliberately ignored and only the captured
  // prompt is asserted on. `toHaveBeenCalled` still guards the one failure that WOULD make this
  // vacuous: a disk-cache hit that skips the model entirely.
  await toIR(testCase, appModel, freshPrompt(), entryUrl).catch(() => undefined);
  expect(geminiMock).toHaveBeenCalled();
  return String(geminiMock.mock.calls[0][0]);
};

describe("toIR page pick — a bare-origin entry must not silently take pages[0]", () => {
  it("sends the login page for an Authentication case entered at the bare origin", async () => {
    const prompt = await promptFor(authCase, HOST);          // no path — the real-world shape
    expect(prompt).toContain("you@thinkvibes.com");
    expect(prompt).toContain("Sign In");
    expect(prompt).toContain("/login");
  });

  it("does not send the dashboard instead — the specific old failure", async () => {
    const prompt = await promptFor(authCase, HOST);
    // "hamburger" is unique to /dashboard, so its presence proves the wrong page was chosen.
    expect(prompt).not.toContain("hamburger");
  });

  it("still honours a case that targets the dashboard — the fix is not 'always pick the last page'", async () => {
    const dashCase = {
      ...authCase, feature: "Navigation", title: "Sign out works",
      targetUrl: `${HOST}/dashboard`,
    };
    const prompt = await promptFor(dashCase, HOST);
    expect(prompt).toContain("hamburger");
    expect(prompt).not.toContain("you@thinkvibes.com");
  });

  it("leaves an entry URL that HAS a path working as before", async () => {
    const prompt = await promptFor(authCase, `${HOST}/login`);
    expect(prompt).toContain("Sign In");
  });
});

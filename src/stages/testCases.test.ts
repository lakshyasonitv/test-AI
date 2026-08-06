import { describe, it, expect, vi, beforeEach } from "vitest";
import { toTestCases } from "./testCases.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";

// The gemini mock responds based on the systemInstruction it receives, so the
// fromPrompt flags on the returned cases genuinely depend on which fromPromptRule
// branch toTestCases selected — the assertions below prove the ternary works.
const h = vi.hoisted(() => ({ systemInstructions: [] as string[] }));

vi.mock("../llm/gemini.js", () => ({
  gemini: vi.fn(async (_prompt: string, opts: { systemInstruction?: string }) => {
    h.systemInstructions.push(opts.systemInstruction ?? "");
    const mustMint = /Exactly ONE case/.test(opts.systemInstruction ?? "");
    return JSON.stringify([
      {
        title: "Log in with valid credentials",
        priority: "high",
        feature: "Login",
        fromPrompt: mustMint,
        category: "valid",
        intent: "proves a real user can authenticate with the given credentials",
        checklistTitle: "Valid credentials",
        steps: ["Navigate to /login", "Fill 'Email' with 'user@test.com'", "Fill 'Password' with 'pass'", "Click 'Sign In'"],
        expected: "Login succeeds and the dashboard is shown",
      },
      {
        title: "Login with wrong password",
        priority: "medium",
        feature: "Login",
        fromPrompt: false,
        category: "invalid-input",
        intent: "proves a wrong password is rejected",
        steps: ["Navigate to /login", "Fill 'Email' with 'user@test.com'", "Fill 'Password' with 'wrong'", "Click 'Sign In'"],
        expected: "An error is shown and the user stays on the login page",
      },
    ]);
  }),
}));

// The cache key does not include mintPrimary, so two extend calls with the same
// plan/model/titles would collide — mock the cache out entirely for determinism.
vi.mock("../kb/llmCache.js", () => ({
  llmCacheGet: () => null,
  llmCacheSet: () => {},
  makeCacheKey: (...parts: string[]) => parts.join("|"),
}));

const plan: Plan = {
  goal: "Verify a user can log in and reach the dashboard",
  steps: ["Open the login page", "Log in with valid credentials", "Verify the dashboard is displayed"],
  testTypeScope: ["functional", "security"],
  coverage: "standard",
};

const appModel: AppModel = {
  baseUrl: "https://x.example",
  pages: [{
    url: "https://x.example/",
    concepts: ["Login"],
    elements: [
      { role: "textbox", name: "Email" },
      { role: "textbox", name: "Password" },
      { role: "button", name: "Sign In" },
    ],
  }],
};

beforeEach(() => {
  h.systemInstructions.length = 0;
  vi.clearAllMocks();
});

describe("toTestCases fromPrompt rule", () => {
  it("mints no primary on an extend call when mintPrimary is false", async () => {
    const cases = await toTestCases(plan, appModel, {
      existingTitles: ["Log in with valid credentials"],
      mintPrimary: false,
    });

    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every(c => c.fromPrompt === false)).toBe(true);
    expect(h.systemInstructions[0]).toContain('Never set "fromPrompt"');
  });

  it("mints exactly one primary on an extend call when mintPrimary is true", async () => {
    const cases = await toTestCases(plan, appModel, {
      existingTitles: ["Log in with valid credentials"],
      mintPrimary: true,
    });

    const primaries = cases.filter(c => c.fromPrompt === true);
    expect(primaries.length).toBe(1);
    expect(h.systemInstructions[0]).toContain("no primary case has been accepted yet");
    expect(h.systemInstructions[0]).toContain('must be tagged "fromPrompt": true');
  });

  it("still mints exactly one primary with no ExtendContext (original behavior)", async () => {
    const cases = await toTestCases(plan, appModel);

    const primaries = cases.filter(c => c.fromPrompt === true);
    expect(primaries.length).toBe(1);
    expect(h.systemInstructions[0]).toContain("Exactly ONE case");
  });
});

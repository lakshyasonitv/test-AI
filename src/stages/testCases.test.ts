import { describe, it, expect, vi, beforeEach } from "vitest";
import { toTestCases } from "./testCases.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";

// The gemini mock responds based on the systemInstruction it receives, so the
// fromPrompt flags on the returned cases genuinely depend on which fromPromptRule
// branch toTestCases selected — the assertions below prove the ternary works.
// The user prompt and cache keys are captured too, so we can assert a round's
// refinement prompt actually reaches the LLM and keys the cache.
const h = vi.hoisted(() => ({
  systemInstructions: [] as string[],
  userPrompts: [] as string[],
  cacheKeys: [] as string[],
}));

vi.mock("../llm/gemini.js", () => ({
  gemini: vi.fn(async (prompt: string, opts: { systemInstruction?: string }) => {
    h.userPrompts.push(prompt);
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
  llmCacheSet: (_key: string) => { h.cacheKeys.push(_key); },
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
  h.userPrompts.length = 0;
  h.cacheKeys.length = 0;
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

describe("toTestCases refinement prompt", () => {
  it("reaches the LLM user prompt with the latest refinement as an additive focus", async () => {
    await toTestCases(plan, appModel, {
      existingTitles: ["Log in with valid credentials"],
      rejectedTitles: [],
      mintPrimary: false,
      latestPrompt: "focus on empty-field and boundary checks",
    });

    const user = h.userPrompts[0];
    expect(user).toContain("focus on empty-field and boundary checks");
    expect(user).toContain("The user refined the request for this round");
  });

  it("keeps the round-1 prompt free of the focus block so first-batch behavior is unchanged", async () => {
    await toTestCases(plan, appModel, undefined, { sourcePrompt: "test login" });

    expect(h.userPrompts[0]).not.toContain("refined the request for this round");
  });

  it("keys the cache on the literal source prompt and refinement, so a rephrased or refined run never collides with a stale batch", async () => {
    await toTestCases(plan, appModel, undefined, { sourcePrompt: "test the search" });
    await toTestCases(plan, appModel, {
      existingTitles: [],
      rejectedTitles: [],
      mintPrimary: false,
      latestPrompt: "focus on empty fields",
    }, { sourcePrompt: "test the search" });

    // Two batches over the same plan/model/scope but different literal requests must NOT
    // share a cache entry — that shared key was the stale-suite bug.
    expect(h.cacheKeys).toHaveLength(2);
    expect(h.cacheKeys[0]).not.toBe(h.cacheKeys[1]);
    expect(h.cacheKeys[0]).toContain("test the search");
    expect(h.cacheKeys[1]).toContain("test the search");
    expect(h.cacheKeys[1]).toContain("focus on empty fields");
  });
});

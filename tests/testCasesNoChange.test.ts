import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * PROOF OF NO CHANGE for the standard case generator (Pro document intake, tests 1 and 2).
 *
 * Pro mode adds a SEPARATE generator (`proTestCases.ts`) and a router in front of both. The
 * promise that makes that safe is that `src/stages/testCases.ts` is never edited: with Pro off, a
 * run must send the model exactly the prompt it sends today and look up exactly the cache key it
 * looks up today — so suites cached before the feature existed are still served after it.
 *
 * That promise is checked here, not argued. The fixture under `tests/fixtures/proIntake/` was
 * captured from `toTestCases` on code that predates Pro, and these tests compare against it with
 * strict equality — not "contains", not a regex. Two call shapes are pinned, because the gate uses
 * both: round 1 (no extend context) and a later "not satisfied" round (accepted titles, rejected
 * titles, a refinement prompt, mintPrimary).
 *
 * DO NOT REGENERATE THE FIXTURE TO MAKE THIS PASS. A failure here means the standard path's prompt
 * or cache key changed — every suite cached before that change is now unreachable, and every
 * standard run now asks the model something different. That may be intended, but it is a decision
 * for a human, made knowingly, not a snapshot refresh.
 *
 * The model and the cache are mocked at their lowest layer (`gemini.js`, `llmCache.ts`'s get/set),
 * so the real `toTestCases`, the real `llm()` routing and the real `makeCacheKey` all run. Nothing
 * is read from or written to `runs/_cache`.
 */

const { geminiMock, cacheKeyCalls } = vi.hoisted(() => ({
  geminiMock: vi.fn(),
  cacheKeyCalls: [] as string[][],
}));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kb/llmCache.js")>();
  return {
    ...real,
    llmCacheGet: () => null,
    llmCacheSet: () => {},
    makeCacheKey: (...parts: string[]) => {
      cacheKeyCalls.push(parts);
      return real.makeCacheKey(...parts);
    },
  };
});

const { toTestCases } = await import("../src/stages/testCases.js");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "proIntake");
const readFixture = (name: string) =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as {
    system: string; user: string; cacheKeyParts: string[]; cacheKey: string;
  };

const appModel: AppModel = {
  baseUrl: "https://shop.example",
  pages: [
    {
      url: "https://shop.example/login",
      title: "Sign in",
      concepts: ["Login"],
      elements: [
        { role: "textbox", name: "Email" },
        { role: "textbox", name: "Password" },
        { role: "button", name: "Sign In" },
        { role: "link", name: "Forgot password?" },
      ],
    },
    {
      url: "https://shop.example/leads",
      title: "Leads",
      concepts: ["Leads", "Search"],
      elements: [
        { role: "searchbox", name: "Search leads" },
        { role: "button", name: "New Lead" },
        { role: "button", name: "Convert" },
        { role: "textbox", name: "Phone" },
      ],
    },
  ],
};

const plan: any = {
  goal: "Verify a sales user can convert a lead into an account.",
  steps: ["Log in", "Open the Leads page", "Convert a lead", "Verify the new account is shown"],
  testTypeScope: ["functional", "security"],
  coverage: "standard",
};

const SOURCE_PROMPT = "Log in as sales@shop.example / Hunter2! and convert the lead 'Acme Ltd'.";

const OK_CASE = {
  title: "Convert a lead", priority: "high", feature: "Leads", fromPrompt: true, category: "valid",
  intent: "proves a lead converts", whyItMatters: "If this breaks, sales cannot close deals.",
  targetUrl: "https://shop.example/leads", steps: ["Click the 'Convert' button."],
  expected: "The account is shown",
};

// Every env var the prompt or the key reads, pinned — the fixture must not depend on the shell.
const PINNED_ENV: Record<string, string | undefined> = {
  LLM_PROVIDER: undefined,
  LLM_PROVIDER_LITE: undefined,
  GEMINI_MODEL: "gemini-fixture-model",
  GEMINI_MODEL_LITE: undefined,
  LLM_CACHE_VERSION: undefined,
  MAX_LITE_ELEMENTS_PER_PAGE: undefined,
  MAX_LITE_FORMS_PER_PAGE: undefined,
  MAX_LITE_FORM_FIELDS: undefined,
  MAX_LITE_NAV_NODES_PER_PAGE: undefined,
  MAX_LITE_NAV_DEPTH: undefined,
  MAX_LITE_BUTTONS_PER_PAGE: undefined,
  MAX_LITE_HEADINGS_PER_PAGE: undefined,
};
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const [k, v] of Object.entries(PINNED_ENV)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  geminiMock.mockReset();
  geminiMock.mockResolvedValue({
    content: JSON.stringify([OK_CASE]),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  cacheKeyCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** Run toTestCases once and return exactly what it sent and what it keyed on. */
async function capture(extend?: Parameters<typeof toTestCases>[2]) {
  await toTestCases(plan, appModel, extend, { sourcePrompt: SOURCE_PROMPT });
  expect(geminiMock).toHaveBeenCalledTimes(1);
  const [user, opts] = geminiMock.mock.calls[0];
  expect(cacheKeyCalls).toHaveLength(1);
  const cacheKeyParts = cacheKeyCalls[0];
  const { makeCacheKey } = await vi.importActual<typeof import("../src/kb/llmCache.js")>("../src/kb/llmCache.js");
  return { system: opts.systemInstruction as string, user: user as string, cacheKeyParts, cacheKey: makeCacheKey(...cacheKeyParts) };
}

const ROUND_N_EXTEND = {
  existingTitles: ["Log in with the given credentials", "Search leads by name"],
  rejectedTitles: ["Login with SQL injection in the email field"],
  mintPrimary: false,
  latestPrompt: "Focus on what happens when the phone number is missing.",
};

describe("toTestCases is unchanged by Pro (test 1: the prompt)", () => {
  it("round 1 sends exactly the captured system instruction and user prompt", async () => {
    const got = await capture();
    const want = readFixture("toTestCases-round1.json");
    expect(got.system).toBe(want.system);
    expect(got.user).toBe(want.user);
  });

  it("a 'not satisfied' round sends exactly the captured system instruction and user prompt", async () => {
    const got = await capture(ROUND_N_EXTEND);
    const want = readFixture("toTestCases-roundN.json");
    expect(got.system).toBe(want.system);
    expect(got.user).toBe(want.user);
  });
});

describe("toTestCases is unchanged by Pro (test 2: the cache key)", () => {
  it("round 1 keys on exactly the captured eleven parts, in order", async () => {
    const got = await capture();
    const want = readFixture("toTestCases-round1.json");
    expect(got.cacheKeyParts).toHaveLength(11);
    expect(got.cacheKeyParts).toEqual(want.cacheKeyParts);
    expect(got.cacheKey).toBe(want.cacheKey);
  });

  it("a 'not satisfied' round keys on exactly the captured eleven parts, in order", async () => {
    const got = await capture(ROUND_N_EXTEND);
    const want = readFixture("toTestCases-roundN.json");
    expect(got.cacheKeyParts).toHaveLength(11);
    expect(got.cacheKeyParts).toEqual(want.cacheKeyParts);
    expect(got.cacheKey).toBe(want.cacheKey);
  });
});

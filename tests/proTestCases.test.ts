import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppModel } from "../src/schema/appModel.js";
import type { SpecModel } from "../src/schema/spec.js";

/**
 * The Pro generator and the two generators' shared cache-key contract (Pro tests 3 and 13).
 *
 * The model and the cache are mocked at their lowest layer (`gemini.js`, `llmCache.ts`'s get/set),
 * so the real prompt builders, the real `llm()` routing and the real `makeCacheKey` all run.
 */

const { geminiMock, keyCalls } = vi.hoisted(() => ({ geminiMock: vi.fn(), keyCalls: [] as string[][] }));
vi.mock("../src/llm/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gemini.js")>()),
  gemini: geminiMock,
}));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kb/llmCache.js")>();
  return {
    ...real,
    llmCacheGet: () => null,
    llmCacheSet: () => {},
    makeCacheKey: (...parts: string[]) => { keyCalls.push(parts); return real.makeCacheKey(...parts); },
  };
});

const { toTestCases, NoTestCasesError } = await import("../src/stages/testCases.js");
const { proTestCases, PRO_FAILURE_PREFIX } = await import("../src/stages/proTestCases.js");
const { makeCacheKey } = await vi.importActual<typeof import("../src/kb/llmCache.js")>("../src/kb/llmCache.js");

const appModel: AppModel = {
  baseUrl: "https://crm.example",
  pages: [{
    url: "https://crm.example/leads", title: "Leads", concepts: ["Leads"],
    elements: [{ role: "textbox", name: "Phone" }, { role: "button", name: "Convert" }],
  }],
};
const plan: any = { goal: "Convert a lead", steps: ["Open Leads", "Convert"], testTypeScope: ["functional"], coverage: "standard" };

const SPEC: SpecModel = {
  actors: ["Sales Manager"], entities: ["Lead"], actions: ["Convert a Lead"],
  rules: ["A Lead cannot convert without a phone number."],
  criteria: ["Converting shows a confirmation naming the new Account."],
  outOfScope: ["Refunds"],
  unresolved: ["Which currency?"],
  answers: [{ question: "Which currency?", answer: "INR" }],
};

const OK = [{
  title: "Convert a lead", priority: "high", feature: "Leads", fromPrompt: true, category: "valid",
  intent: "i", whyItMatters: "w", targetUrl: "https://crm.example/leads", steps: ["Click the 'Convert' button."], expected: "e",
}];
const answer = (o: unknown) => ({ content: JSON.stringify(o), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

const ENV = ["LLM_PROVIDER", "GEMINI_MODEL", "LLM_CACHE_VERSION"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.GEMINI_MODEL = "gemini-pro-test";
  geminiMock.mockReset();
  geminiMock.mockResolvedValue(answer(OK));
  keyCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

const EXTEND = { existingTitles: ["A"], rejectedTitles: ["B"], mintPrimary: true, latestPrompt: "focus on phone" };

async function keyParts(fn: () => Promise<unknown>): Promise<string[]> {
  keyCalls.length = 0;
  await fn();
  expect(keyCalls).toHaveLength(1);
  return keyCalls[0];
}

describe("cache-key dimension parity between the two generators (test 3)", () => {
  for (const [label, extend] of [["round 1", undefined], ["a 'not satisfied' round", EXTEND]] as const) {
    it(`${label}: Pro keys on the SAME eleven dimensions, in the same order, plus the spec`, async () => {
      const std = await keyParts(() => toTestCases(plan, appModel, extend, { sourcePrompt: "p" }));
      const pro = await keyParts(() => proTestCases(plan, appModel, extend, { sourcePrompt: "p", spec: SPEC }));

      // A twelfth dimension added to ONE generator changes this length relation and fails here.
      expect(std).toHaveLength(11);
      expect(pro).toHaveLength(std.length + 1);

      const SYSTEM = 7; // the `system` position — differs by design (Pro's instructions are longer)
      for (let i = 0; i < std.length; i++) {
        if (i === SYSTEM) continue;
        expect(pro[i], `dimension ${i} must be the same input in both keys`).toBe(std[i]);
      }
      expect(pro[SYSTEM].startsWith(std[SYSTEM].slice(0, 2000))).toBe(true);
      expect(pro[SYSTEM]).not.toBe(std[SYSTEM]);
      expect(pro[pro.length - 1]).toBe(JSON.stringify(SPEC));
    });
  }

  it("the same inputs never collide across the two generators", async () => {
    const std = await keyParts(() => toTestCases(plan, appModel, undefined, { sourcePrompt: "p" }));
    const pro = await keyParts(() => proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC }));
    expect(makeCacheKey(...pro)).not.toBe(makeCacheKey(...std));
  });
});

describe("two different specs give two different cache keys (test 13)", () => {
  it("changing only a rule changes the key", async () => {
    const a = await keyParts(() => proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC }));
    const b = await keyParts(() => proTestCases(plan, appModel, undefined, {
      sourcePrompt: "p", spec: { ...SPEC, rules: ["A Lead cannot convert without an email address."] },
    }));
    expect(makeCacheKey(...a)).not.toBe(makeCacheKey(...b));
  });

  it("changing only an answer changes the key", async () => {
    const a = await keyParts(() => proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC }));
    const b = await keyParts(() => proTestCases(plan, appModel, undefined, {
      sourcePrompt: "p", spec: { ...SPEC, answers: [{ question: "Which currency?", answer: "USD" }] },
    }));
    expect(makeCacheKey(...a)).not.toBe(makeCacheKey(...b));
  });
});

describe("what the Pro generator sends", () => {
  it("puts the rules, criteria, answers and out-of-scope list in the prompt; never the unanswered-question list as fact", async () => {
    await proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC });
    const [user, opts] = geminiMock.mock.calls[0];
    expect(user).toContain("A Lead cannot convert without a phone number.");
    expect(user).toContain("Converting shows a confirmation naming the new Account.");
    expect(user).toContain("Q: Which currency?");
    expect(user).toContain("A: INR");
    expect(user).toMatch(/Out of scope — write NO case for these:\n  - Refunds/);
    expect(opts.systemInstruction).toContain("NEVER write a case for anything listed as out of scope");
  });

  it("an unanswered question is absent — no Q/A line is invented for it", async () => {
    await proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: { ...SPEC, answers: [] } });
    expect(geminiMock.mock.calls[0][0]).not.toContain("Q: Which currency?");
  });

  it("still applies the shared correctness filters and schema (imported, not copied)", async () => {
    const cases = await proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC });
    expect(cases[0]).toMatchObject({ title: "Convert a lead", generatedFrom: "upfront" });
  });
});

describe("a Pro failure is labelled, and keeps its type", () => {
  it("an unusable answer fails with the Pro prefix", async () => {
    geminiMock.mockResolvedValue({ content: "not json", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    await expect(proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC }))
      .rejects.toThrow(PRO_FAILURE_PREFIX);
  });

  it("an empty answer is STILL a NoTestCasesError, so the orchestrator still saves the raw response", async () => {
    geminiMock.mockResolvedValue(answer([]));
    const err = await proTestCases(plan, appModel, undefined, { sourcePrompt: "p", spec: SPEC }).catch((e) => e);
    expect(err).toBeInstanceOf(NoTestCasesError);
    expect(err.message.startsWith(PRO_FAILURE_PREFIX)).toBe(true);
    expect(err.rawResponse).toBe("[]");
  });
});

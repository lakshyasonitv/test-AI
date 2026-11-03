import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { SpecModel } from "../src/schema/spec.js";

/**
 * PRO_STORY_PROMPT (TD-181): a vague prompt like "give test cases according to the story" used to
 * plan and explore nothing in particular, because only the case generator ever saw the story.
 *
 *   1. storyPromptText / storyPlanBlock — the two deterministic renderings of the confirmed spec.
 *   2. The planner reads the story when given one, keys on it, and is byte-identical without it.
 *   3. The browser fills an EMPTY prompt box, never overwrites typed text, and re-fills its own
 *      earlier fill — evaluated from public/app.js against a fake DOM (app.js has no module surface).
 *
 * The route field and the orchestrator wiring are pinned beside their neighbours, in
 * tests/specRoutes.test.ts and tests/proOrchestrator.test.ts.
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

const { storyPromptText, storyPlanBlock, STORY_PROMPT_MAX_CHARS } = await import("../src/stages/storyPrompt.js");
const { plan } = await import("../src/stages/planner.js");

const STORY: SpecModel = {
  actors: ["Sales Representative"],
  entities: ["Account"],
  actions: ["Create a new Account from the Accounts tab"],
  rules: ["Account Name is required."],
  criteria: ["Saving with only Account Name creates the Account and opens its record page."],
  outOfScope: ["Editing or deleting an Account"],
  unresolved: ["Which record type?"],
  answers: [{ question: "Which record type?", answer: "Default" }],
};
const EMPTY: SpecModel = { actors: [], entities: [], actions: [], rules: [], criteria: [], outOfScope: [], unresolved: [], answers: [] };

const ok = (o: unknown) => ({ content: JSON.stringify(o), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

beforeEach(() => {
  geminiMock.mockReset();
  geminiMock.mockResolvedValue(ok({ goal: "g", steps: ["s"] }));
  keyCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("storyPromptText — the prompt-box request", () => {
  it("is ONE short line: the objects, the first action, and how much more there is", () => {
    expect(storyPromptText(STORY)).toBe(
      "Test the uploaded requirements on Account: Create a new Account from the Accounts tab (2 checks)");
    expect(storyPromptText({ ...STORY, actions: [...STORY.actions, "Edit it", "View it"], entities: ["Case", "Report", "List View"] }))
      .toBe("Test the uploaded requirements on Case and Report: Create a new Account from the Accounts tab (+2 more, 2 checks)");
  });

  it("with no actions, the first check names the flow", () => {
    expect(storyPromptText({ ...EMPTY, rules: ["Name is required.", "Phone is optional."] }))
      .toBe("Test the uploaded requirements: Name is required. (+1 more check)");
    expect(storyPromptText({ ...EMPTY, criteria: ["Saving works."] })).toBe("Test the uploaded requirements: Saving works.");
  });

  it("is empty when the story names nothing to test — the browser then leaves the box alone", () => {
    expect(storyPromptText(EMPTY)).toBe("");
    expect(storyPromptText({ ...EMPTY, actors: ["Someone"], entities: ["Lead"] })).toBe("");
  });

  it("never carries the open questions, the answers, the actors or the out-of-scope list", () => {
    const text = storyPromptText(STORY);
    for (const t of ["Which record type?", "Default", "Sales Representative", "Editing or deleting"]) expect(text).not.toContain(t);
  });

  it("stays short however long the story is — the user's real story stays on one line", () => {
    const long = {
      ...STORY,
      actions: ["Create reports on the Case object including survey fields and a very long tail ".repeat(5), ..."abcde".split("").map((c) => `Action ${c}`)],
      entities: ["Case object with an extremely long descriptive name here", "Work Order", "Account"],
      rules: Array.from({ length: 50 }, (_, i) => `Rule ${i}`),
    };
    const text = storyPromptText(long);
    expect(text.length).toBeLessThanOrEqual(STORY_PROMPT_MAX_CHARS);
    expect(text).not.toContain("\n");
    expect(text).toContain("(+5 more, 51 checks)"); // 50 rules + STORY's one criterion
  });
});

describe("the planner reads the story", () => {
  async function planCall(story?: SpecModel) {
    keyCalls.length = 0;
    geminiMock.mockClear();
    await plan("give test cases according to the story", "https://org.example", "standard", story);
    return { key: keyCalls[0], user: geminiMock.mock.calls[0][0] as string };
  }

  it("with a story: the message carries it, and so does the key", async () => {
    const { key, user } = await planCall(STORY);
    expect(user).toContain("Plan the story's main flow.");
    expect(user).toContain("Create a new Account from the Accounts tab");
    expect(user).toContain("Out of scope — do NOT plan these:\n  - Editing or deleting an Account");
    expect(user).not.toContain("Which record type?");
    expect(key[key.length - 1]).toBe(storyPlanBlock(STORY));
  });

  it("without a story: the message and the key are exactly what they were", async () => {
    const { key, user } = await planCall(undefined);
    expect(key).toHaveLength(8);
    expect(user).toBe("Request: give test cases according to the story\nTarget URL: https://org.example\nCoverage: standard\nReturn JSON: { \"goal\": string, \"steps\": string[] }");
  });

  it("two different stories never share a cached plan", async () => {
    const { makeCacheKey } = await vi.importActual<typeof import("../src/kb/llmCache.js")>("../src/kb/llmCache.js");
    const a = (await planCall(STORY)).key;
    const b = (await planCall({ ...STORY, actions: ["Create a Contact"] })).key;
    const none = (await planCall(undefined)).key;
    expect(makeCacheKey(...a)).not.toBe(makeCacheKey(...b));
    expect(makeCacheKey(...a)).not.toBe(makeCacheKey(...none));
  });
});

// ------------------------------------------------------------------------------------------------
// The browser half, evaluated from public/app.js.

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function slice(from: string, to: string): string {
  const s = APP.indexOf(from);
  const e = APP.indexOf(to, s);
  expect(s, `${from} not found in app.js`).toBeGreaterThan(0);
  expect(e).toBeGreaterThan(s);
  return APP.slice(s, e);
}
// The two constants and the two functions, exactly as shipped.
const BROWSER_SRC =
  slice("const PRO_STORY_FILLED", "/**\n * After Continue") +
  slice("function proApplyStoryPrompt", "\nasync function proConfirm");

function browser(initialPrompt: string) {
  const promptEl = { value: initialPrompt, events: 0, dispatchEvent() { this.events++; } };
  const pro = { storyPrompt: "", storyNote: "", storyFilled: "" };
  const document = { getElementById: (id: string) => (id === "prompt" ? promptEl : null) };
  class Event { constructor(public type: string, public init?: unknown) {} }
  const api = new Function("pro", "document", "Event",
    `${BROWSER_SRC}\nreturn { proApplyStoryPrompt, proFillPrompt, PRO_STORY_FILLED, PRO_STORY_OFFER };`,
  )(pro, document, Event);
  return { promptEl, pro, ...api };
}

describe("the browser after Continue", () => {
  it("an EMPTY prompt box is filled from the story, with an input event, and says so", () => {
    const b = browser("   ");
    b.pro.storyPrompt = "Test the requirements…";
    b.proApplyStoryPrompt();
    expect(b.promptEl.value).toBe("Test the requirements…");
    expect(b.promptEl.events).toBe(1);
    expect(b.pro.storyNote).toBe(b.PRO_STORY_FILLED);
  });

  it("text the user typed is NEVER overwritten — the button is offered instead", () => {
    const b = browser("Create an Account and check it saves");
    b.pro.storyPrompt = "Test the requirements…";
    b.proApplyStoryPrompt();
    expect(b.promptEl.value).toBe("Create an Account and check it saves");
    expect(b.pro.storyNote).toBe(b.PRO_STORY_OFFER);
    // The button: an explicit click replaces it.
    b.proFillPrompt();
    expect(b.promptEl.value).toBe("Test the requirements…");
  });

  it("re-confirming edited rules refills our own earlier fill, but not once the user changed it", () => {
    const b = browser("");
    b.pro.storyPrompt = "first";
    b.proApplyStoryPrompt();
    b.pro.storyPrompt = "second";
    b.proApplyStoryPrompt();
    expect(b.promptEl.value).toBe("second");
    b.promptEl.value = "second, plus my own words";
    b.pro.storyPrompt = "third";
    b.proApplyStoryPrompt();
    expect(b.promptEl.value).toBe("second, plus my own words");
  });

  it("no promptText from the server (flag off) changes nothing at all", () => {
    const b = browser("");
    b.proApplyStoryPrompt();
    expect(b.promptEl.value).toBe("");
    expect(b.promptEl.events).toBe(0);
    expect(b.pro.storyNote).toBe("");
  });

  it("proConfirm takes promptText only as an optional field of the confirm response", () => {
    const confirm = slice("async function proConfirm", "\nfunction proRunOptions");
    expect(confirm).toContain('pro.storyPrompt = typeof body.promptText === "string" ? body.promptText : "";');
    expect(confirm).toContain("proApplyStoryPrompt();");
  });
});

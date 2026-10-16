import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Gap 5 / TD-136: the request's own values survive into the primary test case on a Salesforce run.
const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { requestValues, missingValues, restoreDroppedValues } = await import("../src/stages/requestValues.js");
const { toTestCases } = await import("../src/stages/testCases.js");
const { withTargetApp } = await import("../src/runTarget.js");

// The user's real short request (run 2026-10-15T18-02-40) and the case the model wrote for it.
const REQUEST = `Click Explore Projects, then View Project, then Select for EOI on an available unit, then Express Interest. Fill the 3-screen form with valid test data: Self Use as purpose, Buying Timeline "Later", Preferred Project "The Sanctuary", Preferred Areas "Abu Dhabi", Preferred Unit Type "Office". Submit and check that "Thank You" is shown.`;
const DROPPED: any = {
  title: "Express interest end-to-end with valid data (multi-screen)", priority: "high", feature: "EOI",
  category: "valid", fromPrompt: true, intent: "i", whyItMatters: "w", generatedFrom: "upfront",
  steps: [
    "Go to the '/' page.",
    "Click the 'Explore Projects' button to list projects.",
    "On a chosen project card, click the 'View Project' button to open the project details.",
    "Choose an available unit in the project and select it for Expression of Interest.",
    "Start the Express Interest process (initiate the multi-step interest form for the selected unit).",
    "On the first screen, type a real full name into the 'Full Name' field and click 'Next'.",
    "On the second screen, provide valid preference selections, then click the 'Next' button to continue.",
    "On the third screen, provide any requested property-specific details, then submit the completed interest form.",
    "Verify a Thank You or confirmation message is displayed.",
  ],
  expected: "A visible Thank You or confirmation message is shown after submitting the interest form.",
};
const REPAIRED = {
  steps: [
    ...DROPPED.steps.slice(0, 6),
    "On the second screen, click the 'Self Use' button, choose 'Later' in the 'Buying Timeline' field, then click the 'Next' button.",
    "On the third screen, choose 'The Sanctuary' in 'Preferred Project', 'Abu Dhabi' in 'Preferred Areas' and 'Office' in 'Preferred Unit Type', then submit.",
    "Verify the 'Thank You' message is displayed.",
  ],
  expected: "The 'Thank You' message is shown after submitting the interest form.",
};
const reply = (body: unknown) => ({ content: JSON.stringify(body), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

// Isolation: these tests share the on-disk cache (runs/_cache) with a running local server, so they
// must NEVER clear a namespace. Each test gets its own LLM_CACHE_VERSION, which every key here
// includes, so nothing written or read can meet the server's real entries (or another test's).
const savedCacheVersion = process.env.LLM_CACHE_VERSION;
const freshCacheVersion = () => { process.env.LLM_CACHE_VERSION = `test-${Date.now()}-${Math.random()}`; };
beforeEach(() => { geminiMock.mockReset(); freshCacheVersion(); });
afterAll(() => { if (savedCacheVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedCacheVersion; });

describe("requestValues", () => {
  it("takes every quoted value and multi-word name, drops the opening verb, never crosses a sentence", () => {
    expect(requestValues(REQUEST).sort()).toEqual([
      "Abu Dhabi", "Buying Timeline", "Explore Projects", "Express Interest", "Later", "Office",
      "Preferred Areas", "Preferred Project", "Preferred Unit Type", "Self Use", "Thank You", "The Sanctuary", "View Project",
    ].sort());
  });

  it("finds exactly what run 18-02-40's case dropped", () => {
    expect(missingValues(DROPPED, requestValues(REQUEST)).sort()).toEqual(
      ["Abu Dhabi", "Buying Timeline", "Later", "Office", "Preferred Areas", "Preferred Project", "Preferred Unit Type", "Self Use", "The Sanctuary"].sort());
  });
});

describe("restoreDroppedValues", () => {
  it("one repair call puts the values back, and code confirms nothing is still missing", async () => {
    geminiMock.mockResolvedValue(reply(REPAIRED));
    const { cases, fixed } = await restoreDroppedValues([DROPPED], REQUEST);
    expect(fixed).toBe(1);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(missingValues(cases[0], requestValues(REQUEST))).toEqual([]);
    expect(cases[0]).toMatchObject({ title: DROPPED.title, fromPrompt: true, category: "valid" });
  });

  it("a repair that loses a value the case had is rejected; the case is kept as written", async () => {
    geminiMock.mockResolvedValue(reply({ steps: REPAIRED.steps.map((s) => s.replace("'Explore Projects'", "the projects")), expected: REPAIRED.expected }));
    const { cases, fixed } = await restoreDroppedValues([DROPPED], REQUEST);
    expect(fixed).toBe(0);
    expect(cases[0]).toBe(DROPPED);
  });

  it("no call at all when nothing is missing, and only the fromPrompt case is ever repaired", async () => {
    const full = { ...DROPPED, ...REPAIRED };
    const other = { ...DROPPED, fromPrompt: false, title: "Other" };
    const { fixed } = await restoreDroppedValues([full, other], REQUEST);
    expect(fixed).toBe(0);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it("an accepted repair is cached: the same case and request cost no second call", async () => {
    geminiMock.mockResolvedValue(reply(REPAIRED));
    await restoreDroppedValues([DROPPED], REQUEST);
    await restoreDroppedValues([DROPPED], REQUEST);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });
});

describe("toTestCases restores dropped values on a Salesforce run only", () => {
  const HOST = "https://org.example.my.site.com";
  const appModel: any = { baseUrl: HOST, pages: [{ url: `${HOST}/`, title: "Home", concepts: ["EOI"], elements: [{ role: "button", name: "Explore Projects" }] }] };
  const PLAN = { goal: "g", steps: ["a"], testTypeScope: ["functionality"], coverage: "standard" } as any;
  const generated = [{ ...DROPPED, generatedFrom: undefined }];

  it("Salesforce run: the returned primary case carries every request value", async () => {
    geminiMock.mockImplementation(async (_u: string, o: any) => reply(/repair ONE QA test case/.test(o.systemInstruction) ? REPAIRED : generated));
    const cases = await withTargetApp("salesforce", () =>
      toTestCases(PLAN, appModel, undefined, { sourcePrompt: `${REQUEST} ${Date.now()}` }));
    expect(missingValues(cases[0], requestValues(REQUEST))).toEqual([]);
  });

  it("ordinary run: one call, the model's case returned as written", async () => {
    geminiMock.mockResolvedValue(reply(generated));
    const cases = await toTestCases(PLAN, appModel, undefined, { sourcePrompt: `${REQUEST} plain ${Date.now()}` });
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(cases[0].steps).toEqual(DROPPED.steps);
  });
});

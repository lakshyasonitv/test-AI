import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";

// Gap 1 (TD-137): the test-case writer sees the stored screen map on a Salesforce run, in the order
// a person reaches the screens, so a case crossing a multi-screen form puts each field on the screen
// that holds it. Run 2026-10-15T19-34-46 listed screen 3's Preferred Project/Areas/Unit Type under
// screen 2, and the IR stage spent two extra calls recovering. The fixture is the real map run
// 2026-10-15T17-50-49 stored for the EOI site (host and contact details replaced).

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { orderedScreens, screensForCases, SCREEN_MAP_NS, screenMapKey } = await import("../src/stages/screenMap.js");
const { toTestCases } = await import("../src/stages/testCases.js");
const { restoreDroppedValues } = await import("../src/stages/requestValues.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { llmCacheSet } = await import("../src/kb/llmCache.js");

const MAP = JSON.parse(readFileSync(new URL("./fixtures/screenMap/eoi-map.json", import.meta.url), "utf8"));
const HOST = "https://org.example.my.site.com";
const fresh = () => ({ ...MAP, screens: MAP.screens.map((s: any) => ({ ...s, lastSeen: new Date().toISOString() })) });

const savedFlag = process.env.SCREEN_MAP_ENABLED;
// Isolation: these tests share the on-disk cache (runs/_cache) with a running local server, so they
// must NEVER clear a namespace. Each test gets its own LLM_CACHE_VERSION, which every key here
// includes, so nothing written or read can meet the server's real entries (or another test's).
const savedCacheVersion = process.env.LLM_CACHE_VERSION;
const freshCacheVersion = () => { process.env.LLM_CACHE_VERSION = `test-${Date.now()}-${Math.random()}`; };
beforeEach(() => { geminiMock.mockReset(); freshCacheVersion(); });
afterAll(() => {
  if (savedFlag === undefined) delete process.env.SCREEN_MAP_ENABLED; else process.env.SCREEN_MAP_ENABLED = savedFlag;
  if (savedCacheVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedCacheVersion;
});

describe("orderedScreens / screensForCases", () => {
  it("orders the real EOI map the way a person reaches it, following the recorded clicks", () => {
    // Stored REVERSED, so the order can only come from following the clicks.
    const reversed = { ...MAP, screens: [...MAP.screens].reverse() };
    expect(orderedScreens(reversed).map((s: any) => s.key)).toEqual(
      ["5aac58ba815d", "8a5937275c1e", "e17c131be715", "b8b2751745d0", "779aae4b65a1"]);
  });

  it("a chain that starts mid-flow is followed by its clicks, not by how recently each screen was seen", () => {
    // No edge reaches the project page (two clicks led there, so none was recorded); its chain must
    // still come out in click order even when the later screens were seen in a different order.
    const age = { "5aac58ba815d": 0, "8a5937275c1e": 1, "779aae4b65a1": 2, "e17c131be715": 3, "b8b2751745d0": 4 } as Record<string, number>;
    const shuffled = { ...MAP, screens: MAP.screens.map((sc: any) => ({ ...sc, lastSeen: new Date(Date.UTC(2026, 9, 15, 18, 0, age[sc.key])).toISOString() })) };
    expect(orderedScreens(shuffled).map((sc: any) => sc.key)).toEqual(
      ["5aac58ba815d", "8a5937275c1e", "e17c131be715", "b8b2751745d0", "779aae4b65a1"]);
  });

  it("each form screen lists its OWN fields, with the click that opens it; the page around them is left out", () => {
    const block = screensForCases(MAP);
    const line = (n: number) => block.split("\n").find((l) => l.startsWith(`- Screen ${n} `))!;
    expect(line(3)).toMatch(/opened by clicking button "Express Interest".*textbox "Full Name".*textbox "Email Address"/);
    expect(line(4)).toMatch(/button "Self Use".*spinbutton "Min Budget \(AED\)".*combobox "Buying Timeline"/);
    expect(line(5)).toMatch(/combobox "Preferred Project".*combobox "Preferred Unit Type".*button "Submit"/);
    // Screen 3 must not carry screen 5's fields, and the chrome every screen of the URL repeats is gone.
    expect(line(3)).not.toMatch(/Preferred Project/);
    for (const n of [3, 4, 5]) expect(line(n)).not.toMatch(/Book a Viewing/);
    // Screen 2 is the project page the form opens over: everything on it is repeated on the form
    // screens, so nothing is "its own" and it keeps its full list — which is where the clicks live.
    expect(line(2)).toMatch(/button "Select for EOI".*button "Express Interest"/);
  });

  it("an empty map gives no block", () => {
    expect(screensForCases({ version: 2, site: "x", screens: [], edges: [] })).toBe("");
  });
});

describe("toTestCases shows the stored screens on a Salesforce run with the flag on", () => {
  const appModel: any = { baseUrl: HOST, pages: [{ url: `${HOST}/`, title: "Home", concepts: ["EOI"], elements: [{ role: "button", name: "Explore Projects" }] }] };
  const PLAN = { goal: "g", steps: ["a"], testTypeScope: ["functionality"], coverage: "standard" } as any;
  const reply = (body: unknown) => ({ content: JSON.stringify(body), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const CASES = [{ title: "t", priority: "high", feature: "EOI", category: "valid", fromPrompt: true, intent: "i", whyItMatters: "w",
    steps: ["Click the 'Explore Projects' button."], expected: "e" }];
  const casePrompt = async (salesforce: boolean, tag: string) => {
    geminiMock.mockReset();
    geminiMock.mockResolvedValue(reply(CASES));
    const go = () => toTestCases(PLAN, appModel, undefined, { sourcePrompt: `open a project ${tag} ${Date.now()}` });
    await (salesforce ? withTargetApp("salesforce", go) : go());
    return geminiMock.mock.calls[0][0] as string;
  };

  it("the case prompt carries the screens block, in reach order", async () => {
    process.env.SCREEN_MAP_ENABLED = "true";
    llmCacheSet(screenMapKey(HOST, undefined), fresh(), SCREEN_MAP_NS);
    const prompt = await casePrompt(true, "sf");
    expect(prompt).toContain("Screens of this application seen by an earlier run");
    expect(prompt.indexOf('combobox "Buying Timeline"')).toBeLessThan(prompt.indexOf('combobox "Preferred Project"'));
  });

  it("no block with the flag off, on an ordinary run, or for a map stored under a LOGIN (never shown here)", async () => {
    llmCacheSet(screenMapKey(HOST, undefined), fresh(), SCREEN_MAP_NS);
    delete process.env.SCREEN_MAP_ENABLED;
    expect(await casePrompt(true, "off")).not.toContain("Screens of this application");
    process.env.SCREEN_MAP_ENABLED = "true";
    expect(await casePrompt(false, "plain")).not.toContain("Screens of this application");
    freshCacheVersion(); // drop the anonymous map this test stored above
    llmCacheSet(screenMapKey(HOST, { username: "u@org.example", password: "pw-123456", secret: true } as any), fresh(), SCREEN_MAP_NS);
    expect(await casePrompt(true, "login-only")).not.toContain("Screens of this application");
  });

  it("the value repair gets the screens too, so a value lands on its own screen", async () => {
    const reqst = `Fill the form: Buying Timeline "Later", Preferred Project "The Sanctuary".`;
    const dropped: any = { ...CASES[0], steps: ["On the second screen, fill the preferences."], expected: "done" };
    geminiMock.mockResolvedValue(reply({ steps: dropped.steps, expected: "done" }));
    await restoreDroppedValues([dropped], reqst, screensForCases(MAP));
    expect(geminiMock.mock.calls[0][0]).toMatch(/Screen 5 .*combobox "Preferred Project"/);
  });
});

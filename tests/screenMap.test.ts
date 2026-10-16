import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";

// The persistent screen map (handoff Phase 2a), pure parts plus the disk round trip. The
// organisation dimension is mocked so two tenants can be told apart in one process.
const dim = vi.hoisted(() => ({ value: "azure:env" }));
vi.mock("../src/llm/llmContext.js", async (orig) => ({
  ...(await orig<typeof import("../src/llm/llmContext.js")>()),
  llmCacheDimension: () => dim.value,
}));

const m = await import("../src/stages/screenMap.js");
const { withRunId } = await import("../src/runContext.js");

const NOW = new Date("2026-10-15T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const SITE = "https://org.example.my.site.com";
const screen = (key: string, title: string, labels: string[], lastSeen = at(0), url = `${SITE}/form`): any => ({
  key, url, title, tab: "", labels, controls: labels.map((l) => ({ role: "textbox", name: l })), seen: 1, lastSeen,
});
const click = (name: string) => ({ role: "button", name });

// Isolation: these tests share the on-disk cache (runs/_cache) with a running local server, so they
// must NEVER clear a namespace. Each test gets its own LLM_CACHE_VERSION, which every key here
// includes, so nothing written or read can meet the server's real entries (or another test's).
const savedCacheVersion = process.env.LLM_CACHE_VERSION;
const freshCacheVersion = () => { process.env.LLM_CACHE_VERSION = `test-${Date.now()}-${Math.random()}`; };
beforeEach(() => { dim.value = "azure:env"; freshCacheVersion(); });
afterAll(() => { if (savedCacheVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedCacheVersion; });

describe("mergeIntoMap", () => {
  const base = m.mergeIntoMap(m.emptyScreenMap(SITE), [screen("a1", "details", ["full name", "email"])], []);

  it("the same screen captured again replaces the stored one and bumps seen", () => {
    // Same URL + title, most labels shared, different key: the loose same-screen rule.
    const again = m.mergeIntoMap(base, [screen("a2", "details", ["full name", "email", "phone"], at(5))], []);
    expect(again.screens).toHaveLength(1);
    expect(again.screens[0]).toMatchObject({ key: "a2", seen: 2, lastSeen: at(5) });
  });

  it("a different screen is added", () => {
    const more = m.mergeIntoMap(base, [screen("b1", "budget", ["min budget", "max budget"])], []);
    expect(more.screens.map((s) => s.key).sort()).toEqual(["a1", "b1"]);
  });

  it("edges are deduped by (from, action, to), and follow a screen whose key was replaced", () => {
    let map = m.mergeIntoMap(base, [screen("b1", "budget", ["min budget"])], [{ from: "a1", action: click("Next"), to: "b1" }]);
    map = m.mergeIntoMap(map, [], [{ from: "a1", action: click("Next"), to: "b1" }]);
    expect(map.edges).toEqual([{ from: "a1", action: click("Next"), to: "b1", seen: 2 }]);
    map = m.mergeIntoMap(map, [screen("a9", "details", ["full name", "email"], at(9))], []);
    expect(map.edges[0]).toMatchObject({ from: "a9", to: "b1" });
  });

  it("caps evict the least recently seen screens and edges", () => {
    const many = Array.from({ length: m.MAX_MAP_SCREENS + 5 }, (_, i) =>
      screen(`k${i}`, `screen ${i}`, [`field ${i}`], at(i), `${SITE}/p${i}`));
    const map = m.mergeIntoMap(m.emptyScreenMap(SITE), many, []);
    expect(map.screens).toHaveLength(m.MAX_MAP_SCREENS);
    expect(map.screens.map((s) => s.key)).not.toContain("k0");
    expect(map.screens.map((s) => s.key)).toContain(`k${m.MAX_MAP_SCREENS + 4}`);

    const two = m.mergeIntoMap(m.emptyScreenMap(SITE), [screen("x", "x", ["x"]), screen("y", "y", ["y"], at(0), `${SITE}/y`)], []);
    const edges = Array.from({ length: m.MAX_MAP_EDGES + 3 }, (_, i) => ({ from: "x", action: click(`b${i}`), to: "y" }));
    const capped = m.mergeIntoMap(two, [], edges);
    expect(capped.edges).toHaveLength(m.MAX_MAP_EDGES);
    expect(capped.edges[0].action.name).toBe("b3");
  });

  it("an expired screen is dropped on read, with its edges", () => {
    const map = m.mergeIntoMap(m.emptyScreenMap(SITE),
      [screen("old", "old", ["o"], at(-8 * 24 * 60), `${SITE}/o`), screen("new", "new", ["n"])],
      [{ from: "old", action: click("Go"), to: "new" }]);
    const fresh = m.withinTtl(map, NOW);
    expect(fresh.screens.map((s) => s.key)).toEqual(["new"]);
    expect(fresh.edges).toEqual([]);
  });
});

describe("stored per site, organisation and login", () => {
  const creds = { username: "tester@org.example", password: "S3cretPass!", secret: true };

  it("round-trips through the disk cache", () => {
    m.recordIntoScreenMap(SITE, creds, [screen("a1", "details", ["full name"])], [], NOW);
    expect(m.loadScreenMap(SITE, creds, NOW).screens.map((s) => s.key)).toEqual(["a1"]);
  });

  it("another organisation, another login or another site sees nothing", () => {
    m.recordIntoScreenMap(SITE, creds, [screen("a1", "details", ["full name"])], [], NOW);
    expect(m.loadScreenMap(SITE, { ...creds, username: "other@org.example" }, NOW).screens).toEqual([]);
    expect(m.loadScreenMap("https://elsewhere.my.site.com", creds, NOW).screens).toEqual([]);
    dim.value = "openai:org-b";
    expect(m.loadScreenMap(SITE, creds, NOW).screens).toEqual([]);
  });

  it("a control name carrying the password never reaches the stored map or the run artifact", () => {
    const leaky = { ...screen("a1", "details", ["full name"]), controls: [{ role: "heading", name: "Welcome S3cretPass!" }] };
    m.recordIntoScreenMap(SITE, creds, [leaky], [], NOW);
    expect(JSON.stringify(m.loadScreenMap(SITE, creds, NOW))).not.toContain("S3cretPass!");

    const runId = `screenmap-test-${Date.now()}`;
    try {
      withRunId(runId, () => m.writeRunScreenMap(SITE, creds, [leaky], []));
      const file = `runs/${runId}/09-screen-map.json`;
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).not.toContain("S3cretPass!");
    } finally { rmSync(`runs/${runId}`, { recursive: true, force: true }); }
  });

  it("outside a run nothing is written", () => {
    expect(() => m.writeRunScreenMap(SITE, creds, [], [])).not.toThrow();
  });
});

describe("edgeForCapture: an edge only when the click that opened the screen is unambiguous (v2)", () => {
  const click = (name: string) => ({ action: "click", target: { role: "button", name } });
  const fill = (name: string) => ({ action: "fill", target: { role: "textbox", name } });
  const nav = { action: "navigate", target: {} };

  it("one click since the previous screen: recorded, from that screen", () => {
    // form 1 began at step 3; Full Name, then Next; the new screen begins at step 5.
    const steps = [nav, click("Express Interest"), fill("Full Name"), click("Next")] as any[];
    expect(m.edgeForCapture([{ at: 2, key: "form1" }], steps, 4, "form2"))
      .toEqual({ from: "form1", action: { role: "button", name: "Next" }, to: "form2" });
  });

  it("from the entry page (no earlier capture): from is null", () => {
    expect(m.edgeForCapture([], [nav, click("Explore Projects")] as any[], 2, "projects")?.from).toBeNull();
  });

  it("a click that re-renders the screen it is on opens nothing (run 05-34-49's \"Self Use\")", () => {
    const steps = [nav, click("Next"), click("Self Use")] as any[];
    expect(m.edgeForCapture([{ at: 2, key: "form2" }], steps, 3, "form2")).toBeUndefined();
  });

  it("two clicks since the previous screen: which one changed it is unknown, so nothing", () => {
    const steps = [nav, click("Explore Projects"), click("View Project"), click("Select for EOI")] as any[];
    expect(m.edgeForCapture([{ at: 2, key: "home" }], steps, 4, "project")).toBeUndefined();
  });
});

describe("loadScreenMap drops a v1 map (its edges came from the old, wrong rule)", () => {
  it("v1 is ignored; v2 is read", async () => {
    const { llmCacheSet } = await import("../src/kb/llmCache.js");
    const site = `https://v1-${Date.now()}.example.my.site.com`;
    llmCacheSet(m.screenMapKey(site), { version: 1, site, screens: [screen("a", "a", ["a"])], edges: [] }, m.SCREEN_MAP_NS);
    expect(m.loadScreenMap(site, undefined, NOW).screens).toEqual([]);
    m.recordIntoScreenMap(site, undefined, [screen("a", "a", ["a"])], [], NOW);
    expect(m.loadScreenMap(site, undefined, NOW).screens).toHaveLength(1);
  });
});

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
const { llmCacheClear } = await import("../src/kb/llmCache.js");
const { withRunId } = await import("../src/runContext.js");

const NOW = new Date("2026-10-15T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const SITE = "https://org.example.my.site.com";
const screen = (key: string, title: string, labels: string[], lastSeen = at(0), url = `${SITE}/form`): any => ({
  key, url, title, tab: "", labels, controls: labels.map((l) => ({ role: "textbox", name: l })), seen: 1, lastSeen,
});
const click = (name: string) => ({ role: "button", name });

beforeEach(() => { dim.value = "azure:env"; llmCacheClear(m.SCREEN_MAP_NS); });
afterAll(() => llmCacheClear(m.SCREEN_MAP_NS));

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

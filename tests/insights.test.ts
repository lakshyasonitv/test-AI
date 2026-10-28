import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * D-69 — run insight logging. Pure helpers first, then the real orchestrator with plan, discovery
 * and the model mocked (the proOrchestrator.test.ts pattern): with EXTENDED_LOGGING on, `[insight]`
 * lines are printed and `10-insights.json` is written; with it off, neither. A planted secret in
 * the prompt and a session id in the URL's query must never reach either output.
 */

const { geminiMock, planMock, discoverSiteHybridMock, cache } = vi.hoisted(() => ({
  geminiMock: vi.fn(), planMock: vi.fn(), discoverSiteHybridMock: vi.fn(), cache: new Map<string, unknown>(),
}));
vi.mock("../src/llm/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gemini.js")>()),
  gemini: geminiMock,
}));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kb/llmCache.js")>()),
  llmCacheGet: (k: string, ns = "llm") => (cache.get(`${ns}/${k}`) as any) ?? null,
  llmCacheSet: (k: string, d: unknown, ns = "llm") => { cache.set(`${ns}/${k}`, d); },
}));
vi.mock("../src/stages/planner.js", () => ({ plan: planMock }));
vi.mock("../src/stages/hybridDiscovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/hybridDiscovery.js")>()),
  discoverSiteHybrid: discoverSiteHybridMock,
}));

const insights = await import("../src/insights.js");
const { runPipeline } = await import("../src/orchestrator.js");
const { generateSpec } = await import("../src/stages/generator.js");

const SECRET_PASSWORD = "Hunter2-Planted-9";
const SESSION = "SID-planted-00DXX";
const URL = `https://crm.example/app?sid=${SESSION}`;
const PLAN = { goal: "g", steps: ["log in"], testTypeScope: ["functional"], coverage: "standard" };
const APPMODEL = {
  baseUrl: "https://crm.example",
  pages: [{
    url: `https://crm.example/login?sid=${SESSION}`, title: "Login", concepts: ["Login"], crawlTimeMs: 1200,
    discoveryMethod: "dom",
    elements: [
      { role: "textbox", name: "Username", css: "#username", visible: true },
      { role: "textbox", name: "Password", css: "#password", visible: true },
      { role: "button", name: "Log In", visible: true },
      { role: "link", name: "Help", visible: false },
    ],
  }],
  auth: { status: "authenticated", url: "https://crm.example/home", loginUrl: `https://crm.example/login?sid=${SESSION}`,
    loginSteps: [{ action: "fill", css: "#username", credential: "username" }] },
};

let runId = "";
let logLines: string[] = [];
beforeEach(() => {
  runId = `test-run-insights-${Math.random().toString(16).slice(2, 10)}`;
  cache.clear();
  logLines = [];
  planMock.mockResolvedValue(PLAN);
  discoverSiteHybridMock.mockResolvedValue(APPMODEL);
  // The case generator gets an unusable answer, so the run ends at test cases — far enough to
  // exercise run-start, stage timing, plan, discovery and the run-end summary with no browser.
  geminiMock.mockResolvedValue({ content: "[]", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } });
  vi.spyOn(console, "log").mockImplementation((...a: any[]) => { logLines.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(path.join("runs", runId), { recursive: true, force: true });
  delete process.env.EXTENDED_LOGGING;
  geminiMock.mockReset(); planMock.mockReset(); discoverSiteHybridMock.mockReset();
  vi.restoreAllMocks();
});

const run = () => runPipeline(
  { prompt: `log in with username admin and password ${SECRET_PASSWORD}`, url: URL }, () => {}, runId,
).catch((e) => e);

describe("pure helpers", () => {
  it("safeUrl keeps origin + path only", () => {
    expect(insights.safeUrl(`https://a.example/x/y?sid=${SESSION}#frag`)).toBe("https://a.example/x/y");
    expect(insights.safeUrl("not a url")).toBe("(unparseable url)");
  });

  it("insightLine is one greppable line", () => {
    expect(insights.insightLine("r1", "discovery", {
      pages: 3, ok: true, roles: { button: 4, link: 2 }, list: ["a", "b"], note: "two words", none: undefined,
    })).toBe('[insight] run=r1 stage=discovery pages=3 ok=yes roles=button:4,link:2 list=a,b note="two words"');
  });

  it("appModelInsights counts elements, visibility, stable locators and login — no names", () => {
    const f = insights.appModelInsights(APPMODEL as any);
    expect(f).toMatchObject({
      pages: 1, elements: 4, visible: 3, hidden: 1, stableLocator: 2, stableLocatorPct: 50,
      authStatus: "authenticated", loginSteps: 1, loginUrl: "https://crm.example/login", crawlMsTotal: 1200,
    });
    expect(f.appModelBytes).toBeGreaterThan(100);
    expect(JSON.stringify(f)).not.toContain("Username");
  });

  it("specModelInsights sizes the Pro distilled rules", () => {
    const f = insights.specModelInsights({
      actors: ["Rep"], entities: ["Lead"], actions: [], rules: ["r1", "r2"], criteria: ["c"], outOfScope: [],
      unresolved: ["q"], answers: [],
    } as any);
    expect(f).toMatchObject({ rules: 2, criteria: 1, openQuestions: 1, actors: 1, entities: 1 });
    expect(f.specModelBytes).toBeGreaterThan(20);
  });

  it("specInsights reads a real generated spec: steps and helpers", () => {
    const spec = generateSpec({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://crm.example" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "https://crm.example/" } },
        { id: "s2", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
      ],
    } as any);
    const f = insights.specInsights(spec);
    expect(f.testSteps).toBe(2);
    expect(f.helpers).toContain("shot");
    expect(f.specBytes).toBe(Buffer.byteLength(spec));
  });

  it("execInsights reads per-step durations and the failing step", () => {
    const raw = { suites: [{ specs: [{ tests: [{ results: [{ status: "failed", duration: 900,
      steps: [{ duration: 100 }, { duration: 700 }, { duration: 50 }] }] }] }] }] };
    expect(insights.execInsights(raw, { failedStep: 2, error: "Timeout" })).toMatchObject({
      playwrightStatus: "failed", durationMs: 900, steps: 3, stepMs: [100, 700, 50], slowestStep: 2, failedStep: 2,
    });
  });

  it("insight() is a no-op with EXTENDED_LOGGING off", () => {
    insights.insight("x", { a: 1 }, "r-off");
    expect(logLines.filter((l) => l.startsWith("[insight]"))).toEqual([]);
    expect(insights._collectedFor("r-off")).toBeUndefined();
  });
});

describe("through the real orchestrator", () => {
  it("EXTENDED_LOGGING on: lines for each stage, 10-insights.json written, no secret anywhere", async () => {
    process.env.EXTENDED_LOGGING = "true";
    await run();
    const lines = logLines.filter((l) => l.startsWith("[insight]"));
    const stages = new Set(lines.map((l) => l.match(/ stage=(\S+)/)?.[1]));
    for (const s of ["run-start", "stage", "plan", "discovery-page", "discovery", "run-end"]) expect(stages).toContain(s);
    expect(lines.find((l) => l.includes("stage=discovery ")!)).toMatch(/elements=4 .*stableLocatorPct=50/);

    const file = path.join("runs", runId, "10-insights.json");
    expect(existsSync(file)).toBe(true);
    const json = readFileSync(file, "utf8");
    expect(JSON.parse(json).insights.some((r: any) => r.stage === "run-end")).toBe(true);

    for (const out of [lines.join("\n"), json]) {
      expect(out).not.toContain(SECRET_PASSWORD);
      expect(out).not.toContain(SESSION);
      expect(out).not.toContain("log in with username");
    }
  });

  it("EXTENDED_LOGGING off: no [insight] line and no 10-insights.json", async () => {
    await run();
    expect(logLines.filter((l) => l.startsWith("[insight]"))).toEqual([]);
    expect(existsSync(path.join("runs", runId, "10-insights.json"))).toBe(false);
  });
});

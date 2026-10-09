import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";

/**
 * The "This URL is a Salesforce org" checkbox now DOES something (D-51): a Salesforce run takes the
 * live walker whatever the global flag says, and gets Salesforce guidance appended to the planner,
 * test-case and IR system prompts. Two promises, both pinned here:
 *
 *   1. NOT a Salesforce run => nothing changes. Each stage's system prompt is byte-identical to a
 *      capture taken from the code BEFORE this change (fixtures/salesforceTarget/null-run-prompts.json),
 *      so its LLM cache key — which hashes the prompt — is unchanged too.
 *   2. A Salesforce run => the base prompt, then the guidance, and its own cache entries.
 *
 * The mocked layer is gemini.js, the one the stages ultimately call, so the real stage code, the
 * real cache-key construction and the real prompt assembly all run.
 */
const seen: Record<string, string[]> = {};
let stageNow = "";
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async (_u: string, o: any) => {
    (seen[stageNow] ??= []).push(o.systemInstruction);
    const body = stageNow === "plan" ? { goal: "g", steps: ["a"] }
      : stageNow === "cases" ? [{ title: "t", priority: "high", feature: "f", category: "valid", steps: ["s"], expected: "e", fromPrompt: true, intent: "i", whyItMatters: "w" }]
      : { meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://sf.example" },
          steps: [{ id: "s1", action: "navigate", target: { url: "/" } }] };
    return { content: JSON.stringify(body), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }),
}));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m), refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { withTargetApp } = await import("../src/runTarget.js");
const { plan } = await import("../src/stages/planner.js");
const { toTestCases } = await import("../src/stages/testCases.js");
const { toIR } = await import("../src/stages/ir.js");
const { SALESFORCE_GUIDANCE, salesforceGuidance } = await import("../src/stages/salesforceGuidance.js");
const { elementStrategy, domCacheKey, extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { siteCacheKey } = await import("../src/stages/hybridDiscovery.js");

const baseline: Record<"plan" | "cases" | "ir", string> =
  JSON.parse(readFileSync(new URL("./fixtures/salesforceTarget/null-run-prompts.json", import.meta.url), "utf8"));

const HOST = "https://sf.example";
const appModel: any = { baseUrl: HOST, pages: [{ url: `${HOST}/`, title: "Home", concepts: ["Login"], elements: [{ role: "button", name: "Go" }] }] };
const tc: any = { title: "t", priority: "high", feature: "f", category: "valid", steps: ["s"], expected: "e", fromPrompt: true, generatedFrom: "upfront", intent: "i", whyItMatters: "w" };
const PLAN = { goal: "g", steps: ["a"], testTypeScope: ["functionality"], coverage: "standard" } as any;

/** Run all three stages with a unique prompt, return the system prompt each one sent. */
async function runStages(tag: string): Promise<Record<"plan" | "cases" | "ir", string>> {
  const u = `${tag}-${Date.now()}-${Math.random()}`;
  for (const k of Object.keys(seen)) delete seen[k];
  stageNow = "plan"; await plan(u, `${HOST}/`);
  stageNow = "cases"; await toTestCases(PLAN, appModel, undefined, { sourcePrompt: u });
  stageNow = "ir"; await toIR(tc, appModel, u, `${HOST}/`);
  return { plan: seen.plan.at(-1)!, cases: seen.cases.at(-1)!, ir: seen.ir.at(-1)! };
}

const savedFlag = process.env.DISCOVERY_LIVE_DOM;
afterAll(() => { if (savedFlag === undefined) delete process.env.DISCOVERY_LIVE_DOM; else process.env.DISCOVERY_LIVE_DOM = savedFlag; });

describe("NOT a Salesforce run: prompts are byte-identical to before this change", () => {
  it("outside any run", async () => {
    const got = await runStages("plain");
    expect(got.plan).toBe(baseline.plan);
    expect(got.cases).toBe(baseline.cases);
    expect(got.ir).toBe(baseline.ir);
  });

  it("inside a run that explicitly has no target app", async () => {
    const got = await withTargetApp(null, () => runStages("null-app"));
    expect(got).toEqual(baseline);
  });

  it("salesforceGuidance is the empty string for every stage", () => {
    for (const stage of ["plan", "cases", "ir"] as const) expect(salesforceGuidance(stage)).toBe("");
  });
});

describe("a Salesforce run: base prompt + guidance, and its own cache entries", () => {
  it("each stage sends the unchanged base prompt followed by that stage's guidance", async () => {
    const got = await withTargetApp("salesforce", () => runStages("sf"));
    for (const stage of ["plan", "cases", "ir"] as const) {
      expect(got[stage], stage).toBe(baseline[stage] + SALESFORCE_GUIDANCE[stage]);
      expect(got[stage].startsWith(baseline[stage]), `${stage} must only APPEND`).toBe(true);
    }
  });

  it("the three guidance blocks are different, non-trivial and carry no URL or credential", () => {
    const g = SALESFORCE_GUIDANCE;
    expect(new Set([g.plan, g.cases, g.ir]).size).toBe(3);
    for (const stage of ["plan", "cases", "ir"] as const) {
      expect(g[stage].length, stage).toBeGreaterThan(800);
      expect(g[stage], `${stage} names a URL`).not.toMatch(/https?:\/\//i);
      expect(g[stage], `${stage} looks like it carries a credential`).not.toMatch(/password\s*[:=]|api[_-]?key|secret\s*[:=]/i);
    }
  });

  it("an ordinary run and a Salesforce run on identical inputs do NOT share an LLM cache entry", async () => {
    // Same plan input, run twice in each mode. If the keys ignored the target app the second mode's
    // call would be served from cache and the model would never be asked: one extra call per mode.
    const u = `shared-${Date.now()}`;
    const calls = async (fn: () => Promise<unknown>) => {
      seen.plan = []; stageNow = "plan"; await fn(); await fn(); return seen.plan.length;
    };
    const ordinary = await calls(() => plan(u, `${HOST}/`));
    expect(ordinary).toBe(1);            // second call is a cache hit
    const sf = await withTargetApp("salesforce", () => calls(() => plan(u, `${HOST}/`)));
    expect(sf).toBe(1);                  // a MISS on first (own key), then a hit — not zero calls
  });
});

describe("the live walker is selected by the checkbox", () => {
  it.each([
    [null, undefined, "cheerio"],
    [null, "false", "cheerio"],
    [null, "true", "live"],
    ["salesforce", undefined, "live"],
    ["salesforce", "false", "live"],
    ["salesforce", "true", "live"],
  ] as const)("target app %s, DISCOVERY_LIVE_DOM=%s -> %s", (app, flag, want) => {
    if (flag === undefined) delete process.env.DISCOVERY_LIVE_DOM; else process.env.DISCOVERY_LIVE_DOM = flag;
    expect(withTargetApp(app, () => elementStrategy())).toBe(want);
  });

  it("discovery cache keys follow the per-run strategy, and ordinary keys are unchanged", () => {
    delete process.env.DISCOVERY_LIVE_DOM;
    const ordinary = [domCacheKey("https://x.test/"), siteCacheKey("https://x.test/"),
      siteCacheKey("https://x.test/", { username: "u", password: "p" } as any)];
    expect(ordinary[0]).toBe("dom:https://x.test/");
    expect(ordinary[1]).toBe("site:https://x.test/");
    expect(ordinary[2]).toMatch(/^site:https:\/\/x\.test\/#auth=[0-9a-f]{12}$/);
    const sf = withTargetApp("salesforce", () => [domCacheKey("https://x.test/"), siteCacheKey("https://x.test/"),
      siteCacheKey("https://x.test/", { username: "u", password: "p" } as any)]);
    expect(sf[0]).toBe("dom-live:https://x.test/");
    expect(sf[1]).toBe("site:https://x.test/#live");
    expect(sf[2]).toBe(`${ordinary[2]}#live`);
    for (let i = 0; i < 3; i++) expect(sf[i]).not.toBe(ordinary[i]);
  });
});

describe("extractDomModelFromPage follows the checkbox (real browser)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    process.env.DISCOVERY_HYDRATION_POLL_MS = "0";
    browser = await chromium.launch(); page = await browser.newPage();
  });
  afterAll(async () => { await browser.close(); });

  const HTML = `<button id="a">Plain</button><div id="h"></div>
    <script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML = "<button>InShadow</button>";</script>`;

  it("an ordinary run, flag unset: static elements, no shadow content", async () => {
    delete process.env.DISCOVERY_LIVE_DOM;
    await page.setContent(HTML);
    const els = (await extractDomModelFromPage(page, "https://x.test/"))!.pages[0].elements;
    expect(els.map((e) => e.name)).toEqual(["Plain"]);
    expect(els.every((e) => e.visibleSource === undefined)).toBe(true);
  });

  it("a Salesforce run, flag unset: the live walker ran and sees the shadow content", async () => {
    delete process.env.DISCOVERY_LIVE_DOM;
    await page.setContent(HTML);
    const els = (await withTargetApp("salesforce", () => extractDomModelFromPage(page, "https://x.test/")))!.pages[0].elements;
    expect(els.map((e) => e.name)).toEqual(["Plain", "InShadow"]);
    expect(els.every((e) => e.visibleSource === "computed")).toBe(true);
  });
});

describe("the walker tags elements inside an open dialog (the Lightning modal case)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });
  const { enumerateLiveElements } = { enumerateLiveElements: (p: Page) => import("../src/stages/liveDomDiscovery.js").then((m) => m.enumerateLiveElements(p)) };

  it("separates the modal's Save from the page's Save, by section and dialog name", async () => {
    await page.setContent(`
      <button data-k="page-save">Save</button>
      <section role="dialog" aria-label="New Account">
        <label for="n">Account Name</label><input id="n" data-k="dlg-name">
        <button data-k="dlg-save">Save</button>
      </section>`);
    const els = await enumerateLiveElements(page);
    const saves = els.filter((e) => e.name === "Save");
    expect(saves).toHaveLength(2);
    const [pageSave, dlgSave] = saves;
    expect(pageSave.pageSection).toBeUndefined();
    expect(pageSave.containerRole).toBeUndefined();
    expect(dlgSave).toMatchObject({ pageSection: "dialog", containerRole: "dialog", containerName: "New Account" });
    expect(els.find((e) => e.name === "Account Name")).toMatchObject({ pageSection: "dialog", containerName: "New Account" });
  });

  it("names the dialog from aria-labelledby, including a dialog reached across a shadow boundary", async () => {
    await page.setContent(`
      <div id="host"></div>
      <script>
        const root = document.getElementById("host").attachShadow({ mode: "open" });
        root.innerHTML = '<h2 id="t">Edit Contact</h2><div role="dialog" aria-labelledby="t"><div id="inner"></div></div>';
        root.getElementById("inner").attachShadow({ mode: "open" }).innerHTML = '<button>Save</button>';
      </script>`);
    const els = await enumerateLiveElements(page);
    const save = els.find((e) => e.name === "Save")!;
    expect(save).toMatchObject({ pageSection: "dialog", containerRole: "dialog", containerName: "Edit Contact", inShadow: true });
  });

  it("an unnamed dialog is still tagged, without a containerName", async () => {
    await page.setContent(`<div role="dialog"><button>Go</button></div>`);
    const go = (await enumerateLiveElements(page)).find((e) => e.name === "Go")!;
    expect(go).toMatchObject({ pageSection: "dialog", containerRole: "dialog" });
    expect(go).not.toHaveProperty("containerName");
  });

  it("an ordinary page gains none of the container fields", async () => {
    await page.setContent(`<nav><a href="/x">X</a></nav><button>Y</button>`);
    for (const e of await enumerateLiveElements(page)) {
      expect(e).not.toHaveProperty("pageSection");
      expect(e).not.toHaveProperty("containerRole");
      expect(e).not.toHaveProperty("containerName");
    }
  });
});

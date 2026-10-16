import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";

// The screen map across runs (handoff Phase 2b), end to end in a real Chromium. Only the LLM is
// mocked: it writes the right field name only when its prompt NAMES that field, as a model that has
// never seen screen 2 cannot. Run 1 learns screen 2 through a retry; run 2 should know it at once.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { withRunId } = await import("../src/runContext.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");
const { SCREEN_MAP_NS } = await import("../src/stages/screenMap.js");

/** Screen 1: Full Name + Next. Screen 2, same URL: Min Budget (a spinbutton, as on the real site) + Submit. */
const FORM = `<!doctype html><html><head><title>Form</title></head><body><main><div id="f"></div><p id="out"></p></main>
<script>
  const f = document.getElementById("f");
  f.innerHTML = '<h2>Your details</h2><label>Full Name <input id="fn"></label><button type="button" id="n1">Next</button>';
  document.getElementById("n1").onclick = () => {
    f.innerHTML = '<h2>Budget</h2><label>Min Budget <input id="min" type="number"></label><button type="button" id="go">Submit</button>';
    document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "sent"; };
  };
</script></body></html>`;

let server: http.Server;
let base = "";
const savedFlag = process.env.SCREEN_MAP_ENABLED;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(FORM); else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.SCREEN_MAP_ENABLED; else process.env.SCREEN_MAP_ENABLED = savedFlag;
  if (savedCacheVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedCacheVersion;
  return new Promise<void>((r) => server.close(() => r()));
});
// Isolation: these tests share the on-disk cache (runs/_cache) with a running local server, so they
// must NEVER clear a namespace. Each test gets its own LLM_CACHE_VERSION, which every key here
// includes, so nothing written or read can meet the server's real entries (or another test's).
const savedCacheVersion = process.env.LLM_CACHE_VERSION;
const freshCacheVersion = () => { process.env.LLM_CACHE_VERSION = `test-${Date.now()}-${Math.random()}`; };
beforeEach(() => { geminiMock.mockReset(); freshCacheVersion(); });

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const testCase: any = { title: "Form", priority: "high", feature: "Form", steps: ["Fill both screens and submit"],
  expected: "sent", category: "valid", generatedFrom: "upfront" };
const irPrompts = () => geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));
const ir = (minName: string) => ({
  meta: { feature: "Form", title: "Form", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/form" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ann" },
    { id: "s3", action: "click", target: { role: "button", name: "Next" } },
    { id: "s4", action: "wait", value: "300" },
    { id: "s5", action: "fill", target: { role: "spinbutton", name: minName }, value: "40" },
    { id: "s6", action: "click", target: { role: "button", name: "Submit" } },
  ],
});
/** Right name only when the prompt names it — a model can't know screen 2 otherwise. */
const model = async (prompt: string, opts: any) =>
  /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
    ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
    : reply(ir(/spinbutton "Min Budget"/.test(prompt) ? "Min Budget" : "Budget Range"));

async function discover() {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(base + "/form");
    await page.waitForTimeout(300);
    return await withTargetApp("salesforce", () => extractDomModelFromPage(page, base + "/form"));
  } finally { await browser.close(); }
}

/** One Salesforce compile as run `runId`; returns its IR prompts, logs and result. */
async function compile(runId: string) {
  geminiMock.mockReset();
  geminiMock.mockImplementation(model);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: any[]) => { logs.push(a.join(" ")); });
  try {
    const appModel = await discover();
    const { ir: out } = await withRunId(runId, () => withTargetApp("salesforce", () =>
      toIR(testCase, appModel, `screen map ${runId} ${Math.random()}`, base + "/form")));
    return { prompts: irPrompts(), logs, out };
  } finally { spy.mockRestore(); }
}

const runs: string[] = [];
const runId = (tag: string) => { const id = `screenmap-${tag}-${Date.now()}`; runs.push(id); return id; };
afterAll(() => { for (const r of runs) rmSync(`runs/${r}`, { recursive: true, force: true }); });

describe("the screen map across runs (SCREEN_MAP_ENABLED, Salesforce run)", () => {
  it("run 2's FIRST prompt already names screen 2, so it compiles in fewer IR calls", async () => {
    process.env.SCREEN_MAP_ENABLED = "true";
    const first = await compile(runId("one"));
    expect(first.prompts.length).toBeGreaterThanOrEqual(2);              // learned screen 2 by retrying
    expect(first.prompts[0]).not.toMatch(/Min Budget/);
    const artifact = JSON.parse(readFileSync(`runs/${runs.at(-1)}/09-screen-map.json`, "utf8"));
    expect(JSON.stringify(artifact)).toContain('"name":"Min Budget"');
    expect(artifact.edges).toEqual([expect.objectContaining({ action: { role: "button", name: "Next" } })]);
    expect(JSON.stringify(artifact)).not.toMatch(/"css"|#min/);           // names only, never selectors

    const second = await compile(runId("two"));
    expect(second.prompts[0]).toMatch(/spinbutton "Min Budget"[^\n]*opened by clicking button "Next"[^\n]*from an earlier run/);
    expect(second.prompts.length).toBeLessThan(first.prompts.length);
    expect(second.logs.some((l) => /\[ir\] screen map predicts: button "Next" -> "budget"/i.test(l))).toBe(true);
    expect(second.out.meta.truncated ?? false).toBe(false);
  }, 300_000);

  it("flag off: the first prompt has no screens block and no 09-screen-map.json is written", async () => {
    process.env.SCREEN_MAP_ENABLED = "true";
    await compile(runId("seed"));                                         // a map exists...
    delete process.env.SCREEN_MAP_ENABLED;                                // ...but the flag is off
    const off = await compile(runId("off"));
    expect(off.prompts[0]).not.toMatch(/Screens of this application|Screens your earlier steps/);
    expect(existsSync(`runs/${runs.at(-1)}/09-screen-map.json`)).toBe(false);
  }, 300_000);

  it("Pro's options.spec cannot change screenMode: the target app is entered from options.targetApp alone", () => {
    const orch = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
    expect(orch.match(/enterWithTargetApp\(/g)).toHaveLength(1);
    expect(orch).toContain("enterWithTargetApp(options?.targetApp ?? null)");
  });
});

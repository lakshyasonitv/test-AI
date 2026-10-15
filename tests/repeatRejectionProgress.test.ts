import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// TD-74, made progress-aware on Salesforce runs (handoff Phase 1c, Fix A). A target rejected a
// second time stops the retries only when the repeat carries no new information: the target was
// never grounded in any attempt AND this attempt got no further than when it was last rejected.
//
// Same harness as selectOnTextbox.test.ts: only the LLM is mocked, and it answers attempt by
// attempt from a script; discovery, screen captures and grounding are the real code in Chromium.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

/** Screen 1: Full Name + Next. Screen 2 (same URL): Min Budget + Submit. */
const FORM = `<!doctype html><html><head><title>Form</title></head><body><main><div id="f"></div><p id="out"></p></main>
<script>
  const f = document.getElementById("f");
  f.innerHTML = '<h2>Your details</h2><label>Full Name <input id="fn"></label><button type="button" id="n1">Next</button>';
  document.getElementById("n1").onclick = () => {
    f.innerHTML = '<h2>Budget</h2><label>Min Budget <input id="min"></label><button type="button" id="go">Submit</button>';
    document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "sent"; };
  };
</script></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(FORM);
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => geminiMock.mockReset());

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const unique = () => `repeat-progress ${Date.now()}-${Math.random()}`;
const testCase: any = { title: "Form", priority: "high", feature: "Form", steps: ["Fill both screens and submit"],
  expected: "sent", category: "valid", generatedFrom: "upfront" };
const irPrompts = () => geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));
const ir = (steps: any[]) => ({ meta: { feature: "Form", title: "Form", priority: "high", sourcePrompt: "p", baseUrl: base }, steps });

const nav = { id: "s1", action: "navigate", target: { url: "/form" } };
const name = { id: "s2", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ann" };
const next = { id: "s3", action: "click", target: { role: "button", name: "Next" } };
const wait = { id: "s4", action: "wait", value: "300" };
const min = (id: string) => ({ id, action: "fill", target: { role: "textbox", name: "Min Budget" }, value: "40" });
const ghost = (id: string) => ({ id, action: "click", target: { role: "button", name: "Ghost" } });
const submit = { id: "s9", action: "click", target: { role: "button", name: "Submit" } };
const complete = ir([nav, name, next, wait, min("s5"), submit]);

/** Answers attempt N (1-based) with script[N-1], repeating the last entry. */
const scripted = (script: any[]) => async (_prompt: string, opts: any) => {
  if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
    return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
  }
  return reply(script[Math.min(irPrompts().length, script.length) - 1]);
};

async function discover() {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(base + "/form");
    await page.waitForTimeout(300);
    return await withTargetApp("salesforce", () => extractDomModelFromPage(page, base + "/form"));
  } finally { await browser.close(); }
}

async function compile(script: any[], salesforce = true) {
  const model = await discover();
  geminiMock.mockImplementation(scripted(script));
  const go = () => toIR(testCase, model, unique(), base + "/form");
  const { ir: out } = salesforce ? await withTargetApp("salesforce", go) : await go();
  return { out, attempts: irPrompts().length };
}

describe("a repeated rejection stops only when it carries no new information (Salesforce, Phase 1c)", () => {
  it("retries when the rejected target was grounded in an earlier attempt (it exists)", async () => {
    // 1: Min Budget before opening screen 2 → rejected. 2: Min Budget grounded, Ghost rejected.
    // 3: the attempt-1 mistake again → old TD-74 stopped here. 4: complete.
    const early = ir([nav, min("s2")]);
    const { out, attempts } = await compile([early, ir([nav, name, next, wait, min("s5"), ghost("s6")]), early, complete]);
    expect(attempts).toBe(4);
    expect(out.meta.truncated ?? false).toBe(false);
  }, 240_000);

  it("retries when the same target is rejected again but this attempt got further", async () => {
    // 1: Ghost after 1 grounded step. 2: Ghost after 4 grounded steps (waits not counted). 3: complete.
    const { out, attempts } = await compile([ir([nav, ghost("s2")]), ir([nav, name, next, wait, min("s5"), ghost("s6")]), complete]);
    expect(attempts).toBe(3);
    expect(out.meta.truncated ?? false).toBe(false);
  }, 240_000);

  it("still stops when the target was never grounded and nothing got further (TD-74 kept)", async () => {
    // Ghost twice after the same grounded steps; the second only adds a wait (run 16-39-13's shape).
    const a = ir([nav, name, ghost("s3")]);
    const b = ir([nav, name, { ...wait, id: "s3" }, ghost("s4")]);
    const { out, attempts } = await compile([a, b, complete]);
    expect(attempts).toBe(2);
    expect(out.meta.truncated).toBe(true);
  }, 240_000);

  it("an ordinary (non-Salesforce) run keeps the old rule: the same target twice stops", async () => {
    // The same "got further" shape as the Salesforce case above (Next is grounded on an ordinary run).
    const { out, attempts } = await compile([ir([nav, ghost("s2")]), ir([nav, { ...next, id: "s2" }, ghost("s3")]), complete], false);
    expect(attempts).toBe(2);
    expect(out.meta.truncated).toBe(true);
  }, 240_000);
});

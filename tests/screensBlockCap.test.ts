import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// The retry prompt's screens block (TD-122) is capped (handoff Phase 1b): at most 8 screens, the
// newest kept, and when the prompt is over MAX_CHARS the oldest screens go before any page does.
//
// Same harness as selectOnTextbox.test.ts: only the LLM is mocked; discovery, the screen captures
// and grounding are the real code in a real Chromium. The wizard has 10 screens on ONE URL, so a
// case that reaches screen 10 has captured 9 screens (2..10) by the time it is retried.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

const SCREENS = 10;
/** `long`: 30 extra long-named text boxes per screen, so 8 screens' names exceed MAX_CHARS. */
const WIZARD = (long: boolean) => `<!doctype html><html><head><title>Wizard</title></head>
<body><main><div id="f"></div></main>
<script>
  const f = document.getElementById("f");
  const pad = (n) => ${long}
    ? Array.from({ length: 30 }, (_, k) => '<label>Screen ' + n + ' additional detail field number ' + k +
        ' with a deliberately long accessible name to fill the prompt <input></label>').join("")
    : "";
  function show(n) {
    f.innerHTML = '<h2>Step ' + n + '</h2><label>Field ' + n + ' <input id="x' + n + '"></label>' + pad(n) +
      (n < ${SCREENS} ? '<button type="button" id="n' + n + '">Next</button>' : '<button type="button">Finish</button>');
    if (n < ${SCREENS}) document.getElementById("n" + n).onclick = () => show(n + 1);
  }
  show(1);
</script></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/wizard")) res.end(WIZARD(req.url.includes("long")));
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => geminiMock.mockReset());

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const unique = () => `screens-cap ${Date.now()}-${Math.random()}`;
const testCase: any = { title: "Wizard", priority: "high", feature: "Wizard", steps: ["Fill every step and finish"],
  expected: "Finished", category: "valid", generatedFrom: "upfront" };
const BLOCK = /Screens your earlier steps reached in a live run[^\n]*\n((?:- [^\n]*\n)+)/;
const irPrompts = () => geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));

/** Screens 1..9: fill, Next, wait. Screen 10: a field named `last`. */
const wizardIr = (path: string, last: string) => ({
  meta: { feature: "Wizard", title: "Wizard", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s0", action: "navigate", target: { url: path } },
    ...Array.from({ length: SCREENS - 1 }, (_, i) => [
      { id: `f${i + 1}`, action: "fill", target: { role: "textbox", name: `Field ${i + 1}` }, value: "x" },
      { id: `n${i + 1}`, action: "click", target: { role: "button", name: "Next" } },
      { id: `w${i + 1}`, action: "wait", value: "300" },
    ]).flat(),
    { id: "f10", action: "fill", target: { role: "textbox", name: last }, value: "x" },
    { id: "fin", action: "click", target: { role: "button", name: "Finish" } },
  ],
});

/** Discovery's first screen, as a Salesforce run captures it (live walker). */
async function discover(path: string) {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(base + path);
    await page.waitForTimeout(300);
    return await withTargetApp("salesforce", () => extractDomModelFromPage(page, base + path));
  } finally { await browser.close(); }
}

/** First answer names a field that is not there; once the block names "Field 10", the fix. */
const answer = (path: string) => async (prompt: string, opts: any) => {
  if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
    return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
  }
  return reply(wizardIr(path, /textbox "Field 10"/.test(BLOCK.exec(prompt)?.[1] ?? "") ? "Field 10" : "Budget Range"));
};

async function run(path: string, model: any) {
  const logs: string[] = [];
  const keep = (...a: any[]) => { logs.push(a.join(" ")); };
  const spyLog = vi.spyOn(console, "log").mockImplementation(keep);
  const spyWarn = vi.spyOn(console, "warn").mockImplementation(keep);
  try {
    geminiMock.mockImplementation(answer(path));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase, model, unique(), base + path));
    return { ir, logs };
  } finally { spyLog.mockRestore(); spyWarn.mockRestore(); }
}

describe("the retry's screens block is capped (Salesforce run, handoff Phase 1b)", () => {
  it("9 captured screens: the block keeps the 8 newest, and the fix grounds", async () => {
    const { ir, logs } = await run("/wizard", await discover("/wizard"));

    const prompts = irPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    const lines = BLOCK.exec(prompts[1])![1].trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toContain('textbox "Field 10"');     // newest kept...
    expect(lines[0]).toContain('textbox "Field 3"');           // ...screens 3..10
    expect(prompts[1]).not.toMatch(/textbox "Field 2"/);       // the oldest (screen 2) dropped
    expect(logs).toContain(`[ir] screens block: 8 screens, ${BLOCK.exec(prompts[1])![0].length + 1} chars`);
    expect(ir.meta.truncated ?? false).toBe(false);
  }, 300_000);

  it("over MAX_CHARS: the oldest screens are dropped before any page", async () => {
    const model = await discover("/wizard?long=1");
    // A second page the prompt could drop, so "before any page" is a real choice, not a no-op.
    model.pages.push({ url: `${base}/other`, title: "Other", concepts: ["Wizard"], elements: [{ role: "button", name: "Other" }] } as any);
    const { logs } = await run("/wizard?long=1", model);

    const retry = irPrompts()[1];
    expect(retry.length).toBeLessThanOrEqual(30_000);
    const lines = BLOCK.exec(retry)![1].trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(8);
    expect(lines.at(-1)).toContain('textbox "Field 10"');      // the newest survives
    const screenDrops = logs.filter((l) => /dropped the oldest captured screen/.test(l));
    expect(screenDrops.length).toBe(8 - lines.length);
    expect(logs.some((l) => /dropped to \d+ page\(s\)/.test(l))).toBe(false);
    expect(logs).toContain(`[ir] screens block: ${lines.length} screens, ${BLOCK.exec(retry)![0].length + 1} chars`);
  }, 300_000);
});

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// A `select` step aimed at a TEXT BOX (TD-125), end to end in a real browser.
//
// Run 2026-10-14T04-27-15-943Z-9a9cf014, a Salesforce Experience site: the request said "In the
// Min Budget (AED) combobox, select 40", but on screen 2 of the form (same URL) Min/Max Budget are
// <input>s. The model followed the wording — `select` on combobox "Min Budget (AED)" — grounding
// found only a textbox, rejected the step twice, and TD-74 shipped the case truncated.
//
// Same harness as multiScreenWizard.test.ts: only the LLM is mocked (a fixed IR); discovery, the
// screen captures and grounding are the real code in a real Chromium, and the final IR is EXECUTED
// with the real live resolver (D-19).

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { runStepLive } = await import("../src/stages/liveExtend.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

/**
 * The real form's screen 2, behind a "Next" that swaps the DOM without changing the URL.
 *   both:   the screen ALSO has a real <select> named "Min Budget (AED)" — the dropdown must win
 *   dupSelf: two buttons both named "Self Use" — no way to tell which one "select Self Use" means
 *   single: the fields are on the entry page itself, no Next (for the ordinary-run comparison)
 */
const BUDGET = (o: { both?: boolean; dupSelf?: boolean; single?: boolean; num?: boolean }) => {
  // num: the budgets are <input type="number"> (role spinbutton), as on the real site.
  const ty = o.num ? ' type="number"' : "";
  const screen2 =
    (o.both ? `<label>Min Budget (AED) <select id="minsel"><option>10</option><option>40</option></select></label>` : "") +
    `<label>Min Budget (AED) <span>AED</span><input id="min"${ty} placeholder="1,000,000"></label>` +
    `<label>Max Budget (AED) <span>AED</span><input id="max"${ty} placeholder="5,000,000"></label>` +
    `<label>Buying Timeline <select id="when"><option>Now</option><option>Later</option></select></label>` +
    `<div role="group" aria-label="Purpose"><button type="button" id="self">Self Use</button>` +
    (o.dupSelf ? `<button type="button" id="self2">Self Use</button>` : "") +
    `<button type="button" id="inv">Investment</button></div>` +
    `<button type="button" id="go">Submit</button>`;
  return `<!doctype html><html><head><title>Express Interest</title></head>
<body><main><h2>Express Interest</h2><div id="f"></div><p id="out"></p></main>
<script>
  const f = document.getElementById("f");
  let purpose = "";
  function s2() {
    f.innerHTML = ${JSON.stringify(screen2)};
    for (const b of f.querySelectorAll("[role=group] button")) b.onclick = () => { purpose = b.textContent; };
    document.getElementById("go").onclick = () => {
      document.getElementById("out").textContent = "min=" + document.getElementById("min").value +
        " max=" + document.getElementById("max").value + " when=" + document.getElementById("when").value +
        " purpose=" + purpose;
    };
  }
  ${o.single ? "s2();" : `f.innerHTML = '<label>Full Name <input id="fn"></label><button type="button" id="n1">Next</button>';
  document.getElementById("n1").onclick = s2;`}
</script></body></html>`;
};

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/budget")) {
      res.end(BUDGET({ both: q.has("both"), dupSelf: q.has("dup"), single: q.has("single"), num: q.has("num") }));
    } else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => geminiMock.mockReset());

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const answer = (ir: any) => async (_prompt: string, opts: any) =>
  /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
    ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
    : reply(ir);
const testCase = (title: string): any => ({
  title, priority: "high", feature: "EOI", steps: ["Fill in the budget, timeline and purpose and submit"],
  expected: "The interest is submitted", category: "valid", generatedFrom: "upfront",
});
const unique = () => `select-textbox ${Date.now()}-${Math.random()}`;
const meta = (title: string) => ({ feature: "EOI", title, priority: "high", sourcePrompt: "p", baseUrl: base });
const choose = (id: string, name: string, value: string) =>
  ({ id, action: "select", target: { role: "combobox", name }, value });

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

/** Execute the IR's steps with the real live resolver; returns the page's final text. */
async function execute(ir: any): Promise<string> {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    for (const step of ir.steps) {
      if (step.action === "assert") continue;
      await runStepLive(page, step, base);
      if (step.action === "click") await page.waitForTimeout(800);
    }
    return await page.locator("body").innerText();
  } finally { await browser.close(); }
}

const BUDGET_IR = (path: string, extra: any[] = []) => ({
  meta: meta("Express interest with a budget"),
  steps: [
    { id: "s1", action: "navigate", target: { url: path } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ann" },
    { id: "s3", action: "click", target: { role: "button", name: "Next" } },
    { id: "s4", action: "wait", value: "500" },
    choose("s5", "Min Budget (AED)", "40"),
    choose("s6", "Max Budget (AED)", "50"),
    choose("s7", "Buying Timeline", "Later"),
    ...extra,
    { id: "s9", action: "click", target: { role: "button", name: "Submit" } },
    { id: "s10", action: "assert", target: { text: "min=40" }, assertion: "visible" },
  ],
});
const step = (ir: any, id: string) => ir.steps.find((s: any) => s.id === id);

describe("a select step aimed at a text box (Salesforce run, TD-125)", () => {
  it("becomes a fill on that box; a real dropdown stays a select; the IR runs", async () => {
    const model = await discover("/budget");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget")));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("budget"), model, unique(), base + "/budget"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(step(ir, "s5")).toMatchObject({ action: "fill", value: "40", target: { role: "textbox", css: "#min" } });
    expect(step(ir, "s6")).toMatchObject({ action: "fill", value: "50", target: { role: "textbox", css: "#max" } });
    expect(step(ir, "s7")).toMatchObject({ action: "select", value: "Later", target: { css: "#when" } });
    expect(await execute(ir)).toContain("min=40 max=50 when=Later");
  }, 120_000);

  it("an ordinary (non-Salesforce) run is unchanged: the same select is still rejected", async () => {
    // One screen, no Next, so the select-on-a-textbox is the ONLY thing that can fail here.
    const ir0 = {
      meta: meta("Budget"),
      steps: [
        { id: "s1", action: "navigate", target: { url: "/budget?single=1" } },
        choose("s5", "Min Budget (AED)", "40"),
        { id: "s9", action: "click", target: { role: "button", name: "Submit" } },
      ],
    };
    const model = await discover("/budget?single=1");

    geminiMock.mockImplementation(answer(ir0));
    const { ir } = await toIR(testCase("ordinary"), model, unique(), base + "/budget?single=1");
    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1"]);
    expect(JSON.stringify(ir.meta)).toMatch(/Min Budget/);

    // ...while the very same IR on a Salesforce run converts, so the gate is what differs.
    geminiMock.mockReset();
    geminiMock.mockImplementation(answer(ir0));
    const sf = await withTargetApp("salesforce", () => toIR(testCase("sf"), model, unique(), base + "/budget?single=1"));
    expect(sf.ir.meta.truncated ?? false).toBe(false);
    expect(step(sf.ir, "s5")).toMatchObject({ action: "fill", target: { css: "#min" } });
  }, 120_000);

  it("with BOTH a dropdown and a text box named Min Budget (AED), the select stays a select", async () => {
    const model = await discover("/budget?both=1");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget?both=1")));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("both"), model, unique(), base + "/budget?both=1"));

    expect(step(ir, "s5")).toMatchObject({ action: "select", value: "40", target: { role: "combobox", css: "#minsel" } });
    // The Max box has no dropdown twin, so it is still converted.
    expect(step(ir, "s6")).toMatchObject({ action: "fill", target: { css: "#max" } });
  }, 120_000);
});

describe("a select step aimed at a group of buttons (Salesforce run, TD-125 part B)", () => {
  const purpose = choose("s8", "Purpose", "Self Use");

  it("becomes a click on the one button named by the value", async () => {
    const model = await discover("/budget");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget", [purpose])));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("purpose"), model, unique(), base + "/budget"));

    expect(ir.meta.truncated ?? false).toBe(false);
    const s8 = step(ir, "s8");
    expect(s8).toMatchObject({ action: "click", target: { role: "button", name: "Self Use", css: "#self" } });
    expect(s8.value).toBeUndefined();
    expect(await execute(ir)).toContain("purpose=Self Use");
  }, 120_000);

  it("a partial value (\"Self\") clicks the ONE button whose name holds it as a whole word (TD-126)", async () => {
    const model = await discover("/budget");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget", [choose("s8", "Purpose", "Self")])));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("partial"), model, unique(), base + "/budget"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(step(ir, "s8")).toMatchObject({ action: "click", target: { role: "button", name: "Self Use", css: "#self" } });
    expect(await execute(ir)).toContain("purpose=Self Use");
  }, 120_000);

  it("a partial value matching TWO buttons is rejected, naming both", async () => {
    const model = await discover("/budget?dup=1");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget?dup=1", [choose("s8", "Purpose", "Self")])));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("dup-partial"), model, unique(), base + "/budget?dup=1"));

    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(ir.meta.truncationNote).toMatch(/2 of them match "Self": button "Self Use", button "Self Use"/);
  }, 120_000);

  it("two buttons with that name: no conversion, the step is rejected as before", async () => {
    const model = await discover("/budget?dup=1");
    geminiMock.mockImplementation(answer(BUDGET_IR("/budget?dup=1", [purpose])));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("dup"), model, unique(), base + "/budget?dup=1"));

    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(JSON.stringify(ir.meta)).toMatch(/Purpose/);
  }, 120_000);
});

describe("a retry shows the model the screens it reached (Salesforce run, TD-122)", () => {
  // Run 2026-10-15T03-01-14: on the EOI form's second screen the model asked for combobox
  // "Budget Range" — the HOME page's search filter, the only page its prompt shows — for the real
  // spinbutton "Min Budget (AED)". On a retry, the captured screens' control names now go in too.
  const SCREENS = /Screens your earlier steps reached in a live run[^\n]*\n((?:- [^\n]*\n)+)/;
  const ir = (minName: string) => ({
    meta: meta("Budget"),
    steps: [
      { id: "s1", action: "navigate", target: { url: "/budget?num=1" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ann" },
      { id: "s3", action: "click", target: { role: "button", name: "Next" } },
      { id: "s4", action: "wait", value: "500" },
      { id: "s5", action: "fill", target: { role: "spinbutton", name: minName }, value: "40" },
      { id: "s9", action: "click", target: { role: "button", name: "Submit" } },
    ],
  });
  /** The IR prompts the model received (not the vision pass's). */
  const irPrompts = () => geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));

  it("the retry lists the captured screen's controls (spinbuttons included), and the model's fix grounds", async () => {
    const model = await discover("/budget?num=1");
    geminiMock.mockImplementation(async (prompt: string, opts: any) => {
      if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
        return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
      }
      // Writes the right name only when the screens block names it.
      const block = SCREENS.exec(prompt)?.[1] ?? "";
      return reply(ir(/spinbutton "Min Budget \(AED\)/.test(block) ? "Min Budget (AED)" : "Budget Range"));
    });
    const { ir: out } = await withTargetApp("salesforce", () => toIR(testCase("screens"), model, unique(), base + "/budget?num=1"));

    const prompts = irPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).not.toMatch(SCREENS); // retries only
    const block = SCREENS.exec(prompts[1])![1];
    expect(block).toMatch(/spinbutton "Min Budget \(AED\)[^"]*", spinbutton "Max Budget \(AED\)/);
    expect(block).toContain('combobox "Buying Timeline"');
    // Names only: no selectors or other element fields.
    expect(block).not.toMatch(/#min|css|"role"/);
    expect(out.meta.truncated ?? false).toBe(false);
    expect(step(out, "s5")).toMatchObject({ action: "fill", target: { role: "spinbutton", css: "#min" } });
    expect(await execute(out)).toContain("min=40");
  }, 180_000);

  it("an ordinary (non-Salesforce) run's retry prompt has no screens block", async () => {
    const model = await discover("/budget?single=1");
    const bad = {
      meta: meta("Budget"),
      steps: [
        { id: "s1", action: "navigate", target: { url: "/budget?single=1" } },
        { id: "s5", action: "fill", target: { role: "spinbutton", name: "Budget Range" }, value: "40" },
        { id: "s9", action: "click", target: { role: "button", name: "Submit" } },
      ],
    };
    geminiMock.mockImplementation(answer(bad));
    await toIR(testCase("ordinary-retry"), model, unique(), base + "/budget?single=1");

    const prompts = irPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const p of prompts) expect(p).not.toMatch(/Screens your earlier steps reached/);
  }, 120_000);
});

describe("retries keep the best attempt and reuse captured screens (Salesforce run, TD-128)", () => {
  // Run 2026-10-15T05-37-13: attempt 2 grounded 27 steps, but every attempt re-captured each screen
  // from scratch, the 16-capture budget ran out, the last attempt stopped at step 2 — and the code
  // shipped the LAST attempt's 2 steps instead of the best attempt's 27.
  const irPrompts = () => geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));
  const answerIrs = (first: any, rest: any) => async (prompt: string, opts: any) => {
    if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
      return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
    }
    return reply(irPrompts().length <= 1 ? first : rest);
  };
  const head = [
    { id: "s1", action: "navigate", target: { url: "/budget" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ann" },
    { id: "s3", action: "click", target: { role: "button", name: "Next" } },
    { id: "s4", action: "wait", value: "500" },
  ];
  const submit = { id: "s9", action: "click", target: { role: "button", name: "Submit" } };

  it("Q1: the last attempt failing early still ships the best attempt's longer prefix", async () => {
    const deep = { meta: meta("Budget"), steps: [...head,
      { id: "s5", action: "fill", target: { role: "textbox", name: "Min Budget (AED)" }, value: "40" },
      { id: "s6", action: "fill", target: { role: "textbox", name: "Max Budget (AED)" }, value: "50" },
      choose("s7", "Buying Timeline", "Later"),
      { id: "s8", action: "click", target: { role: "button", name: "No Such Button" } }, submit] };
    const shallow = { meta: meta("Budget"), steps: [head[0],
      { id: "s2", action: "fill", target: { role: "textbox", name: "No Such Field" }, value: "x" }, submit] };
    const model = await discover("/budget");
    geminiMock.mockImplementation(answerIrs(deep, shallow));
    const { ir } = await withTargetApp("salesforce", () => toIR(testCase("best"), model, unique(), base + "/budget"));

    expect(irPrompts().length).toBeGreaterThanOrEqual(2); // the shallow IR really was the last one
    expect(ir.meta.truncated).toBe(true);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  }, 180_000);

  it("Q2: a retry reuses the screen an earlier attempt captured for the same steps", async () => {
    const prev = process.env.MAX_SCREEN_CAPTURES;
    process.env.MAX_SCREEN_CAPTURES = "2"; // attempt 1 spends both; attempt 2 needs the same screen again
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: any[]) => { logs.push(a.join(" ")); });
    try {
      const wrong = { meta: meta("Budget"), steps: [...head,
        { id: "s5", action: "fill", target: { role: "textbox", name: "Budget Range" }, value: "40" }, submit] };
      const right = { meta: meta("Budget"), steps: [...head,
        { id: "s5", action: "fill", target: { role: "textbox", name: "Min Budget (AED)" }, value: "40" }, submit] };
      const model = await discover("/budget");
      geminiMock.mockImplementation(answerIrs(wrong, right));
      const { ir } = await withTargetApp("salesforce", () => toIR(testCase("reuse"), model, unique(), base + "/budget"));

      expect(logs.some((l) => /reused screen \w+, captured earlier for the same steps/.test(l))).toBe(true);
      expect(ir.meta.truncated ?? false).toBe(false);
      expect(step(ir, "s5")).toMatchObject({ action: "fill", target: { css: "#min" } });
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.MAX_SCREEN_CAPTURES; else process.env.MAX_SCREEN_CAPTURES = prev;
    }
  }, 180_000);
});

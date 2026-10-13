import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// MULTI-SCREEN FLOWS ON ONE URL, end to end in a real browser (D-52).
//
// The Salesforce report: a three-screen form, and after the first screen "we didn't have the DOM
// to create the scripts". Every screen lives at the same URL, so the URL-keyed model could hold
// only one of them; live-extend replaced screen 1 with screen 2, lost screen 1's fields, and the
// run truncated after the navigate. Reproduced here before the fix: `steps=1`, truncated.
//
// Only the LLM is mocked — it returns a fixed IR. Discovery, the replays, the screen captures and
// grounding are the real code against a real Chromium, and the final IR is then EXECUTED step by
// step with the real live resolver, so a selector that merely looks right fails here (D-19).

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { runStepLive, waitForScreenSettle } = await import("../src/stages/liveExtend.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { screenCount } = await import("../src/stages/screens.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

// Each screen REPLACES the form's DOM (as Lightning does); nothing changes the URL. Every screen
// has a "Next"/"Save" with the same name as the last screen's, so a merged pool binds the wrong
// one. Screen 2 renders behind a spinner after 1.2 s — longer than the replay's 600 ms floor —
// so a capture that does not wait for the screen to settle sees only the spinner.
const WIZARD = (opts: { dropWebsite?: boolean }) => `<!doctype html><html><head><title>New Account</title></head>
<body><main><h2>New Account</h2><div id="f"></div></main>
<script>
  const f = document.getElementById("f");
  function s1() {
    f.innerHTML = '<label>Account Name <input id="nm"></label><label>Phone <input id="ph"></label>' +
      '<fieldset><legend>Type</legend><label><input type="radio" name="t" id="biz" value="b" checked> Business</label>' +
      '<label><input type="radio" name="t" id="per" value="p"> Person</label></fieldset>' +
      '<button id="n1">Next</button>';
    document.getElementById("n1").onclick = () => {
      const person = document.getElementById("per").checked;
      f.innerHTML = '<div role="progressbar" aria-label="Loading">Loading…</div>';
      setTimeout(person ? s2person : s2, 1200);
    };
  }
  function s2() {
    f.innerHTML = '<label>Industry <input id="ind"></label>' +
      ${opts.dropWebsite ? "''" : `'<label>Website <input id="web"></label>'`} +
      '<button id="n2">Next</button>';
    document.getElementById("n2").onclick = s3;
  }
  function s2person() {
    f.innerHTML = '<label>First Name <input id="fn"></label><label>Last Name <input id="ln"></label>' +
      '<button id="n2p">Next</button>';
    document.getElementById("n2p").onclick = s3;
  }
  function s3() {
    f.innerHTML = '<label>Rating <input id="rt"></label><label>Notes <textarea id="no"></textarea></label>' +
      '<button id="sv">Save</button>';
    document.getElementById("sv").onclick = () => { f.innerHTML = '<p>Account "Acme" was created.</p>'; };
  }
  s1();
</script></body></html>`;

// A list page whose "New" opens a modal dialog on the same URL. The page behind it has its own
// "Save" (a list-view control) — the dialog's Save must win.
const MODAL = `<!doctype html><html><head><title>Contacts</title></head><body>
<main><h1>Contacts</h1><button id="sv-view">Save</button><button id="new">New</button>
<p id="out"></p></main>
<script>
  document.getElementById("new").onclick = () => {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "New Contact"); d.id = "dlg";
    d.innerHTML = '<label>Last Name <input id="last"></label><label>Email <input id="em"></label>' +
      '<button id="dlg-save">Save</button>';
    setTimeout(() => {
      document.body.appendChild(d);
      document.getElementById("dlg-save").onclick = () => { d.remove(); document.getElementById("out").textContent = "Contact was created."; };
    }, 300);
  };
</script></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/wizard-dropped")) res.end(WIZARD({ dropWebsite: true }));
    else if (req.url?.startsWith("/wizard")) res.end(WIZARD({}));
    else if (req.url?.startsWith("/contacts")) res.end(MODAL);
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => geminiMock.mockReset());

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
/** The IR for the IR stage; an empty page for the vision pass a replay makes when a dialog opens
 *  (liveExtend's modal branch). Vision there only ADDS elements the DOM missed, so "nothing extra"
 *  leaves the walker's own elements, which are what this test checks. */
const answer = (ir: any) => async (_prompt: string, opts: any) =>
  /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
    ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
    : reply(ir);
const testCase = (title: string): any => ({
  title, priority: "high", feature: "Accounts", steps: ["Fill every screen of the form and save"],
  expected: "The record was created", category: "valid", generatedFrom: "upfront",
});
const unique = () => `multi-screen ${Date.now()}-${Math.random()}`;

/** What discovery captures before any step runs: the first screen only (live walker, as a
 *  Salesforce run uses). */
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
      if (step.action === "click") await page.waitForTimeout(1500);
    }
    return await page.locator("body").innerText();
  } finally { await browser.close(); }
}

const meta = (title: string) => ({ feature: "Accounts", title, priority: "high", sourcePrompt: "p", baseUrl: base });
const fill = (id: string, name: string, value = "x") => ({ id, action: "fill", target: { role: "textbox", name }, value });
const click = (id: string, name: string) => ({ id, action: "click", target: { role: "button", name } });

const WIZARD_IR = (path: string) => ({
  meta: meta("Create an account through every screen"),
  steps: [
    { id: "s1", action: "navigate", target: { url: path } },
    fill("s2", "Account Name", "Acme"),
    fill("s3", "Phone", "555"),
    click("s4", "Next"),
    { id: "s5", action: "wait", value: "500" },
    fill("s6", "Industry", "Tech"),
    fill("s7", "Website", "acme.test"),
    click("s8", "Next"),
    fill("s9", "Rating", "Hot"),
    fill("s10", "Notes", "n"),
    click("s11", "Save"),
    { id: "s12", action: "assert", target: { text: "was created" }, assertion: "visible" },
  ],
});

describe("multi-screen form on one URL (Salesforce run)", () => {
  it("grounds every screen, binds each Next to its own screen, and the result runs", async () => {
    const model = await discover("/wizard");
    geminiMock.mockImplementation(answer(WIZARD_IR("/wizard")));
    const { ir, updatedAppModel } = await withTargetApp("salesforce",
      () => toIR(testCase("wizard"), model, unique(), base + "/wizard"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps.map((s: any) => s.id)).toEqual(WIZARD_IR("").steps.map((s) => s.id));
    // Next on every screen: each click is on THAT screen's button.
    expect(ir.steps[3].target!.css).toBe("#n1");
    expect(ir.steps[7].target!.css).toBe("#n2");
    expect(ir.steps[10].target!.css).toBe("#sv");
    // Three screens of one URL, all kept.
    expect(screenCount(updatedAppModel, base + "/wizard")).toBe(3);
    // And it actually runs.
    expect(await execute(ir)).toContain("was created");
  }, 90_000);

  it("a field removed from a screen fails the step; it is not grounded from a stale screen", async () => {
    // Discovery saw the full first screen; screen 2 no longer has "Website" at all.
    const model = await discover("/wizard-dropped");
    geminiMock.mockImplementation(answer(WIZARD_IR("/wizard-dropped")));
    const { ir, updatedAppModel } = await withTargetApp("salesforce",
      () => toIR(testCase("dropped"), model, unique(), base + "/wizard-dropped"));

    expect(ir.meta.truncated).toBe(true);
    // Kept everything up to the missing field, and nothing after it.
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(JSON.stringify(ir.meta)).toMatch(/Website/);
    // Re-capturing at the missing field found the SAME screen: it was replaced, not duplicated.
    expect(screenCount(updatedAppModel, base + "/wizard-dropped")).toBe(2);
  }, 90_000);

  it("a branching wizard grounds the branch the earlier steps chose", async () => {
    const model = await discover("/wizard");
    const ir0 = {
      meta: meta("Create a person account"),
      steps: [
        { id: "s1", action: "navigate", target: { url: "/wizard" } },
        fill("s2", "Account Name", "Ann"),
        { id: "s3", action: "check", target: { role: "radio", name: "Person" } },
        click("s4", "Next"),
        fill("s5", "First Name", "Ann"),
        fill("s6", "Last Name", "Lee"),
        click("s7", "Next"),
        fill("s8", "Rating", "Warm"),
        click("s9", "Save"),
      ],
    };
    geminiMock.mockImplementation(answer(ir0));
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("branch"), model, unique(), base + "/wizard"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps[4].target!.css).toBe("#fn");
    expect(ir.steps[6].target!.css).toBe("#n2p");
    expect(await execute(ir)).toContain("was created");
  }, 90_000);

  it("a modal on the same URL: the dialog's Save wins over the page's own Save", async () => {
    const model = await discover("/contacts");
    const ir0 = {
      meta: meta("Create a contact"),
      steps: [
        { id: "s1", action: "navigate", target: { url: "/contacts" } },
        click("s2", "New"),
        { id: "s3", action: "wait", value: "500" },
        fill("s4", "Last Name", "Lee"),
        fill("s5", "Email", "lee@example.test"),
        click("s6", "Save"),
      ],
    };
    geminiMock.mockImplementation(answer(ir0));
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("modal"), model, unique(), base + "/contacts"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps[5].target!.css).toBe("#dlg-save");
    expect(await execute(ir)).toContain("Contact was created.");
  }, 90_000);

  it("an ordinary (non-Salesforce) run is unchanged: the same wizard still truncates", async () => {
    const model = await discover("/wizard");
    geminiMock.mockImplementation(answer(WIZARD_IR("/wizard")));
    const { ir } = await toIR(testCase("ordinary"), model, unique(), base + "/wizard");
    expect(ir.meta.truncated).toBe(true);
  }, 90_000);
});

describe("waitForScreenSettle", () => {

  // Lightning renders a screen in several async passes behind a spinner. Here: a spinner, then
  // one field every 400 ms for five fields, then the spinner goes. A capture before the last pass
  // models part of a screen.
  const STAGED = `<!doctype html><body><div id="sp" role="progressbar">Loading</div><div id="f"></div><script>
    let n = 0;
    const t = setInterval(() => {
      const i = document.createElement("input"); i.setAttribute("aria-label", "F" + (++n));
      document.getElementById("f").appendChild(i);
      if (n === 5) { clearInterval(t); document.getElementById("sp").remove(); }
    }, 400);
  </script></body>`;

  it("waits for the spinner to go and the field count to stop changing", async () => {
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      await page.setContent(STAGED);
      await waitForScreenSettle(page);
      expect(await page.locator("input").count()).toBe(5);
    } finally { await browser.close(); }
  });

  it("returns promptly on a page that is already settled", async () => {
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><body><input aria-label="A"><button>Go</button></body>`);
      const t0 = Date.now();
      await waitForScreenSettle(page);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { await browser.close(); }
  });
});

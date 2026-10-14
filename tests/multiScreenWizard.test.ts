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

// Modelled on the real Salesforce Experience site (runs 2026-10-13T11-06/11-24): "View Project" is
// a button that swaps the view without changing the URL; "Express Interest" is DISABLED until a
// unit is chosen with "Select for EOI"; the unit list is fetched late, below a tall page, and the
// first unit's button is disabled (sold).
const UNITS_DELAY_MS = 6000;
const ESTATE = `<!doctype html><html><head><title>Estate</title></head><body><main id="m">
<h1>Projects</h1><button id="vp">View Project</button></main>
<script>
  const m = document.getElementById("m");
  document.getElementById("vp").onclick = () => {
    m.innerHTML = '<h1>The Sanctuary</h1><aside><button id="ei" disabled>Express Interest</button></aside>' +
      '<div style="height:2400px">Gallery</div><section id="units"></section>';
    const ei = document.getElementById("ei");
    fetch("/api/units").then((r) => r.json()).then((units) => {
      document.getElementById("units").innerHTML = units.map((u, i) =>
        '<div>Unit ' + u + ' <button id="sel-' + u + '"' + (i === 0 ? " disabled" : "") + '>Select for EOI</button></div>').join("");
      document.getElementById("sel-102").onclick = () => { ei.disabled = false; };
    });
    ei.onclick = () => {
      m.innerHTML = '<h2>Express Interest</h2><label>Full Name <input id="fn"></label><button id="go">Submit</button>';
      document.getElementById("go").onclick = () => { m.innerHTML = "<p>Thank you, your interest was submitted.</p>"; };
    };
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
    else if (req.url?.startsWith("/api/units")) {
      // A slow Apex-style data call: the unit list arrives 6 s after the project view asks.
      setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(["101", "102"])); }, UNITS_DELAY_MS);
    }
    else if (req.url?.startsWith("/estate")) res.end(ESTATE);
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

describe("late, below-the-fold content and disabled buttons (real-site shape)", () => {
  const steps = (withSelect: boolean) => [
    { id: "s1", action: "navigate", target: { url: "/estate" } },
    click("s2", "View Project"),
    ...(withSelect ? [click("s3", "Select for EOI")] : []),
    click("s4", "Express Interest"),
    fill("s5", "Full Name", "Test User"),
    click("s6", "Submit"),
  ];
  const estateIr = (withSelect: boolean) => ({ meta: meta("Express interest"), steps: steps(withSelect) });

  it("A: the capture waits for the late unit list, and the enabled unit's button is chosen", async () => {
    const model = await discover("/estate");
    geminiMock.mockImplementation(answer(estateIr(true)));
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("estate"), model, unique(), base + "/estate"));

    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps.find((s: any) => s.id === "s3")!.target!.css).toBe("#sel-102");
    expect(await executeSlow(ir)).toContain("Thank you");
  }, 180_000);

  it("B: a step missing before a DISABLED button is sent back to the model, naming the screen's controls", async () => {
    const model = await discover("/estate");
    geminiMock.mockImplementation(async (prompt: string, opts: any) => {
      if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
        return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
      }
      // The model's first answer skips "Select for EOI", exactly as the real run did; once told,
      // it adds it.
      return reply(estateIr(/DISABLED/.test(prompt)));
    });
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("estate-b"), model, unique(), base + "/estate"));

    const irPrompts = geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));
    expect(irPrompts.length).toBeGreaterThanOrEqual(2);
    const correction = irPrompts[1];
    expect(correction).toMatch(/Express Interest.*DISABLED/s);
    expect(correction).toContain('button "Select for EOI"');
    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(await executeSlow(ir)).toContain("Thank you");
  }, 240_000);

  it("B: if the model never adds the enabling step, the case stops at the disabled button with that reason", async () => {
    const model = await discover("/estate");
    geminiMock.mockImplementation(answer(estateIr(false)));
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("estate-c"), model, unique(), base + "/estate"));

    expect(ir.meta.truncated).toBe(true);
    expect(ir.meta.truncationKind).toBe("disabled-target");
    expect(ir.meta.truncationNote).toMatch(/Express Interest.*DISABLED/s);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2"]);
  }, 240_000);
});

describe("a step whose target is not on its screen names what IS there (TD-124)", () => {
  // Run 2026-10-14T02-35-44-042Z-1fe67e2f: the model went View Project -> fill "Full Name",
  // skipping "Select for EOI" and "Express Interest". The rejection said only "not present", the
  // retry repeated the mistake, and the case was cut to three steps.
  const skipping = {
    meta: meta("Express interest"),
    steps: [
      { id: "s1", action: "navigate", target: { url: "/estate" } },
      click("s2", "View Project"),
      fill("s5", "Full Name", "Test User"),
      click("s6", "Submit"),
    ],
  };
  const complete = {
    meta: meta("Express interest"),
    steps: [
      { id: "s1", action: "navigate", target: { url: "/estate" } },
      click("s2", "View Project"),
      click("s3", "Select for EOI"),
      click("s4", "Express Interest"),
      fill("s5", "Full Name", "Test User"),
      click("s6", "Submit"),
    ],
  };

  it("the rejection lists the screen's controls, so the model can add the missing steps", async () => {
    const model = await discover("/estate");
    geminiMock.mockImplementation(async (prompt: string, opts: any) => {
      if (/accessibility snapshot/i.test(opts?.systemInstruction ?? "")) {
        return reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] });
      }
      // Fixes its IR only when the rejection names the controls that lead to the form.
      return reply(/button "Select for EOI"/.test(prompt) && /Express Interest" \(disabled\)/.test(prompt) ? complete : skipping);
    });
    const { ir } = await withTargetApp("salesforce",
      () => toIR(testCase("estate-skip"), model, unique(), base + "/estate"));

    const irPrompts = geminiMock.mock.calls.map((c) => c[0] as string).filter((p) => /Return IR JSON/.test(p));
    expect(irPrompts[1]).toMatch(/Full Name.*not on the screen the flow is on/s);
    expect(ir.meta.truncated ?? false).toBe(false);
    expect(ir.steps.map((s: any) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(await executeSlow(ir)).toContain("Thank you");
  }, 240_000);
});

/** `execute`, with the generated spec's own 10 s click timeout, for a page whose data is slow. */
async function executeSlow(ir: any): Promise<string> {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    for (const step of ir.steps) {
      if (step.action === "assert") continue;
      await runStepLive(page, step, base);
      if (step.action === "click") await page.waitForTimeout(500);
    }
    return await page.locator("body").innerText();
  } finally { await browser.close(); }
}


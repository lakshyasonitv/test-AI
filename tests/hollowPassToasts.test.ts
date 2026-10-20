import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// TD-162 Phase A (HOLLOW_PASS_GUARDS_ENABLED): a Salesforce save error is a page-level toast, outside
// the form, which Fix 1 (form alerts only) did not see. A page-level role="alert" / aria-live="assertive"
// region now counts when it is on screen AND was not there before the replay's last interaction. A banner
// already on screen, a 1px screen-reader-only route announcer (Next.js reads out the new page's title
// with one) and a role="status" success toast do not. Real Chromium (D-19); only the LLM is mocked.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { finalScreenErrors } = await import("../src/stages/liveExtend.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

// Every page: a site-wide alert banner already on screen, a Next.js-style route announcer, and a form.
// What Save does differs per page. Messages live in data attributes, so they are not in the page's
// textContent (the old re-check reads it) until they are shown.
const page = (onSave: string, extra = "") => `<!doctype html><html><head><title>Record</title></head><body>
<div role="alert" style="padding:8px">Scheduled maintenance tonight</div>
<p id="announcer" role="alert" aria-live="assertive" data-msg="Record saved page"
   style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"></p>
<main><form onsubmit="return false">
  <label for="n">Name</label><input id="n">
  <button type="button" id="save">Save</button>
</form>${extra}
<div id="toasts"></div></main>
<script>
document.getElementById("save").onclick = () => {
  const a = document.getElementById("announcer");
  a.textContent = a.dataset.msg;
  ${onSave}
};
</script></body></html>`;
const toast = (role: string) => `
  const t = document.createElement("div");
  ${role}
  t.style.padding = "8px";
  t.textContent = document.getElementById("toasts").dataset.msg;
  document.getElementById("toasts").appendChild(t);`;
const PAGES: Record<string, string> = {
  "/error": page(toast(`t.setAttribute("role", "alert");`))
    .replace(`<div id="toasts"></div>`, `<div id="toasts" data-msg="Review the errors on this page."></div>`),
  "/assertive": page(toast(`t.setAttribute("aria-live", "assertive");`))
    .replace(`<div id="toasts"></div>`, `<div id="toasts" data-msg="Could not save the record."></div>`),
  "/ok": page(toast(`t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");`))
    .replace(`<div id="toasts"></div>`, `<div id="toasts" data-msg="Record saved"></div>`),
  // role="status" wins even when the region is also marked assertive.
  "/ok-assertive": page(toast(`t.setAttribute("role", "status"); t.setAttribute("aria-live", "assertive");`))
    .replace(`<div id="toasts"></div>`, `<div id="toasts" data-msg="Record saved"></div>`),
  // An error toast rendered from the start but hidden, shown by Save: not on screen before, so it counts.
  "/late": page(`document.getElementById("late").style.display = "block";`,
    `<div id="late" role="alert" style="display:none;padding:8px">Duplicate value found.</div>`),
  // The same, faded in: opacity 0 before Save, which Playwright's :visible still counts as visible.
  "/fade": page(`document.getElementById("fade").style.opacity = "1";`,
    `<div id="fade" role="alert" style="opacity:0;padding:8px">Duplicate value found.</div>`),
};

let server: http.Server;
let base = "";
const models: Record<string, any> = {};
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const html = PAGES[req.url ?? ""];
    if (html) res.end(html); else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    for (const path of ["/error", "/ok"]) {
      const p = await browser.newPage();
      await p.goto(base + path);
      models[path] = await extractDomModelFromPage(p, base + path);
      await p.close();
    }
  } finally { await browser.close(); }
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const saved = { version: process.env.LLM_CACHE_VERSION, attempts: process.env.MAX_IR_ATTEMPTS };
beforeEach(() => {
  geminiMock.mockReset();
  process.env.LLM_CACHE_VERSION = `test-hollow-toast-${Date.now()}-${Math.random()}`;
  process.env.MAX_IR_ATTEMPTS = "2";
});
afterEach(() => {
  delete process.env.HOLLOW_PASS_GUARDS_ENABLED;
  for (const [k, v] of [["LLM_CACHE_VERSION", saved.version], ["MAX_IR_ATTEMPTS", saved.attempts]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const irFor = (path: string, asserted: string): any => ({
  meta: { feature: "Record", title: "Record", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s1", action: "navigate", target: { url: path } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "Ada Lovelace" },
    { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    { id: "s4", action: "wait", value: "300" },
    { id: "s5", action: "assert", target: { text: asserted }, assertion: "visible" },
  ],
});
const modelAt = (path: string): any => ({ baseUrl: base, pages: [{ url: base + path, title: "Record", concepts: [], elements: [] }] });

describe("finalScreenErrors: page-level alerts new after the last interaction (real Chromium replay)", () => {
  it("a page-level role=\"alert\" toast after Save counts; the banner and the route announcer do not", async () => {
    expect(await finalScreenErrors(irFor("/error", "Saved"), modelAt("/error")))
      .toEqual([{ kind: "page-alert", text: "Review the errors on this page." }]);
  }, 60_000);

  it("a page-level aria-live=\"assertive\" toast counts too", async () => {
    expect(await finalScreenErrors(irFor("/assertive", "Saved"), modelAt("/assertive")))
      .toEqual([{ kind: "page-alert", text: "Could not save the record." }]);
  }, 60_000);

  it("a toast that was in the page but hidden (display:none, or faded out), and Save showed it, counts", async () => {
    for (const path of ["/late", "/fade"]) {
      expect(await finalScreenErrors(irFor(path, "Saved"), modelAt(path)))
        .toEqual([{ kind: "page-alert", text: "Duplicate value found." }]);
    }
  }, 90_000);

  it("a role=\"status\" success toast does not, nor does the route announcer reading the new title", async () => {
    expect(await finalScreenErrors(irFor("/ok", "Record saved"), modelAt("/ok"))).toEqual([]);
    expect(await finalScreenErrors(irFor("/ok-assertive", "Record saved"), modelAt("/ok-assertive"))).toEqual([]);
  }, 60_000);

  it("with no interaction at all (only opening the page), a banner shown on load is not an outcome", async () => {
    const onlyOpen: any = { ...irFor("/error", "Saved"), steps: [irFor("/error", "Saved").steps[0],
      { id: "s2", action: "wait", value: "200" }, { id: "s3", action: "assert", target: { text: "Saved" }, assertion: "visible" }] };
    expect(await finalScreenErrors(onlyOpen, modelAt("/error"))).toEqual([]);
  }, 60_000);
});

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
async function compile(category: string, path: string, asserted: string) {
  geminiMock.mockImplementation(async (_p: string, opts: any) =>
    /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
      ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
      : reply(irFor(path, asserted)));
  const testCase: any = { title: "Save the record", priority: "high", feature: "Record", steps: ["Fill the name", "Save"],
    expected: "The record is saved", category, generatedFrom: "upfront" };
  return (await toIR(testCase, models[path], `Save a record. ${Date.now()}-${Math.random()}`, base + path)).ir;
}

describe("Phase A through toIR, flag on", () => {
  beforeEach(() => { process.env.HOLLOW_PASS_GUARDS_ENABLED = "true"; });

  it("a VALID case ending after a page-level error toast: incomplete, and the marker says page-alert", async () => {
    const ir = await compile("valid", "/error", "Record saved");
    expect(ir.meta.truncated).toBe(true);
    expect(ir.meta.truncationKind).toBe("error-assertion");
    expect(ir.meta.hasTerminalAssertion).toBe(false);
    expect(ir.meta.truncationNote).toContain(`page-alert "Review the errors on this page."`);
  }, 180_000);

  it("a VALID case ending on a role=\"status\" success toast is accepted", async () => {
    const ir = await compile("valid", "/ok", "Record saved");
    expect(ir.meta.truncated).toBeFalsy();
    expect(ir.steps.at(-1).target.text).toBe("Record saved");
  }, 180_000);

  it("a NEGATIVE case ending on the error toast keeps today's behaviour (accepted)", async () => {
    const ir = await compile("invalid-input", "/error", "Review the errors on this page.");
    expect(ir.meta.truncated).toBeFalsy();
  }, 180_000);
});

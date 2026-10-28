import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import {
  captureErrorMarkers, errorMarkersOf, describeMarkers, isPositiveCase, hollowPassGuardsEnabled,
} from "../src/stages/hollowPassGuards.js";
import { finalScreenErrors, groundTerminalTextAssertion, walkCacheKey, WALK_CACHE_NS } from "../src/stages/liveExtend.js";
import { llmCacheGet } from "../src/kb/llmCache.js";
import { isHealable } from "../src/stages/heal.js";

// TD-162 Fix 1 (HOLLOW_PASS_GUARDS_ENABLED): a positive case may not end on a screen where the page
// shows its own error. Run 2026-10-19T13-44-20-358Z-8e01a75f typed "email" into an email field,
// clicked Next, and passed by asserting the site's "Please enter a valid email address.".
//
// Real Chromium against a local server (D-19): the error markers are read by Playwright locators and
// evaluate callbacks, which only a real browser proves. The replays are the real ones. Each test gets
// its own LLM_CACHE_VERSION (part of the walk key), so no walk is shared between tests.
// The pages keep their messages in data attributes: the old re-check reads the body's textContent,
// which would otherwise include the inline script's own source.

const FORM = `<!doctype html><html><head><title>Enquiry</title></head><body><main>
<form id="f" onsubmit="return false">
  <h2>Your Contact Details</h2>
  <label for="email">Email Address</label><input id="email" type="email">
  <button type="button" id="next">Next</button>
  <p id="err" role="alert" data-msg="Please enter a valid email address."></p>
</form>
<p id="done" hidden data-msg="Thank you, your enquiry is complete."></p>
<script>
document.getElementById("next").onclick = () => {
  const v = document.getElementById("email").value;
  if (!/^[^@ ]+@[^@ ]+$/.test(v)) {
    const e = document.getElementById("err");
    e.textContent = e.dataset.msg;
    return;
  }
  document.getElementById("f").hidden = true;
  const d = document.getElementById("done");
  d.hidden = false;
  d.textContent = d.dataset.msg;
};
</script></main></body></html>`;

// The error is marked ONLY by aria-invalid + aria-describedby (no alert role), in words that are not
// "message-shaped" for the old re-check.
const ARIA = `<!doctype html><html><head><title>Enquiry</title></head><body><main>
<form id="f" onsubmit="return false">
  <label for="email">Email Address</label><input id="email" type="email">
  <span id="email-err" data-msg="That address does not look right"></span>
  <button type="button" id="next">Next</button>
</form>
<script>
document.getElementById("next").onclick = () => {
  const v = document.getElementById("email").value;
  const i = document.getElementById("email");
  const e = document.getElementById("email-err");
  if (!/^[^@ ]+@[^@ ]+$/.test(v)) {
    i.setAttribute("aria-invalid", "true");
    i.setAttribute("aria-describedby", "email-err");
    e.textContent = e.dataset.msg;
  }
};
</script></main></body></html>`;

const SIGNALS = `<!doctype html><html><body><main>
<div role="alert" aria-live="assertive">Dashboard</div>
<form>
  <input id="a" aria-invalid="true" aria-describedby="a-hint a-err"><span id="a-hint">We never share it</span><span id="a-err">Email is not valid</span>
  <input id="b" aria-invalid="true" aria-errormessage="b-err"><span id="b-err">Phone must be digits</span>
  <input id="c" aria-describedby="c-hint"><span id="c-hint">Optional</span>
  <input id="d" aria-invalid="true" aria-label="Postcode">
  <input id="e" aria-errormessage="e-err" aria-describedby="e-hint"><span id="e-err">Card number is incomplete</span><span id="e-hint">Sixteen digits</span>
  <input id="g" aria-errormessage="g-err"><span id="g-err" hidden>Not shown</span>
  <p role="alert">Fix the 2 errors below</p>
  <div aria-live="assertive">Name is required</div>
  <p role="alert" style="display:none">Hidden error</p>
  <p role="alert" style="opacity:0">Faded error</p>
  <div role="status" aria-live="polite">Saved</div>
  <div aria-live="polite">Polite error</div>
  <div role="status" aria-live="assertive">Status assertive</div>
</form>
<div id="host"></div>
<script>
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<form><input aria-invalid="true" aria-describedby="s-err"><div id="s-err">Shadow field error</div>' +
  '<p role="alert">Shadow alert</p></form>';
</script></main></body></html>`;

let server: http.Server;
let base = "";
let browser: Browser;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(FORM);
    else if (req.url?.startsWith("/aria")) res.end(ARIA);
    else if (req.url?.startsWith("/signals")) res.end(SIGNALS);
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const savedVersion = process.env.LLM_CACHE_VERSION;
beforeEach(() => { process.env.LLM_CACHE_VERSION = `test-hollow-${Date.now()}-${Math.random()}`; });
afterEach(() => {
  delete process.env.HOLLOW_PASS_GUARDS_ENABLED;
  if (savedVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedVersion;
});

describe("the flag and the positive-case rule", () => {
  it("is off unless set to exactly \"true\"", () => {
    expect(hollowPassGuardsEnabled()).toBe(false);
    process.env.HOLLOW_PASS_GUARDS_ENABLED = "1";
    expect(hollowPassGuardsEnabled()).toBe(false);
    process.env.HOLLOW_PASS_GUARDS_ENABLED = "true";
    expect(hollowPassGuardsEnabled()).toBe(true);
  });
  it("guards valid and state-change cases only; negative and catch-all cases keep today's behaviour", () => {
    expect(isPositiveCase({ category: "valid" })).toBe(true);
    expect(isPositiveCase({ category: "state-change" })).toBe(true);
    for (const category of ["invalid-input", "empty-boundary", "security-injection", "security-xss", "functional-other", undefined]) {
      expect(isPositiveCase({ category })).toBe(false);
    }
  });
});

describe("captureErrorMarkers reads what the page marks as an error (real Chromium)", () => {
  it("only alerts, assertive regions, invalid fields and their linked messages, inside shadow roots too", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/signals");
      const markers = await captureErrorMarkers(page);
      const got = markers.map((m) => `${m.kind}: ${m.text}`).sort();
      expect(got).toEqual([
        "aria-describedby: Email is not valid",
        "aria-describedby: Shadow field error",
        "aria-describedby: We never share it", // a hint, but on an INVALID field
        "aria-errormessage: Card number is incomplete", // shown, on a field not marked invalid
        "aria-errormessage: Phone must be digits",
        "aria-invalid: field \"Postcode\" is marked invalid", // invalid with no linked message
        "aria-live-assertive: Name is required",
        "role-alert: Fix the 2 errors below",
        "role-alert: Shadow alert",
      ]);
      // Never: role="status" or aria-live="polite" (success toasts use these), a page-level alert
      // outside any form (a route announcer reads the new page's title out this way), a hint on a
      // field that is NOT invalid, an error message not on screen, and alerts that are not shown —
      // display:none, and opacity 0 (a fade left behind), which Playwright's :visible alone accepts.
      for (const t of ["Saved", "Polite error", "Status assertive", "Dashboard", "Optional", "Sixteen digits", "Not shown", "Hidden error", "Faded error"]) {
        expect(markers.map((m) => m.text)).not.toContain(t);
      }
    } finally { await page.close(); }
  });
});

describe("errorMarkersOf and describeMarkers", () => {
  it("joins the capture and the page model's shown alerts inside a form, once per text, capture first", () => {
    const markers = errorMarkersOf({
      errorMarkers: [
        { kind: "aria-describedby", text: "Email is not valid" },
        { kind: "role-alert", text: "Please enter a valid email address." },
      ],
      pageModel: { elements: [
        { role: "alert", name: "Please  enter a valid EMAIL address.", landmark: "form", visible: true },
        { role: "alert", name: "Name is required", landmark: "form" },
        { role: "alert", name: "Dashboard", landmark: "main", visible: true },
        { role: "alert", name: "Gone", landmark: "form", visible: false },
        { role: "status", name: "Saved", landmark: "form", visible: true },
      ] as any },
    });
    expect(markers).toEqual([
      { kind: "aria-describedby", text: "Email is not valid" },
      { kind: "role-alert", text: "Please enter a valid email address." },
      { kind: "role-alert", text: "Name is required" },
    ]);
    expect(describeMarkers(markers)).toBe(
      `aria-describedby "Email is not valid", role-alert "Please enter a valid email address.", role-alert "Name is required"`);
  });
  it("is empty for a page with no error markers", () => {
    expect(errorMarkersOf({ pageModel: { elements: [{ role: "heading", name: "Thanks", landmark: "form" }] as any } })).toEqual([]);
    expect(errorMarkersOf({})).toEqual([]);
  });
});

describe("the walk cache key", () => {
  const model: any = { baseUrl: "https://example.test", pages: [] };
  it("is unchanged unless the replay asks for error signals", () => {
    const plain = walkCacheKey(model, [], undefined, "full");
    expect(walkCacheKey(model, [], undefined, "full", {})).toBe(plain);
    process.env.HOLLOW_PASS_GUARDS_ENABLED = "true"; // the flag alone changes nothing
    expect(walkCacheKey(model, [], undefined, "full")).toBe(plain);
    expect(walkCacheKey(model, [], undefined, "full", { errorSignals: true })).not.toBe(plain);
  });
});

const modelAt = (path: string): any => ({ baseUrl: base, pages: [{ url: base + path, title: "Enquiry", concepts: [], elements: [] }] });
const irFor = (path: string, email: string, last: any = { id: "s5", action: "assert", target: { text: "Thank You" }, assertion: "visible" }): any => ({
  meta: { feature: "Enquiry", title: "Enquiry", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s1", action: "navigate", target: { url: path } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email Address" }, value: email },
    { id: "s3", action: "click", target: { role: "button", name: "Next" } },
    { id: "s4", action: "wait", value: "200" },
    ...(last ? [last] : []),
  ],
});

describe("finalScreenErrors: the errors on the screen a case ends on (real Chromium replay)", () => {
  const ALERT = { kind: "role-alert", text: "Please enter a valid email address." };
  it("the 8e01a75f shape: an alert in the form after typing \"email\"", async () => {
    expect(await finalScreenErrors(irFor("/form", "email"), modelAt("/form"))).toEqual([ALERT]);
  }, 60_000);

  it("none when the flow really succeeded", async () => {
    expect(await finalScreenErrors(irFor("/form", "test.user@example.com"), modelAt("/form"))).toEqual([]);
  }, 60_000);

  it("an error marked only by aria-invalid + aria-describedby (the live capture, not the page model)", async () => {
    expect(await finalScreenErrors(irFor("/aria", "email"), modelAt("/aria")))
      .toEqual([{ kind: "aria-describedby", text: "That address does not look right" }]);
  }, 60_000);

  it("replays every step when the IR does not end on an assertion", async () => {
    expect(await finalScreenErrors(irFor("/form", "email", null), modelAt("/form"))).toEqual([ALERT]);
  }, 60_000);

  it("leaves the walk the terminal-text re-check reuses (same prefix, error signals on)", async () => {
    const ir = irFor("/form", "email");
    await finalScreenErrors(ir, modelAt("/form"));
    const walk: any = llmCacheGet(walkCacheKey(modelAt("/form"), ir.steps.slice(0, -1), undefined, "full", { errorSignals: true }), WALK_CACHE_NS);
    expect(walk?.errorMarkers).toEqual([ALERT]);
  }, 60_000);
});

describe("the terminal-text re-check itself is unchanged", () => {
  it("still rewrites a missing guess onto the page's message (the guard lives in toIR, before it)", async () => {
    const out = await groundTerminalTextAssertion(irFor("/form", "email"), modelAt("/form"), undefined, "full");
    expect(out.corrected).toBe(true);
    expect(out.ir.steps.at(-1).target.text).toBe("Please enter a valid email address.");
  }, 60_000);
});

describe("heal", () => {
  it("never heals an error-assertion truncation (a passing heal would turn incomplete into passed)", () => {
    const ir: any = { meta: { truncated: true, truncationKind: "error-assertion" }, steps: [{ id: "s1" }, { id: "s2" }, { id: "s3", action: "click" }] };
    expect(isHealable({ category: "element_missing", failingStepId: "s3" } as any, ir)).toBe(false);
    expect(isHealable({ category: "element_missing", failingStepId: "s3" } as any, { ...ir, meta: { truncated: true, truncationKind: "role-name" } })).toBe(true);
  });
});

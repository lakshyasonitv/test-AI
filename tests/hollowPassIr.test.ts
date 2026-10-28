import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// TD-162 Fix 1, end to end through toIR (HOLLOW_PASS_GUARDS_ENABLED). Run 2026-10-19T13-44-20-358Z-8e01a75f:
// a VALID case typed "email" into an email field, clicked Next, and passed by asserting the site's own
// "Please enter a valid email address.". With the flag on, a positive case whose final screen shows the
// page's own error is rejected back to the model, whatever it asserts there, and once the attempts run
// out it ships truncated WITHOUT an assertion (truncated_no_assertion: never passed), on every exit of
// toIR. A NEGATIVE case ending on the same alert is accepted: there the error is the point.
// Same harness as quotedSuccessText.test.ts: only the LLM is mocked; every replay is real Chromium.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

// Messages live in data attributes: the re-check reads the body's textContent, which would otherwise
// include this inline script's own source.
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
// 8e01a75f's other shape: beside the error, a message-shaped line that is NOT an error (its sidebar's
// "Fully refundable … confirmed booking …"), which the re-check would otherwise land on.
const MIXED = FORM.replace(`<p id="done"`, `<aside><p>Your place is confirmed once the form is complete.</p></aside><p id="done"`);
// The error marked only by aria-invalid + aria-describedby, in words the old re-check never scans for.
const ARIA = FORM
  .replace(`<p id="err" role="alert" data-msg="Please enter a valid email address."></p>`,
    `<span id="err" data-msg="That address does not look right"></span>`)
  .replace(`    const e = document.getElementById("err");`,
    `    const i = document.getElementById("email");\n    i.setAttribute("aria-invalid", "true");\n    i.setAttribute("aria-describedby", "err");\n    const e = document.getElementById("err");`);

// A success announced the way success toasts are: role="status" / aria-live="polite", inside the form,
// with the form still on screen. Not an error marker, so a valid case ending there is accepted.
const TOAST = FORM
  .replace(`<p id="err" role="alert" data-msg="Please enter a valid email address."></p>`,
    `<p id="err" role="alert" data-msg="Please enter a valid email address."></p>\n  <div id="toast" role="status" aria-live="polite" data-msg="Your enquiry was sent"></div>`)
  .replace(`  document.getElementById("f").hidden = true;\n  const d = document.getElementById("done");\n  d.hidden = false;`,
    `  const d = document.getElementById("toast");`);

let server: http.Server;
let base = "";
const models: Record<string, any> = {};
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const page = req.url?.startsWith("/form") ? FORM : req.url?.startsWith("/mixed") ? MIXED
      : req.url?.startsWith("/aria") ? ARIA : req.url?.startsWith("/toast") ? TOAST : null;
    if (page) res.end(page); else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    for (const path of ["/form", "/mixed", "/aria", "/toast"]) {
      const page = await browser.newPage();
      await page.goto(base + path);
      models[path] = await extractDomModelFromPage(page, base + path);
      await page.close();
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
  process.env.LLM_CACHE_VERSION = `test-hollow-ir-${Date.now()}-${Math.random()}`;
  process.env.MAX_IR_ATTEMPTS = "2";
});
afterEach(() => {
  delete process.env.HOLLOW_PASS_GUARDS_ENABLED;
  vi.restoreAllMocks();
  for (const [k, v] of [["LLM_CACHE_VERSION", saved.version], ["MAX_IR_ATTEMPTS", saved.attempts]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const ASSERT_THANKS = { id: "s5", action: "assert", target: { text: "Thank You" }, assertion: "visible" };
const irFor = (path: string, email: string, tail: any[] = [ASSERT_THANKS]) => ({
  meta: { feature: "Enquiry", title: "Enquiry", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s1", action: "navigate", target: { url: path } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email Address" }, value: email },
    { id: "s3", action: "click", target: { role: "button", name: "Next" } },
    { id: "s4", action: "wait", value: "300" },
    ...tail,
  ],
});
const caseOf = (category: string): any => ({
  title: "Send the enquiry", priority: "high", feature: "Enquiry", steps: ["Fill the form", "Click Next"],
  expected: "A confirmation is shown", category, generatedFrom: "upfront",
});
const isIrCall = (opts: any) => !/accessibility snapshot/i.test(opts?.systemInstruction ?? "");

/** Compile, the model answering `answers[i]` on its i-th IR call (the last one repeats). */
async function compile(category: string, path: string, answers: any[], salesforce = false) {
  let n = 0;
  geminiMock.mockImplementation(async (_p: string, opts: any) => isIrCall(opts)
    ? reply(answers[Math.min(n++, answers.length - 1)])
    : reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] }));
  const request = `Fill the enquiry form and submit it. ${Date.now()}-${Math.random()}`;
  const go = () => toIR(caseOf(category), models[path], request, base + path);
  const { ir } = salesforce ? await withTargetApp("salesforce", go) : await go();
  const prompts = geminiMock.mock.calls.filter(([, o]) => isIrCall(o)).map(([p]) => String(p));
  return { ir, irCalls: n, prompts, last: ir.steps.at(-1)! };
}
/** Can never report "passed": truncated with no assertion at its end -> truncated_no_assertion. */
const expectCannotPass = (ir: any) => {
  expect(ir.meta.truncated).toBe(true);
  expect(ir.meta.hasTerminalAssertion).toBe(false);
  expect(ir.steps.at(-1).action).not.toBe("assert");
};
const expectIncomplete = (ir: any) => {
  expectCannotPass(ir);
  expect(ir.meta.truncationKind).toBe("error-assertion");
};

describe("TD-162 Fix 1 through toIR, flag on (real Chromium replay)", () => {
  beforeEach(() => { process.env.HOLLOW_PASS_GUARDS_ENABLED = "true"; });

  it("a VALID case ending on the alert: rejected with the reason, retried, then shipped incomplete", async () => {
    const log = vi.spyOn(console, "log");
    const { ir, irCalls, prompts } = await compile("valid", "/form", [irFor("/form", "email")]);
    expect(irCalls).toBe(2);
    expect(prompts[1]).toContain("Please enter a valid email address."); // the reason went back to the model
    expectIncomplete(ir);
    // Which marker triggered it is logged and kept in the note, so false incompletes can be counted.
    const marker = `role-alert "Please enter a valid email address."`;
    expect(log.mock.calls.some((c) => String(c[0]).includes("error-assertion") && String(c[0]).includes(marker))).toBe(true);
    expect(ir.meta.truncationNote).toContain(marker);
  }, 180_000);

  it("the same on a Salesforce run (screen mode, as run 8e01a75f)", async () => {
    expectIncomplete((await compile("valid", "/form", [irFor("/form", "email")], true)).ir);
  }, 180_000);

  it("8e01a75f's other shape: a guess not on the page is NOT moved onto the non-error line beside the error", async () => {
    expectIncomplete((await compile("valid", "/mixed", [irFor("/mixed", "email")])).ir);
  }, 180_000);

  it("an error marked only by aria-invalid (no alert role): incomplete", async () => {
    expectIncomplete((await compile("valid", "/aria", [irFor("/aria", "email")])).ir);
  }, 180_000);

  it("whatever the final assertion is: a heading that is true on the error screen", async () => {
    const last = { id: "s5", action: "assert", target: { role: "heading", name: "Your Contact Details" }, assertion: "visible" };
    expectIncomplete((await compile("valid", "/form", [irFor("/form", "email", [last])])).ir);
  }, 180_000);

  it("the alert asserted by role and name cannot pass either (off Salesforce, grounding already stops it)", async () => {
    const last = { id: "s5", action: "assert", target: { role: "alert", name: "Please enter a valid email address." }, assertion: "visible" };
    expectCannotPass((await compile("valid", "/form", [irFor("/form", "email", [last])])).ir);
  }, 180_000);

  it("an earlier assertion before the final one is dropped too, so the result cannot count as passed", async () => {
    const tail = [{ id: "s4b", action: "assert", target: { role: "heading", name: "Your Contact Details" }, assertion: "visible" }, ASSERT_THANKS];
    expectIncomplete((await compile("valid", "/form", [irFor("/form", "email", tail)])).ir);
  }, 180_000);

  it("a state-change case is guarded as well", async () => {
    expectIncomplete((await compile("state-change", "/form", [irFor("/form", "email")])).ir);
  }, 180_000);

  // Side exits: IRs that never reach the main-path check.
  const VACUOUS = { id: "s4c", action: "assert", target: { text: "Thank You" }, assertion: "text_contains" };
  const HEADING = { id: "s1b", action: "assert", target: { role: "heading", name: "Your Contact Details" }, assertion: "visible" };
  const withHeading = (ir: any) => ({ ...ir, steps: [ir.steps[0], HEADING, ...ir.steps.slice(1)] });

  it("an earlier contradiction does not ship in place of a later refusal", async () => {
    const first = withHeading(irFor("/form", "email", [VACUOUS])); // rejected as vacuous; its strip still asserts
    expectIncomplete((await compile("valid", "/form", [first, irFor("/form", "email")])).ir);
    // Even when that strip ends on a screen WITHOUT an error: it verifies nothing at its end (the
    // vacuous final assertion is gone), yet untruncated it would report passed. Incomplete instead.
    const succeeded = withHeading(irFor("/form", "test.user@example.com", [VACUOUS]));
    expectIncomplete((await compile("valid", "/form", [succeeded, irFor("/form", "email")])).ir);
  }, 240_000);

  it("a refusal first, then a contradiction on the last attempt: the strip is checked at the exit", async () => {
    // B2: the strip would end on the error text itself.
    const b2 = irFor("/form", "email", [{ ...VACUOUS, assertion: "url_contains", value: "/" }, { ...ASSERT_THANKS, target: { text: "Please enter a valid email address." } }]);
    expectIncomplete((await compile("valid", "/form", [irFor("/form", "email"), b2])).ir);
    // B1: the strip would end on a heading that is true on the error screen.
    const b1 = withHeading(irFor("/form", "email", [VACUOUS]));
    expectIncomplete((await compile("valid", "/form", [irFor("/form", "email"), b1])).ir);
  }, 240_000);

  it("the best-effort exit for unverified text targets is checked too", async () => {
    const log = vi.spyOn(console, "log");
    const unverified = irFor("/form", "email", [{ id: "s5", action: "click", target: { text: "Your Contact Details" } }, ASSERT_THANKS]);
    const { ir } = await compile("valid", "/form", [irFor("/form", "email"), unverified]);
    expect(log.mock.calls.some((c) => String(c[0]).includes("shipping unverified text targets"))).toBe(true);
    expect(ir.meta.truncated).toBe(true);
    expect(ir.meta.hasTerminalAssertion).toBe(false);
  }, 180_000);

  it("a NEGATIVE case ending on the same alert is accepted: the error is its expected outcome", async () => {
    const { ir, last } = await compile("invalid-input", "/form", [irFor("/form", "email")]);
    expect(ir.meta.truncated).toBeFalsy();
    expect(last.target?.text).toBe("Please enter a valid email address.");
  }, 180_000);

  it("a VALID case ending on a role=\"status\" success toast (not an error marker) is accepted", async () => {
    const last = { id: "s5", action: "assert", target: { text: "Your enquiry was sent" }, assertion: "visible" };
    const { ir, irCalls } = await compile("valid", "/toast", [irFor("/toast", "test.user@example.com", [last])]);
    expect(irCalls).toBe(1);
    expect(ir.meta.truncated).toBeFalsy();
    expect(ir.steps.at(-1)!.target?.text).toBe("Your enquiry was sent");
  }, 180_000);

  it("a VALID case that really succeeds is accepted on its success text, first time", async () => {
    const { ir, irCalls, last } = await compile("valid", "/form", [irFor("/form", "test.user@example.com")]);
    expect(irCalls).toBe(1);
    expect(ir.meta.truncated).toBeFalsy();
    expect(last.target?.text).toBe("Thank you");
  }, 180_000);
});

describe("flag OFF and the cache", () => {
  it("flag off: the old behaviour, re-grounded onto the error and not truncated", async () => {
    const { ir, irCalls, last } = await compile("valid", "/form", [irFor("/form", "email")]);
    expect(irCalls).toBe(1);
    expect(ir.meta.truncated).toBeFalsy();
    expect(last.target?.text).toBe("Please enter a valid email address.");
  }, 180_000);

  it("a hollow IR cached with the flag off is never served once the flag is on (TD-22)", async () => {
    geminiMock.mockImplementation(async () => reply(irFor("/form", "email")));
    const request = `Fill the enquiry form and submit it. ${Date.now()}-${Math.random()}`;
    const off = (await toIR(caseOf("valid"), models["/form"], request, base + "/form")).ir;
    expect(off.meta.truncated).toBeFalsy(); // cached: finalize caches every untruncated IR
    process.env.HOLLOW_PASS_GUARDS_ENABLED = "true";
    expectIncomplete((await toIR(caseOf("valid"), models["/form"], request, base + "/form")).ir);
  }, 180_000);
});

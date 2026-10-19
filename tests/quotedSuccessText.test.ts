import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

// TD-131: the request's own quoted success text is never re-grounded onto a different message.
// Run 2026-10-15T17-13-59 asked to check that "Thank You" is shown; the flow stalled on a validation
// error, the final assertion was rewritten to that error, and the case PASSED unsubmitted.
// Same harness as selectOnTextbox.test.ts: only the LLM is mocked; the replay that re-grounds the
// assertion is the real one, in a real Chromium.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR, replacesQuotedSuccessText } = await import("../src/stages/ir.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

describe("replacesQuotedSuccessText", () => {
  const req = `Submit the form and check that "Thank You" is shown.`;
  it("refuses a different message in place of the request's quoted text", () => {
    expect(replacesQuotedSuccessText("Thank You", "Please select a purpose (Self Use or Investment).", req)).toBe(true);
  });
  it("accepts a respelling that still contains it", () => {
    expect(replacesQuotedSuccessText("Thank You", "Thank you!", req)).toBe(false);
    expect(replacesQuotedSuccessText("Thank You", "THANK YOU — your interest has been registered", req)).toBe(false);
  });
  it("does not apply when the guess is the model's own, not quoted by the person", () => {
    expect(replacesQuotedSuccessText("Success", "Please select a purpose.", req)).toBe(false);
    expect(replacesQuotedSuccessText("Thank You", "Please select a purpose.", "submit and check it worked")).toBe(false);
  });
  it("reads single and curly quotes too", () => {
    expect(replacesQuotedSuccessText("Thank You", "Error", "check 'Thank You' appears")).toBe(true);
    expect(replacesQuotedSuccessText("Thank You", "Error", "check “Thank You” appears")).toBe(true);
  });
});

const PAGE = `<!doctype html><html><head><title>Form</title></head><body><main>
<h2>Preferences</h2><button type="button" id="next">Next</button><p id="err"></p>
<script>document.getElementById("next").onclick = () => {
  document.getElementById("err").textContent = "Please select a purpose (Self Use or Investment).";
};</script></main></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(PAGE); else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => geminiMock.mockReset());

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const IR = {
  meta: { feature: "Form", title: "Form", priority: "high", sourcePrompt: "p", baseUrl: "" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/form" } },
    { id: "s2", action: "click", target: { role: "button", name: "Next" } },
    { id: "s3", action: "wait", value: "300" },
    { id: "s4", action: "assert", target: { text: "Thank You" }, assertion: "visible" },
  ],
};
const testCase: any = { title: "Form", priority: "high", feature: "Form", steps: ["Submit"], expected: "Thank You",
  category: "valid", generatedFrom: "upfront" };

async function compile(salesforce: boolean): Promise<string> {
  const browser = await chromium.launch(chromiumLaunchOptions());
  let model: any;
  try {
    const page = await browser.newPage();
    await page.goto(base + "/form");
    model = await withTargetApp("salesforce", () => extractDomModelFromPage(page, base + "/form"));
  } finally { await browser.close(); }
  geminiMock.mockImplementation(async (_p: string, opts: any) =>
    /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
      ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
      : reply({ ...IR, meta: { ...IR.meta, baseUrl: base } }));
  const request = `Click Next and check that "Thank You" is shown. ${Date.now()}-${Math.random()}`;
  const go = () => toIR(testCase, model, request, base + "/form");
  const { ir } = salesforce ? await withTargetApp("salesforce", go) : await go();
  return ir.steps.at(-1)!.target!.text!;
}

describe("the final assertion keeps the request's quoted success text (Salesforce run)", () => {
  it("a stalled flow keeps \"Thank You\", so the test fails instead of passing on the error", async () => {
    expect(await compile(true)).toBe("Thank You");
  }, 180_000);

  it("an ordinary run is unchanged: it is still re-grounded onto the page's message", async () => {
    expect(await compile(false)).toBe("Please select a purpose (Self Use or Investment).");
  }, 180_000);
});

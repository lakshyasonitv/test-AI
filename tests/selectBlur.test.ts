import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { chooseLive } from "../src/stages/targetResolver.js";
import { chromiumLaunchOptions } from "../src/browserLaunch.js";
import { specHelpers } from "./fixtures/specHelpers.js";
import type { IR } from "../src/schema/ir.js";

// Real Salesforce Experience run 2026-10-14T01-59-44-982Z-5d0a0e15. The lead form keeps a field's
// value in component state only on `change` — which the browser fires when the field LOSES FOCUS.
// `fill()` focuses the field; `selectOption()` on the next control does NOT move focus. So the
// email was typed, never committed, and choosing the phone code re-rendered the form from state
// with the email empty. Its screenshots show it: filled after step 11, empty after step 12. A person
// clicks the dropdown, which blurs the email first; choose() must do the same.

const FORM = `<!doctype html><body><form id="f"></form><p id="out"></p><script>
  const state = { name: "", email: "", code: "" };
  function render() {
    const f = document.getElementById("f");
    f.innerHTML =
      '<label>Full Name <input id="nm" value="' + state.name + '"></label>' +
      '<label>Email Address <input id="em" value="' + state.email + '"></label>' +
      '<label>Code <select id="cd"><option value="">--</option><option>+971 (UAE)</option><option>+91 (IN)</option></select></label>';
    document.getElementById("cd").value = state.code;
    document.getElementById("nm").addEventListener("change", (e) => { state.name = e.target.value; });
    document.getElementById("em").addEventListener("change", (e) => { state.email = e.target.value; });
    // Like the real form: choosing a code re-renders from state.
    document.getElementById("cd").addEventListener("change", (e) => { state.code = e.target.value; render(); });
  }
  render();
</script></body>`;

const SPEC = generateSpec({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
  steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Code" }, value: "+971 (UAE)" }],
} as unknown as IR, "artifacts");

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(chromiumLaunchOptions()); });
afterAll(async () => { await browser.close(); });

describe("choosing an option commits the field typed before it", () => {
  it("the generated spec's choose(): the email survives choosing the phone code", async () => {
    const { choose } = specHelpers(SPEC, ["choose"]) as unknown as { choose: Function };
    const page = await browser.newPage();
    await page.setContent(FORM);
    await page.locator("#nm").fill("test full name");
    await page.locator("#em").fill("test@gmail.com");
    await choose(page, page.locator("#cd"), "+971 (UAE)");
    expect(await page.locator("#em").inputValue()).toBe("test@gmail.com");
    expect(await page.locator("#nm").inputValue()).toBe("test full name");
    expect(await page.locator("#cd").inputValue()).toBe("+971 (UAE)");
    await page.close();
  });

  it("the live replay's chooseLive(): same", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    await page.locator("#nm").fill("test full name");
    await page.locator("#em").fill("test@gmail.com");
    await chooseLive(page, page.locator("#cd"), "+971 (UAE)");
    expect(await page.locator("#em").inputValue()).toBe("test@gmail.com");
    await page.close();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { resolveScope, resolveField } from "../src/stages/targetResolver.js";
import type { IR } from "../src/schema/ir.js";
import { specHelpers } from "./fixtures/specHelpers.js";

/**
 * TD-135, in a REAL Chromium (D-19): a hidden modal-like element must never become the scope.
 *
 * Two shapes of the same bug:
 * - the live resolver (`resolveScope`) used `.filter({ visible: true })`, which Playwright 1.49 does
 *   not have (a silent no-op), so ANY hidden match won: a `display:none` `.modal-backdrop`;
 * - the generated spec's `scopeOf` appended `':visible'` to the whole comma-separated
 *   `DIALOG_SELECTOR`, so it applied to the LAST alternative only, and a hidden `[role="dialog"]`
 *   still matched. Demoblaze keeps three such modals in every page; Lightning keeps them too.
 * Both now put `:visible` on every alternative.
 */

const SPEC = generateSpec({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "fill email", baseUrl: "https://example.com" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.co" },
  ],
} as unknown as IR, "artifacts");

// A hidden backdrop and a hidden role="dialog" (each with its own "Email"), and the visible form.
const HIDDEN_MODALS = `<html><body>
  <div class="modal-backdrop" style="display:none"></div>
  <div class="modal fade" role="dialog" style="display:none"><label>Email <input id="hidden-email"></label></div>
  <form id="main"><label>Email <input id="page-email"></label></form>
</body></html>`;

// A genuinely open dialog over a page with the same field name: the dialog must still win.
const OPEN_DIALOG = `<html><body>
  <form><label>Email <input id="page-email"></label></form>
  <div role="dialog" id="dlg"><label>Email <input id="dlg-email"></label></div>
</body></html>`;

describe("TD-135: a hidden modal-like element is never the scope", () => {
  let browser: Browser;
  let page: Page;
  let h: Record<string, Function>;
  const tagAndId = (l: { evaluate: Function }) =>
    l.evaluate((e: Element) => `${e.tagName}#${e.id}`);

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    h = specHelpers(SPEC, ["scopeOf", "field"]);
  });
  afterAll(async () => { await browser.close(); });

  it("live resolver: hidden backdrop + hidden role=dialog → the scope is the page body", async () => {
    await page.setContent(HIDDEN_MODALS);
    expect(await tagAndId(await resolveScope(page))).toBe("BODY#");
  });

  it("live resolver: a fill on 'Email' lands in the VISIBLE page field", async () => {
    await page.setContent(HIDDEN_MODALS);
    await (await resolveField(page, "Email", "fill")).fill("x@y.co");
    expect(await page.locator("#page-email").inputValue()).toBe("x@y.co");
  });

  it("generated spec: scopeOf ignores the hidden role=dialog too", async () => {
    await page.setContent(HIDDEN_MODALS);
    expect(await tagAndId(await h.scopeOf(page))).toBe("BODY#");
  });

  it("generated spec: field() fills the VISIBLE page field", async () => {
    await page.setContent(HIDDEN_MODALS);
    await (await h.field(page, "Email", "fill")).fill("x@y.co");
    expect(await page.locator("#page-email").inputValue()).toBe("x@y.co");
  });

  // TD-160 (latent, not fixed): `firstUnique`'s `c.locator(":visible")` looks at the candidate's
  // DESCENDANTS, so its "one visible match out of two" narrowing is a no-op. A later rung still picks
  // the visible twin today; these pin that, so a change to the later rungs cannot silently lose it.
  const TWIN = `<html><body>
    <div style="display:none"><label>Email <input id="hidden-twin"></label></div>
    <label>Email <input id="visible-twin"></label>
  </body></html>`;

  it("TD-160 pin, live resolver: one visible field among same-named twins is the one filled", async () => {
    await page.setContent(TWIN);
    await (await resolveField(page, "Email", "fill")).fill("x@y.co");
    expect(await page.locator("#visible-twin").inputValue()).toBe("x@y.co");
  });

  it("TD-160 pin, generated spec: field() picks the visible twin too", async () => {
    await page.setContent(TWIN);
    await (await h.field(page, "Email", "fill")).fill("x@y.co");
    expect(await page.locator("#visible-twin").inputValue()).toBe("x@y.co");
  });

  it("an OPEN dialog is still the scope, in both", async () => {
    await page.setContent(OPEN_DIALOG);
    expect(await tagAndId(await resolveScope(page))).toBe("DIV#dlg");
    expect(await tagAndId(await h.scopeOf(page))).toBe("DIV#dlg");
  });
});

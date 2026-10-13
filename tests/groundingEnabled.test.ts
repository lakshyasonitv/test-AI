import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { AppModel } from "../src/schema/appModel.js";
import { groundingError, urlAssertionError } from "../src/stages/ir.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import { resolveLive } from "../src/stages/targetResolver.js";
import { withTargetApp } from "../src/runTarget.js";
import { chromiumLaunchOptions } from "../src/browserLaunch.js";

// A real Salesforce Experience site (run 2026-10-13T11-06-23-259Z-5afedf16) lists one
// "Select for EOI" button per unit; the first unit's is DISABLED. Grounding took the first by
// document order and the generated click waited 10 s on "element is not enabled". An acting step
// must prefer an enabled twin; discovery already measures `enabled`.

const HOST = "https://units.example";
const ir = (action: string, extra: any = {}) => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action, target: { role: "button", name: "Select for EOI" }, ...extra },
  ],
}) as any;
const model = (elements: any[]) => AppModel.parse({ baseUrl: HOST, pages: [{ url: `${HOST}/`, concepts: [], elements }] });
const btn = (css: string, extra: any = {}) => ({ role: "button", name: "Select for EOI", visible: true, css, ...extra });

describe("grounding prefers an enabled twin for a step that acts", () => {
  it("a click skips the disabled first twin", () => {
    const i = ir("click");
    expect(groundingError(i, model([btn("#u1", { enabled: false }), btn("#u2", { enabled: true })]))).toBeNull();
    expect(i.steps[1].target.css).toBe("#u2");
  });

  it("an assertion keeps first-in-order: asserting a disabled button is legitimate", () => {
    const i = ir("assert", { assertion: "visible" });
    expect(groundingError(i, model([btn("#u1", { enabled: false }), btn("#u2", { enabled: true })]))).toBeNull();
    expect(i.steps[1].target.css).toBe("#u1");
  });

  it("visibility still outranks enabled: a visible disabled twin beats a hidden enabled one", () => {
    const i = ir("click");
    groundingError(i, model([btn("#hid", { visible: false, enabled: true }), btn("#dis", { enabled: false })]));
    expect(i.steps[1].target.css).toBe("#dis");
  });

  it("only a tie-break: an exact disabled match still beats an enabled partial one", () => {
    const i = ir("click");
    groundingError(i, model([btn("#exact", { enabled: false }), { ...btn("#partial"), name: "Select for EOI now" }]));
    expect(i.steps[1].target.css).toBe("#exact");
  });

  it("in a real browser: the live walker marks the disabled twin and the grounded css is clickable", async () => {
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><main>
        <div class="row"><span>Unit 101 — sold</span><button disabled>Select for EOI</button></div>
        <div class="row"><span>Unit 102</span><button aria-disabled="true">Select for EOI</button></div>
        <div class="row"><span>Unit 103</span><button onclick="document.body.dataset.picked='103'">Select for EOI</button></div>
      </main>`);
      const discovered = await withTargetApp("salesforce", () => extractDomModelFromPage(page, `${HOST}/`));
      const i = ir("click");
      expect(groundingError(i, AppModel.parse({ ...discovered, baseUrl: HOST }))).toBeNull();
      await (await resolveLive(page, i.steps[1].target)).click({ timeout: 3000 });
      expect(await page.evaluate(() => document.body.dataset.picked)).toBe("103");
    } finally { await browser.close(); }
  });
});

describe("url_contains values that can never be a page URL", () => {
  const withAssert = (value: string, clickRole = "link", clickName = "+91 9414933975") => ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: HOST },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: clickRole, name: clickName } },
      { id: "s3", action: "assert", value, assertion: "url_contains" },
    ],
  }) as any;
  const m = model([{ role: "link", name: "+91 9414933975", visible: true }]);

  it("rejects tel: and mailto: (the page URL never changes for them)", () => {
    expect(urlAssertionError(withAssert("tel:+91"), m)?.index).toBe(2);
    expect(urlAssertionError(withAssert("mailto:a@b.example"), m)?.index).toBe(2);
  });

  it("rejects a value that is only punctuation, like \"#\"", () => {
    expect(urlAssertionError(withAssert("#"), m)?.index).toBe(2);
    expect(urlAssertionError(withAssert("/"), m)?.index).toBe(2);
  });

  it("leaves a real path alone when no clicked link says otherwise", () => {
    expect(urlAssertionError(withAssert("/projects", "button", "Explore Projects"), m)).toBeNull();
    expect(urlAssertionError(withAssert("#/projects", "button", "Explore Projects"), m)).toBeNull();
  });
});

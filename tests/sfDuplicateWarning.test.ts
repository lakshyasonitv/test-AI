import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { dismissDuplicateWarning } from "../src/stages/liveExtend.js";
import { FRONTDOOR_REF } from "../src/stages/salesforceFrontdoor.js";

/**
 * Salesforce's duplicate-rule warning covers the fields under it.
 *
 * Run 2026-11-03T05-07-28-369Z-388aa153: after the billing address was typed, "Similar Records
 * Exist" opened upward from the form's footer over Billing Zip; the fill waited under it until the
 * run was killed. The warning is closed before each step of an org-connection test. Executed in a
 * real browser (D-19): what matters is that the field becomes reachable again.
 */
const FORM = `<html><body>
  <label for="zip">Billing Zip/Postal Code</label><input id="zip" />
  <div id="pop" role="dialog" style="position:fixed;inset:0;background:#fff">
    <h2>Similar Records Exist</h2>
    <button aria-label="Close error dialog" onclick="document.getElementById('pop').remove()">x</button>
  </div>
</body></html>`;

const base = "https://zq.example";
const fill = { id: "s2", action: "fill", target: { css: "#zip" }, value: "12345" } as any;

describe("Salesforce duplicate warning", () => {
  let browser: Browser; let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("an org-connection spec closes it before each interaction step, so the covered field fills", async () => {
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: base },
      steps: [{ id: "s1", action: "navigate", target: { url: FRONTDOOR_REF } }, fill] } as any);
    expect(spec).toContain("async function sfDismissDuplicates(page)");
    const helper = spec.slice(spec.indexOf("async function sfDismissDuplicates"), spec.indexOf("\n}", spec.indexOf("async function sfDismissDuplicates")) + 2);
    const fillLine = spec.split("\n").find((l) => l.includes('.fill("12345"'))!;
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;
    await page.setContent(FORM);
    await new AsyncFunction("page", `${helper}\nawait sfDismissDuplicates(page);\n${fillLine}`)(page);
    expect(await page.locator("#zip").inputValue()).toBe("12345");
  }, 60_000);

  it("a spec that is not an org-connection test is unchanged", () => {
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: base },
      steps: [fill] } as any);
    expect(spec).not.toContain("sfDismissDuplicates");
  });

  it("the grounding replay closes it too, and does nothing when it is not there", async () => {
    await page.setContent(FORM);
    await dismissDuplicateWarning(page);
    expect(await page.locator("#pop").count()).toBe(0);
    await dismissDuplicateWarning(page); // nothing open: no error, no click
  }, 60_000);
});

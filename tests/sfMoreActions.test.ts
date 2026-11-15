import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { generateSpec } from "../src/stages/generator.js";

/**
 * A record action Lightning keeps under "Show more actions": a Service Appointment shows New Contact,
 * New Opportunity, New Case and hides Edit (run 2026-11-15T11-55-56-797Z-7153003e timed out on "Edit").
 * The spec clicks the menu item of the same name. Canary names.
 */
const spec = generateSpec({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.my.salesforce.com" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/lightning/r/Zq/view" } },
    { id: "s2", action: "click", target: { role: "button", name: "Zq Edit", css: 'button[name="Edit"]' } },
    { id: "s3", action: "click", target: { role: "button", name: "Save" } },
  ],
} as any);

let browser: Browser;
let sfMoreItem: (page: any, loc: any, name: string) => Promise<any>;
beforeAll(async () => {
  const start = spec.indexOf("async function sfMoreItem(");
  let depth = 0, end = -1;
  for (let i = spec.indexOf("{", start); i < spec.length; i++) {
    if (spec[i] === "{") depth++;
    else if (spec[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  sfMoreItem = new Function(spec.slice(start, end) + "\nreturn sfMoreItem;")();
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); });

const MENU = `<button aria-label="Show more actions" onclick="document.getElementById('m').hidden=false">v</button>
  <div id="m" role="menu" hidden><a role="menuitem" href="#" onclick="document.body.dataset.done='edit'">Zq Edit</a></div>`;

describe("a record action under Show more actions", () => {
  it("is used for a named button on a Salesforce page, not for Save", () => {
    expect(spec).toContain(`await sfMoreItem(page, page.locator("button[name=\\"Edit\\"]").first(), "Zq Edit")`);
    expect(spec.match(/await sfMoreItem\(page/g)).toHaveLength(1);
  });

  it("clicks the menu item when the button is not on the page", async () => {
    const page = await browser.newPage();
    await page.setContent(MENU);
    const item = await sfMoreItem(page, page.locator('button[name="Edit"]').first(), "Zq Edit");
    expect(item).toBeTruthy();
    await item.click();
    expect(await page.evaluate(() => document.body.dataset.done)).toBe("edit");
    await page.close();
  }, 30_000);

  it("leaves the page alone when the button is there, and closes a menu without the item", async () => {
    const page = await browser.newPage();
    await page.setContent(`<button name="Edit">Zq Edit</button>`);
    expect(await sfMoreItem(page, page.locator('button[name="Edit"]').first(), "Zq Edit")).toBeNull();
    await page.setContent(MENU.replace("Zq Edit", "Zq Other"));
    expect(await sfMoreItem(page, page.locator('button[name="Edit"]').first(), "Zq Edit")).toBeNull();
    await page.close();
  }, 30_000);
});

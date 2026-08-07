import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";

// Regression: a <div onClick={...}>Submit</div> built with no semantic tag and no role
// attribute — the common shape of an early-stage React/Vue/Tailwind "button" component — was
// invisible to discovery entirely. extractCrawlResponse (domExtract.ts) parses an HTML STRING
// via cheerio and has no access to computed styles, so this needs a real, rendered page —
// hence a real browser here rather than a mocked/pure-function test.
describe("extractDomModelFromPage — generic clickable detection", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("finds a non-semantic div styled as a button via cursor:pointer", async () => {
    await page.setContent(`
      <html><body>
        <div style="cursor:pointer; width:120px; height:40px;" id="submit-btn">Submit</div>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const found = model?.pages[0]?.elements.find((e) => e.name === "Submit");
    expect(found).toBeDefined();
    expect(found?.role).toBe("button");
    expect(found?.css).toBe("#submit-btn");
  });

  it("finds a div with an onclick attribute even without a pointer cursor", async () => {
    await page.setContent(`
      <html><body>
        <div onclick="void(0)" data-testid="save-action" style="width:80px;height:30px;">Save</div>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const found = model?.pages[0]?.elements.find((e) => e.name === "Save");
    expect(found).toBeDefined();
    expect(found?.testId).toBe("save-action");
  });

  it("does not capture a large wrapper div that merely inherits cursor:pointer", async () => {
    await page.setContent(`
      <html><body>
        <div style="cursor:pointer; width:900px; height:600px;">
          Some big section wrapper with lots of unrelated content inside it.
        </div>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const names = model?.pages[0]?.elements.map((e) => e.name) ?? [];
    expect(names.some((n) => n.includes("big section wrapper"))).toBe(false);
  });

  it("does not duplicate an element the existing semantic-tag pass already found", async () => {
    await page.setContent(`
      <html><body>
        <button style="cursor:pointer;">Click me</button>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const matches = model?.pages[0]?.elements.filter((e) => e.name === "Click me") ?? [];
    expect(matches.length).toBe(1);
  });

  it("does not capture an invisible (zero-size) element", async () => {
    await page.setContent(`
      <html><body>
        <div onclick="void(0)" style="width:0;height:0;overflow:hidden;">Hidden action</div>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const found = model?.pages[0]?.elements.find((e) => e.name === "Hidden action");
    expect(found).toBeUndefined();
  });
});

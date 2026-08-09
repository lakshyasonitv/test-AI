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

// Regression for the thinkvibes.com run (2026-08-07T04-47-41-260Z-40270415): a hamburger
// menu-toggle (<a id="nav-toggle">, display:none at desktop width, mobile-only via a CSS media
// query) got grounded as a "visible" assertion target and timed out — because cheerio
// (extractCrawlResponse, the primary DOM-extraction path) has no computed-style access at all,
// so every element's `visible` field arrives hardcoded true regardless of actual CSS state.
// recheckVisibility re-checks real visibility, in the live page, for every element discovery
// gave a css selector (an id, here) — that's exactly the subset eligible for ir.ts's
// grounding-time auto-css-attach, which is what let the bad selector reach the generated test.
describe("extractDomModelFromPage — real visibility for css-bearing elements", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("flags a display:none, id-bearing element as not visible", async () => {
    await page.setContent(`
      <html><body>
        <a href="#0" id="nav-toggle" style="display:none;">Menu</a>
        <a href="#0" id="home-link" style="display:block;">Home</a>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const toggle = model?.pages[0]?.elements.find((e) => e.css === "#nav-toggle");
    const home = model?.pages[0]?.elements.find((e) => e.css === "#home-link");
    expect(toggle?.visible).toBe(false);
    expect(home?.visible).toBe(true);
  });

  it("flags visibility:hidden and zero-size id-bearing elements as not visible too", async () => {
    await page.setContent(`
      <html><body>
        <a href="#0" id="vis-hidden" style="visibility:hidden;">Ghost</a>
        <a href="#0" id="zero-size" style="display:inline-block;width:0;height:0;overflow:hidden;">Collapsed</a>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    expect(model?.pages[0]?.elements.find((e) => e.css === "#vis-hidden")?.visible).toBe(false);
    expect(model?.pages[0]?.elements.find((e) => e.css === "#zero-size")?.visible).toBe(false);
  });

  it("leaves an element with no css selector untouched (still hardcoded true)", async () => {
    // A link with no id/data-test/data-testid has no css selector at all — recheckVisibility
    // has nothing to re-query, so the pre-existing (hardcoded) `visible: true` survives.
    await page.setContent(`
      <html><body>
        <a href="#0" style="display:none;">No id at all</a>
      </body></html>
    `);
    const model = await extractDomModelFromPage(page, "https://example.com/");
    const el = model?.pages[0]?.elements.find((e) => e.name === "No id at all");
    expect(el?.css).toBeFalsy();
    expect(el?.visible).toBe(true);
  });
});

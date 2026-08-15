import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";

// extractDomModelFromPage polls for up to DISCOVERY_HYDRATION_POLL_MS when it finds zero
// elements, to give a real JS-hydrated page time to render (TECH_DEBT.md TD-31). Every test in
// this file uses page.setContent() — static from the instant it's set, nothing to wait for — so
// disable the poll for the whole file rather than pay it on every negative-result test.
process.env.DISCOVERY_HYDRATION_POLL_MS = "0";

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

// Regression (TECH_DEBT.md TD-31): discovery snapshotted amazon.in before it had rendered a
// <body> at all — 0 elements, empty title — and the resulting empty AppModel forced test-case
// generation into role-only assertions with no name to ground against, which then crashed spec
// generation and killed the whole run with zero cases. Measured directly against the real site:
// 0 elements at +800ms post-domcontentloaded (the wait every call site already had), 347 by
// +2.8s. extractDomModelFromPage must poll rather than accept the first zero-element read.
describe("extractDomModelFromPage — hydration poll", () => {
  let browser: Browser;
  let page: Page;
  let prevPollMs: string | undefined;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    prevPollMs = process.env.DISCOVERY_HYDRATION_POLL_MS;
    // Short but real: long enough for the delayed-render test below to land inside it (content
    // appears at 500ms, poll interval is a fixed 1000ms — one cycle is enough), short enough
    // this test doesn't itself become the slow one in the suite.
    process.env.DISCOVERY_HYDRATION_POLL_MS = "2500";
  });

  afterAll(async () => {
    await browser.close();
    if (prevPollMs === undefined) delete process.env.DISCOVERY_HYDRATION_POLL_MS;
    else process.env.DISCOVERY_HYDRATION_POLL_MS = prevPollMs;
  });

  it("picks up content that renders shortly after the first (empty) read", async () => {
    await page.setContent("<html><body></body></html>");
    // Simulate JS hydration finishing just after the initial snapshot — exactly the shape of
    // the real bug (Amazon's body is empty at domcontentloaded, populated ~2s later).
    page.evaluate(() => {
      setTimeout(() => {
        const btn = document.createElement("button");
        btn.textContent = "Hydrated Button";
        document.body.appendChild(btn);
      }, 500);
    });

    const model = await extractDomModelFromPage(page, "https://example.com/hydrating");
    const names = model?.pages[0]?.elements.map((e) => e.name) ?? [];
    expect(names).toContain("Hydrated Button");
  });

  it("still correctly resolves to zero elements for a page that never renders any (auth wall)", async () => {
    await page.setContent("<html><body></body></html>");
    const model = await extractDomModelFromPage(page, "https://example.com/truly-empty");
    expect(model?.pages[0]?.elements.length ?? 0).toBe(0);
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

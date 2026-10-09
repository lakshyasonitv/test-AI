import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page, type Locator } from "@playwright/test";
import { groundingError } from "../src/stages/ir.js";
import { resolveCode } from "../src/stages/targetResolver.js";

/**
 * LS-1 (grounding ignored `nth`) and LS-2 (a hidden twin beat the visible element), filed by the
 * live-DOM stream in TECH_DEBT.md. Both block turning DISCOVERY_LIVE_DOM on.
 *
 * Every case grounds a step through the real `groundingError`, takes the expression the generator
 * would emit (`resolveCode`), and RUNS it against a real Chromium page — CLAUDE.md D-19: a generated
 * locator that reads right is not verified until it has been executed once. LS-1 was exactly that:
 * `page.locator("#add-1").nth(1)` reads fine and matches nothing.
 */

const meta = { feature: "f", title: "t", priority: "high", sourcePrompt: "", baseUrl: "https://shop.example.com" };
const URL_ = "https://shop.example.com/";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

function ground(elements: any[], step: Record<string, unknown>) {
  const ir = { meta, steps: [{ id: "s0", action: "navigate", target: { url: URL_ } }, { id: "s1", ...step }] } as any;
  const err = groundingError(ir, { baseUrl: URL_, pages: [{ url: URL_, title: "", forms: [], elements }] } as any);
  return { err, target: ir.steps[1].target };
}

/** The generator's expression for this target, evaluated against a live page. */
async function emitted(page: Page, target: any, action?: string): Promise<{ code: string; loc: Locator }> {
  const code = resolveCode(target, action);
  const loc = await (new Function("page", `return (async () => ${code})();`))(page);
  return { code, loc };
}

async function open(body: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  return page;
}

describe("LS-1 — the nth duplicate, and an nth that matches what the browser counts", () => {
  const TWO_IDS = [
    { role: "button", name: "Add to cart", css: "#add-1", visible: true },
    { role: "button", name: "Add to cart", css: "#add-2", visible: true },
  ];

  it("the reported case: nth 1 grounds to the SECOND button, and the emitted locator finds exactly it", async () => {
    const { err, target } = ground(TWO_IDS, { action: "click", target: { role: "button", name: "Add to cart", nth: 1 } });
    expect(err).toBeNull();
    expect(target.css).toBe("#add-2");
    expect(target.nth, "a unique selector needs no index").toBeUndefined();

    const page = await open(`<button id="add-1">Add to cart</button><button id="add-2">Add to cart</button>`);
    const { code, loc } = await emitted(page, target);
    expect(await loc.count(), code).toBe(1);
    expect(await loc.getAttribute("id")).toBe("add-2");
    await page.close();
  }, 30_000);

  it("a SHARED selector keeps an index — rebased onto the elements that share it", async () => {
    // A "Remove" control shares the data-test, so the second "Add to cart" is the THIRD
    // [data-test="add"] in the document: nth must become 2, not stay 1.
    const shared = [
      { role: "button", name: "Remove", css: '[data-test="add"]', visible: true },
      { role: "button", name: "Add to cart", css: '[data-test="add"]', visible: true },
      { role: "button", name: "Add to cart", css: '[data-test="add"]', visible: true },
    ];
    const { err, target } = ground(shared, { action: "click", target: { role: "button", name: "Add to cart", nth: 1 } });
    expect(err).toBeNull();
    expect(target).toMatchObject({ css: '[data-test="add"]', nth: 2 });

    const page = await open(`<button data-test="add" id="r">Remove</button>
      <button data-test="add" id="a1">Add to cart</button><button data-test="add" id="a2">Add to cart</button>`);
    const { code, loc } = await emitted(page, target);
    expect(await loc.count(), code).toBe(1);
    expect(await loc.getAttribute("id")).toBe("a2");
    await page.close();
  }, 30_000);

  it("a text-only action target honours nth the same way", () => {
    const { err, target } = ground(TWO_IDS, { action: "click", target: { text: "Add to cart", nth: 1 } });
    expect(err).toBeNull();
    expect(target).toMatchObject({ role: "button", name: "Add to cart", css: "#add-2" });
    expect(target.nth).toBeUndefined();
  });

  it("no nth: the first duplicate, exactly as before", () => {
    const { target } = ground(TWO_IDS, { action: "click", target: { role: "button", name: "Add to cart" } });
    expect(target.css).toBe("#add-1");
    expect("nth" in target).toBe(false);
  });

  it("an nth beyond the duplicates the model holds is left exactly as it was", () => {
    const { err, target } = ground(TWO_IDS, { action: "click", target: { role: "button", name: "Add to cart", nth: 5 } });
    expect(err).toBeNull();
    expect(target).toMatchObject({ css: "#add-1", nth: 5 });
  });
});

describe("LS-2 — a visible element beats a hidden twin", () => {
  const MIRROR = [
    { role: "textbox", name: "Password", css: "#pwMirror", visible: false },
    { role: "textbox", name: "Password", css: "#password", visible: true },
  ];

  it("the Salesforce password-mirror shape grounds to the box a person can type into", async () => {
    const { err, target } = ground(MIRROR, { action: "fill", target: { role: "textbox", name: "Password" }, value: "x" });
    expect(err).toBeNull();
    expect(target.css).toBe("#password");

    const page = await open(`<input id="pwMirror" type="password" aria-label="Password" style="display:none">
      <input id="password" type="password" aria-label="Password">`);
    const { code, loc } = await emitted(page, target, "fill");
    await loc.fill("secret", { timeout: 3000 });
    expect(await page.locator("#password").inputValue(), code).toBe("secret");
    await page.close();
  }, 30_000);

  it("a step asserting something is HIDDEN keeps the old first-in-order choice", () => {
    const { target } = ground(MIRROR, { action: "assert", target: { role: "textbox", name: "Password" }, assertion: "hidden" });
    expect(target.css).toBe("#pwMirror");
  });

  it("only a tie-break: a hidden EXACT match still beats a visible partial one", () => {
    const { target } = ground([
      { role: "button", name: "Save draft", css: "#visible-partial", visible: true },
      { role: "button", name: "Save", css: "#hidden-exact", visible: false },
    ], { action: "click", target: { role: "button", name: "Save" } });
    expect(target.css).toBe("#hidden-exact");
  });

  it("nth and visibility together: hidden twins still count as duplicates in model order", () => {
    // nth names a position among same-role+name elements; visibility does not renumber them.
    const { target } = ground(MIRROR, { action: "fill", target: { role: "textbox", name: "Password", nth: 1 }, value: "x" });
    expect(target.css).toBe("#password");
  });
});

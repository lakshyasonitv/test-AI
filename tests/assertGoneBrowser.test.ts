import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, expect as pwExpect, type Browser, type Page } from "@playwright/test";

/**
 * `assertGone`, EXECUTED — a renamed element must be reported as renamed, not as a mystery timeout.
 *
 * TECH_DEBT.md TD-95, from a real saucedemo run. The case "Add item to cart updates cart count and
 * contents" failed at `Assert 'Cart, empty' is hidden` with nothing but
 * `Timed out 10000ms waiting for expect(locator).toBeHidden()`, on a site that was working
 * perfectly. Discovery records the cart's `aria-label` ("Cart, empty") as its identity, that label
 * ENCODES STATE and becomes "Cart, 1 item" once something is added, and `resolveCode` resolves
 * `css` first — so the locator matches an element that is always present and the assertion can
 * never pass.
 *
 * This helper does not make the test pass. It makes the failure TRUE: the state did change, the
 * test just expressed it as "the element disappears" instead of "the label changes".
 *
 * WHY EXECUTED. DECISIONS.md D-19: `.filter({visible:true})` shipped as a fix, passed `tsc`, passed
 * a unit test, and was a silent no-op because the option did not exist in the pinned Playwright.
 * Both checks only read the emitted string. This one reasons about `getAttribute` on a locator that
 * may match nothing, and about what Playwright throws — neither is safe to assume.
 *
 * Extracted from a REAL generated spec, not from generator.ts's template source: the template
 * interpolates the timeout and carries escaped regex backslashes, so the raw text between backticks
 * is not valid JavaScript on its own. That is not hypothetical — writing this helper produced
 * exactly that bug: one lost backslash turned an escape into a real newline inside a single-quoted
 * string, i.e. a spec that would not parse. Generating it is what caught it.
 */

type AssertGone = (loc: any, namedAs: string) => Promise<void>;

let browser: Browser;
let assertGone: AssertGone;

beforeAll(async () => {
  // A short assertion timeout, or every negative case below waits the full 10s. It is read at
  // module load, so the env has to be set before generator.ts is imported — hence the dynamic
  // import rather than a top-level one.
  process.env.ASSERTION_TIMEOUT_MS = "700";
  const { generateSpec } = await import("../src/stages/generator.js");
  const spec = generateSpec({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      {
        id: "s2", action: "assert", assertion: "hidden",
        target: { role: "button", name: "Cart, empty", css: '[data-test="shopping-cart-link"]' },
      },
    ],
  } as any);

  const start = spec.indexOf("async function assertGone(");
  if (start < 0) throw new Error("generated spec has no assertGone — is the helper wired in?");
  let depth = 0, end = -1;
  for (let i = spec.indexOf("{", start); i < spec.length; i++) {
    if (spec[i] === "{") depth++;
    else if (spec[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  assertGone = new Function("expect", spec.slice(start, end) + "\nreturn assertGone;")(pwExpect);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => { await browser?.close(); });

const pageWith = async (body: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body>" + body + "</body></html>");
  return page;
};

/** The saucedemo cart, in shape: one stable selector, one state-encoding label. */
const CART = (label: string) =>
  '<a data-test="shopping-cart-link" href="#" aria-label="' + label + '">cart</a>';

const cartLocator = (page: Page) => page.locator('[data-test="shopping-cart-link"]').first();

/** Run the helper and hand back the rejection, or null if it resolved. */
const failure = (page: Page, named = "Cart, empty") =>
  assertGone(cartLocator(page), named).then(() => null, (e: any) => e);

describe("assertGone — executed in a real browser (D-19)", () => {
  it("names BOTH labels when the element was renamed rather than removed", async () => {
    // The exact saucedemo shape: same element, same selector, label moved.
    const page = await pageWith(CART("Cart, 1 item"));
    const err = await failure(page);
    expect(err, "a renamed element did not fail at all").toBeTruthy();
    expect(err.message).toContain('now labelled "Cart, 1 item"');
    expect(err.message).toContain('instead of "Cart, empty"');
    expect(err.message).toContain("the label changed rather than the element disappearing");
    await page.close();
  }, 60_000);

  it("puts the finding on the FIRST line, because that is what reaches the card", async () => {
    // extractFailureDetail takes the first non-empty line as `error` and the whole message as
    // `errorDetail`. A finding on line 3 would never be seen by anyone.
    const page = await pageWith(CART("Cart, 1 item"));
    const err = await failure(page);
    const first = err.message.split("\n").map((l: string) => l.trim()).filter(Boolean)[0];
    expect(first).toContain("Still on the page, but now labelled");
    // …and Playwright's own message must survive further down, or errorDetail loses ground truth.
    expect(err.message).toContain("toBeHidden");
    await page.close();
  }, 60_000);

  it("passes when the element is genuinely gone — the common, valuable case", async () => {
    // `check that button "Login" is not shown` after signing in. This must not regress: it is how
    // the product proves a login worked, and it is the assertion a careless fix would have broken.
    const page = await pageWith("<p>signed in</p>");
    await expect(assertGone(cartLocator(page), "Cart, empty")).resolves.toBeUndefined();
    await page.close();
  }, 60_000);

  it("passes when the element is present but actually hidden", async () => {
    const page = await pageWith(
      '<a data-test="shopping-cart-link" aria-label="Cart, empty" style="display:none">x</a>');
    await expect(assertGone(cartLocator(page), "Cart, empty")).resolves.toBeUndefined();
    await page.close();
  }, 60_000);

  it("still fails plainly when the element is there with the SAME label", async () => {
    // The honest red. Suppressing this would be the "green verdict verifying nothing" failure that
    // emitAssert's own vacuous-assertion guard exists to prevent.
    const page = await pageWith(CART("Cart, empty"));
    const err = await failure(page);
    expect(err, "an unchanged visible element must still fail").toBeTruthy();
    expect(err.message).toContain("toBeHidden");
    expect(err.message).not.toContain("the label changed");
    await page.close();
  }, 60_000);

  it("falls back to text when the label is not an aria-label", async () => {
    const page = await pageWith('<button data-test="shopping-cart-link">Cart, 1 item</button>');
    const err = await failure(page);
    expect(err.message).toContain('now labelled "Cart, 1 item"');
    await page.close();
  }, 60_000);

  it("normalises whitespace, so indented markup does not produce a garbled label", async () => {
    // The multi-line-fixture trap that bit the assertChoice test: raw textContent carries the
    // source indentation, and an unnormalised label would read "Cart,\n    1 item".
    const page = await pageWith(
      '<button data-test="shopping-cart-link">\n    Cart,\n    1 item\n  </button>');
    const err = await failure(page);
    expect(err.message).toContain('now labelled "Cart, 1 item"');
    await page.close();
  }, 60_000);
});

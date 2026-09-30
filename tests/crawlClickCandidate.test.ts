import { describe, it, expect } from "vitest";
import { isCrawlClickCandidate } from "../src/stages/hybridDiscovery.js";

/**
 * Which elements the crawler may CLICK to find pages the href pass cannot see.
 *
 * TD-103 IS OPEN, AND THE FIX FOR IT WAS REVERTED. `nav || header` shipped, was measured offline
 * as 8 -> 11 candidates admitting `Cart, empty`, and produced no change at all in production —
 * four more authenticated saucedemo runs, still exactly 2 pages. This file now pins the REVERTED
 * behaviour and records what was ruled out, so the next attempt starts from evidence instead of
 * repeating the same measurement.
 *
 * VERIFIED WORKING, so do not re-investigate these: the filter admitted the cart;
 * `discoverUrlsByClicking` returned "https://www.saucedemo.com/cart.html" against a live
 * authenticated page; `collectCrawlTargets` passed that URL through; `getByRole("button",
 * {name:"Cart, empty"})` resolves to 1 element and clicking it navigates; the probe page keeps its
 * session (one page, one context); `MAX_DISCOVERY_PAGES` is 5 and not binding.
 *
 * THE UNCHECKED LINK: the widening was measured against a 2026-09-17 AppModel where the cart
 * carried `landmark: "header"`. `landmark` is populated ONLY by the DOM discovery path, and
 * `attachElementIdentity` does not copy it onto LLM-authored elements — so on a model built the
 * other way the field is absent and any landmark-keyed condition matches nothing. Check that field
 * on a CURRENT run's AppModel before trying again.
 *
 * SCOPE, measured across every run on disk: the crawl LOOP works — qa-practice.com goes 1 -> 5
 * pages via the href path. It is this click-probe FALLBACK that has never added a page.
 *
 * WHAT IT WAS. `(button && landmark === "nav") || link`. Measured against the real saucedemo
 * inventory page as discovery itself recorded it
 * (`runs/2026-09-17T11-38-39-418Z-bfd03461/02-appmodel.json`), **8 of 38 elements passed and ZERO
 * new URLs survived** the same-origin filter and the two verb guards: the two nav buttons loop
 * back to the same page, About and the three footer socials are external, and Logout / Reset App
 * State are correctly dropped. The filter admitted exactly what led nowhere and excluded exactly
 * what navigated — 2 pages crawled on five separate runs, four of them authenticated.
 *
 * THE PART WORTH REMEMBERING. It had already been "fixed" for this exact site. The comment above
 * the condition says the widening to `/link/i` exists for saucedemo's cart —
 * `<a class="shopping_cart_link">` with no href. It never fired on it: an `<a>` with no href is
 * not a link in the accessibility tree, so discovery records the cart as
 * `role: "button", landmark: "header"`, and the widened condition still rejected it. A fix written
 * against the HTML, checked against the a11y role.
 *
 * The fixtures below are the REAL recorded `{role, name, landmark}` triples from that AppModel,
 * transcribed rather than loaded — `runs/` is gitignored, so a test that read it would pass here
 * and fail in CI.
 */

/** Verbatim from the inventory page's recorded elements. */
const INVENTORY = [
  { role: "button", name: "Open Menu", landmark: "header" },
  { role: "button", name: "All Items", landmark: "nav" },
  { role: "button", name: "Dynamic Catalog", landmark: "nav" },
  { role: "link", name: "About", landmark: "nav" },
  { role: "button", name: "Logout", landmark: "nav" },
  { role: "button", name: "Reset App State", landmark: "nav" },
  { role: "button", name: "Close Menu", landmark: "header" },
  { role: "button", name: "Cart, empty", landmark: "header" },
  { role: "button", name: "View details for Sauce Labs Backpack", landmark: undefined },
  { role: "button", name: "Add to cart", landmark: undefined },
  { role: "link", name: "X", landmark: "footer" },
  { role: "link", name: "Facebook", landmark: "footer" },
  { role: "link", name: "LinkedIn", landmark: "footer" },
  { role: "button", name: "Sauce Labs Backpack", landmark: undefined },
  { role: "button", name: "Name (A to Z)", landmark: undefined },
];

const admitted = () => INVENTORY.filter(isCrawlClickCandidate).map((e) => e.name);

describe("isCrawlClickCandidate", () => {
  it("does NOT admit a header button — the reverted state, pinned deliberately", () => {
    // The cart is `role: button, landmark: header`, so it stays outside the filter and the crawl
    // stops at 2 pages on saucedemo. That is the CURRENT, KNOWN-INCOMPLETE behaviour; this test
    // exists so a re-widening is a deliberate act with a fresh measurement behind it, not a
    // silent repeat of a change that already failed in production.
    expect(isCrawlClickCandidate({ role: "button", name: "Cart, empty", landmark: "header" })).toBe(false);
    expect(admitted()).not.toContain("Cart, empty");
  });

  it("admits a nav button, which is the one button shape it was always scoped to", () => {
    expect(isCrawlClickCandidate({ role: "button", name: "Open Menu", landmark: "nav" })).toBe(true);
    expect(isCrawlClickCandidate({ role: "button", name: "Open Menu", landmark: "header" })).toBe(false);
  });

  it("NEVER admits a button that mutates state — discovery must stay read-only", () => {
    // The dangerous direction. "Add to cart" is not a destructive VERB, so DESTRUCTIVE_VERB does
    // not catch it — the only thing standing between the crawler and six state mutations is that
    // landmark-less buttons stay excluded. Widening to those would lose the read-only guarantee
    // quietly, which is why TD-103 says to fix the landmark and stop there.
    expect(isCrawlClickCandidate({ role: "button", name: "Add to cart", landmark: undefined })).toBe(false);
    expect(admitted()).not.toContain("Add to cart");
    expect(INVENTORY.filter((e) => /add to cart/i.test(e.name)).filter(isCrawlClickCandidate)).toHaveLength(0);
  });

  it("keeps both safety verbs working regardless of landmark", () => {
    // The guards must not depend on which landmark let the element through — checked for both, so
    // a future re-widening cannot quietly lose them.
    for (const landmark of ["nav", "header"]) {
      expect(isCrawlClickCandidate({ role: "button", name: "Logout", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Sign out", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Reset App State", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Delete", landmark })).toBe(false);
    }
  });

  it("documents the guards' real reach: they are EXACT-match, not word-match — TD-105 (pre-existing; unchanged by the revert)", () => {
    // Asserting what the code does, not what its comment implies. SIGN_OUT_VERB and
    // DESTRUCTIVE_VERB are anchored `^...$`, so only a button named exactly "Delete" is stopped;
    // "Delete account" is admitted. That predates this change — it applied to `nav` already — but
    // widening to `header` widens where it applies, which is why it is filed rather than left
    // unwritten. Change this expectation only alongside a deliberate decision about the regex:
    // loosening `^delete$` to `^delete\b` would also start excluding real navigation such as
    // "Cancelled orders", so it is a tradeoff, not a free win.
    expect(isCrawlClickCandidate({ role: "link", name: "Delete account" })).toBe(true);
    expect(isCrawlClickCandidate({ role: "button", name: "Clear cart", landmark: "nav" })).toBe(true);
    // The exact names ARE stopped. That much is guaranteed.
    expect(isCrawlClickCandidate({ role: "button", name: "Clear", landmark: "nav" })).toBe(false);
  });

  it("still excludes an ordinary content button with no landmark", () => {
    for (const name of ["Sauce Labs Backpack", "Name (A to Z)", "View details for Sauce Labs Backpack"]) {
      expect(isCrawlClickCandidate({ role: "button", name, landmark: undefined }),
        `"${name}" was admitted — product-detail coverage is a separate decision, not this change`)
        .toBe(false);
    }
  });

  it("still admits any link regardless of landmark, as before", () => {
    expect(isCrawlClickCandidate({ role: "link", name: "About", landmark: "nav" })).toBe(true);
    expect(isCrawlClickCandidate({ role: "link", name: "Facebook", landmark: "footer" })).toBe(true);
    expect(isCrawlClickCandidate({ role: "link", name: "Anything", landmark: undefined })).toBe(true);
  });

  it("records what the reverted widening WOULD have admitted, for the next attempt", () => {
    // Kept as data, not as an expectation: these three are what `nav || header` added offline.
    // That measurement was correct and still produced nothing in production, which is the whole
    // reason TD-103 is open rather than closed. Whoever retries needs the list, not the change.
    // Isolate the LANDMARK dimension: an element gained by the widening is one that is rejected
    // today AND would be admitted if its header landmark were nav. Asking the real predicate both
    // times keeps the verb guards in play — a hand-rolled copy of the condition silently dropped
    // them and counted Logout and Reset App State as gains, which they never were.
    const wouldGain = INVENTORY
      .filter((e) => e.landmark === "header"
        && !isCrawlClickCandidate(e)
        && isCrawlClickCandidate({ ...e, landmark: "nav" }))
      .map((e) => e.name);
    expect(wouldGain).toEqual(["Open Menu", "Close Menu", "Cart, empty"]);
  });
});

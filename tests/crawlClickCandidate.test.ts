import { describe, it, expect } from "vitest";
import { isCrawlClickCandidate } from "../src/stages/hybridDiscovery.js";

/**
 * Which elements the crawler may CLICK to find pages the href pass cannot see — TECH_DEBT.md
 * TD-103, the root cause behind the truncations, the IR retry spend, and self-heal being
 * undemonstrable.
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
  it("admits the cart — the element the whole crawl was stuck behind", () => {
    // `/cart.html`, and from the cart the checkout flow becomes reachable inside the existing
    // MAX_DISCOVERY_PAGES budget of 5. This is the assertion the change exists for.
    expect(isCrawlClickCandidate({ role: "button", name: "Cart, empty", landmark: "header" })).toBe(true);
    expect(admitted()).toContain("Cart, empty");
  });

  it("treats a header button as navigation chrome, exactly like a nav button", () => {
    for (const landmark of ["nav", "header"]) {
      expect(isCrawlClickCandidate({ role: "button", name: "Open Menu", landmark })).toBe(true);
    }
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

  it("keeps both safety verbs working on the newly-admitted landmark", () => {
    // Logout and Reset App State are `nav` today, but a header-mounted sign-out is ordinary. The
    // guards must not depend on which landmark let the element through.
    for (const landmark of ["nav", "header"]) {
      expect(isCrawlClickCandidate({ role: "button", name: "Logout", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Sign out", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Reset App State", landmark })).toBe(false);
      expect(isCrawlClickCandidate({ role: "button", name: "Delete", landmark })).toBe(false);
    }
  });

  it("documents the guards' real reach: they are EXACT-match, not word-match — TD-105", () => {
    // Asserting what the code does, not what its comment implies. SIGN_OUT_VERB and
    // DESTRUCTIVE_VERB are anchored `^...$`, so only a button named exactly "Delete" is stopped;
    // "Delete account" is admitted. That predates this change — it applied to `nav` already — but
    // widening to `header` widens where it applies, which is why it is filed rather than left
    // unwritten. Change this expectation only alongside a deliberate decision about the regex:
    // loosening `^delete$` to `^delete\b` would also start excluding real navigation such as
    // "Cancelled orders", so it is a tradeoff, not a free win.
    expect(isCrawlClickCandidate({ role: "button", name: "Delete account", landmark: "header" })).toBe(true);
    expect(isCrawlClickCandidate({ role: "button", name: "Clear cart", landmark: "nav" })).toBe(true);
    // The exact names ARE stopped, in both landmarks — that much is guaranteed.
    expect(isCrawlClickCandidate({ role: "button", name: "Clear", landmark: "header" })).toBe(false);
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

  it("admits exactly three more than before, and they are the header trio", () => {
    // Pins the measured before/after so a future widening has to be deliberate: 8 -> 11 on this
    // page, the three gained being Open Menu / Close Menu / Cart, empty.
    const before = (el: { role: string; name: string; landmark?: string }) =>
      (/button/i.test(el.role) && el.landmark === "nav") || /link/i.test(el.role);
    const gained = INVENTORY.filter((e) => isCrawlClickCandidate(e) && !before(e)).map((e) => e.name);
    expect(gained).toEqual(["Open Menu", "Close Menu", "Cart, empty"]);
  });
});

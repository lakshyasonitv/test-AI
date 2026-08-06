import { describe, it, expect } from "vitest";
import {
  humaniseIdentifier, stableSelector, deriveElementName,
  formatInteractiveElements, attachElementIdentity, type DetectedElement,
} from "../src/stages/discovery.js";
import type { AppModel } from "../src/schema/appModel.js";

const el = (o: Partial<DetectedElement>): DetectedElement =>
  ({ role: "link", name: "", derived: false, tag: "a", hasIcon: false, css: "", testId: "", id: "", ...o });

describe("humaniseIdentifier", () => {
  it("turns identifiers into readable names", () => {
    expect(humaniseIdentifier("shopping-cart-link")).toBe("shopping cart link");
    expect(humaniseIdentifier("shopping_cart_container")).toBe("shopping cart container");
    expect(humaniseIdentifier("btnAddToCart")).toBe("btn add to cart");
  });
});

describe("stableSelector", () => {
  it("prefers data-test over data-testid over data-qa over id", () => {
    expect(stableSelector({ dataTest: "checkout", id: "x" })).toBe('[data-test="checkout"]');
    expect(stableSelector({ dataTestid: "checkout" })).toBe('[data-testid="checkout"]');
    expect(stableSelector({ dataQa: "checkout" })).toBe('[data-qa="checkout"]');
    expect(stableSelector({ id: "shopping_cart_container" })).toBe("#shopping_cart_container");
  });

  it("returns empty when the element has no stable attribute", () => {
    expect(stableSelector({})).toBe("");
  });
});

describe("deriveElementName", () => {
  // Regression: saucedemo's cart is <a class="shopping_cart_link"
  // data-test="shopping-cart-link"></a> — no href, no text, no aria-label. It was dropped
  // entirely, so the cart was invisible to the whole pipeline.
  it("derives a name for an icon-only control from its test hook", () => {
    expect(deriveElementName({ dataTest: "shopping-cart-link" })).toBe("shopping cart link");
  });

  it("falls back to id, then a meaningful class, then the href leaf", () => {
    expect(deriveElementName({ id: "shopping_cart_container" })).toBe("shopping cart container");
    expect(deriveElementName({ classes: ["shopping_cart_link"] })).toBe("shopping cart link");
    expect(deriveElementName({ href: "/checkout-step-one.html" })).toBe("checkout step one");
  });

  it("skips layout and styling class noise", () => {
    expect(deriveElementName({ classes: ["active", "flex", "mt-2", "col-6"] })).toBe("");
  });

  it("ignores placeholder hrefs", () => {
    expect(deriveElementName({ href: "#" })).toBe("");
    expect(deriveElementName({ href: "javascript:void(0)" })).toBe("");
  });

  it("returns empty when nothing addressable exists", () => {
    expect(deriveElementName({})).toBe("");
  });
});

describe("formatInteractiveElements", () => {
  it("marks derived names, icons and stable ids", () => {
    const out = formatInteractiveElements([
      el({ name: "shopping cart link", derived: true, hasIcon: true, css: '[data-test="shopping-cart-link"]', testId: "shopping-cart-link" }),
    ]);
    expect(out).toContain('- link "shopping cart link"');
    expect(out).toContain("[has-icon]");
    expect(out).toContain("[derived-name]");
    expect(out).toContain("[testid=shopping-cart-link]");
  });

  // Regression: six identical "Add to cart" buttons produced Playwright strict-mode
  // violations because the IR addressed them by name with no nth.
  it("flags repeated role+name pairs as needing nth", () => {
    const dupes = Array.from({ length: 6 }, (_, i) =>
      el({ role: "button", name: "Add to cart", css: `[data-test="add-${i}"]` }));
    expect(formatInteractiveElements(dupes)).toContain("[x6-requires-nth]");
  });

  it("returns empty for no elements", () => {
    expect(formatInteractiveElements([])).toBe("");
  });
});

describe("attachElementIdentity", () => {
  const model = (elements: any[]): AppModel =>
    ({ baseUrl: "https://x", pages: [{ url: "https://x", concepts: [], elements }] }) as AppModel;

  it("attaches the selector for a uniquely named element", () => {
    const out = attachElementIdentity(
      model([{ role: "link", name: "shopping cart link" }]),
      [el({ role: "link", name: "shopping cart link", css: '[data-test="shopping-cart-link"]', testId: "shopping-cart-link" })],
    );
    expect(out.pages[0].elements[0].css).toBe('[data-test="shopping-cart-link"]');
    expect(out.pages[0].elements[0].testId).toBe("shopping-cart-link");
  });

  // Regression: keying on role|name with first-wins gave all six "Add to cart" buttons the
  // BACKPACK's selector, so adding the Fleece Jacket silently added the wrong product.
  it("attaches nothing when a role+name maps to several different elements", () => {
    const detected = [
      el({ role: "button", name: "Add to cart", css: '[data-test="add-to-cart-sauce-labs-backpack"]' }),
      el({ role: "button", name: "Add to cart", css: '[data-test="add-to-cart-sauce-labs-fleece-jacket"]' }),
    ];
    const out = attachElementIdentity(
      model([{ role: "button", name: "Add to cart" }, { role: "button", name: "Add to cart" }]),
      detected,
    );
    expect(out.pages[0].elements.every(e => e.css === undefined)).toBe(true);
  });

  it("leaves the model untouched when nothing was detected", () => {
    const m = model([{ role: "link", name: "a" }]);
    expect(attachElementIdentity(m, [])).toBe(m);
  });
});

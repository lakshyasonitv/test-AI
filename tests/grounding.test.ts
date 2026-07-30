import { describe, it, expect } from "vitest";
import {
  groundingError, hasTerminalAssertion, normalizeIR,
  assertionContradictsCase, vacuousAssertion, urlAssertionError,
} from "../src/stages/ir.js";
import { IR } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";

const model = (elements: any[]): AppModel =>
  ({ baseUrl: "https://x", pages: [{ url: "https://x", concepts: [], elements }] }) as AppModel;

// Homepage + the two destinations a "Sign up"/"Dashboard" click can actually reach, wired
// with domLinks so trackPages can resolve real click destinations — mirrors the shape
// hybridDiscovery actually produces (community-connect-frontend run: Sign up -> /register).
const multiPage = (): AppModel =>
  ({
    baseUrl: "https://x",
    pages: [
      {
        url: "https://x/", concepts: [],
        elements: [
          { role: "heading", name: "Experience the magic of community." },
          { role: "link", name: "Sign up" },
          { role: "link", name: "Dashboard" },
        ],
        domLinks: [
          { text: "Sign up", href: "/register", title: "", ariaLabel: "", isExternal: false, role: "link" },
          { text: "Dashboard", href: "/dashboard", title: "", ariaLabel: "", isExternal: false, role: "link" },
          { text: "Anchor", href: "#", title: "", ariaLabel: "", isExternal: false, role: "link" },
        ],
      },
      { url: "https://x/register", concepts: [], elements: [{ role: "heading", name: "Create account" }] },
      { url: "https://x/dashboard", concepts: [], elements: [{ role: "heading", name: "Dashboard" }] },
    ],
  }) as AppModel;

const ir = (steps: any[]): IR =>
  ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" },
    steps,
  }) as unknown as IR;

const tc = (o: Partial<TestCase>): TestCase =>
  ({ priority: "high", feature: "Login", steps: ["s"], generatedFrom: "upfront",
     fromPrompt: false, title: "t", expected: "e", ...o }) as TestCase;

describe("groundingError", () => {
  const shop = model([
    { role: "button", name: "Continue Shopping", css: '[data-test="continue-shopping"]' },
    { role: "button", name: "Continue", css: '[data-test="continue"]' },
    { role: "button", name: "Checkout", css: '[data-test="checkout"]' },
    { role: "link", name: "+ Add New" },
  ]);

  // Regression: `en.includes(name)` took the first substring hit in element order, so
  // "Continue" grounded to "Continue Shopping" — a different control on a different page.
  it("prefers an exact match over a longer substring match", () => {
    const t = ir([{ id: "s1", action: "click", target: { role: "button", name: "Continue" } }]);
    expect(groundingError(t, shop)).toBeNull();
    expect(t.steps[0].target!.name).toBe("Continue");
    expect(t.steps[0].target!.css).toBe('[data-test="continue"]');
  });

  it("still matches a longer name against itself", () => {
    const t = ir([{ id: "s1", action: "click", target: { role: "button", name: "Continue Shopping" } }]);
    expect(groundingError(t, shop)).toBeNull();
    expect(t.steps[0].target!.name).toBe("Continue Shopping");
  });

  it("resolves a partial name to the closest-length candidate", () => {
    const t = ir([{ id: "s1", action: "click", target: { role: "button", name: "Check" } }]);
    expect(groundingError(t, shop)).toBeNull();
    expect(t.steps[0].target!.name).toBe("Checkout");
  });

  it("matches ignoring decorative glyphs", () => {
    const t = ir([{ id: "s1", action: "click", target: { role: "link", name: "Add New" } }]);
    expect(groundingError(t, shop)).toBeNull();
    expect(t.steps[0].target!.name).toBe("+ Add New");
  });

  it("rejects an element the model has never seen", () => {
    const t = ir([{ id: "s1", action: "click", target: { role: "button", name: "Teleport" } }]);
    expect(groundingError(t, shop)?.index).toBe(0);
  });

  it("accepts a target whose css discovery verified, without a name match", () => {
    const t = ir([{ id: "s1", action: "click", target: { css: '[data-test="checkout"]' } }]);
    expect(groundingError(t, shop)).toBeNull();
  });

  // Regression: icon-only controls have an empty accessible name, so their model name is
  // derived. getByRole with a derived name matches nothing — the selector must ride along.
  it("carries the verified selector onto the target", () => {
    const cart = model([
      { role: "link", name: "shopping cart link", css: '[data-test="shopping-cart-link"]', testId: "shopping-cart-link" },
    ]);
    const t = ir([{ id: "s1", action: "click", target: { role: "link", name: "Cart" } }]);
    expect(groundingError(t, cart)).toBeNull();
    expect(t.steps[0].target!.css).toBe('[data-test="shopping-cart-link"]');
    expect(t.steps[0].target!.testId).toBe("shopping-cart-link");
  });

  // Regression: a real run asserted the homepage-only heading was visible at a step deep
  // into a flow that had already navigated away — groundingError wrongly passed it because
  // the heading exists SOMEWHERE in the model, not because it's on the current page.
  it("does not ground an element against a page the flow already left", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Dashboard" } },
      { id: "s3", action: "assert", target: { role: "heading", name: "Experience the magic of community." }, assertion: "visible" },
    ]);
    expect(groundingError(t, multiPage())?.index).toBe(2);
  });

  it("grounds correctly after navigating directly to a non-entry page", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/dashboard" } },
      { id: "s2", action: "assert", target: { role: "heading", name: "Dashboard" }, assertion: "visible" },
    ]);
    expect(groundingError(t, multiPage())).toBeNull();
  });

  it("still advances the page cursor through a click step that takes the css-shortcut path", () => {
    const pages: AppModel = {
      baseUrl: "https://x",
      pages: [
        {
          url: "https://x/", concepts: [],
          elements: [{ role: "link", name: "Dashboard", css: '[data-test="dashboard-link"]' }],
          domLinks: [{ text: "Dashboard", href: "/dashboard", title: "", ariaLabel: "", isExternal: false, role: "link" }],
        },
        { url: "https://x/dashboard", concepts: [], elements: [{ role: "heading", name: "Dashboard" }] },
      ],
    } as AppModel;
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { css: '[data-test="dashboard-link"]', role: "link", name: "Dashboard" } },
      { id: "s3", action: "assert", target: { role: "heading", name: "Dashboard" }, assertion: "visible" },
    ]);
    expect(groundingError(t, pages)).toBeNull();
  });
});

describe("urlAssertionError", () => {
  // Regression: a real run clicked "Sign up" (real destination /register) then asserted
  // url_contains "/signup" — a hallucinated value groundingError never checks at all.
  it("rejects an asserted path that doesn't match the clicked link's real destination", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Sign up" } },
      { id: "s3", action: "assert", target: { url: "/signup" }, value: "/signup", assertion: "url_contains" },
    ]);
    const err = urlAssertionError(t, multiPage());
    expect(err?.index).toBe(2);
    expect(err?.message).toContain("/register");
  });

  it("accepts the real destination path", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Sign up" } },
      { id: "s3", action: "assert", target: { url: "/register" }, value: "/register", assertion: "url_contains" },
    ]);
    expect(urlAssertionError(t, multiPage())).toBeNull();
  });

  it("does not check when there was no recent link click", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "assert", target: { url: "/whatever" }, value: "/whatever", assertion: "url_contains" },
    ]);
    expect(urlAssertionError(t, multiPage())).toBeNull();
  });

  it("clears a stale click destination after an intervening navigate", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Sign up" } },
      { id: "s3", action: "navigate", target: { url: "/dashboard" } },
      { id: "s4", action: "assert", target: { url: "/register" }, value: "/register", assertion: "url_contains" },
    ]);
    expect(urlAssertionError(t, multiPage())).toBeNull();
  });

  it("does not crash or set a bogus destination for a '#' link", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Anchor" } },
      { id: "s3", action: "assert", target: { url: "/anything" }, value: "/anything", assertion: "url_contains" },
    ]);
    expect(urlAssertionError(t, multiPage())).toBeNull();
  });
});

describe("normalizeIR", () => {
  // Regression: 30 occurrences of toHaveURL(new RegExp("")) across the run history. The
  // model puts the path in target.url (the IR prompt's own examples do), the generator only
  // read step.value, so the assertion matched any page and always passed.
  it("folds target.url into value for url_contains", () => {
    const parsed = IR.parse(normalizeIR({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" },
      steps: [{ id: "s1", action: "assert", target: { url: "/login" }, assertion: "url_contains" }],
    }));
    expect(parsed.steps[0].value).toBe("/login");
  });

  it("coerces a numeric id to a string", () => {
    const out = normalizeIR({ steps: [{ id: 1, action: "wait" }] });
    expect(out.steps[0].id).toBe("1");
  });

  it("collapses an object-shaped assertion into the enum string", () => {
    const out = normalizeIR({
      steps: [{ id: "s1", action: "assert", assertion: { text_contains: "hello" } }],
    });
    expect(out.steps[0].assertion).toBe("text_contains");
    expect(out.steps[0].value).toBe("hello");
  });

  it("drops an invented role in favour of a text target", () => {
    const out = normalizeIR({
      steps: [{ id: "s1", action: "assert", target: { role: "text", name: "Oops" }, assertion: "visible" }],
    });
    expect(out.steps[0].target.role).toBeUndefined();
    expect(out.steps[0].target.text).toBe("Oops");
  });
});

describe("vacuousAssertion", () => {
  it("flags a comparison assertion with nothing to compare against", () => {
    const t = ir([{ id: "s1", action: "assert", target: { role: "heading", name: "x" }, assertion: "text_contains" }]);
    expect(vacuousAssertion(t)?.stepIds).toEqual(["s1"]);
  });

  it("accepts url_contains that carries its path in target.url", () => {
    const t = ir([{ id: "s1", action: "assert", target: { url: "/login" }, assertion: "url_contains" }]);
    expect(vacuousAssertion(t)).toBeNull();
  });

  it("ignores assertions that need no value", () => {
    const t = ir([{ id: "s1", action: "assert", target: { role: "button", name: "x" }, assertion: "visible" }]);
    expect(vacuousAssertion(t)).toBeNull();
  });
});

describe("assertionContradictsCase", () => {
  const NEG = tc({
    title: "Verify login failure with invalid password",
    expected: "An error is shown and the user stays on the login page",
    category: "Invalid password",
  });

  // Regression: the real run asserted the SUCCESS banner on an invalid-password test and
  // reported a healthy site broken.
  it("rejects a success banner on a negative-path case", () => {
    const t = ir([{ id: "s5", action: "assert", target: { text: "Your username is valid!" }, assertion: "visible" }]);
    expect(assertionContradictsCase(t, NEG)?.stepIds).toEqual(["s5"]);
  });

  // Regression: the first version of this guard only checked the terminal step, so a
  // success assertion at s5 followed by a correct one at s6 slipped through.
  it("checks every assert step, not only the last", () => {
    const t = ir([
      { id: "s5", action: "assert", target: { text: "Your username is valid." }, assertion: "visible" },
      { id: "s6", action: "assert", target: { text: "Your password is invalid!" }, assertion: "visible" },
    ]);
    expect(assertionContradictsCase(t, NEG)?.stepIds).toEqual(["s5"]);
  });

  it("does not mistake 'invalid' for the success word 'valid'", () => {
    const t = ir([{ id: "s5", action: "assert", target: { text: "Your username is invalid!" }, assertion: "visible" }]);
    expect(assertionContradictsCase(t, NEG)).toBeNull();
  });

  it("flags landing on /dashboard after a failed login", () => {
    const t = ir([{ id: "s5", action: "assert", target: { role: "h", name: "x" }, value: "/dashboard", assertion: "url_contains" }]);
    expect(assertionContradictsCase(t, NEG)?.stepIds).toEqual(["s5"]);
  });

  it("allows an ambiguous real-world error message through", () => {
    const t = ir([{ id: "s5", action: "assert",
      target: { text: "Epic sadface: Username and password do not match any user in this service" },
      assertion: "visible" }]);
    expect(assertionContradictsCase(t, NEG)).toBeNull();
  });

  it("allows a positive case to assert success", () => {
    const pos = tc({ title: "Log in with valid credentials", expected: "The dashboard is shown", category: "Valid credentials" });
    const t = ir([{ id: "s5", action: "assert", target: { text: "Welcome to the dashboard" }, assertion: "visible" }]);
    expect(assertionContradictsCase(t, pos)).toBeNull();
  });

  it("allows hidden-on-success as a negative assertion", () => {
    const t = ir([{ id: "s5", action: "assert", target: { text: "Welcome" }, assertion: "hidden" }]);
    expect(assertionContradictsCase(t, NEG)).toBeNull();
  });

  it("does not read 'validation error' as success", () => {
    const t = ir([{ id: "s5", action: "assert", target: { text: "Validation error: password required" }, assertion: "visible" }]);
    expect(assertionContradictsCase(t, NEG)).toBeNull();
  });
});

describe("hasTerminalAssertion", () => {
  it("is true only when the last step asserts", () => {
    expect(hasTerminalAssertion([{ action: "assert" }] as any)).toBe(true);
    expect(hasTerminalAssertion([{ action: "assert" }, { action: "click" }] as any)).toBe(false);
    expect(hasTerminalAssertion([])).toBe(false);
  });
});

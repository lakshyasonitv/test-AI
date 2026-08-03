import { describe, it, expect } from "vitest";
import {
  groundingError, hasTerminalAssertion, normalizeIR,
  assertionContradictsCase, vacuousAssertion, urlAssertionError, missingActions,
  clickedElementHiddenAssertion,
} from "../src/stages/ir.js";
import { IR } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";
import { selectCases } from "../src/stages/testCases.js";

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

  // Guards the credential-policy grounding fix specifically: once liveExtend's replay types
  // the case's own wrong password instead of the real one, groundTerminalTextAssertion can
  // finally correct the guess to the real page text — "Invalid login credentials" (the exact
  // string from runs/2026-08-02T12-49-23-839Z-3b887895). That correction only survives if this
  // guard doesn't veto it. It's safe today only because FAILURE_SIGNAL ("invalid") is checked
  // before SUCCESS_SIGNAL ("\bvalid\b") — if that order ever flipped, grounding would produce
  // the right text and this guard would silently throw it away.
  it("does not veto the real corrected text from the credential-policy grounding fix", () => {
    const t = ir([{ id: "s5", action: "assert", target: { text: "Invalid login credentials" }, assertion: "visible" }]);
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

// ---------------------------------------------------------------------------
// Regressions from run 2026-07-30T15-19-00-537Z-dcd09643: 5 of its 7 "passed"
// verdicts verified nothing.
// ---------------------------------------------------------------------------

describe("vacuousAssertion — assertions that cannot fail", () => {
  const m = { baseUrl: "https://x.example", pages: [] } as any;
  const step = (o: any) => ({ id: o.id, action: "assert", assertion: "url_contains", ...o });

  // This single assertion is why a run parked on an unpassable OTP screen reported PASSED:
  // toHaveURL(new RegExp("/")) matches every URL there is.
  it('rejects url_contains "/"', () => {
    const ir = { meta: {}, steps: [step({ id: "s1", value: "/" })] } as any;
    expect(vacuousAssertion(ir, m)?.stepIds).toEqual(["s1"]);
  });

  it("rejects asserting the path you just navigated to with nothing in between", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/register" } },
      step({ id: "s2", value: "/register" }),
    ] } as any;
    expect(vacuousAssertion(ir, m)?.stepIds).toEqual(["s2"]);
  });

  // Both of these are CORRECT assertions and an earlier version of the rule flagged them.
  it("accepts asserting the destination after a link click", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Log in" } },
      step({ id: "s3", value: "/login" }),
    ] } as any;
    expect(vacuousAssertion(ir, m)).toBeNull();
  });

  it("accepts 'still on /login' as proof a login was rejected", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { name: "Password" }, value: "wrong" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      step({ id: "s5", value: "/login" }),
    ] } as any;
    expect(vacuousAssertion(ir, m)).toBeNull();
  });
});

describe("missingActions — the IR must carry out its case", () => {
  const loginCase = tc({
    title: "Log in with valid credentials",
    steps: ["Click the 'Log in' link", "Fill the login form with valid credentials", "Click 'Sign In'"],
    expected: "The user reaches the dashboard",
  });

  // The real case-2 IR: click the link, assert the link is hidden. No fill, no submit.
  // Its final screenshot was an empty login form and it reported PASSED.
  it("flags an IR that never fills the form its case describes", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Log in" } },
      { id: "s3", action: "assert", target: { role: "link", name: "Log in" }, assertion: "hidden" },
    ] } as any;
    expect(missingActions(ir, loginCase)?.message).toMatch(/no "fill" step/);
  });

  it("accepts an IR that does perform the described actions", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(missingActions(ir, loginCase)).toBeNull();
  });

  it("says nothing about a case that only navigates and asserts", () => {
    const navCase = tc({ title: "Home page loads", steps: ["Open the home page"], expected: "The hero is visible" });
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "assert", target: { role: "heading", name: "Hero" }, assertion: "visible" },
    ] } as any;
    expect(missingActions(ir, navCase)).toBeNull();
  });
});

describe("selectCases — one suite, capped and deduplicated", () => {
  const mk = (title: string, category: any, extra: any = {}) =>
    tc({ title, category, ...extra });

  // The real duplicate pair: the reactive batch restated the primary in different words.
  it("collapses a reworded restatement of the primary case", () => {
    const cases = [
      mk("Verify end-to-end account creation and authentication flow", "valid", { fromPrompt: true }),
      mk("Verify the end-to-end functionality of user account creation and authentication", "valid"),
    ];
    const out = selectCases(cases, 5);
    expect(out).toHaveLength(1);
    expect(out[0].fromPrompt).toBe(true);
  });

  // ... but two genuinely different cases that share a category must both survive.
  it("keeps two different cases that happen to share a category", () => {
    const cases = [
      mk("Log in with valid credentials", "valid"),
      mk("Register a new account successfully", "valid"),
    ];
    expect(selectCases(cases, 5)).toHaveLength(2);
  });

  it("caps the suite and prefers category diversity over priority", () => {
    const cases = [
      mk("asked for", "valid", { fromPrompt: true }),
      mk("bad password", "invalid-input", { priority: "low" }),
      mk("empty password", "empty-boundary", { priority: "low" }),
      mk("wrong email format", "invalid-input", { priority: "critical" }),
      mk("blank identifier", "empty-boundary", { priority: "critical" }),
    ];
    const out = selectCases(cases, 3);
    expect(out).toHaveLength(3);
    expect(out[0].fromPrompt).toBe(true);
    expect(new Set(out.map(c => c.category)).size).toBe(3);
  });
});

describe("clickedElementHiddenAssertion", () => {
  // The real case-2: "Navigate to registration page" compiled to click Sign Up, then assert
  // Sign Up is hidden. Nothing was typed, so this is a navigation click — whether that button
  // disappears is incidental and proves nothing about the app.
  it("flags assert-hidden on a control that was merely clicked", () => {
    const nav = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "click", target: { role: "button", name: "Sign Up" } },
      { id: "s3", action: "assert", target: { role: "button", name: "Sign Up" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(nav)?.stepIds).toEqual(["s3"]);
  });

  // The real case-1, which passed and must stay legal: this is the pattern ir.ts's own prompt
  // recommends for a submit button. It differs from the above ONLY in having fills first.
  it("allows it after a form submission", () => {
    const login = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(login)).toBeNull();
  });

  // Zero fills is the threshold, not "fewer than two" — one field then Continue is a real
  // submission and must stay legal.
  it("allows a single-field submission", () => {
    const oneField = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "click", target: { role: "button", name: "Continue" } },
      { id: "s4", action: "assert", target: { role: "button", name: "Continue" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(oneField)).toBeNull();
  });

  it("ignores an assert-hidden on a different element", () => {
    const other = { meta: {}, steps: [
      { id: "s1", action: "click", target: { role: "button", name: "Sign Up" } },
      { id: "s2", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(other)).toBeNull();
  });
});

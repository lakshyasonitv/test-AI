import { describe, it, expect } from "vitest";
import {
  groundingError, hasTerminalAssertion, normalizeIR,
  assertionContradictsCase, vacuousAssertion, urlAssertionError, missingActions,
  clickedElementHiddenAssertion, postClickRevealIndex, crossFormBleedError,
} from "../src/stages/ir.js";
import { IR } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";
import { selectCases } from "../src/stages/testCases.js";

const model = (elements: any[]): AppModel =>
  ({ baseUrl: "https://x", pages: [{ url: "https://x", concepts: [], elements }] }) as AppModel;

// Same shape as `model`, plus page.forms — needed for credentialFieldMap/credentialFieldsNeeded,
// which read DOM-derived form field inputType, not the elements array.
const modelWithForms = (elements: any[], forms: any[]): AppModel =>
  ({ baseUrl: "https://x", pages: [{ url: "https://x", concepts: [], elements, forms }] }) as AppModel;

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

  // Regression: a role with no name (undefined OR "") took the same silent-skip path as a step
  // with no target at all, reached generation completely unchecked, and crashed generateSpec
  // with "No semantic locator for target". For the PRIMARY case that isn't isolated the way a
  // suite case is — the whole run died with zero cases and zero artifacts. Reproduced verbatim
  // from a real run (2026-08-15T05-25-38…901f5358): a thin AppModel left the model nothing
  // specific to name for "confirm the nav landmark is visible", so it emitted role-only
  // landmark targets. Must be REJECTED (routed through the normal retry/truncate path), not
  // silently skipped past grounding.
  it("rejects a role target with no name instead of silently skipping it", () => {
    const empty = model([]);
    const noNameKey = ir([{ id: "s1", action: "assert", target: { role: "heading" }, assertion: "visible" }]);
    expect(groundingError(noNameKey, empty)?.index).toBe(0);

    const emptyStringName = ir([{ id: "s1", action: "press", target: { role: "textbox", name: "" } }]);
    expect(groundingError(emptyStringName, empty)?.index).toBe(0);
  });

  it("still skips grounding for steps with no role at all (navigate/wait/text-only)", () => {
    const t = ir([{ id: "s1", action: "wait", value: "1000" }]);
    expect(groundingError(t, shop)).toBeNull();
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

  // Regression for the thinkvibes.com run (2026-08-07T04-47-41-260Z-40270415): a hamburger
  // menu-toggle (visible: false — display:none at the current viewport, e.g. mobile-only) got
  // name-matched and auto-attached a css selector, producing a generated test step that timed
  // out asserting it visible. This must be a grounding failure, not a silent pass — same
  // "return {index, message}, let the outer retry loop's correction feedback handle it" shape
  // every other grounding rejection in this function uses.
  it("rejects grounding a 'visible' assertion against an element already known to be hidden", () => {
    const hiddenNav = model([
      { role: "link", name: "Menu", css: "#nav-toggle", visible: false },
    ]);
    const t = ir([
      { id: "s1", action: "assert", target: { role: "link", name: "Menu" }, assertion: "visible" },
    ]);
    const err = groundingError(t, hiddenNav);
    expect(err?.index).toBe(0);
    expect(err?.message).toMatch(/hidden/);
  });

  // The exact same hidden element, but asserting it HIDDEN — this is the correct, intended use
  // (e.g. the post-login "Sign In" button going hidden) and must NOT be blocked.
  it("does not block a 'hidden' assertion against the same hidden element", () => {
    const hiddenNav = model([
      { role: "link", name: "Menu", css: "#nav-toggle", visible: false },
    ]);
    const t = ir([
      { id: "s1", action: "assert", target: { role: "link", name: "Menu" }, assertion: "hidden" },
    ]);
    expect(groundingError(t, hiddenNav)).toBeNull();
  });

  // Same rejection, but via the direct-css early-exit path (ir.ts:247) rather than the
  // name-matched auto-attach path — a model that emits `target.css` directly for a selector
  // discovery already verified must be checked too, not just membership-checked.
  it("rejects a direct-css 'visible' target against an element already known to be hidden", () => {
    const hiddenNav = model([
      { role: "link", name: "Menu", css: "#nav-toggle", visible: false },
    ]);
    const t = ir([
      { id: "s1", action: "assert", target: { css: "#nav-toggle" }, assertion: "visible" },
    ]);
    const err = groundingError(t, hiddenNav);
    expect(err?.index).toBe(0);
    expect(err?.message).toMatch(/hidden/);
  });

  // Regression for the learnvibes.vercel.app run (2026-08-08T07-00-16-355Z-219db80c): a
  // dashboard sidebar item implemented as <button onClick=router.push(...)>, not <a href> — the
  // IR reasonably guessed role:"link" for "navigate via the sidebar," and the strict role-equal
  // filter reported "not present" for an element that WAS present, just under a different role.
  // That falsely truncated the entire rest of the case. safeClick/locate() already tolerate this
  // exact mismatch at runtime (their own css/text fallback chain) — grounding shouldn't be
  // stricter than the code it's protecting.
  it("falls back to a compatible role and self-corrects the target when the exact role isn't present", () => {
    const dashboard = model([{ role: "button", name: "Admin" }]);
    const t = ir([{ id: "s7", action: "click", target: { role: "link", name: "Admin" } }]);
    expect(groundingError(t, dashboard)).toBeNull();
    expect(t.steps[0].target!.role).toBe("button");
    expect(t.steps[0].target!.name).toBe("Admin");
  });

  // An exact-role match must always win — the fallback only runs when the first pass finds
  // nothing at all, never as a "better option" once a real match already exists.
  it("prefers an exact-role match over a same-named compatible-role decoy", () => {
    const both = model([
      { role: "link", name: "Admin" },
      { role: "button", name: "Admin" },
    ]);
    const t = ir([{ id: "s7", action: "click", target: { role: "link", name: "Admin" } }]);
    expect(groundingError(t, both)).toBeNull();
    expect(t.steps[0].target!.role).toBe("link"); // unchanged — no fallback needed
  });

  // The fallback is scoped to interactive-clickable roles only. A heading/textbox target must
  // never be silently reinterpreted as a button — matching the wrong element type there either
  // can't work (.fill() on a heading) or changes what an assertion actually proves.
  it("does not widen a non-clickable role (heading) into the compatible-role group", () => {
    const dashboard = model([{ role: "button", name: "Total" }]);
    const t = ir([{ id: "s1", action: "assert", target: { role: "heading", name: "Total" }, assertion: "visible" }]);
    expect(groundingError(t, dashboard)?.index).toBe(0);
  });

  // The fallback must still respect page-cursor scoping — a compatible-role match on a page
  // the flow already left shouldn't ground, same as an exact-role match wouldn't.
  it("does not let the compatible-role fallback ground against a page the flow already left", () => {
    const pages: AppModel = {
      baseUrl: "https://x",
      pages: [
        { url: "https://x/", concepts: [],
          elements: [{ role: "link", name: "Dashboard" }, { role: "button", name: "Admin" }],
          domLinks: [{ text: "Dashboard", href: "/dashboard", title: "", ariaLabel: "", isExternal: false, role: "link" }] },
        { url: "https://x/dashboard", concepts: [], elements: [{ role: "heading", name: "Dashboard" }] },
      ],
    } as AppModel;
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Dashboard" } },
      // Only reachable as role:"button" back on the ENTRY page, which the flow already left —
      // must not fall back to it just because it shares a name with something once seen.
      { id: "s3", action: "click", target: { role: "link", name: "Admin" } },
    ]);
    expect(groundingError(t, pages)?.index).toBe(2);
  });

  // Regression for the learnvibes.vercel.app run (2026-08-08T11-08-53-602Z-a986748a): the whole
  // case truncated at s6 with `role="button" name="Admin" ... is not present in the application
  // model` — while the shipped model in 04-ir.json contained exactly that element on /dashboard,
  // next to `heading "Good Afternoon, Vaibhav Parmar"`. Login had worked; live-extend had found
  // the page. trackPages advances its cursor only on a navigate or a resolvable LINK click, so
  // clicking the "Sign In" button (a form submit / SPA route change) left the cursor parked on
  // /login for every later step, and grounding searched only that page. A cursor that can't
  // track the flow any more must report null so grounding falls back to the whole model — which
  // is what trackPages' own docstring already promised, and didn't do.
  it("grounds a post-login element after a form-submit click the cursor can't track", () => {
    const app: AppModel = {
      baseUrl: "https://x",
      pages: [
        { url: "https://x/login", concepts: [],
          elements: [
            { role: "textbox", name: "you@thinkvibes.com" },
            { role: "textbox", name: "*********" },
            { role: "button", name: "Sign In" },
          ] },
        { url: "https://x/dashboard", concepts: [],
          elements: [
            { role: "button", name: "Admin" },
            { role: "heading", name: "Good Afternoon, Vaibhav Parmar" },
          ] },
      ],
    } as AppModel;
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "e" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "*********" }, value: "p" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "wait", value: "2000" },
      { id: "s6", action: "click", target: { role: "button", name: "Admin" } },
    ]);
    expect(groundingError(t, app)).toBeNull();
  });

  // Regression for the learnvibes run (2026-08-08T11-52-35-503Z-0981bd0c): the IR addressed
  // EVERY step after login by bare text — {text:"Admin"}, {text:"users"}, {text:"Name"} —
  // which groundingError skipped wholesale, so nothing was rejected, live-extend never ran,
  // the model still held only /login when the run ended, and `fill {text:"Name"}` resolved to
  // <label>Full Name</label> at execution time ("Element is not an <input>...").
  it("upgrades a text-only fill target to the verified field it names", () => {
    const form = model([
      { role: "textbox", name: "Full Name" },
      { role: "textbox", name: "Email" },
      { role: "button", name: "Submit" },
    ]);
    const t = ir([{ id: "s12", action: "fill", target: { text: "Name" }, value: "test" }]);
    expect(groundingError(t, form)).toBeNull();
    expect(t.steps[0].target!.role).toBe("textbox");
    expect(t.steps[0].target!.name).toBe("Full Name");
    expect(t.steps[0].target!.text).toBeUndefined();
  });

  // A fill must never ground onto a link/button just because the name matches, and a click
  // must never ground onto a textbox — the two role groups are deliberately disjoint.
  it("does not ground a text-only fill target onto a non-field element", () => {
    const page = model([{ role: "link", name: "Name" }]);
    const t = ir([{ id: "s1", action: "fill", target: { text: "Name" }, value: "x" }]);
    expect(groundingError(t, page)?.kind).toBe("text-target");
  });

  it("rejects a text-only click target the model has never seen, so live-extend can run", () => {
    const loginOnly = model([{ role: "button", name: "Sign In" }]);
    const t = ir([{ id: "s7", action: "click", target: { text: "Admin" } }]);
    const err = groundingError(t, loginOnly);
    expect(err?.index).toBe(0);
    expect(err?.kind).toBe("text-target");
  });

  // The exemption this narrows must survive for its real purpose: an assertion on content
  // that only exists after an action, which discovery by definition never snapshotted.
  it("still exempts a text target on an assert step", () => {
    const loginOnly = model([{ role: "button", name: "Sign In" }]);
    const t = ir([
      { id: "s5", action: "assert", target: { text: "Invalid login credentials" }, assertion: "visible" },
    ]);
    expect(groundingError(t, loginOnly)).toBeNull();
  });

  // The other half of the same rule: a click that provably does NOT navigate (an in-page
  // anchor, a JS handler) must leave the cursor intact, or every modal/accordion click would
  // widen grounding back to the whole model for the rest of the flow.
  it("keeps the page cursor after clicking a link that does not navigate", () => {
    const app: AppModel = {
      baseUrl: "https://x",
      pages: [
        { url: "https://x/", concepts: [],
          elements: [{ role: "link", name: "Open panel" }],
          domLinks: [{ text: "Open panel", href: "#", title: "", ariaLabel: "", isExternal: false, role: "link" }] },
        { url: "https://x/other", concepts: [], elements: [{ role: "button", name: "Elsewhere" }] },
      ],
    } as AppModel;
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Open panel" } },
      { id: "s3", action: "click", target: { role: "button", name: "Elsewhere" } },
    ]);
    expect(groundingError(t, app)?.index).toBe(2);
  });

  // Regression for the learnvibes.vercel.app run (2026-08-08T07-54-39-812Z-d322e1fe). The case
  // step read "Navigate to the Admin section via the sidebar" — meaning click the sidebar item —
  // and the IR took "navigate" literally, emitting navigate "/admin" then "/admin/users".
  // Nothing validated those: groundingError only ever checked role+name targets, so a guessed
  // route sailed straight through to the browser, landed on a blank page (screenshots confirmed
  // a stuck spinner then an empty black page), and every later step ground against a page that
  // was never really reached. Same "never invent" principle already applied to CSS selectors
  // and role+name, now extended to the one target kind that had no check at all.
  it("rejects a mid-flow navigate to a route the app model never saw", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "navigate", target: { url: "/admin" } },
    ]);
    const err = groundingError(t, multiPage());
    expect(err?.index).toBe(1);
    // Marked so toIR skips live-extension for it — replaying a prefix can never make an
    // invented route real, and extending here would drain the budget real discovery needs.
    expect(err?.kind).toBe("navigate-url");
  });

  it("allows a mid-flow navigate to a discovered page", () => {
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "navigate", target: { url: "/dashboard" } },
    ]);
    expect(groundingError(t, multiPage())).toBeNull();
  });

  // A link's href is a destination discovery genuinely observed, even when the page behind it
  // was never crawled — navigating there is following the app's own wiring, not guessing.
  it("allows a navigate to a path known only from a link href", () => {
    const withLink: AppModel = {
      baseUrl: "https://x",
      pages: [{
        url: "https://x/", concepts: [], elements: [{ role: "link", name: "Settings" }],
        domLinks: [{ text: "Settings", href: "/settings", title: "", ariaLabel: "", isExternal: false, role: "link" }],
      }],
    } as AppModel;
    const t = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "navigate", target: { url: "/settings" } },
    ]);
    expect(groundingError(t, withLink)).toBeNull();
  });

  // Step 0's navigate is the entry URL the pipeline supplied itself, never a model guess.
  it("does not second-guess the entry navigate at step 0", () => {
    const t = ir([{ id: "s1", action: "navigate", target: { url: "/some-entry-path" } }]);
    expect(groundingError(t, multiPage())).toBeNull();
  });

  // The user naming a path in their own prompt is a stated fact about their app, not a guess.
  it("allows a path the user typed in their own prompt", () => {
    const t = {
      meta: { feature: "f", title: "t", priority: "high", baseUrl: "https://x",
              sourcePrompt: "log in then go to /admin and add a user" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/" } },
        { id: "s2", action: "navigate", target: { url: "/admin" } },
      ],
    } as unknown as IR;
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

  // The real bug: run 2026-08-08T11-33-53-639Z-0cc9b64c reported 4/4 passed while this case's
  // IR stopped after logging in — it never touched Admin or Users, which its own case text
  // names. The presence checks above are blind to this: a "fill" and a "click" both exist,
  // they just belong to the login, not the rest of the flow.
  const adminCase = tc({
    title: "Admin can view the users list",
    steps: [
      "Fill 'Email' with the admin's email",
      "Fill 'Password' with the admin's password",
      "Click 'Sign In'",
      "Click 'Admin' in the sidebar",
      "Click 'Users'",
    ],
    expected: "The users list is displayed",
  });

  it("flags an IR that stops after login instead of completing the case's later steps", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(missingActions(ir, adminCase)?.message).toMatch(/action steps/);
  });

  it("accepts an IR that carries out every action step the case names", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "click", target: { role: "link", name: "Admin" } },
      { id: "s6", action: "click", target: { role: "link", name: "Users" } },
      { id: "s7", action: "assert", target: { role: "heading", name: "Users" }, assertion: "visible" },
    ] } as any;
    expect(missingActions(ir, adminCase)).toBeNull();
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
  const noForms = model([]);
  const notAuthCase = tc({ title: "t", expected: "e" }); // no auth wording anywhere

  // The real case-2: "Navigate to registration page" compiled to click Sign Up, then assert
  // Sign Up is hidden. Nothing was typed, so this is a navigation click — whether that button
  // disappears is incidental and proves nothing about the app.
  it("flags assert-hidden on a control that was merely clicked", () => {
    const nav = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "click", target: { role: "button", name: "Sign Up" } },
      { id: "s3", action: "assert", target: { role: "button", name: "Sign Up" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(nav, noForms, notAuthCase)?.stepIds).toEqual(["s3"]);
  });

  // The real case-1, which passed and must stay legal: this is the pattern ir.ts's own prompt
  // recommends for a submit button. It differs from the above ONLY in having fills first, one
  // of which the AppModel confirms is a real password field.
  it("allows it after a login form submission with a discovered password field", () => {
    const loginModel = modelWithForms(
      [{ role: "textbox", name: "Email" }, { role: "textbox", name: "Password" }, { role: "button", name: "Sign In" }],
      [{ fields: [
        { tag: "input", inputType: "email", name: "Email", label: "Email" },
        { tag: "input", inputType: "password", name: "Password", label: "Password" },
      ] }],
    );
    const login = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(login, loginModel, notAuthCase)).toBeNull();
  });

  // Zero fills is the threshold, not "fewer than two" — one field then Continue is a real
  // submission and must stay legal, via the progressive-login INTENT fallback (the password
  // field isn't revealed yet, but the case is explicitly about signing in).
  it("allows a single-field progressive-login submission", () => {
    const wayIn = model([{ role: "textbox", name: "Email" }, { role: "link", name: "Sign in" }]);
    const signInCase = tc({ title: "Sign in with a valid account", expected: "e" });
    const oneField = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "click", target: { role: "button", name: "Continue" } },
      { id: "s4", action: "assert", target: { role: "button", name: "Continue" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(oneField, wayIn, signInCase)).toBeNull();
  });

  // The real case-4 (this session's original bug report): fill an email field, click
  // "Subscribe", assert Subscribe hidden. No password field anywhere, and the case isn't about
  // authentication — a Mailchimp-style newsletter form, not a login. Must now be REJECTED; the
  // old fillsBefore>0-only check let this through, which is exactly what broke in production.
  it("rejects a non-authentication submission (the real Subscribe-button bug)", () => {
    const newsletterModel = modelWithForms(
      [{ role: "textbox", name: "Email *" }, { role: "button", name: "Subscribe" }],
      [{ fields: [{ tag: "input", inputType: "email", name: "EMAIL", label: "Email *" }] }],
    );
    const subscribeCase = tc({ title: "Newsletter subscription with valid email", expected: "e" });
    const subscribe = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email *" }, value: "subscriber@example.com" },
      { id: "s3", action: "click", target: { role: "button", name: "Subscribe" } },
      { id: "s4", action: "assert", target: { role: "button", name: "Subscribe" }, assertion: "hidden" },
    ] } as any;
    const result = clickedElementHiddenAssertion(subscribe, newsletterModel, subscribeCase);
    expect(result?.stepIds).toEqual(["s4"]);
    expect(result?.message).toMatch(/non-authentication|authentication field/i);
  });

  it("ignores an assert-hidden on a different element", () => {
    const other = { meta: {}, steps: [
      { id: "s1", action: "click", target: { role: "button", name: "Sign Up" } },
      { id: "s2", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(clickedElementHiddenAssertion(other, noForms, notAuthCase)).toBeNull();
  });
});

describe("crossFormBleedError", () => {
  // Two forms on one page: a contact form and an unrelated newsletter signup — real shape from
  // the thinkvibes.com run this check was written to catch.
  const twoForms = (): AppModel => ({
    baseUrl: "https://x",
    pages: [{
      url: "https://x", concepts: [],
      elements: [
        { role: "textbox", name: "Name" }, { role: "textbox", name: "Email *" },
        { role: "textbox", name: "Comment or Message" }, { role: "button", name: "Submit" },
        { role: "textbox", name: "Email *" }, { role: "button", name: "Subscribe" },
      ],
      forms: [
        // Realistic WPForms shape: generated field `name` attributes, human-readable `label`s
        // — matching on name attribute alone would miss these, which is why label is checked too.
        { id: "contact", fields: [
          { tag: "input", inputType: "text", name: "wpforms[fields][0]", label: "Name" },
          { tag: "input", inputType: "email", name: "wpforms[fields][1]", label: "Email *" },
          { tag: "textarea", inputType: "text", name: "wpforms[fields][2]", label: "Comment or Message" },
        ] },
        { id: "newsletter", fields: [
          { tag: "input", inputType: "text", name: "EMAIL", label: "" },
          // Real recorded shape: the field's own `name` attribute matched the click target's
          // accessible name ("Subscribe") even though its extracted `label` said something else
          // entirely ("Join our Newsletter") — a different DOM-extraction path for the same
          // physical control. Matching on name as well as label is what catches this.
          { tag: "input", inputType: "submit", name: "subscribe", label: "Join our Newsletter" },
        ] },
      ],
    }],
  }) as AppModel;

  // The real case-2 shape: fill three contact-form fields, then click the OTHER form's submit
  // control (whose accessible name the model picked was "Join our Newsletter" — the newsletter
  // form's field label). Must reject.
  it("rejects a click that lands on a different form than the preceding fills", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "Test User" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Email *" }, value: "test@example.com" },
      { id: "s4", action: "fill", target: { role: "textbox", name: "Comment or Message" }, value: "Hi" },
      { id: "s5", action: "click", target: { role: "button", name: "Join our Newsletter" } },
      { id: "s6", action: "assert", target: { text: "Message sent successfully" }, assertion: "visible" },
    ] } as any;
    const result = crossFormBleedError(ir, twoForms());
    expect(result?.stepIds).toEqual(["s5"]);
    expect(result?.message).toMatch(/different form/i);
  });

  // Fail open: the click target ("Submit") isn't itself a FIELD in fields[] (real <button>
  // elements aren't extracted into forms[].fields — only inputs/textareas/selects are), so
  // there's no match to compare against. Correct clicks routinely hit this path.
  it("allows a click that matches no form field at all (the correct button)", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "Test User" },
      { id: "s3", action: "click", target: { role: "button", name: "Submit" } },
      { id: "s4", action: "assert", target: { text: "Message sent successfully" }, assertion: "visible" },
    ] } as any;
    expect(crossFormBleedError(ir, twoForms())).toBeNull();
  });

  // Fail open: an ambiguous name shared across forms — don't guess which one is right.
  it("allows a click whose target name is ambiguous across forms", () => {
    const ambiguous = (): AppModel => ({
      baseUrl: "https://x",
      pages: [{
        url: "https://x", concepts: [],
        elements: [],
        forms: [
          { id: "a", fields: [
            { tag: "input", inputType: "text", name: "Name", label: "Name" },
            { tag: "input", inputType: "submit", name: "go", label: "Continue" },
          ] },
          { id: "b", fields: [{ tag: "input", inputType: "submit", name: "go2", label: "Continue" }] },
        ],
      }],
    }) as AppModel;
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "Test" },
      { id: "s3", action: "click", target: { role: "button", name: "Continue" } },
    ] } as any;
    expect(crossFormBleedError(ir, ambiguous())).toBeNull();
  });

  it("allows a click that matches the SAME form as the preceding fills", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      // "EMAIL" matches only the newsletter form's field (its `name` attribute) — the contact
      // form's own email field is labelled differently ("Email *"), so this fill resolves
      // unambiguously to the newsletter form.
      { id: "s2", action: "fill", target: { role: "textbox", name: "EMAIL" }, value: "subscriber@example.com" },
      { id: "s3", action: "click", target: { role: "button", name: "Subscribe" } },
    ] } as any;
    // Fills the newsletter form's own field, then clicks the newsletter form's own submit
    // (matched via its `name` attribute "subscribe") — same form both times.
    expect(crossFormBleedError(ir, twoForms())).toBeNull();
  });
});

// Regression: a modal opened by a button click never changes the URL, so its fields are absent
// from the AppModel and the model invents names for them. When an invented name coincidentally
// COLLIDES with real page chrome, groundingError reports the step grounded, live-extend (which
// only fires on a MISS) never runs, and a test that fills the wrong control ships. Confirmed
// against run 2026-08-10T11-15-46-262Z-1279794e: "fill the ticket Title" ground onto the page
// header's asset-search box. postClickRevealIndex is the structural trigger that spots the shape.
describe("postClickRevealIndex", () => {
  // The exact step list of the failing run's primary case.
  const raiseTicket = ir([
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "p" },
    { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
    { id: "s5", action: "wait", value: "3000" },
    { id: "s6", action: "click", target: { role: "link", name: "TicketsTickets" } },
    { id: "s7", action: "wait", value: "3000" },
    { id: "s8", action: "click", target: { role: "button", name: "Raise Ticket" } },
    { id: "s9", action: "wait", value: "3000" },
    { id: "s10", action: "fill", target: { role: "textbox", name: "Search assets by serial or name..." }, value: "test data" },
    { id: "s11", action: "click", target: { role: "button", name: "open" } },
  ]);

  it("flags the fill that follows a modal-opening button click", () => {
    // s10 (index 9) — the step that ground onto the header search box in the real run.
    expect(postClickRevealIndex(raiseTicket)).toBe(9);
  });

  // The whole reason this trigger is safe to run at all: it must never fire on a login, which is
  // the single most common step shape in the project. In a login the fills come BEFORE the click.
  it("does not fire on a login flow", () => {
    const login = ir([
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: "p" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "heading", name: "Dashboard" }, assertion: "visible" },
    ]);
    expect(postClickRevealIndex(login)).toBe(-1);
  });

  // A navigate is a page load, not an in-page reveal — live-extend's existing on-miss path
  // already covers that, and firing here would pay for a browser launch to learn nothing.
  it("does not fire when a navigate intervenes", () => {
    const navigated = ir([
      { id: "s1", action: "click", target: { role: "button", name: "Continue" } },
      { id: "s2", action: "navigate", target: { url: "/form" } },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
    ]);
    expect(postClickRevealIndex(navigated)).toBe(-1);
  });

  // A link click that goes somewhere is a navigation, not a reveal.
  it("does not fire after a link click", () => {
    const viaLink = ir([
      { id: "s1", action: "click", target: { role: "link", name: "Sign up" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
    ]);
    expect(postClickRevealIndex(viaLink)).toBe(-1);
  });

  // Waits are transparent — a modal replay routinely has one between the click and the fill,
  // and the real failing run had exactly that (s9).
  it("sees through an intervening wait", () => {
    const withWait = ir([
      { id: "s1", action: "click", target: { role: "button", name: "Add New" } },
      { id: "s2", action: "wait", value: "1000" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Title" }, value: "t" },
    ]);
    expect(postClickRevealIndex(withWait)).toBe(2);
  });

  // select/check are form-field actions too — a revealed <select> is the same bug shape.
  it("covers select as well as fill", () => {
    const withSelect = ir([
      { id: "s1", action: "click", target: { role: "button", name: "Raise Ticket" } },
      { id: "s2", action: "select", target: { role: "combobox", name: "Department" }, value: "IT" },
    ]);
    expect(postClickRevealIndex(withSelect)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TD-01's open class: "check" is not an action verb
// ---------------------------------------------------------------------------
//
// THE RUN THIS COMES FROM. A real run against qable.io/blog/happy-path-testing died with "the case
// describes 3 action steps but the IR only carries out 0", four identical attempts, then
// `IR failed schema validation after retry`. The IR was CORRECT.
//
// `check` means opposite things in the two vocabularies missingActions straddles:
//   case prose:      "Check that the heading is visible"  -> an ASSERTION
//   STEP_VOCABULARY: `Check checkbox "Name"`              -> an ACTION
// With bare `check` in CASE_ACTION_LINE, three "Check that ..." verifications counted as three
// ACTIONS while the IR's three `assert` steps counted as zero, so 3 >= 2 && 0 < 2 rejected it
// every time — nothing about the input changed between retries, so it could never pass.
//
// This is the second run-killing false positive TD-01 has produced. CLAUDE.md names it as the
// reference example of the project's central failure mode: a "deterministic" check written as a
// regex over LLM-authored prose is not actually deterministic.
describe("missingActions — 'check' is a verification, not an action (TD-01)", () => {
  // The failing case, verbatim from the run.
  const blogCase = tc({
    title: "Homepage loads and key areas are visible (from plan)",
    steps: [
      "Go to the 'https://www.qable.io/blog/happy-path-testing' page.",
      "Wait for the page to fully load.",
      "Check that the page shows the level 1 heading with the text 'What Is Happy Path Testing? - Complete Guide 2024'.",
      "Check that the 'Services' button is visible in the navigation area.",
      "Check that the level 2 heading 'What is happy path testing?' is present and visible in the main content area.",
    ],
    expected: "The level 1 heading is visible, the 'Services' button is visible, and the level 2 heading is visible.",
  });

  it("accepts the IR that was rejected four times on a real run", () => {
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/blog/happy-path-testing" } },
      { id: "s2", action: "assert", target: { role: "heading", name: "What Is Happy Path Testing? - Complete Guide 2024" }, assertion: "visible" },
      { id: "s3", action: "assert", target: { role: "button", name: "Services" }, assertion: "visible" },
      { id: "s4", action: "assert", target: { role: "heading", name: "What is happy path testing?" }, assertion: "visible" },
    ] } as any;
    expect(missingActions(ir, blogCase)).toBeNull();
  });

  it("still counts a check that names a CHECKBOX as a real action", () => {
    // The action form STEP_VOCABULARY actually defines: `Check checkbox "Name"`. Narrowing the
    // regex must not blind the guard to a case that genuinely ticks boxes and an IR that doesn't.
    const consentCase = tc({
      title: "Accept both consents before submitting",
      steps: [
        "Check the 'Terms and Conditions' checkbox",
        "Check the 'Marketing emails' checkbox",
        "Click 'Submit'",
      ],
      expected: "The form is accepted",
    });
    const lazyIr = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "assert", target: { role: "button", name: "Submit" }, assertion: "visible" },
    ] } as any;
    expect(missingActions(lazyIr, consentCase)?.message).toMatch(/action steps but the IR only carries out/);
  });

  it("a quoted page string containing an action verb does not inflate the count", () => {
    // TD-01's ORIGINAL recorded failure: a correct IR rejected because the page's own heading
    // contained the word "Click". The quoted span is the case's data, not its instructions.
    const quotedCase = tc({
      title: "Landing page shows its call to action",
      steps: [
        "Go to the landing page.",
        "Check that the text 'Click here to get started' is displayed.",
        "Check that the text 'Press play to watch the demo' is displayed.",
      ],
      expected: "Both lines are visible",
    });
    const ir = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "assert", target: { text: "Click here to get started" }, assertion: "visible" },
      { id: "s3", action: "assert", target: { text: "Press play to watch the demo" }, assertion: "visible" },
    ] } as any;
    expect(missingActions(ir, quotedCase)).toBeNull();
  });

  it("still catches the flow it was built for", () => {
    // The protection must survive: an IR that logs in and stops, against a case naming five
    // actions. This is the case that once reported PASSED having filled nothing.
    const adminFlow = tc({
      title: "Admin can view the users list",
      steps: [
        "Fill 'Email' with the admin's email",
        "Fill 'Password' with the admin's password",
        "Click 'Sign In'",
        "Click 'Admin' in the sidebar",
        "Click 'Users'",
      ],
      expected: "The users list is displayed",
    });
    const stopsAfterLogin = { meta: {}, steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { name: "Email" }, value: "a@b.c" },
      { id: "s3", action: "fill", target: { name: "Password" }, value: "pw" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    ] } as any;
    expect(missingActions(stopsAfterLogin, adminFlow)?.message).toMatch(/action steps but the IR only carries out/);
  });
});

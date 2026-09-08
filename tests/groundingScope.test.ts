import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { groundingError } from "../src/stages/ir.js";
import { AppModel } from "../src/schema/appModel.js";
import { IR } from "../src/schema/ir.js";

/**
 * A save re-verifies the steps it edited, not all of them — TECH_DEBT.md TD-86.
 *
 * THE FAILURE. `regroundEditedIr` called `groundingError(ir, model)` over the WHOLE IR. The only
 * existing skip is "this step's `css` is in the model's `knownSelectors`", and during an edit the
 * model is whatever the walk could reach — often near-empty, because a case whose source run
 * folder has been deleted starts from an empty base model. So that skip essentially never fires,
 * and every untouched step is re-matched by NAME against a model that does not contain its page:
 * a step inside a modal, or on the login form, comes back "not present on the page" for an edit
 * somewhere else entirely. A ghost rejection that blames the user's edit for the walk's blind
 * spots.
 *
 * Worse, after any click that is not a plain link `trackPages` marks the cursor stale, and a
 * stale cursor matches against EVERY page's elements at once — so an untouched "Save" can bind
 * to a Save button on a different page and the case still saves, silently wrong.
 */

/** Two pages that both have a "Save" button — the collision the all-pages fallback creates. */
const TWO_PAGES = AppModel.parse({
  baseUrl: "https://app.example.com",
  pages: [
    {
      url: "https://app.example.com/settings", title: "Settings", concepts: [],
      elements: [
        { role: "button", name: "Save", css: "#settings-save" },
        { role: "button", name: "Add New", css: "#add-new" },
      ],
    },
    {
      url: "https://app.example.com/profile", title: "Profile", concepts: [],
      elements: [{ role: "button", name: "Save", css: "#profile-save" }],
    },
  ],
});

/** The state an edit actually starts from when the case's source run folder is gone. */
const EMPTY_MODEL = AppModel.parse({ baseUrl: "https://app.example.com", pages: [] });

const irOf = (steps: unknown[]) => IR.parse({
  meta: {
    feature: "admin", title: "Log in and navigate to the admin panel",
    priority: "high", sourcePrompt: "p", baseUrl: "https://app.example.com",
  },
  steps,
});

/** A 15-step case: login, a modal, and grounded targets throughout. */
const FIFTEEN = irOf([
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com", css: "#u" }, value: "${env:TEST_USERNAME}" },
  { id: "s3", action: "fill", target: { role: "textbox", name: "*********", css: "#p" }, value: "${env:TEST_PASSWORD}" },
  { id: "s4", action: "click", target: { role: "button", name: "Sign In", css: "#signin" } },
  { id: "s5", action: "click", target: { role: "button", name: "Admin", css: "#admin" } },
  { id: "s6", action: "click", target: { role: "button", name: "Users", css: "#users" } },
  { id: "s7", action: "click", target: { role: "button", name: "Add New", css: "#add-new" } },
  { id: "s8", action: "fill", target: { role: "textbox", name: "Full Name", css: "#name" }, value: "x" },
  { id: "s9", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "y" },
  { id: "s10", action: "select", target: { role: "combobox", name: "Role", css: "#role" }, value: "Learner" },
  { id: "s11", action: "select", target: { role: "combobox", name: "Manager", css: "#mgr" }, value: "a b" },
  { id: "s12", action: "click", target: { role: "button", name: "Save", css: "#modal-save" } },
  { id: "s13", action: "click", target: { role: "button", name: "Close", css: "#close" } },
  { id: "s14", action: "click", target: { role: "link", name: "Home", css: "#home" } },
  { id: "s15", action: "assert", assertion: "url_contains", value: "/home" },
]);

describe("scoped grounding — only the edited steps are re-verified", () => {
  it("without a scope, an untouched modal step is rejected against an empty model", () => {
    // The failure this fixes, reproduced: nothing about the case changed, the model simply does
    // not contain the modal, and grounding blames a step the user never touched.
    const err = groundingError(FIFTEEN, EMPTY_MODEL);
    expect(err).not.toBeNull();
  });

  it("with a scope, those untouched grounded steps are skipped entirely", () => {
    // Adding step 16 re-grounds only step 16. Every other step keeps the css it was grounded
    // with, so there is nothing to re-derive and nothing to reject.
    const withNewStep = irOf([
      ...FIFTEEN.steps,
      { id: "s16", action: "click", target: { role: "button", name: "Add New" } },
    ]);
    const model = AppModel.parse({
      baseUrl: "https://app.example.com",
      pages: [{
        url: "https://app.example.com/admin", title: "Admin", concepts: [],
        elements: [{ role: "button", name: "Add New", css: "#add-new" }],
      }],
    });
    expect(groundingError(withNewStep, model, { onlyIndexes: [15] })).toBeNull();
  });

  it("still rejects the EDITED step when it genuinely is not there", () => {
    // The scope narrows what is checked; it must not weaken the check itself.
    const withBadStep = irOf([
      ...FIFTEEN.steps,
      { id: "s16", action: "click", target: { role: "button", name: "Nonexistent" } },
    ]);
    const err = groundingError(withBadStep, TWO_PAGES, { onlyIndexes: [15] });
    expect(err?.index).toBe(15);
  });

  it("an UNLISTED step with NO grounding is skipped too — proved necessary by a live run", () => {
    // The rule was originally "not listed AND already grounded". A live run against the LMS
    // showed that is too narrow: adding `Click on button "Admin"` to the login case still failed,
    // on step 2 — the email box — because that case's login steps carry no `css`, so they were
    // re-matched against the post-login dashboard, which has no login form. The user's edit was
    // blamed for a step they never touched.
    //
    // The trade-off, deliberately taken: an untouched step that was never grounded stays never
    // grounded. That is its status quo, and the alternative is refusing edits to any case with an
    // ungrounded step anywhere in it.
    const ungroundedUntouched = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Ghost" } },   // no css
      { id: "s3", action: "click", target: { role: "button", name: "Save", css: "#settings-save" } },
    ]);
    expect(groundingError(ungroundedUntouched, TWO_PAGES, { onlyIndexes: [2] })).toBeNull();
  });

  it("but a NEW step is always listed, so nothing unverified enters through that door", () => {
    // A new row is a changed row by construction, so it is always in `onlyIndexes` and always
    // checked. This is what keeps the relaxed skip safe.
    const withNew = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Nonexistent" } },
    ]);
    expect(groundingError(withNew, TWO_PAGES, { onlyIndexes: [1] })?.index).toBe(1);
  });

  it("a testId counts as grounded, same as a css", () => {
    const withTestId = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Whatever", testId: "wtv" } },
    ]);
    expect(groundingError(withTestId, EMPTY_MODEL, { onlyIndexes: [] })).toBeNull();
  });

  it("editing step 9 grounds step 9 and nothing else", () => {
    const edited = irOf(FIFTEEN.steps.map((s, i) =>
      i === 8 ? { ...s, target: { role: "textbox", name: "Email address" } } : s));
    const model = AppModel.parse({
      baseUrl: "https://app.example.com",
      pages: [{
        url: "https://app.example.com/admin", title: "Admin", concepts: [],
        elements: [{ role: "textbox", name: "Email address", css: "#email2" }],
      }],
    });
    expect(groundingError(edited, model, { onlyIndexes: [8] })).toBeNull();
  });
});

describe("scoped grounding — the page the walk actually reached wins", () => {
  it("binds an edited step to the reached page, not to whichever page matched first", () => {
    // Both pages have a "Save". With a stale cursor the all-pages fallback can attach the step to
    // the wrong one and the case saves silently wrong. The URL the walk landed on settles it.
    const ir = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Add New", css: "#add-new" } },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    ]);
    const grounded = { ...ir, steps: ir.steps.map((s) => ({ ...s, target: { ...s.target } })) } as typeof ir;
    const err = groundingError(grounded, TWO_PAGES, {
      onlyIndexes: [2],
      reachedUrlAt: new Map([[2, "https://app.example.com/profile"]]),
    });
    expect(err).toBeNull();
    expect(grounded.steps[2].target?.css).toBe("#profile-save");
  });

  it("the other reached page binds the other button — the map is what decides", () => {
    const ir = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Add New", css: "#add-new" } },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    ]);
    const grounded = { ...ir, steps: ir.steps.map((s) => ({ ...s, target: { ...s.target } })) } as typeof ir;
    groundingError(grounded, TWO_PAGES, {
      onlyIndexes: [2],
      reachedUrlAt: new Map([[2, "https://app.example.com/settings"]]),
    });
    expect(grounded.steps[2].target?.css).toBe("#settings-save");
  });

  it("matches the reached URL scheme-insensitively, like every other page comparison", () => {
    // The walk reports where the browser landed; the model may hold the other scheme (TD-82).
    const ir = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Save" } },
    ]);
    const grounded = { ...ir, steps: ir.steps.map((s) => ({ ...s, target: { ...s.target } })) } as typeof ir;
    groundingError(grounded, TWO_PAGES, {
      onlyIndexes: [1],
      reachedUrlAt: new Map([[1, "http://app.example.com/profile?next=1"]]),
    });
    expect(grounded.steps[1].target?.css).toBe("#profile-save");
  });

  it("falls back to the old behaviour when no walk exists for that index", () => {
    const ir = irOf([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Add New" } },
    ]);
    expect(groundingError(ir, TWO_PAGES, { onlyIndexes: [1], reachedUrlAt: new Map() })).toBeNull();
  });
});

describe("the fresh-run compile path is untouched", () => {
  it("passes no scope, so every step is still checked", () => {
    // The option only ever narrows. A fresh IR is a model's invention and every step of it is
    // equally unverified — checking all of them is the entire point of that path.
    const src = readFileSync("src/stages/ir.ts", "utf8");
    const calls = [...src.matchAll(/groundingError\((.*?)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.split(",").length, `ir.ts must call groundingError with 2 args, got: ${args}`).toBe(2);
    }
  });

  it("two-argument calls behave exactly as before", () => {
    expect(groundingError(FIFTEEN, EMPTY_MODEL)).not.toBeNull();
    expect(groundingError(FIFTEEN, EMPTY_MODEL, undefined)).not.toBeNull();
  });
});

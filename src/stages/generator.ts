import type { IR, Step } from "../schema/ir.js";
import {
  resolveCode as locator,
  DOM_ORDER_FIELD_JS, FIELD_SELECTOR, DIALOG_SELECTOR,
  SELECTABLE_JS, OPTION_PROBE_JS, MATCH_OPTION_INDEX_JS, OPTION_ERROR_JS, SELECT_TIMEOUT_MS,
} from "./targetResolver.js";
import { isAuthTriggeringStep } from "./authSettle.js";
import { isEnvValueRef } from "./credentials.js";

const q = (s: string) => JSON.stringify(s);

/** The code for a fill/select value. A user's own credential arrives as an env-reference
 *  sentinel rather than the literal, so it is emitted as a `process.env` read — the spec file
 *  lives under runs/, which the server serves publicly, and must never contain the secret.
 *  The env var name comes from a fixed two-item allowlist, never from LLM or user text. */
const valueCode = (value: string | undefined): string => {
  const envVar = isEnvValueRef(value);
  return envVar ? `process.env.${envVar} ?? ""` : q(value ?? "");
};
const escapeRe = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Comparison value for the assertions that need one. Accepts target.url for url_contains
 *  because the IR prompt's own examples put the path there; ir.ts normalizes it too, so
 *  this is belt-and-braces. Empty is never OK — see emitAssert. */
function comparisonValue(step: Step): string {
  if (step.assertion === "url_contains") return step.value ?? step.target?.url ?? "";
  return step.value ?? "";
}

function emitAssert(step: Step): string {
  const t = step.target!;

  // An empty comparison value silently turns into `toHaveURL(new RegExp(""))` or
  // `toContainText("")` — assertions that match anything and therefore verify nothing.
  // A test that always passes is worse than one that fails: it reports a green verdict
  // the user has no reason to doubt. Fail loudly instead of lying quietly.
  if (step.assertion === "url_contains" || step.assertion === "text_contains" ||
      step.assertion === "text_equals" || step.assertion === "title_contains" ||
      step.assertion === "title_equals") {
    if (!comparisonValue(step).trim()) {
      throw new Error(
        `Step ${step.id}: "${step.assertion}" has no comparison value, which would assert ` +
        `nothing at all (it matches any page). Refusing to emit a vacuous assertion.`
      );
    }
  }

  switch (step.assertion) {
    case "visible": {
      // .and(page.locator(':visible')) narrows to elements Playwright considers visible RIGHT
      // NOW, evaluated at query time, before toBeVisible()'s own poll starts. Without it, a
      // locator that matches more than one same-named element (a real page's <option> inside a
      // collapsed dropdown, alongside the intended visible one) can resolve to a hidden
      // candidate and poll forever waiting for something it never asked to become visible.
      // Reproduced directly: getByText("Amazon") matched a hidden <option> in a dropdown menu
      // instead of the real, visible "Amazon" text elsewhere on the page. Scoped to "visible"
      // only — hidden/enabled/disabled/click/fill all depend on matching the SAME element the
      // step already resolved, not filtering it out.
      //
      // NOT .filter({ visible: true }) — that reads like the obvious API but isn't real:
      // Locator.filter() in this project's pinned Playwright (1.49.0) only accepts
      // has/hasNot/hasText/hasNotText. Passing `visible` is silently ignored, not an error —
      // verified directly against the type declarations AND with a real headless-browser run
      // (a hidden and a visible "Amazon" both still matched with `.filter({visible:true})`,
      // count stayed 3 either way). `.and(page.locator(':visible'))` — Playwright's `:visible`
      // pseudo-class intersected via `.and()` — is the real, verified mechanism: the same test
      // dropped the hidden match and kept the one visible "Amazon".
      //
      // Order matters and resolveCode()'s own output already narrows to one candidate for two
      // of its three shapes: text/label/placeholder/testId targets end in a hardcoded
      // `.first()`, and a css target ends in `.first()`/`.nth(N)`. Appending .and() AFTER that
      // narrowing doesn't exclude a hidden element in favor of a visible one — it locks onto
      // whichever candidate DOM order put first, and if THAT one is hidden, intersecting it
      // with :visible afterward just empties the locator (a confusing "resolved to 0" instead
      // of correctly finding the visible sibling) — verified directly: the hidden-option-first
      // test case above resolves to 0 with .and() after .first(), and to the real visible match
      // with .and() before .first(). Inserting it BEFORE the trailing .first()/.nth() — so the
      // visible subset is chosen from first, and only then narrowed — is the only order that
      // works. The role+name path via locate() has no such trailing modifier (it already
      // resolves to one specific element internally), so .and() is simply appended there.
      const raw = locator(t);
      const narrowed = raw.match(/^(.*)(\.first\(\)|\.nth\(\d+\))$/);
      const withFilter = narrowed
        ? `${narrowed[1]}.and(page.locator(':visible'))${narrowed[2]}`
        : `${raw}.and(page.locator(':visible'))`;
      return `  await expect(${withFilter}).toBeVisible({ timeout: 10000 });`;
    }

    case "hidden":
      return `  await expect(${locator(t)}).toBeHidden({ timeout: 10000 });`;

    case "enabled":
      return `  await expect(${locator(t)}).toBeEnabled({ timeout: 10000 });`;

    case "disabled":
      return `  await expect(${locator(t)}).toBeDisabled({ timeout: 10000 });`;

    case "text_equals":
      return `  await expect(${locator(t)}).toHaveText(${q(comparisonValue(step))}, { timeout: 10000 });`;

    case "text_contains":
      return `  await expect(${locator(t)}).toContainText(${q(comparisonValue(step))}, { timeout: 10000 });`;

    case "url_contains":
      return `  await expect(page).toHaveURL(new RegExp(${q(
        escapeRe(comparisonValue(step))
      )}), { timeout: 10000 });`;

    // Page-level, like url_contains — asserts against <title> metadata, never body text.
    // Exists so "verify the page title is X" has a correct compilation target at all; without
    // it the step degraded to a body-text search for a string that only lives in <title>.
    case "title_contains":
      return `  await expect(page).toHaveTitle(new RegExp(${q(
        escapeRe(comparisonValue(step))
      )}), { timeout: 10000 });`;

    case "title_equals":
      return `  await expect(page).toHaveTitle(${q(comparisonValue(step))}, { timeout: 10000 });`;

    default:
      throw new Error(`Unknown assertion: ${step.assertion}`);
  }
}

// -----------------------------------------------------------------------------
// Auth settle helper
// -----------------------------------------------------------------------------

const AUTH_SETTLE_HELPER = `
async function waitForAuthSettle(page) {
  const startUrl = page.url();

  try {
    await page.waitForURL(
      url => url.toString() !== startUrl,
      { timeout: 3000 }
    );
    return;
  } catch {}

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 8000,
    });
  } catch {}
}
`;

// -----------------------------------------------------------------------------
// Screenshot helper — capture a frame that is actually worth looking at
// -----------------------------------------------------------------------------

/**
 * Screenshots taken immediately after an action came out solid white or ghost-faded, which is
 * what a user sees as "blank and blurry".
 *
 * TWO distinct causes, found a session apart. Both are handled below, and the second one
 * invalidates the original diagnosis of the first, so both are recorded here.
 *
 * 1. FADE-IN (the original finding, still true). On the site this helper was written against,
 *    the DOM is fully populated within a few milliseconds of `domcontentloaded` (233 characters
 *    of text, 751px of layout height) while the captured frame is still blank, because the app
 *    fades content in with JS-driven animation — the pixels are near-transparent long after the
 *    DOM is complete. `page.screenshot({ animations: "disabled" })` does not help: it freezes
 *    CSS animations and transitions, not animation driven from JavaScript. So the only signal
 *    that means "this page has stopped moving" is the pixels themselves: sample until two
 *    consecutive frames are identical.
 *
 * 2. NOT-YET-PAINTED (found later; the original comment explicitly ruled paint timing out, and
 *    was wrong to). The stillness test in (1) cannot distinguish "finished painting" from
 *    "hasn't started painting" — two identical BLANK frames pass it just as well. Measured on
 *    a heavy real page: `load` fired 5ms in, samples 0 and 1 were the same empty 4331-byte
 *    frame 150ms apart, the loop exited immediately and wrote it; the same page four seconds
 *    later screenshotted at 547817 bytes. Across the runs on disk this made `step-1.png` (the
 *    post-navigate frame) blank in 23 of 38 cases — a constant 4331 bytes, the same empty
 *    image every time. Fixed by waiting for real rendered content BEFORE sampling, and by
 *    requiring one observed change before the identical-frames rule may exit.
 *
 * Measured cost — an animated page settles in ~750-950ms (4 samples), a static one in ~650ms
 * (3 samples: one extra versus before, to prove the picture was ever drawn), versus a blind
 * 2-3s delay that would be paid on every step of every case regardless.
 */
const SHOT_HELPER = `
async function shot(page, path) {
  const step = Number(process.env.SCREENSHOT_SETTLE_MS ?? 150);
  const maxSamples = Number(process.env.SCREENSHOT_MAX_SAMPLES ?? 10);
  const paintTimeout = Number(process.env.SCREENSHOT_PAINT_TIMEOUT_MS ?? 8000);
  await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready.then(() => true)).catch(() => {});

  // Wait for the page to have actually RENDERED something before sampling for stillness.
  // Without this the settle loop below cannot tell "finished painting" from "hasn't started
  // painting" — two identical BLANK frames satisfy its exit condition just as well as two
  // identical finished ones. Measured on amazon.in: load fired 5ms in, samples 0 and 1 were
  // both the same empty 4331-byte frame 150ms apart, the loop exited immediately and wrote
  // that; four seconds later the same page screenshotted at 547817 bytes. Polls cheap DOM
  // facts (rendered text + laid-out height), never pixels, and is best-effort throughout —
  // a page that legitimately has no content still proceeds once the timeout lapses.
  await page.waitForFunction(
    () => {
      const b = document.body;
      if (!b) return false;
      return (b.innerText || "").trim().length > 0 || b.scrollHeight > 200;
    },
    undefined,
    { timeout: paintTimeout }
  ).catch(() => {});

  let prev = null;
  let buf = null;
  let changed = false;
  for (let i = 0; i < maxSamples; i++) {
    try {
      buf = await page.screenshot({ animations: "disabled", caret: "hide" });
    } catch {
      break;   // page closed/navigating — keep whatever we already have
    }
    // Two identical frames mean "settled" ONLY once we've seen the picture change at least
    // once; before that they equally mean "nothing has been drawn yet". Requiring one observed
    // change first is what separates the two cases. A genuinely static page costs one extra
    // sample (~150ms) and no more, because the second pair of identical frames does exit.
    if (prev && buf.equals(prev)) {
      if (changed) break;
      changed = true;   // treat the first stable pair as the baseline, sample once more
    } else if (prev) {
      changed = true;
    }
    prev = buf;
    await page.waitForTimeout(step);
  }
  // A screenshot is diagnostic output. It must never be able to fail a passing test.
  try { if (buf) writeFileSync(path, buf); } catch {}
}
`;

// -----------------------------------------------------------------------------
// Self-healing locator helper — ARIA role → CSS fallback chain
// -----------------------------------------------------------------------------

const LOCATE_HELPER = `
async function locate(page, role, name, nth) {
  // exact: true is load-bearing. getByRole's name match defaults to case-insensitive
  // SUBSTRING, so asserting the real, discovered button "All" also matched an embedded video
  // player's hidden "restore all settings to the default" button and a "Open All Categories
  // Menu" hamburger — elements discovery never modelled, so grounding had no way to rule them
  // out. The name here is never a guess: groundingError already rewrites it to the exact
  // accessible name of a specific verified element, so demanding an exact match costs nothing
  // and stops unrelated substring collisions from being picked. See TECH_DEBT.md TD-32.
  const original = page.getByRole(role, { name, exact: true });

  // If nth is specified, use it to disambiguate duplicate elements
  if (nth !== undefined && nth !== null) {
    return original.nth(nth);
  }

  const count = await original.count();
  if (count === 1) return original;

  // CSS fallback: covers dropdown items, menu entries, and off-screen links
  // that ARIA role matching misses due to shadow DOM or collapsed state.
  // :text-is() not :has-text() — same exact-match reasoning as above; :has-text() is a
  // substring match on the element's whole subtree, which is how a video player's settings
  // button won a lookup for "All".
  const q = JSON.stringify(name);
  const cssFallbacks = [
    'a:text-is(' + q + ')',
    'button:text-is(' + q + ')',
    '[role="menuitem"]:text-is(' + q + ')',
  ];
  for (const sel of cssFallbacks) {
    const el = page.locator(sel);
    if (await el.count() === 1) return el;
  }

  // Broadest fallback: any element containing the exact text
  const text = page.getByText(name, { exact: true });
  if (await text.count() === 1) return text;

  // count > 1: genuinely ambiguous — every fallback above requires an exact match of 1, so
  // real duplicate-named elements (same name repeated in a header/footer, or a compressed
  // "N items" group the model targeted) fall through all of them. Prefer the first real match
  // over an unresolvable locator: for most assertions ("is X visible/enabled") any one real
  // instance proves the same thing, and a Playwright strict-mode crash was never a better
  // outcome than a possibly-wrong-instance pass. Not a full fix — page-scoping the application
  // model so nth can be assigned correctly is the real one — see TECH_DEBT.md TD-05.
  if (count > 1) {
    console.warn('[locate] ambiguous match for', role, JSON.stringify(name), '—', count, 'elements, using .first()');
    return original.first();
  }

  // count === 0: genuinely missing — return original so Playwright reports "resolved to 0
  // elements", the correct signal for a truly absent element.
  return original;
}
`;

// -----------------------------------------------------------------------------
// Field helper — locate a form control by whatever labels it, however weakly
// -----------------------------------------------------------------------------

// Mirrors resolveField() in targetResolver.ts. Same manual-sync arrangement as LOCATE_HELPER
// above: the generated spec is standalone (no imports beyond @playwright/test), so the
// algorithm exists twice on purpose.
//
// The last rung is what makes an unlabelled field reachable at all. A control with no
// accessible name, no placeholder and no id — `<div>Full Name</div><input>`, the ordinary
// React form shape — cannot be found by any getBy* name lookup; only its position relative to
// the visible text can find it. :text() matches on substring, so a request that says "Name"
// still reaches the field labelled "Full Name".
// scopeOf/firstUnique are used by field(), choose() AND safeClick(), so they are their own
// splice unit — spliced when ANY of the three is present. Living inside FIELD_HELPER meant a
// spec with a select step but no fill emitted choose() with no scopeOf() to call.
const SCOPE_HELPER = `
// Where to look: the open modal if there is one, otherwise the whole page. A modal covers the
// page it opened over, and that page routinely has a same-named field or button — resolving
// against the document while a dialog is open can act on something the user cannot even see.
// Returns a Locator either way, so callers use one uniform API. TECH_DEBT.md TD-72.
async function scopeOf(page) {
  const dialogs = page.locator(${JSON.stringify(DIALOG_SELECTOR)} + ':visible');
  try {
    if (await dialogs.count() > 0) return dialogs.last();
  } catch (e) {}
  return page.locator('body');
}

async function firstUnique(candidates) {
  for (const c of candidates) {
    try {
      const vis = c.locator(':visible');
      if (await vis.count() === 1) return vis;
      if (await c.count() === 1 && await c.isVisible().catch(() => false)) return c;
    } catch (e) {}
  }
  return null;
}
`;

const FIELD_HELPER = `
function nearField(hint, action) {
  const anchor = ':text(' + JSON.stringify(hint) + ')';
  // A 'select' must not fall back onto a plain <input>/<textarea>: selectOption() cannot act on
  // one, so the nearest-control match turned a resolvable step into a hard failure. role, not
  // tag, is what says an element can take a choice. Mirrors nearFieldSelector in
  // targetResolver.ts — tests/selectAction.test.ts pins the two equal (TECH_DEBT.md TD-70/TD-07).
  const tags = action === 'select'
    ? ['select', '[role="combobox"]']
    : ['input', 'textarea', 'select'];
  return tags.map(t => t + ':near(' + anchor + ', 120)').join(', ');
}

async function field(page, hint, action) {
  const scope = await scopeOf(page);

  // Accessible relationships first, exact throughout: a substring match on "Email" also matches
  // "Email address" and "Confirm Email", which silently binds two steps to one control.
  const semantic = action === 'select'
    ? [
      scope.getByRole('combobox', { name: hint, exact: true }),
      scope.getByLabel(hint, { exact: true }),
    ]
    : [
      scope.getByLabel(hint, { exact: true }),
      scope.getByPlaceholder(hint, { exact: true }),
      scope.getByRole('textbox', { name: hint, exact: true }),
      scope.getByRole('combobox', { name: hint, exact: true }),
      scope.getByRole('checkbox', { name: hint, exact: true }),
    ];
  const bySemantics = await firstUnique(semantic);
  if (bySemantics) return bySemantics;

  // DOM ORDER: the control that FOLLOWS the label text. This is the rung that answers "which
  // control does this label describe" instead of "which is nearest in pixels" — the question
  // that filled Full Name with an email address on run 2026-09-06T13-05-36-248Z-db2c0b4c.
  // The body of this callback is authored ONCE, in targetResolver.ts, and interpolated here as
  // SOURCE, so the two implementations are the same characters rather than two copies kept in
  // step (TECH_DEBT.md TD-07).
  //
  // Interpolated BARE, not via JSON.stringify. A string handed to evaluate() is evaluated as an
  // expression, so a function literal is constructed, returned, and lost across the wire as
  // undefined -- the rung then reports "no match" every time and every lookup silently falls
  // through to geometry. That is TD-78, and it is how this shipped green: field() still
  // returns the right control on a simple page, because geometry covers for the dead rung.
  try {
    // The selector is passed in, not baked in: a select step must never be handed a plain
    // <input> (TD-70), and the index below indexes THIS list, so both must be the same one.
    const fieldSel = action === 'select'
      ? 'select, [role="combobox"]'
      : ${JSON.stringify(FIELD_SELECTOR)};
    const idx = await scope.evaluate(${DOM_ORDER_FIELD_JS}, { wanted: hint, fieldSel: fieldSel });
    if (typeof idx === 'number' && idx >= 0) {
      return scope.locator(fieldSel).nth(idx);
    }
  } catch (e) {}

  // Geometry, last. Still useful where DOM order genuinely does not express the layout (a label
  // to the RIGHT of its input, a grid). Prefer a control the label sits above or left of.
  const near = scope.locator(nearField(hint, action));
  try {
    const n = await near.count();
    if (n > 1) {
      const anchor = await scope.locator(':text-is(' + JSON.stringify(hint) + ')').first()
        .boundingBox().catch(() => null);
      if (anchor) {
        for (let i = 0; i < n; i++) {
          const box = await near.nth(i).boundingBox().catch(() => null);
          if (box && (box.y >= anchor.y || box.x >= anchor.x + anchor.width)) return near.nth(i);
        }
      }
    }
  } catch (e) {}
  return near.first();
}
`;

// A "select" step does NOT imply a <select> element. Grounding matches on ROLE, and a React
// combobox is an <input> with a popup list — role="combobox", no <option> children and no
// selectOption() support. Emitting selectOption() unconditionally is how run
// 2026-09-04T10-38-19-619Z-bf20906d killed a valid case with
// "locator.selectOption: Error: Element is not a <select> element" (TECH_DEBT.md TD-70).
//
// So branch on what the element actually IS at run time rather than on what the IR called it.
// Pure code, no model call — the generator stays deterministic (DECISIONS.md D-06).
//
// The evaluate callback is a bare arrow with nothing named inside it, deliberately: esbuild
// rewrites named/const-assigned inner functions to call a __name helper that does not exist in
// the browser (CLAUDE.md sharp edges, TD-40).
const CHOOSE_HELPER = `
// Authored once in targetResolver.ts and interpolated here as SOURCE, so the live path and this
// spec run the same characters (TECH_DEBT.md TD-07). Interpolated BARE: a function handed to
// evaluate() as a STRING is evaluated as an expression and never called (TD-78).
const optionProbeJs = ${OPTION_PROBE_JS};
const matchOptionIndex = ${MATCH_OPTION_INDEX_JS};
const optionErrorMessage = ${OPTION_ERROR_JS};
const selectableJs = ${SELECTABLE_JS};

async function choose(page, target, value) {
  // A role match is not a promise about the tag: the resolved node can be a wrapper div, a
  // label, or a custom shell with the real <select> hidden behind it. Walk to the control that
  // can actually be selected before deciding which branch applies. TECH_DEBT.md TD-79.
  try {
    const tag0 = (await target.evaluate(el => el.tagName).catch(() => '')) || '';
    const role0 = (await target.getAttribute('role').catch(() => '')) || '';
    if (String(tag0).toUpperCase() !== 'SELECT' && role0 !== 'combobox' && role0 !== 'listbox') {
      const si = await target.evaluate(selectableJs, ${q(FIELD_SELECTOR)}).catch(() => -1);
      if (typeof si === 'number' && si >= 0) {
        target = page.locator(${q(FIELD_SELECTOR)}).nth(si);
      }
    }
  } catch (e) {}

  const tag = (await target.evaluate(el => el.tagName).catch(() => '')) || '';
  if (String(tag).toUpperCase() === 'SELECT') {
    // selectOption() matches an option's value or label EXACTLY, so "prashant mishra" misses an
    // <option>Prashant Mishra</option> and Playwright retries for the full timeout reporting only
    // "did not find some options" — which is what killed run 2026-09-06T13-05-36-248Z-db2c0b4c
    // at its Manager dropdown. Resolve the index ourselves: trimmed case-insensitive exact
    // first, then containment, and only then hand the raw value to Playwright so an genuinely
    // absent option still produces its own clear error. TECH_DEBT.md TD-76.
    // Options are very often fetched, so the list can still be empty when the step arrives.
    // Poll, but exit the MOMENT the control is populated and still has no match: waiting the
    // full timeout on a control that is simply the wrong one is how a resolution bug disguises
    // itself as a slow network. TECH_DEBT.md TD-79.
    const deadline = Date.now() + ${SELECT_TIMEOUT_MS};
    let idx = -1;
    for (;;) {
      const probe = await target.evaluate(optionProbeJs, value).catch(() => null);
      if (probe && probe.index >= 0) { idx = probe.index; break; }
      if (probe && probe.populated) break;          // real list, genuinely no match
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(100);
    }
    if (idx >= 0) {
      await target.selectOption({ index: idx }, { timeout: ${SELECT_TIMEOUT_MS} });
      return;
    }
    // Say what WAS on offer. "did not find some options" names neither the wanted value nor the
    // available ones, which is the difference between a person fixing a typo in ten seconds and
    // re-running the whole case to look at a video.
    const available = await target.evaluate(el => Array.prototype.slice
      .call(el.options || []).map(o => (o.textContent || '').trim()).filter(t => t.length > 0)
    ).catch(() => []);
    throw new Error(optionErrorMessage(value, available));
  }
  // Custom dropdown: open it, then pick the option by its accessible name.
  await target.click({ timeout: ${SELECT_TIMEOUT_MS} });
  // Scoped like every other lookup: a listbox behind the modal must not win.
  const optScope = await scopeOf(page);
  // Wait for the popup's items, which are as likely to be fetched as a <select>'s — but wait on
  // the OPEN POPUP, not on the whole scope.
  //
  // ':visible' is load-bearing, not defensive, and for two reasons. A form with several
  // dropdowns has several [role="listbox"] nodes and .first() takes the first in DOM order,
  // which is a CLOSED one. And a native <select> elsewhere on the page contributes its own
  // <option> elements, which carry an implicit role of "option" — so an unscoped
  // getByRole('option') count is above zero before this dropdown has rendered anything, the
  // wait exits instantly, and a late-loading popup fails as though it were empty. Both were
  // caught by running this against a real browser, not by reading it.
  const optDeadline = Date.now() + ${SELECT_TIMEOUT_MS};
  let scope = optScope;
  for (;;) {
    const popup = optScope.locator('[role="listbox"]:visible, [role="menu"]:visible');
    const open = (await popup.count()) > 0 ? popup.first() : null;
    scope = open ?? optScope;
    // Ready means "this dropdown has rendered its choices", and role="option" is only one way a
    // dropdown says so — plenty render plain <div>/<li> items, which the text fallback below
    // handles. Waiting for a role that will never appear would burn the whole timeout on a
    // dropdown that was ready immediately, so any rendered text in the open popup counts.
    if (await scope.getByRole('option').count() > 0) break;
    if (open && ((await open.textContent().catch(() => '')) || '').trim().length > 0) break;
    if (Date.now() >= optDeadline) break;
    await page.waitForTimeout(100);
  }
  const byRole = scope.getByRole('option', { name: value, exact: true });
  if (await byRole.count() > 0) {
    await byRole.first().click({ timeout: ${SELECT_TIMEOUT_MS} });
    return;
  }
  // Same trimmed, case-insensitive match the native branch uses, so a custom dropdown is not
  // held to a stricter standard than a <select> for no reason.
  const allOpts = scope.getByRole('option');
  const optCount = await allOpts.count();
  if (optCount > 0) {
    const texts = [];
    for (let i = 0; i < optCount; i++) {
      texts.push(((await allOpts.nth(i).textContent().catch(() => '')) || '').replace(/\\s+/g, ' ').trim());
    }
    const pick = matchOptionIndex(texts, value);
    if (pick >= 0) {
      await allOpts.nth(pick).click({ timeout: ${SELECT_TIMEOUT_MS} });
      return;
    }
  }
  // No option role anywhere in the popup — a dropdown whose items are plain divs or <li>s.
  const exact = scope.getByText(value, { exact: true });
  if (await exact.count() > 0) {
    await exact.first().click({ timeout: ${SELECT_TIMEOUT_MS} });
    return;
  }
  // Nothing matched. Report what the open popup was actually offering rather than letting
  // Playwright time out on a locator that resolves to nothing — same reason as the native
  // branch: the error is the only thing the person sees on the case card. TD-79.
  const offered = await scope.locator('[role="option"], li, [role="menuitem"]')
    .allTextContents().catch(() => []);
  throw new Error(optionErrorMessage(value, offered.map(t => (t || '').replace(/\\s+/g, ' ').trim())
    .filter(t => t.length > 0)));
}
`;

// -----------------------------------------------------------------------------
// Safe click helper — href-based navigation for links, interactive fallback
// -----------------------------------------------------------------------------

const SAFE_CLICK_HELPER = `
async function safeClick(page, role, name, nth) {
  // A modal's "Save" and the page's own "Save" are different buttons. While a dialog is open,
  // look inside it first and only fall back to the document when it holds no such control —
  // otherwise a step can click something the user cannot even see. TECH_DEBT.md TD-72.
  let el = await locate(page, role, name, nth);
  try {
    const scope = await scopeOf(page);
    const inDialog = await locate(scope, role, name, nth);
    if (await inDialog.count() > 0) el = inDialog;
  } catch (e) {}

  // For <a> tags: read href and navigate directly — bypasses all
  // hover/visibility/viewport issues from collapsed dropdown menus.
  if (role.toLowerCase() === "link") {
    const href = await el.getAttribute("href").catch(() => null);
    if (href && !/^\s*(#|javascript:|mailto:|tel:)/i.test(href)) {
      const target = new URL(href, page.url()).toString();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
      return;
    }
  }

  // Fallback: non-link elements (buttons, menuitems, etc.)
  //
  // EVERY call here carries an explicit timeout. scrollIntoViewIfNeeded() and hover() have
  // none by default, so they inherit Playwright's 30s action default — and both wait for the
  // element to become actionable, which a genuinely hidden element never does. The worst-case
  // ladder was 30 + 5 + 30 + 3 + 30 + 10 + 5 ≈ 113s for a single click step, which blew the
  // executor's own 100s kill timer: the process was SIGKILLed mid-artifact-finalization, so no
  // results.json was ever written and the failure could not be diagnosed at all (TECH_DEBT.md
  // TD-02/TD-36). Reproduced on a hidden "Show/Hide shortcuts" control: 249s of wall clock,
  // two SIGKILLed attempts, zero report. Bounded here to ~13s worst case — a hidden element
  // now fails FAST and reports honestly, which is the outcome that was wanted all along.
  await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await el.waitFor({ state: "visible", timeout: 3000 }).catch(async () => {
    await el.hover({ force: true, timeout: 2000 }).catch(() => {});
    await el.waitFor({ state: "visible", timeout: 2000 });
  });
  await el.hover({ timeout: 2000 }).catch(() => {});
  await el.click({ timeout: 5000 }).catch(async () => {
    await el.click({ force: true, timeout: 3000 });
  });
}
`;

// -----------------------------------------------------------------------------
// Emit one IR step
// -----------------------------------------------------------------------------

function emitStep(step: Step, baseUrl: string): string {
  let code: string;

  // Handle preAction (e.g., hover to reveal dropdown)
  code = '';
  if (step.preAction) {
    const preAction = step.preAction;
    const t = preAction.target;
    if (preAction.action === 'hover') {
      // resolveCode() already returns a full locator expression — wrapping it in
      // page.locator() would pass a Locator where a selector string is expected.
      code = `  await ${locator(t)}.hover();\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    } else if (preAction.action === 'click') {
      code = t.role && t.name
        ? `  await safeClick(page, ${q(t.role)}, ${q(t.name)});\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`
        : `  await ${locator(t)}.click({ timeout: 10000 });\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    }
  }

  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http")
        ? u
        : baseUrl.replace(/\/$/, "") + u;

      code += `  await page.goto(${q(full)}, { waitUntil: "domcontentloaded", timeout: 15000 });`;
      break;
    }

    case "click": {
      const t = step.target!;
      // safeClick is the role+name path only — it calls getByRole under the hood, and
      // Playwright rejects an empty role outright ("Role must not be empty"). A target
      // carrying only text/label/placeholder/testId is legitimate (dynamic content the
      // discovery snapshot never saw), so route it through the same resolver every other
      // action uses instead of passing empty strings that silently drop the target.
      // A verified css selector wins: safeClick goes through getByRole, which cannot match
      // an element whose accessible name is empty or was derived by discovery.
      if (!t.css && t.role && t.name) {
        const nthParam = t.nth !== undefined ? `, ${t.nth}` : '';
        code += `  await safeClick(page, ${q(t.role)}, ${q(t.name)}${nthParam});`;
      } else {
        code += `  await ${locator(t)}.click({ timeout: 10000 });`;
      }
      code += `\n  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});`;
      break;
    }

    case "fill":
      code += `  await ${locator(step.target!, "fill")}.fill(${valueCode(step.value)}, { timeout: 10000 });`;
      break;

    case "select":
      // choose() decides selectOption-vs-click-the-option at run time, from the element's real
      // tag. See CHOOSE_HELPER. Emitting selectOption() here is what TD-70 was.
      code += `  await choose(page, ${locator(step.target!, "select")}, ${valueCode(step.value)});`;
      break;

    case "check":
      code += `  await ${locator(step.target!, "check")}.check({ timeout: 10000 });`;
      break;

    case "press":
      code += `  await ${locator(step.target!)}.press(${q(step.value ?? "Enter")}, { timeout: 10000 });`;
      break;

    case "wait":
      code += `  await page.waitForTimeout(${Number(step.value ?? 1000)});`;
      break;

    case "assert":
      code += emitAssert(step);
      break;

    default:
      throw new Error(`Unknown action: ${(step as any).action}`);
  }

  if (isAuthTriggeringStep(step)) {
    code += `\n  await waitForAuthSettle(page);`;
  }

  return code;
}

// -----------------------------------------------------------------------------
// Step label helper — human-readable name for test.step()
// -----------------------------------------------------------------------------

function stepLabel(step: Step, index: number, baseUrl: string): string {
  const t = step.target;
  const name = t?.name ? ` '${t.name}'` : "";
  // A credential the user supplied is an env reference here, not the literal. Label it in
  // words: this string ends up in results.json and in the UI's step list, and "${env:...}"
  // reads like a bug to anyone looking at it.
  const val = isEnvValueRef(step.value) ? " the credentials you provided"
    : step.value ? ` '${step.value}'` : "";
  switch (step.action) {
    case "navigate": {
      const u = t?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      return `Navigate to ${full}`;
    }
    case "click": return `Click${name}`;
    case "fill": return `Fill${name} with${val}`;
    case "select": return `Select${val} in${name}`;
    case "check": return `Check${name}`;
    case "press": return `Press${val || " Enter"} in${name}`;
    case "wait": return `Wait ${step.value ?? 1000}ms`;
    case "assert": {
      const assertion = step.assertion ?? "visible";
      if (assertion === "text_contains") return `Assert${name} contains${val}`;
      if (assertion === "text_equals") return `Assert${name} text is${val}`;
      if (assertion === "url_contains") return `Assert URL contains${val}`;
      if (assertion === "title_contains") return `Assert page title contains${val}`;
      if (assertion === "title_equals") return `Assert page title is${val}`;
      return `Assert${name} is ${assertion}`;
    }
    default: return `Step ${index + 1}: ${step.action}`;
  }
}

// -----------------------------------------------------------------------------
// Generate Playwright spec
// -----------------------------------------------------------------------------

/**
 * @param screenshotDir where per-step screenshots go, relative to the process CWD.
 *   REQUIRED in practice: the previous hard-coded "artifacts/" was relative to the CWD of
 *   the Playwright process (the project root), so every run and every case in a suite
 *   overwrote the same artifacts/step-N.png files. On a multi-user deployment that is a
 *   cross-user leak, since concurrent runs share one CWD.
 */
export function generateSpec(ir: IR, screenshotDir = "artifacts"): string {
  // Forward slashes and no trailing separator: this string is embedded in generated code and
  // has to be valid on Windows too, where path.join produces backslashes that would need
  // escaping inside a JS string literal.
  const shotDir = screenshotDir.replace(/\\/g, "/").replace(/\/+$/, "");

  const body = ir.steps
    .map((step, i) => {
      const label = stepLabel(step, i, ir.meta.baseUrl);
      const code = emitStep(step, ir.meta.baseUrl);
      const indented = code.split("\n").map((l) => "    " + l).join("\n");
      return `    await test.step(${q(label)}, async () => {\n${indented}\n      await shot(page, ${q(`${shotDir}/step-${i + 1}.png`)});\n    });`;
    })
    .join("\n");

  // A `//` line comment breaks on ANY embedded newline — collapsing to a single space (not
  // cutAtBoundary, which preserves internal newlines on purpose for multi-line text) is what
  // truncNote below already does for truncationNote; feature/sourcePrompt need the same
  // treatment since sourcePrompt is free-form user text that can contain a literal newline.
  const oneLine = (s: string, max = 300) => s.replace(/\s+/g, " ").trim().slice(0, max);

  const truncNote = ir.meta.truncated
    ? `// PARTIAL: verified only up to the last grounded step — ${(
      ir.meta.truncationNote ??
      "further steps could not be grounded"
    )
      .replace(/\s+/g, " ")
      .slice(0, 200)}\n`
    : "";

  const needsLocate = body.includes("await locate(") || body.includes("await safeClick(");
  const needsSafeClick = body.includes("await safeClick(");
  const needsField = body.includes("await field(");
  const needsChoose = body.includes("await choose(");
  const needsScope = needsField || needsChoose || needsSafeClick;

  const needsAuthSettle = body.includes(
    "await waitForAuthSettle(page)"
  );

  const helper = [
    // Unconditional, unlike the others: every step calls shot(), so a `needsShot` flag could
    // only ever be true — and if the splice order ever shifted it could compute false and emit
    // a spec that calls an undefined function. Always-on cannot fail that way.
    SHOT_HELPER,
    needsLocate ? LOCATE_HELPER : "",
    needsScope ? SCOPE_HELPER : "",
    needsField ? FIELD_HELPER : "",
    needsChoose ? CHOOSE_HELPER : "",
    needsSafeClick ? SAFE_CLICK_HELPER : "",
    needsAuthSettle ? AUTH_SETTLE_HELPER : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const spec = `import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

${ helper }

// AUTO-GENERATED from IR — do not edit by hand.
// Feature: ${oneLine(ir.meta.feature, 100)}
// Priority: ${ir.meta.priority}
// Source: ${oneLine(ir.meta.sourcePrompt, 300)}
${ truncNote }
// Record where the flow actually ended up. Some apps stop automation dead — an emailed
// verification code, an external OAuth provider — and a run that halts there must be reported
// as blocked with proof, not as a pass or as a bug in the app. afterEach, not a final step, so
// it still runs when the test fails.
test.afterEach(async ({ page }) => {
  try {
    const text = await page.locator("body").innerText({ timeout: 5000 });
    writeFileSync(${q(`${shotDir}/final-page.txt`)}, page.url() + "\\n" + text.slice(0, 4000));
  } catch { /* best effort: never fail a test over its own postscript */ }
});

  test(${ q(ir.meta.title)
}, async ({ page }) => {
${ body }
});
`;

  // Sanitize: the LLM sometimes emits networkidle which hangs on real sites.
  return spec.replace(/"networkidle"/g, '"domcontentloaded"');
}

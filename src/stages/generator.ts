import type { IR, Step } from "../schema/ir.js";
import {
  resolveCode as locator, frameRootCode,
  DOM_ORDER_FIELD_JS, FIELD_SELECTOR, VISIBLE_DIALOG_SELECTOR,
  SELECTABLE_JS, OPTION_PROBE_JS, MATCH_OPTION_INDEX_JS, OPTION_ERROR_JS, SELECT_TIMEOUT_MS,
} from "./targetResolver.js";
import { isAuthTriggeringStep } from "./authSettle.js";
import { isEnvValueRef } from "./credentials.js";
import { FRONTDOOR_ENV, isFrontdoorRef, recordRefIndex, recordRefObject, SF_RECORD_PAGES_JS } from "./salesforceFrontdoor.js";
import { hasRunToken, RESOLVE_RUN_TOKENS_JS, SHOWN_NUMBER_JS } from "../text.js";

const q = (s: string) => JSON.stringify(s);

/**
 * How long ONE emitted assertion or action may wait. Was `10000` written out 15 times.
 *
 * Read at generation time and baked into the spec, because the spec is a standalone file that
 * shares nothing with the pipeline (DECISIONS.md D-06) — it cannot read this process's env when
 * Playwright later runs it.
 *
 * Deliberately NOT applied to `SAFE_CLICK_HELPER`'s fallback ladder. Those 2s/3s/5s values are not
 * a generic "how long to wait" — they are a bounded worst case, tuned in TECH_DEBT.md TD-36 after
 * an unbounded ladder reached ~113s for a single click and blew the executor's kill timer. Scaling
 * them with this knob would re-open that.
 */
const ASSERT_TIMEOUT_MS = Number(process.env.ASSERTION_TIMEOUT_MS) || 10_000;

/** The code for a fill/select value. A user's own credential arrives as an env-reference
 *  sentinel rather than the literal, so it is emitted as a `process.env` read — the spec file
 *  lives under runs/, which the server serves publicly, and must never contain the secret.
 *  The env var name comes from a fixed two-item allowlist, never from LLM or user text. */
const valueCode = (value: string | undefined): string => {
  const envVar = isEnvValueRef(value);
  if (envVar) return `process.env.${envVar} ?? ""`;
  // Run tokens ({{uid}}, {{phone}}, {{date:+N:locale}}) are resolved when the spec RUNS, from one
  // RUN_CTX per run (declared in the header when used), never when the IR was compiled.
  if (hasRunToken(value)) return `resolveRunTokens(${q(value ?? "")}, RUN_CTX)`;
  return q(value ?? "");
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

  // A record field's VALUE (Target.field, Phase A): read inside that field's own block, never as text
  // anywhere on the page. See SF_FIELD_HELPER.
  if (t?.field && (step.assertion === "text_contains" || step.assertion === "text_equals")) {
    return `  await sfFieldValue(page, ${q(t.field)}, ${valueCode(comparisonValue(step))}, ${q(step.assertion === "text_equals" ? "equals" : "contains")});`;
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
      // The :visible operand must hang off the SAME root as the target: Locator.and() refuses
      // two locators from different frames. `page` whenever the target has no frame.
      const visibleRoot = frameRootCode(t);
      const withFilter = narrowed
        ? `${narrowed[1]}.and(${visibleRoot}.locator(':visible'))${narrowed[2]}`
        : `${raw}.and(${visibleRoot}.locator(':visible'))`;
      return `  await expect(${withFilter}).toBeVisible({ timeout: ${ASSERT_TIMEOUT_MS} });`;
    }

    case "hidden":
      // Only when the step NAMED its target: assertGone compares that name against the element's
      // current label, and with no name there is nothing to compare. See TD-95 on the helper.
      return t.name
        ? `  await assertGone(${locator(t)}, ${q(t.name)});`
        : `  await expect(${locator(t)}).toBeHidden({ timeout: ${ASSERT_TIMEOUT_MS} });`;

    case "enabled":
      return `  await expect(${locator(t)}).toBeEnabled({ timeout: ${ASSERT_TIMEOUT_MS} });`;

    case "disabled":
      return `  await expect(${locator(t)}).toBeDisabled({ timeout: ${ASSERT_TIMEOUT_MS} });`;

    // A dropdown needs its SELECTED option compared, never the element's own text. Proven in a
    // real browser: `textContent` of a <select> is every option concatenated —
    // "Name (A to Z)Name (Z to A)Price (low to high)" — so `toHaveText("Name (A to Z)")` cannot
    // ever match, and `toContainText` matches whichever option happens to exist rather than the
    // one chosen, which is worse: it passes while verifying nothing.
    //
    // Observed on a real saucedemo run: "Assert 'Sort products' text is 'Name (A to Z)'" failed
    // with exactly that concatenation in the error. Every dropdown assertion on every site hits
    // this.
    case "text_equals":
      return t.role === "combobox"
        ? `  await assertChoice(${locator(t)}, ${valueCode(comparisonValue(step))}, "equals");`
        : `  await expect(${locator(t)}).toHaveText(${valueCode(comparisonValue(step))}, { timeout: ${ASSERT_TIMEOUT_MS} });`;

    case "text_contains":
      return t.role === "combobox"
        ? `  await assertChoice(${locator(t)}, ${valueCode(comparisonValue(step))}, "contains");`
        : `  await expect(${locator(t)}).toContainText(${valueCode(comparisonValue(step))}, { timeout: ${ASSERT_TIMEOUT_MS} });`;

    case "url_contains":
      return `  await expect(page).toHaveURL(new RegExp(${q(
        escapeRe(comparisonValue(step))
      )}), { timeout: ${ASSERT_TIMEOUT_MS} });`;

    // Page-level, like url_contains — asserts against <title> metadata, never body text.
    // Exists so "verify the page title is X" has a correct compilation target at all; without
    // it the step degraded to a body-text search for a string that only lives in <title>.
    case "title_contains":
      return `  await expect(page).toHaveTitle(new RegExp(${q(
        escapeRe(comparisonValue(step))
      )}), { timeout: ${ASSERT_TIMEOUT_MS} });`;

    case "title_equals":
      return `  await expect(page).toHaveTitle(${q(comparisonValue(step))}, { timeout: ${ASSERT_TIMEOUT_MS} });`;

    default:
      throw new Error(`Unknown assertion: ${step.assertion}`);
  }
}

// -----------------------------------------------------------------------------
// Dropdown assertion helper
// -----------------------------------------------------------------------------

/**
 * Assert what a dropdown is SHOWING, for both shapes a combobox comes in.
 *
 * Branches on what the element really is, the same way `choose()` does for the select action
 * (TD-70): a native `<select>` has `<option>` children and `option:checked` is its current value;
 * a React/custom combobox is an `<input role="combobox">` with no options at all, where the input's
 * value is what the user sees.
 *
 * Deliberately no `page.evaluate` — TD-40's `__name` trap makes an evaluate callback a runtime-only
 * failure, and `count()` answers the same question through the ordinary API.
 */
const ASSERT_CHOICE_HELPER = `
async function assertChoice(loc, expected, mode) {
  const chosen = loc.locator("option:checked");
  if (await chosen.count() > 0) {
    if (mode === "equals") await expect(chosen).toHaveText(expected, { timeout: ${ASSERT_TIMEOUT_MS} });
    else await expect(chosen).toContainText(expected, { timeout: ${ASSERT_TIMEOUT_MS} });
    return;
  }
  const pattern = mode === "equals"
    ? expected
    : new RegExp(expected.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"));
  await expect(loc).toHaveValue(pattern, { timeout: ${ASSERT_TIMEOUT_MS} });
}
`;

/**
 * `toBeHidden`, but when it fails it says whether the element was RENAMED rather than removed.
 *
 * TECH_DEBT.md TD-95. Discovery records an element's accessible name as its identity, and on real
 * sites that name often encodes STATE: saucedemo's cart is `aria-label="Cart, empty"` and becomes
 * "Cart, 1 item" the moment something is added. The model is shown that name and reasons correctly
 * from it -- after adding an item, "Cart, empty" should no longer be showing -- but `resolveCode`
 * resolves `css` first (it must; it is the only thing that makes icon-only controls addressable),
 * so the locator ignores the name and matches an element that is ALWAYS present. The assertion can
 * never pass, and the run reports a failure against a site that is working.
 *
 * This does not fix that. It makes the failure TRUE: the state did change, the test just expressed
 * it as "the element disappears" instead of "the label changes". Turning that into a specific
 * sentence costs nothing -- no tokens, no LLM call, no second page -- and `extractFailureDetail`
 * takes the FIRST line of the message as the error shown on the card, so the first line is the
 * finding rather than Playwright's generic timeout.
 *
 * WHY IT LIVES IN THE SPEC AND NOT IN failureAnalysis.ts: the page only exists inside this process.
 * `executePlaywright` spawns the runner and reads `result.json` afterwards, by which time the
 * browser is gone, and Playwright's own `toBeHidden` message carries the locator and "Received:
 * visible" but never the element's current label. The question is only answerable while the page is
 * still open, which is here.
 *
 * `aria-label` then text is a deliberate approximation of the accessible name, not the full ARIA
 * computation -- it is what this class of label is actually built from, and a wrong guess here can
 * only omit the extra sentence, never change a verdict. Emitted only when the step names its
 * target: with no name there is nothing to compare and the plain assertion is used.
 *
 * No `page.evaluate` (TD-40's `__name` trap) and no inner named functions -- `getAttribute` and
 * `textContent` answer this through the ordinary locator API.
 */
const ASSERT_GONE_HELPER = `
async function assertGone(loc, namedAs) {
  try {
    await expect(loc).toBeHidden({ timeout: ${ASSERT_TIMEOUT_MS} });
    return;
  } catch (err) {
    let now = null;
    try {
      now = await loc.getAttribute("aria-label");
      if (!now) now = await loc.textContent();
      if (now) now = now.trim().replace(/\\s+/g, " ");
    } catch (probeFailed) {
      now = null;
    }
    if (now && namedAs && now !== namedAs) {
      throw new Error(
        'Still on the page, but now labelled "' + now + '" instead of "' + namedAs +
        '" -- the label changed rather than the element disappearing.\\n' +
        'The state this step was checking DID change. Assert on what the label becomes, ' +
        'not on the element vanishing.\\n\\n' +
        (err && err.message ? err.message : String(err))
      );
    }
    throw err;
  }
}
`;

// -----------------------------------------------------------------------------
// Record pages reached (Phase D cleanup, org-connection specs only)
// -----------------------------------------------------------------------------

const SF_RECORDS_HELPER = `const SF_RECORDS = new Set();
test.beforeEach(({ page }) => {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const m = /\\/lightning\\/r\\/([A-Za-z][A-Za-z0-9_]*)\\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)\\/view/.exec(frame.url());
    if (m) SF_RECORDS.add(m[1] + "/" + m[2]);
  });
});
test.afterEach(() => { test.info().annotations.push({ type: "sf-records", description: JSON.stringify([...SF_RECORDS]) }); });`;

/**
 * Phase A: "go back to the <n>th <Object> record this test created" (recordRef). The records this
 * browser creates are noted as it goes (the replay notes them the same way, liveExtend.ts), and the
 * step opens that one: never another record of the object.
 */
const SF_OPEN_RECORD_HELPER = `let sfRecordPages = null;
test.beforeEach(({ page }) => {
  sfRecordPages = (${SF_RECORD_PAGES_JS})();
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) sfRecordPages.visit(frame.url()); });
});
async function sfOpenRecord(page, base, object, n) {
  const id = sfRecordPages && sfRecordPages.created(object, n);
  if (!id) throw new Error("No " + object + " record this test created (number " + n + ") was reached earlier in this test, so there is none to go back to.");
  await page.goto(base + "/lightning/r/" + object + "/" + id + "/view", { waitUntil: "domcontentloaded", timeout: 15000 });
}`;

/**
 * Does a record field's shown text hold `expected`? `lines` is the field block's text by line; the
 * label and the pencil's "Edit <label>" are not the value. Numbers compare as numbers, so "5000",
 * "5,000" and "$5,000.00" agree and "100" never matches "$1,000.00". Exported for its tests.
 */
export const SF_FIELD_MATCH_JS = `(lines, label, expected, mode) => {
  const num = ${SHOWN_NUMBER_JS};
  const shown = lines.map((l) => String(l).replace(/\\s+/g, " ").trim())
    .map((l) => l.startsWith(label + " ") ? l.slice(label.length + 1) : l)
    .filter((l) => l && l !== label && l !== "Edit " + label);
  const want = num(expected);
  if (want !== null) {
    return shown.some((l) => num(l) === want
      || (mode !== "equals" && (l.match(/\\d[\\d.,]*/g) || []).some((x) => num(x) === want)));
  }
  const e = String(expected).replace(/\\s+/g, " ").trim();
  return shown.some((l) => mode === "equals" ? l === e : l.includes(e));
}`;

/**
 * Phase A: assert a record field's VALUE (Target.field) inside the field's own block: Lightning's
 * record layout item, a highlights-panel item or an SLDS form element whose label is exactly `label`.
 * A bare getByText("$5,000.00") could be another field's (the Opportunity's own Amount, say).
 */
const SF_FIELD_HELPER = `const sfFieldMatch = ${SF_FIELD_MATCH_JS};
async function sfFieldValue(page, label, expected, mode) {
  const blocks = page.locator("records-record-layout-item, records-highlights-details-item, .slds-form-element")
    .filter({ has: page.getByText(label, { exact: true }) });
  const deadline = Date.now() + ${ASSERT_TIMEOUT_MS};
  let seen = [];
  for (;;) {
    seen = [];
    const n = await blocks.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const block = blocks.nth(i);
      if (!(await block.isVisible().catch(() => false))) continue;
      const lines = ((await block.innerText({ timeout: 1000 }).catch(() => "")) || "").split("\\n");
      if (sfFieldMatch(lines, label, expected, mode)) return;
      seen.push(lines.map((l) => l.trim()).filter(Boolean).join(" / "));
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(250);
  }
  throw new Error('The "' + label + '" field does not show "' + expected + '": ' + (seen.length
    ? "it shows " + seen.map((s) => '"' + s + '"').join(", ") : 'no visible field labelled "' + label + '" is on the page') + ".");
}`;

/** Scrolls down a screen at a time until `text` shows or the page ends, so a lazily drawn section
 *  exists before it is checked (and a "hidden" check has really looked everywhere). */
const SF_REVEAL_HELPER = `async function sfReveal(page, text) {
  const wanted = page.getByText(text).first();
  for (let i = 0; i < 15; i++) {
    if (await wanted.isVisible().catch(() => false)) return;
    const atBottom = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2).catch(() => true);
    if (atBottom) return;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await page.waitForTimeout(300);
  }
}`;

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
  const dialogs = page.locator(${JSON.stringify(VISIBLE_DIALOG_SELECTOR)});
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
/**
 * A LOOKUP field (a record reference) on a Lightning form: typing filters a list of records; one must
 * be PICKED, or the save fails with "Review the following fields" (run 2026-10-24T21-26-12-355Z-15cbc64f).
 * With a value: the first suggestion containing it. Without: the first record the org offers (the
 * input lists recent records on focus). "New <Object>" and "Show all results" rows are never picked.
 * Mirrored by lookupLive in targetResolver.ts for the grounding replay.
 */
const LOOKUP_HELPER = `
const lookupOptionError = ${OPTION_ERROR_JS};
async function lookupPick(page, target, value, root) {
  const inDoc = root || page;
  await target.click({ timeout: ${SELECT_TIMEOUT_MS} });
  if (value) await target.fill(value, { timeout: ${SELECT_TIMEOUT_MS} });
  const ownId = ((await target.getAttribute('aria-controls').catch(() => null))
    || (await target.getAttribute('aria-owns').catch(() => null)) || '').trim();
  const own = /^[\\w:.-]+$/.test(ownId) ? inDoc.locator('[id="' + ownId + '"]').first() : null;
  const isRecord = (t) => !/^(new\\b|show (all|more)|search )/i.test(t);
  const deadline = Date.now() + ${SELECT_TIMEOUT_MS};
  let where = null, texts = [];
  for (;;) {
    const open = own && await own.isVisible().catch(() => false) ? own : null;
    const popup = inDoc.locator('[role="listbox"]:visible').first();
    where = open || ((await popup.count().catch(() => 0)) > 0 ? popup : null);
    if (where) {
      const opts = where.getByRole('option');
      texts = (await opts.evaluateAll(els => els.map(el => (el.textContent || '').trim()
        || (el.shadowRoot ? el.shadowRoot.textContent || '' : ''))).catch(() => []))
        .map(t => t.replace(/\\s+/g, ' ').trim());
      if (texts.some(isRecord)) break;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(150);
  }
  const want = (value || '').toLowerCase();
  let idx = -1;
  if (want) idx = texts.findIndex(t => isRecord(t) && t.toLowerCase().includes(want));
  if (idx < 0 && !want) idx = texts.findIndex(isRecord);
  if (idx < 0 || !where) throw new Error(lookupOptionError(value || '(first suggestion)', texts.filter(isRecord)));
  await where.getByRole('option').nth(idx).click({ timeout: ${SELECT_TIMEOUT_MS} });
}
`;

const CHOOSE_HELPER = `
// Authored once in targetResolver.ts and interpolated here as SOURCE, so the live path and this
// spec run the same characters (TECH_DEBT.md TD-07). Interpolated BARE: a function handed to
// evaluate() as a STRING is evaluated as an expression and never called (TD-78).
const optionProbeJs = ${OPTION_PROBE_JS};
const matchOptionIndex = ${MATCH_OPTION_INDEX_JS};
const optionErrorMessage = ${OPTION_ERROR_JS};
const selectableJs = ${SELECTABLE_JS};

async function choose(page, target, value, root) {
  // root: the iframe chain a framed target lives in. Re-indexing the real control and finding its
  // option popup must happen in THAT document; waiting stays on the page. Absent = the page.
  const inDoc = root || page;
  // A role match is not a promise about the tag: the resolved node can be a wrapper div, a
  // label, or a custom shell with the real <select> hidden behind it. Walk to the control that
  // can actually be selected before deciding which branch applies. TECH_DEBT.md TD-79.
  try {
    const tag0 = (await target.evaluate(el => el.tagName).catch(() => '')) || '';
    const role0 = (await target.getAttribute('role').catch(() => '')) || '';
    if (String(tag0).toUpperCase() !== 'SELECT' && role0 !== 'combobox' && role0 !== 'listbox') {
      const si = await target.evaluate(selectableJs, ${q(FIELD_SELECTOR)}).catch(() => -1);
      if (typeof si === 'number' && si >= 0) {
        target = inDoc.locator(${q(FIELD_SELECTOR)}).nth(si);
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
      // Focus first, as a person's click on the dropdown would. selectOption() alone leaves focus
      // in the field typed before it, so that field never fires 'change' — and a form that keeps
      // values on 'change' and re-renders on this choice wipes it (TD-123).
      await target.focus({ timeout: ${SELECT_TIMEOUT_MS} }).catch(() => {});
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
  // The control's OWN popup first, named by its aria-controls / aria-owns (ARIA's link from a
  // combobox to its listbox). Run 2026-10-24T13-19-15-522Z-c180fec9: a Lightning picklist opened
  // with all its options showing, but scopeOf() below picked the modal's footer (the last
  // [class*="modal"] element), which holds no listbox, and the step failed as "no options at all".
  const ownId = ((await target.getAttribute('aria-controls').catch(() => null))
    || (await target.getAttribute('aria-owns').catch(() => null)) || '').trim();
  const own = /^[\\w:.-]+$/.test(ownId) ? inDoc.locator('[id="' + ownId + '"]').first() : null;
  // A click that did not open it (Lightning swallows one while the field before it commits: run
  // 2026-10-24T13-46-36-401Z-db184799, dropdown closed in the screenshot) is repeated once. Only
  // when the control says it is NOT open, so an open dropdown is never clicked shut.
  if (own || (await target.getAttribute('aria-expanded').catch(() => null)) !== null) {
    const isOpen = async () => (own && await own.isVisible().catch(() => false))
      || (await target.getAttribute('aria-expanded').catch(() => null)) === 'true';
    const openBy = Date.now() + 1500;
    while (!(await isOpen()) && Date.now() < openBy) await page.waitForTimeout(100);
    if (!(await isOpen())) await target.click({ timeout: ${SELECT_TIMEOUT_MS} });
  }
  // Scoped like every other lookup: a listbox behind the modal must not win.
  const optScope = await scopeOf(inDoc);
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
    const open = (own && await own.isVisible().catch(() => false)) ? own
      : (await popup.count()) > 0 ? popup.first() : null;
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
    // Shadow text too, for the same reason as the error message below (Lightning options).
    const texts = (await allOpts.evaluateAll(els => els.map(el => (el.textContent || '').trim()
      || (el.shadowRoot ? el.shadowRoot.textContent || '' : ''))).catch(() => []))
      .map(t => t.replace(/\\s+/g, ' ').trim());
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
  // A Lightning option's text lives in its OWN shadow root, so its textContent (and innerText) is
  // "" and the error claimed an open list was empty. Read the shadow text when the light text is empty.
  const offered = await scope.locator('[role="option"], li, [role="menuitem"]')
    .evaluateAll(els => els.map(el => (el.textContent || '').trim() || (el.shadowRoot ? el.shadowRoot.textContent || '' : '')))
    .catch(() => []);
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
    // The .catch here looks like TECH_DEBT.md TD-09 ("swallows a strict-mode error on
    // duplicate-named links ... silently falls through to the non-link click branch"). Measured in
    // a real browser — tests/safeClickBrowser.test.ts — TD-09's premise does not hold: swallowing
    // the error leaves href null, control reaches the fallback ladder, and el.waitFor/el.click
    // raise the SAME strict-mode violation. (No backticks in this comment: it lives INSIDE the
    // SAFE_CLICK_HELPER template literal, where one would terminate the string.)
    // Playwright raises the violation the instant a locator resolves to
    // more than one element rather than after a timeout, so the failure is neither silent nor slow.
    // Rethrowing here was tried and reverted: it changed no observable behaviour, and an inert edit
    // to the emitted spec is exactly what DECISIONS.md D-19 warns against shipping.
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
        : `  await ${locator(t)}.click({ timeout: ${ASSERT_TIMEOUT_MS} });\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    }
  }

  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      if (isFrontdoorRef(u)) {
        // D-63: sign in through a Salesforce org connection. The URL carries an access token, so the
        // spec holds only the env name; executor.ts gives the child a fresh one. Outside Testbench
        // (CI), `sf org open --url-only` prints a URL of the same kind.
        code += `  if (!process.env.${FRONTDOOR_ENV}) throw new Error("${FRONTDOOR_ENV} is not set: this test signs in through a Salesforce org connection. Set it to a signed-in frontdoor URL (for example from: sf org open --url-only).");\n`;
        code += `  await page.goto(process.env.${FRONTDOOR_ENV}, { waitUntil: "domcontentloaded", timeout: 60000 });\n`;
        code += `  await page.waitForURL((u) => !u.pathname.toLowerCase().includes("frontdoor.jsp"), { timeout: 60000 }).catch(() => {});`;
        break;
      }
      // Phase A: the record this test created, known only when the test runs (SF_OPEN_RECORD_HELPER).
      const recordObject = recordRefObject(u);
      if (recordObject) {
        code += `  await sfOpenRecord(page, ${q(baseUrl.replace(/\/$/, ""))}, ${q(recordObject)}, ${recordRefIndex(u)});`;
        break;
      }
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
      // Not for a target inside an iframe either: safeClick resolves against `page` and navigates
      // with page.goto/page.url, none of which a frame root offers; locate() via locator(t) does.
      if (!t.css && !t.frame && t.role && t.name) {
        const nthParam = t.nth !== undefined ? `, ${t.nth}` : '';
        code += `  await safeClick(page, ${q(t.role)}, ${q(t.name)}${nthParam});`;
      } else {
        code += `  await ${locator(t)}.click({ timeout: ${ASSERT_TIMEOUT_MS} });`;
      }
      code += `\n  await page.waitForLoadState("domcontentloaded", { timeout: ${ASSERT_TIMEOUT_MS} }).catch(() => {});`;
      break;
    }

    case "fill":
      code += `  await ${locator(step.target!, "fill")}.fill(${valueCode(step.value)}, { timeout: ${ASSERT_TIMEOUT_MS} });`;
      break;

    case "select":
      // A lookup (Target.lookup, set from the org model): type, wait for the suggestions, pick the
      // match — or the first suggestion with an empty value. See LOOKUP_HELPER.
      if (step.target!.lookup) {
        code += `  await lookupPick(page, ${locator(step.target!, "select")}, ${valueCode(step.value)}${step.target!.frame ? `, ${frameRootCode(step.target!)}` : ""});`;
        break;
      }
      // choose() decides selectOption-vs-click-the-option at run time, from the element's real
      // tag. See CHOOSE_HELPER. Emitting selectOption() here is what TD-70 was.
      // A target in an iframe passes its frame root as choose()'s 4th argument, for the two
      // lookups that must happen in the target's own document. Omitted otherwise, so a spec with
      // no frames is emitted exactly as before.
      code += `  await choose(page, ${locator(step.target!, "select")}, ${valueCode(step.value)}${step.target!.frame ? `, ${frameRootCode(step.target!)}` : ""});`;
      break;

    case "check":
      code += `  await ${locator(step.target!, "check")}.check({ timeout: ${ASSERT_TIMEOUT_MS} });`;
      break;

    case "press":
      code += `  await ${locator(step.target!)}.press(${q(step.value ?? "Enter")}, { timeout: ${ASSERT_TIMEOUT_MS} });`;
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
  const name = t?.name ? ` '${t.name}'` : t?.field ? ` '${t.field}'` : "";
  // A credential the user supplied is an env reference here, not the literal. Label it in
  // words: this string ends up in results.json and in the UI's step list, and "${env:...}"
  // reads like a bug to anyone looking at it.
  const val = isEnvValueRef(step.value) ? " the credentials you provided"
    : step.value ? ` '${step.value}'` : "";
  switch (step.action) {
    case "navigate": {
      const u = t?.url ?? "/";
      if (isFrontdoorRef(u)) return "Sign in through the Salesforce org connection";
      if (recordRefObject(u)) {
        const n = recordRefIndex(u)!;
        return `Go back to the ${recordRefObject(u)} record this test created${n > 1 ? `, number ${n}` : ""}`;
      }
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

  // A text check after a click on a record's "Details" tab first scrolls its lower sections into
  // being: Lightning draws them only when scrolled to (run 2026-10-26T07-53-42-185Z-83b50b3b).
  const detailsAt = ir.steps.findIndex((s) => s.action === "click" && s.target?.role === "tab" && s.target.name === "Details");
  const body = ir.steps
    .map((step, i) => {
      const label = stepLabel(step, i, ir.meta.baseUrl);
      // A field's value check scrolls its label into being too, Details tab or not (Phase A).
      const reveal = step.action === "assert" && step.target?.field && (step.assertion === "text_contains" || step.assertion === "text_equals")
        ? `await sfReveal(page, ${q(step.target.field)});\n`
        : detailsAt >= 0 && i > detailsAt && step.action === "assert" && step.target?.text
        && (step.assertion === "visible" || step.assertion === "hidden")
        ? `await sfReveal(page, ${q(step.target.text)});\n` : "";
      const code = reveal + emitStep(step, ir.meta.baseUrl);
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
  const needsAssertChoice = body.includes("await assertChoice(");
  const needsAssertGone = body.includes("await assertGone(");
  const needsField = body.includes("await field(");
  const needsChoose = body.includes("await choose(");
  const needsLookup = body.includes("await lookupPick(");
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
    needsLookup ? LOOKUP_HELPER : "",
    needsSafeClick ? SAFE_CLICK_HELPER : "",
    needsAssertChoice ? ASSERT_CHOICE_HELPER : "",
    needsAssertGone ? ASSERT_GONE_HELPER : "",
    needsAuthSettle ? AUTH_SETTLE_HELPER : "",
    // One context per run of this spec, for every run-token value (see valueCode): the same resolver
    // source the grounding replay uses (text.ts, TD-07). The context rides in results.json as the
    // "run-tokens" annotation, so the report can show the values this run actually typed.
    body.includes("resolveRunTokens(")
      ? `const RUN_CTX = { uid: Date.now().toString(36).slice(-6), phone: "415555" + String(Date.now()).slice(-4), now: Date.now() };
const resolveRunTokens = ${RESOLVE_RUN_TOKENS_JS};
test.beforeEach(() => { test.info().annotations.push({ type: "run-tokens", description: JSON.stringify(RUN_CTX) }); });`
      : "",
    // Phase D: an org-connection spec notes every record page its browser reached, the page a
    // create's Save opens, as the "sf-records" annotation; the run's cleanup deletes only those the
    // org confirms this user created during the run (salesforceCleanup.ts).
    body.includes(`process.env.${FRONTDOOR_ENV}`) ? SF_RECORDS_HELPER : "",
    body.includes("await sfReveal(") ? SF_REVEAL_HELPER : "",
    body.includes("await sfOpenRecord(") ? SF_OPEN_RECORD_HELPER : "",
    body.includes("await sfFieldValue(") ? SF_FIELD_HELPER : "",
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

import { groq } from "../llm/groq.js";
import { GroqBudget } from "../llm/groqBudget.js";
import { parseJson } from "../llm/json.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import { AppModel, PageModel, Element, toLiteModel } from "../schema/appModel.js";
import { extendAppModel, refreshPageModel, groundTerminalTextAssertion, isPureTextAssertion } from "./liveExtend.js";
import {
  credentialsFor, applyCredentials, credentialPolicyFor, promptCarriesCredentials,
  credentialFieldMap,
  NEGATIVE_CATEGORIES, type Credentials,
} from "./credentials.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";
import { extractPromptSelectors, verifyAgainstModel, promptSelectorHint } from "./promptSelectors.js";

/** Return type for toIR that includes the updated AppModel after live-extension. */
export interface IRResult {
  ir: IR;
  updatedAppModel: AppModel;
}

const ASSERTION_KEYS = [
  "text_contains", "text_equals", "url_contains",
  "visible", "hidden", "enabled", "disabled",
] as const;

// Common ARIA roles the model might legitimately target. Anything outside this set
// (seen in practice: role: "text" for a plain message div) is almost always the model
// inventing a role for content it never actually observed in the AppModel — most often
// dynamic content, like a post-submit error banner, that didn't exist in the discovery
// snapshot. In that case what it really means is "this text is visible somewhere,"
// which page.getByText() (target.text) expresses correctly and getByRole() cannot.
const KNOWN_ROLES = new Set([
  "button", "textbox", "checkbox", "radio", "link", "combobox", "listbox", "option",
  "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "heading", "img",
  "list", "listitem", "table", "row", "cell", "dialog", "alert", "navigation", "banner",
  "main", "contentinfo", "form", "region", "group", "generic", "article", "figure",
]);

/**
 * Groq/Llama reliably gets the IR's shape *close* but not exact: numeric ids,
 * empty-string targets instead of omitted ones, and — worst — an assertion
 * object like { text_contains: "...", visible: "" } instead of the single
 * enum string our schema (and the generator) require. Fold those into the
 * expected shape before validating; only the truly malformed still fails.
 */
export function normalizeIR(raw: any): any {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps)) return raw;

  for (const step of raw.steps) {
    if (step == null || typeof step !== "object") continue;

    if (typeof step.id === "number") step.id = String(step.id);
    if (typeof step.value === "number") step.value = String(step.value);
    if (step.target === "" || step.target === null) delete step.target;
    if (step.value === "") delete step.value;

    if (step.target && typeof step.target === "object" && step.target.role
      && !KNOWN_ROLES.has(String(step.target.role).toLowerCase())) {
      const literalText = step.target.name ?? step.target.text;
      delete step.target.role;
      delete step.target.name;
      if (literalText) step.target.text = literalText;
    }

    if (step.assertion && typeof step.assertion === "object") {
      if (step.action !== "assert") {
        delete step.assertion;
        continue;
      }
      const found = ASSERTION_KEYS.find(k => k in step.assertion);
      if (found) {
        const val = step.assertion[found];
        step.assertion = found;
        if (typeof val === "string" && val && !step.value) step.value = val;
      } else {
        step.assertion = "visible";
      }
    }

    // url_contains carries its comparison path in `value`, but the model routinely puts it
    // in `target.url` — the examples in this file's own system prompt do exactly that. The
    // generator only ever read `value`, so those assertions compiled to
    // `toHaveURL(new RegExp(""))`, which matches ANY url: a silent false PASS that verified
    // nothing. Fold target.url into value so the assertion means what it says.
    if (step.action === "assert" && step.assertion === "url_contains"
      && !step.value && typeof step.target?.url === "string" && step.target.url) {
      step.value = step.target.url;
    }
  }
  return raw;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const NON_NAVIGATING_HREF = /^\s*(#|javascript:|mailto:|tel:)/i;

function resolveHref(base: string, hrefOrPath: string): string | null {
  try { return new URL(hrefOrPath, base).href; } catch { return null; }
}

/** Origin + path, ignoring query/hash — enough to match a discovered page's URL against a
 *  resolved href without tracking params throwing off the comparison. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname.replace(/\/+$/, "") || "/");
  } catch { return url; }
}

function findPageByUrl(appModel: AppModel, absoluteUrl: string): PageModel | null {
  const key = pageKey(absoluteUrl);
  return appModel.pages.find(p => pageKey(p.url) === key) ?? null;
}

function findDomLink(page: PageModel, name: string) {
  const target = norm(name);
  return (page.domLinks ?? []).find(l =>
    norm(l.text) === target ||
    (l.ariaLabel && norm(l.ariaLabel) === target) ||
    (l.title && norm(l.title) === target)
  ) ?? null;
}

export interface PageTrail {
  /** Page the flow is actually on entering step i, or null if unresolved — callers
   *  should fall back to matching against every page's elements when null. */
  pageAt: (PageModel | null)[];
  /** Resolved destination href of the link clicked in the immediately preceding step,
   *  or null. */
  lastLinkHrefAt: (string | null)[];
}

/**
 * Walk the IR's steps once, tracking which page the flow is actually on (advanced by
 * navigate steps, and by clicking a link whose real destination — from the AppModel's
 * domLinks — resolves to a known page) and the destination href of the most recent link
 * click. Conservative by design: whenever the cursor can't be confidently resolved, it's
 * null — callers fall back to "match against everything," today's behavior, never a new
 * false negative. Doesn't track JS-driven navigation, SPA client routing, or
 * nth-disambiguated duplicate link names; those fall back the same safe way.
 */
export function trackPages(ir: IR, appModel: AppModel): PageTrail {
  const pageAt: (PageModel | null)[] = [];
  const lastLinkHrefAt: (string | null)[] = [];
  let currentPage: PageModel | null = null;
  let lastLinkHref: string | null = null;

  for (let i = 0; i < ir.steps.length; i++) {
    pageAt[i] = currentPage;
    lastLinkHrefAt[i] = lastLinkHref;

    const step = ir.steps[i];
    const t = step.target;
    lastLinkHref = null; // only survives to the very next step; re-set below if this one earns it

    if (step.action === "navigate" && t?.url) {
      const resolved = resolveHref(appModel.baseUrl, t.url);
      if (resolved) currentPage = findPageByUrl(appModel, resolved);
    } else if (currentPage && step.action === "click" && t?.role && norm(t.role) === "link" && t?.name) {
      const link = findDomLink(currentPage, t.name);
      const href = link?.href?.trim();
      if (href && !NON_NAVIGATING_HREF.test(href)) {
        const resolved = resolveHref(currentPage.url, href);
        if (resolved) {
          lastLinkHref = resolved;
          currentPage = findPageByUrl(appModel, resolved) ?? currentPage;
        }
      }
    }
  }
  return { pageAt, lastLinkHrefAt };
}

/**
 * The URL the flow is on entering each step, carried forward.
 *
 * trackPages' own `pageAt` only resolves to pages the AppModel already contains, which is too
 * strict here: a signup form reached by clicking "Sign up" often lives on a page discovery
 * hasn't modelled yet, so pageAt stays parked on the entry page and the step looks like it's
 * still on "/". `lastLinkHrefAt` knows the real destination of that click even when the page is
 * unknown, so prefer it and carry it forward until something moves the flow again.
 */
export function legUrls(ir: IR, appModel: AppModel, entryUrl: string): (string | null)[] {
  const trail = trackPages(ir, appModel);
  const out: (string | null)[] = [];
  let leg: string | null = entryUrl;
  let prevPage: string | null = null;
  for (let i = 0; i < ir.steps.length; i++) {
    // pageAt only counts when it CHANGES. It resolves against pages the model already knows,
    // so on a flow into an undiscovered page it sits frozen on the last known one — and
    // letting it win every step would overwrite the destination carried forward from the link
    // click that got us there. Seen exactly that: a signup flow's fill steps reverted from
    // /register back to /, which is what decides whether they receive real credentials.
    const page = trail.pageAt[i]?.url ?? null;
    if (trail.lastLinkHrefAt[i]) leg = trail.lastLinkHrefAt[i];
    else if (page && page !== prevPage) leg = page;
    if (page) prevPage = page;
    out[i] = leg;
    // A navigate step moves the flow for every step AFTER it — including to a page the model
    // has never seen, which trackPages' pageAt cannot represent (it resolves against known
    // pages only and stays null otherwise).
    const s = ir.steps[i];
    if (s.action === "navigate" && s.target?.url) {
      const resolved = resolveHref(appModel.baseUrl, s.target.url);
      if (resolved) leg = resolved;
    }
  }
  return out;
}

/**
 * Deterministic grounding check: every interactive target the IR addresses by
 * role+name must correspond to a real element in the AppModel. This is the guard
 * that catches the downstream LLM inventing a UI (e.g. a Username/Password form)
 * that discovery never actually saw. Pure text targets are intentionally exempt —
 * the IR contract allows target.text for dynamic post-action content (flash/error
 * messages) that isn't in the discovery snapshot. Returns the index of the first
 * ungrounded step plus a human-readable reason (so the caller can replay the
 * grounded prefix steps[0..index] to reach the missing state), or null if grounded.
 */
export function groundingError(ir: IR, appModel: AppModel): { index: number; message: string } | null {
  const allElements = appModel.pages.flatMap(p => p.elements);
  // Selectors the model is allowed to address directly, because discovery captured them.
  const knownSelectors = new Set<string>();
  for (const e of allElements) {
    if (e.css) knownSelectors.add(e.css.toLowerCase());
    if (e.id) knownSelectors.add(`#${e.id}`.toLowerCase());
    if (e.testId) {
      knownSelectors.add(`[data-test="${e.testId}"]`.toLowerCase());
      knownSelectors.add(`[data-testid="${e.testId}"]`.toLowerCase());
    }
  }
  // ponytail: strip decorative glyphs (+, emoji, bullets) for fuzzy name matching —
  // catches "+ Add New" vs "Add New" without the unsound reverse-direction check.
  const stripGlyphs = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  // Which page the flow is actually on at each step — an element grounded only against
  // some OTHER page (never the current one) shouldn't pass just because it exists
  // somewhere in the model. Falls back to allElements wherever the cursor is unresolved.
  const trail = trackPages(ir, appModel);
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    const t = step.target;
    // A target carrying a selector discovery verified is already grounded — that IS the
    // proof the element exists, and it's stronger than a role+name match. Covers the
    // selectors a user names in their own request.
    if (t?.css && knownSelectors.has(t.css.toLowerCase())) continue;
    if (!t?.role || !t?.name) continue; // navigate / text-only / wait steps
    const role = norm(t.role);
    const name = norm(t.name);
    const elements = trail.pageAt[index]?.elements ?? allElements;

    // Rank candidates instead of taking the first substring hit. `en.includes(name)` alone
    // grounded "Continue" to "Continue Shopping" — a different control on a different page —
    // because that happened to come first in element order. An exact match must always beat
    // a partial one, and among partials the closest-length name is the least wrong.
    let matched: Element | null = null;
    let bestTier = 99;
    let bestDelta = Infinity;
    const sn = stripGlyphs(name);
    for (const e of elements) {
      if (norm(e.role) !== role) continue;
      const en = norm(e.name);
      const sen = stripGlyphs(en);

      let tier: number;
      if (en === name) tier = 0;                                  // exact
      else if (sn && sen && sn === sen) tier = 1;                  // exact ignoring glyphs
      else if (en.startsWith(name) || en.endsWith(name)) tier = 2;  // prefix/suffix
      else if (en.includes(name)) tier = 3;                         // substring anywhere
      else continue;

      const delta = Math.abs(en.length - name.length);
      if (tier < bestTier || (tier === bestTier && delta < bestDelta)) {
        matched = e; bestTier = tier; bestDelta = delta;
        if (tier === 0 && delta === 0) break;                       // can't do better
      }
    }
    const matchedName = matched?.name ?? null;
    if (!matchedName) {
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" name="${t.name}", ` +
          `which is not present in the application model — the page under test does not have this element.`,
      };
    }
    // ponytail: self-correct to the app model's literal name so Playwright matches
    t.name = matchedName;
    // Carry the deterministic identity discovery captured for this element. This is the
    // only route by which an icon-only control (empty accessible name, so its model name
    // was derived) becomes locatable — getByRole with a derived name matches nothing.
    // Written here, in code, from an element discovery verified exists: the IR prompt's
    // "never use CSS selectors" rule still holds for anything the model itself emits.
    if (matched?.css && !t.css) t.css = matched.css;
    if (matched?.testId && !t.testId) t.testId = matched.testId;
  }
  return null;
}

// A negative-path case asserts that something must NOT work. Its success criterion is the
// failure signal — an error banner, a validation message, staying put. Asserting the app's
// SUCCESS message in such a case is always wrong, and it fails against a perfectly healthy
// site: seen in practice, "test login with an invalid password" produced
// `assert getByText("Your username is valid!") toBeVisible` and reported the site broken.
//
// groundingError can't catch this: it deliberately exempts pure-text targets, because
// post-action error banners genuinely aren't in the discovery snapshot. So the expected
// text of exactly the assertion that matters most is the one thing nothing validates.
const NEGATIVE_CASE = /\b(invalid|empty|blank|incorrect|wrong|malformed|missing|unable|cannot|fail(s|ed|ure)?|reject(s|ed)?|denied|unauthori[sz]ed|injection|xss|without)\b/i;
// Checked FIRST — "invalid" contains "valid", so failure vocabulary must win the tie.
const FAILURE_SIGNAL = /\b(invalid|error|incorrect|wrong|fail(s|ed|ure)?|denied|required|unable|cannot|unauthori[sz]ed|not\s+(match|found|allowed|valid))\b/i;
// `\bvalid\b` cannot match inside "invalid" — there is no word boundary between the "n"
// and the "v" — so this is safe even though FAILURE_SIGNAL is checked first anyway.
const SUCCESS_SIGNAL = /\b(success(ful|fully)?|succeeded|valid|welcome|logged\s*in|signed\s*in|dashboard|congratulations|thank\s*you|confirmed|complete[ds]?)\b/i;

/**
 * Reject an IR whose negative-path test case ends by asserting the application's SUCCESS
 * message. Returns a human-readable reason, or null when the IR is acceptable.
 *
 * Deliberately conservative — it only fires when the asserted text positively looks like a
 * success message AND doesn't look like a failure message. Anything ambiguous (e.g.
 * saucedemo's "Epic sadface: Username and password do not match...") is allowed through.
 * The cost of a false positive here is a wasted retry; the cost of a false negative is
 * telling a user their working login is broken.
 */
export function assertionContradictsCase(
  ir: IR, testCase: TestCase
): { stepIds: string[]; message: string } | null {
  const isNegative =
    (testCase.category ? NEGATIVE_CATEGORIES.has(testCase.category) : false) ||
    NEGATIVE_CASE.test(testCase.title) ||
    NEGATIVE_CASE.test(testCase.expected);
  if (!isNegative) return null;

  // EVERY assert step, not just the terminal one. Checking only the last step missed a
  // real case: the model emitted `assert "Your username is valid." visible` at s5 and a
  // correct `assert "Your password is invalid!" visible` at s6. The terminal step looked
  // fine, the IR was accepted, and s5 still failed the run against a healthy site.
  const offending: string[] = [];
  let firstText = "";

  for (const step of ir.steps) {
    if (step.action !== "assert") continue;
    // "hidden" on a success element is a legitimate negative assertion, not a contradiction.
    if (step.assertion === "hidden") continue;

    // Two unvalidated surfaces: a pure-text target (exempt from groundingError by design)
    // and the comparison value of a text_*/url_contains assertion. A role+name target is
    // already grounded, but `url_contains "/dashboard"` on a failed login is the same bug.
    const candidates = [step.target?.text, step.value].filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0
    );
    for (const asserted of candidates) {
      if (FAILURE_SIGNAL.test(asserted)) continue;
      if (!SUCCESS_SIGNAL.test(asserted)) continue;
      offending.push(step.id);
      if (!firstText) firstText = asserted;
      break;
    }
  }

  if (!offending.length) return null;
  return {
    stepIds: offending,
    message:
      `Step(s) ${offending.join(", ")} assert a SUCCESS signal (e.g. "${firstText}"), but this ` +
      `test case ("${testCase.title}") expects the action to FAIL — its stated outcome is ` +
      `"${testCase.expected}". Asserting the success signal verifies the opposite of the test, ` +
      `and fails against a correctly-working site. Remove those assertions. Assert instead the ` +
      `error/validation message the app actually shows on failure, that the URL still contains ` +
      `the original page path, or that an element from the starting page is still visible.`,
  };
}

/**
 * Reject assertions that compare against nothing. `url_contains` with no path compiles to
 * `toHaveURL(new RegExp(""))` and `text_contains` with no text to `toContainText("")` —
 * both match anything, so the step reports a confident PASS while verifying nothing. A
 * false pass is the most expensive failure mode a test tool has, because unlike a false
 * failure nobody goes and looks at it.
 */
export function vacuousAssertion(ir: IR, appModel?: AppModel): { stepIds: string[]; message: string } | null {
  const NEEDS_VALUE = new Set(["url_contains", "text_contains", "text_equals"]);
  const offending = ir.steps.filter(s =>
    s.action === "assert" && s.assertion && NEEDS_VALUE.has(s.assertion) &&
    !(s.value ?? (s.assertion === "url_contains" ? s.target?.url : undefined) ?? "").trim()
  );

  // A non-empty value can still be worthless. `url_contains "/"` compiles to
  // `toHaveURL(new RegExp("/"))`, which matches every URL that has ever existed — that single
  // assertion is why a run that was parked on an unpassable OTP screen reported PASSED.
  const trivial = ir.steps.filter(s => {
    if (s.action !== "assert" || s.assertion !== "url_contains") return false;
    const v = (s.value ?? s.target?.url ?? "").trim();
    if (!v) return false;                       // already covered above
    if (v === "/" || v === "*") return true;
    try { return new URL(v).pathname.replace(/\/+$/, "") === ""; } catch { /* relative path */ }
    return false;
  });

  // Asserting the URL you explicitly navigated to, with nothing done in between.
  //
  // Deliberately narrow, and the narrowness is the whole point. Only a bare `navigate` makes
  // this worthless — you told the browser where to go, so arriving proves nothing. If ANY
  // action has happened since, the same assertion is meaningful and often the correct one:
  //  - `click "Log in" → assert url_contains "/login"` verifies the link actually navigated;
  //  - `fill → fill → click "Sign In" → assert url_contains "/login"` is exactly how you
  //    assert a login was REJECTED.
  // Both appear in real runs here, and an earlier version of this rule flagged both.
  const notMoved: typeof ir.steps = [];
  if (appModel) {
    const legs = legUrls(ir, appModel, appModel.baseUrl);
    const STATE_CHANGING = new Set(["click", "fill", "press", "select", "check"]);
    let arrivedByNavigate = false;
    let actedSinceArrival = false;
    for (let i = 0; i < ir.steps.length; i++) {
      const s = ir.steps[i];
      if (s.action === "navigate") { arrivedByNavigate = true; actedSinceArrival = false; continue; }
      if (STATE_CHANGING.has(s.action)) { actedSinceArrival = true; continue; }
      if (s.action !== "assert" || s.assertion !== "url_contains") continue;
      const v = (s.value ?? s.target?.url ?? "").trim();
      if (!v || !(legs[i] ?? "").includes(v)) continue;
      if (arrivedByNavigate && !actedSinceArrival) notMoved.push(s);
    }
  }

  const all = [...new Set([...offending, ...trivial, ...notMoved])];
  if (trivial.length || notMoved.length) {
    const ids = all.map(s => s.id);
    return {
      stepIds: ids,
      message:
        `Step(s) ${ids.join(", ")} assert a URL condition that is already true and cannot fail ` +
        `(e.g. url_contains "/" matches every page, or asserting the page you just navigated to ` +
        `with no action in between). Assert something that is FALSE before the action and TRUE ` +
        `only after it — a specific destination path, or an element that only appears once the ` +
        `action has succeeded.`,
    };
  }
  if (!offending.length) return null;
  return {
    stepIds: offending.map(s => s.id),
    message:
      `Step(s) ${offending.map(s => s.id).join(", ")} use a comparison assertion ` +
      `(url_contains / text_contains / text_equals) but supply no value to compare against, ` +
      `so they would match any page and verify nothing. Put the expected substring in the ` +
      `step's "value" field, or use a different assertion.`,
  };
}

/**
 * Reject a url_contains assertion whose value doesn't match the real destination of the
 * most recently clicked link (per trackPages, using the AppModel's own domLinks). Caught
 * in practice: a model clicks "Sign up" (real href "/register") then asserts
 * url_contains "/signup" — a hallucinated path groundingError never checks, since it only
 * validates role+name targets, not assertion values. Routed through the correction-only
 * retry path like vacuousAssertion below, not groundingError's live-extend path — a wrong
 * assertion string isn't something a browser replay can fix.
 */
export function urlAssertionError(ir: IR, appModel: AppModel): { index: number; message: string } | null {
  const trail = trackPages(ir, appModel);
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    if (step.action !== "assert" || step.assertion !== "url_contains") continue;
    const actualHref = trail.lastLinkHrefAt[index];
    if (!actualHref) continue; // no recently-resolved link click to check against — same
                                // "don't validate" behavior as before this existed
    const value = (step.value ?? step.target?.url ?? "").trim();
    if (!value) continue; // vacuousAssertion already handles the empty case
    let actualPath = actualHref;
    try { const u = new URL(actualHref); actualPath = u.pathname + u.search; } catch { /* keep raw */ }
    if (actualHref.includes(value) || actualPath.includes(value)) continue;
    return {
      index,
      message: `Step ${step.id} asserts url_contains "${value}", but the most recently clicked ` +
        `link actually navigates to "${actualPath}" per the application model's domLinks — ` +
        `"${value}" does not appear in that destination. Use the real destination path instead.`,
    };
  }
  return null;
}

/**
 * Check whether the surviving (after truncation) step list ends in a real assertion.
 * An assertion earlier in the sequence with non-assertion steps after it does not count
 * — only the final step's action discriminator determines whether the test actually
 * verified anything before the ungrounded tail was cut off.
 */
/**
 * Reject an IR that doesn't actually perform what its test case describes.
 *
 * Caught in practice, and the reason this exists: a case titled "Log in with valid credentials"
 * whose steps read "Click the 'Log in' link | Fill the login form with valid credentials |
 * Click the 'Submit' button" compiled to navigate → click the link → assert that link is
 * hidden. No fill, no submit. The final screenshot was an empty login form and the run reported
 * PASSED. Nothing anywhere checked that the IR covered the case.
 *
 * Pure string comparison against the case's own words — no LLM, no browser.
 */
export function missingActions(ir: IR, testCase: TestCase): { message: string } | null {
  const text = [testCase.title, ...(testCase.steps ?? []), testCase.expected ?? ""]
    .join(" ").toLowerCase();
  const has = (...actions: string[]) => ir.steps.some(s => actions.includes(s.action));
  const missing: string[] = [];

  if (/\b(fill|enter|type|input|provide|supply)\b|credential/.test(text) && !has("fill")) {
    missing.push(`the case describes entering values, but the IR has no "fill" step`);
  }
  if (/\b(submit|click|press|tap|sign in|log ?in|continue)\b/.test(text) && !has("click", "press")) {
    missing.push(`the case describes submitting or clicking, but the IR has no "click" or "press" step`);
  }
  if (!missing.length) return null;
  return {
    message:
      `This IR does not carry out the test case: ${missing.join("; ")}. Emit a step for EVERY ` +
      `action the case describes, in order, before the assertion. A test that skips the actions ` +
      `it was written to perform verifies nothing, even when it passes.`,
  };
}

/**
 * Reject "click X, then assert X is hidden" when the click wasn't a form submission.
 *
 * The pattern is legitimate — and this file's own prompt recommends it — for a SUBMIT button:
 * fill the form, press Sign In, and the button really is gone once login succeeds. It is
 * meaningless for a navigation control. Caught in practice: a case titled "Navigate to
 * registration page" compiled to `click button "Sign Up"` then `assert button "Sign Up" hidden`,
 * which asserts nothing about the app — only whether that particular click happened to navigate.
 *
 * The discriminator is whether anything was typed first. Compare two real IRs that differ in
 * nothing else: the login case had two fills before its click (legitimate, passed); the
 * navigation case had none (meaningless, failed).
 *
 * The threshold is ZERO fills, not "fewer than two" — a single-field flow (one fill, then a
 * "Continue" button) is a genuine submission and must stay legal.
 */
export function clickedElementHiddenAssertion(ir: IR): { stepIds: string[]; message: string } | null {
  for (let i = 1; i < ir.steps.length; i++) {
    const assertStep = ir.steps[i];
    if (assertStep.action !== "assert" || assertStep.assertion !== "hidden") continue;
    const clickStep = ir.steps[i - 1];
    if (clickStep.action !== "click") continue;

    const a = assertStep.target, c = clickStep.target;
    if (!a?.role || !c?.role) continue;
    if (norm(a.role) !== norm(c.role) || norm(a.name ?? "") !== norm(c.name ?? "")) continue;

    let fillsBefore = 0;
    for (let j = i - 2; j >= 0; j--) {
      if (ir.steps[j].action === "navigate") break;   // a new page starts a new form
      if (ir.steps[j].action === "fill") fillsBefore++;
    }
    if (fillsBefore > 0) continue;                     // a real submission — allowed

    return {
      stepIds: [assertStep.id],
      message:
        `Step ${assertStep.id} asserts that "${c.name}" is hidden immediately after clicking it, ` +
        `but nothing was filled in first, so this is a navigation click and not a form ` +
        `submission. Whether that control disappears is incidental and proves nothing. Assert ` +
        `something about the DESTINATION instead — a heading or unique element on the page the ` +
        `click leads to, or the URL changing to that page's specific path.`,
    };
  }
  return null;
}

export function hasTerminalAssertion(steps: Step[]): boolean {
  if (steps.length === 0) return false;
  return steps[steps.length - 1].action === "assert";
}

export async function toIR(
  testCase: TestCase, appModel: AppModel, sourcePrompt: string, entryUrl: string,
  budget?: GroqBudget,
  /** Credentials for this run — user-supplied ones take precedence over the built-in demo
   *  map. Undefined falls back to credentialsFor(entryUrl), i.e. today's behaviour. */
  runCreds?: Credentials
): Promise<IRResult> {
  // Compute these ourselves rather than trust the model: baseUrl must be the origin
  // (generator.ts appends relative step paths to it), and entryPath is where the
  // actual page under test lives — telling the model both up front heads off the
  // double-path bug ("https://host/login" + "/login" -> 404) at the source.
  const { origin, pathname, search } = new URL(entryUrl);
  const entryPath = pathname + search || "/";

  // Credentials are decided BEFORE the cache lookup because they belong in the key. The cached
  // IR is stored post-substitution (see finalize below) and a cache hit returns immediately
  // without running finalize — so a key that ignored credentials meant an IR generated once
  // without them was replayed forever, silently discarding whatever the user supplied. The
  // disk half of that cache never expires, so it would not have healed on its own.
  const credPolicy = credentialPolicyFor(testCase, promptCarriesCredentials(sourcePrompt));
  const creds = credPolicy === "none" ? undefined : (runCreds ?? credentialsFor(entryUrl));
  // Never the secret itself: a secret run substitutes an env REFERENCE, so every such run
  // produces a byte-identical IR and this marker fully discriminates. Demo accounts are
  // published by the sites themselves, so keying on that username leaks nothing.
  const credKey = creds ? `${credPolicy}:${creds.secret ? "env" : creds.username}` : "no-creds";
  const cacheKey = makeCacheKey(
    JSON.stringify(testCase), sourcePrompt, JSON.stringify(appModel), credKey);
  const cached = llmCacheGet<IR>(cacheKey);
  if (cached) return { ir: cached, updatedAppModel: appModel };

  const system =
    `Convert ONE human-readable test case into a strict JSON test model (IR).
Address elements only by accessibility role + name taken from the application model.
Allowed actions: navigate, click, fill, select, check, press, wait, assert.
Allowed assertions: visible, hidden, text_equals, text_contains, url_contains, enabled, disabled.

Rules, follow exactly:
- CARRY OUT THE WHOLE CASE. Every action the test case describes — each field it says to fill, each button it says to click — must appear as a step, in order, before the assertion. An IR that skips the fill steps and jumps to an assertion verifies nothing even when it passes, and will be rejected.
- "id" is always a string like "s1", "s2", never a number.
- "assertion" is a single string from the allowed list above — NEVER an object. Omit "assertion" entirely on steps whose action is not "assert".
- Omit "target" entirely for steps that don't need one (e.g. a "wait" step); never set it to an empty string.
- For an "assert" step needing a comparison value (text_equals, text_contains, url_contains), put that value in the step's "value" field, not inside "assertion".
- Never invent CSS selectors. The only exception is a selector explicitly listed as verified in the user's request section below — those may be used as "target.css" exactly as given.
- "meta.baseUrl" must be exactly the origin, with no path: ${origin}
- A "navigate" step's target.url is a path RELATIVE to that origin (it gets concatenated onto baseUrl) — for the page under test here, that path is exactly "${entryPath}". Do not repeat the origin inside it.
- "role" must be a real ARIA role (button, textbox, link, heading, checkbox, ...) for an element actually present in the application model. For asserting on plain visible text that ISN'T in the application model — e.g. an error/flash message that only appears after an action, so discovery never saw it — use target: { "text": "..." } instead. Never invent a role like "text" or "message".
- A success assertion must be FALSE before the action and TRUE only after it — otherwise it verifies nothing. Never assert on a persistent, site-wide element (a header, logo, or nav bar that appears on every page regardless of state) as proof an action succeeded; it was already visible before the action too. In the application model, a decorative/structural element like this typically has no "concept" (empty or absent) — treat that as a signal to avoid it as a success assertion.
- The application model only covers the page you start on, so you usually can't see the page an action like login navigates to. When you can't ground a success assertion on the destination page, assert instead that the FORM'S OWN SUBMIT BUTTON goes "hidden" after you submit it — e.g. the "Sign In" button once login succeeds. That element is already in the model, and is a real discriminator: visible before, gone after.
- This applies ONLY to a submit button after an actual submission. Do NOT assert that a navigation link goes hidden after clicking it, and never use it as a substitute for performing the test: "click the Log in link, then assert the Log in link is hidden" carries out none of the case and verifies nothing.

Negative-path rules (CRITICAL — read the test case's own "expected" field first):
- Some test cases exist to prove an action FAILS: invalid password, empty required field, malformed email, SQL injection, unauthorized access. For these, the PASS condition is that the app REJECTED the input.
- For such a case, NEVER assert that a success message, welcome text, dashboard, or post-login page is visible. That asserts the opposite of the test, and it fails against a perfectly working site.
- Instead assert one of: the error/validation message the app shows on failure (target: { "text": "..." }), that the URL still contains the original page path, or that an element unique to the STARTING page (e.g. the login form's submit button) is still visible.
- If you don't know the exact wording of the app's error message, prefer the URL or starting-page-element assertion over guessing the error text. Never guess the SUCCESS text.

Navigation & Assertion rules (CRITICAL):
- NEVER assert that the clicked link/button itself is "visible" after clicking it — that is redundant and proves nothing. The element was already visible (that's why you could click it).
- After clicking a NAVIGATION link (role="link"), assert a heading or unique text on the DESTINATION page. Use "url_contains" only with a SPECIFIC path that the click actually leads to. Do NOT re-assert the link you just clicked.
- An assertion must be able to FAIL. Never assert url_contains "/" (it matches every page), and never assert the path you just navigated to when nothing has happened since — both pass no matter what the app does. Asserting you are STILL on a page after submitting a form is fine: that is a real result.
- Each navigation path should be INDEPENDENT: if testing "Home -> About -> Academics", each branch should start with its own "navigate" step from the base URL, not chain clicks sequentially. Example: for testing About, start with navigate to "/" then click About. For testing Academics, start with a separate navigate to "/" then click Academics. This prevents cascading failures.
- When a click triggers a page navigation, the assertion should verify the DESTINATION state (URL or heading), not the source element.

Selector Specificity rules (CRITICAL for avoiding strict mode violations):
- If multiple elements share the same role+name (e.g., multiple "Student" links), use the "nth" field to disambiguate: { "role": "link", "name": "Student", "nth": 1 } for the second occurrence (0-indexed).
- When duplicate names exist in the application model, prefer the MOST SPECIFIC one:
  * For navigation links in header: use nth: 0 (first occurrence in header)
  * For sidebar/footer links: use nth: 1 or higher
  * Check the application model's element positions to determine which occurrence to target
- Skip elements that are likely problematic:
  * Links with href="#" or href="javascript:void(0)" — these are non-functional
  * Links that redirect to homepage when a specific page is expected
- For URL assertions: use partial matching (url_contains) instead of exact matching when the destination URL may vary or include query parameters
- For dropdown menus: the parent menu item must be clicked/hovered first to reveal hidden child items. Add a "preAction" field: { "preAction": { "action": "click", "target": { "role": "link", "name": "Academics" } } }

Hidden Element Handling rules:
- Elements in collapsed dropdowns or tabs are not visible until their parent is activated
- When targeting a dropdown item, include the preAction to expand the parent first
- Use "wait" steps with value: 500 after hover/click actions to allow animations to complete
- For tabs: click the tab first, then wait for content to load

Return ONLY the JSON object, no prose, no markdown fences.

Example — multi-link navigation test with independent paths:
{
  "meta": { "feature": "Navigation", "title": "Navigation links work", "priority": "high", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/" } },
    { "id": "s2", "action": "click", "target": { "role": "link", "name": "About" } },
    { "id": "s3", "action": "assert", "target": { "url": "/about" }, "assertion": "url_contains" }
  ]
}

Example — login with post-action assertion:
{
  "meta": { "feature": "Login", "title": "...", "priority": "high", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/login" } },
    { "id": "s2", "action": "fill", "target": { "role": "textbox", "name": "Username" }, "value": "tomsmith" },
    { "id": "s3", "action": "fill", "target": { "role": "textbox", "name": "Password" }, "value": "SuperSecretPassword!" },
    { "id": "s4", "action": "click", "target": { "role": "button", "name": "Login" } },
    { "id": "s5", "action": "assert", "target": { "role": "button", "name": "Login" }, "assertion": "hidden" }
  ]
}

Example — dropdown menu with preAction:
{
  "meta": { "feature": "Navigation", "title": "Dropdown menu works", "priority": "medium", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/" } },
    { "id": "s2", "action": "click", "target": { "role": "link", "name": "Academics" }, "preAction": { "action": "hover", "target": { "role": "link", "name": "Academics" } } },
    { "id": "s3", "action": "click", "target": { "role": "link", "name": "Programmes" } },
    { "id": "s4", "action": "assert", "target": { "url": "/programmes" }, "assertion": "url_contains" }
  ]
}

Example — handling duplicate selectors with nth:
{
  "meta": { "feature": "Navigation", "title": "Student link works", "priority": "high", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/" } },
    { "id": "s2", "action": "click", "target": { "role": "link", "name": "Student", "nth": 1 } },
    { "id": "s3", "action": "assert", "target": { "url": "/student" }, "assertion": "url_contains" }
  ]
}`;

  const buildUser = (model: AppModel, correction?: string) => {
    // Only send pages relevant to this test case: the entry page + pages whose
    // concepts or URL overlap with the test feature. Never send the full model.
    const entryOrigin = new URL(entryUrl).origin;
    const featureLower = testCase.feature.toLowerCase();
    const relevantPages = model.pages.filter(p => {
      // Always include the entry page
      if (p.url.startsWith(entryOrigin) && entryPath && p.url.includes(entryPath)) return true;
      // Include pages whose concepts match the test feature
      if (p.concepts.some(c => c.toLowerCase().includes(featureLower))) return true;
      // Include pages whose URL path contains the feature name
      if (p.url.toLowerCase().includes(featureLower)) return true;
      return false;
    });
    // Fallback: if filtering yielded nothing, use the entry page only
    const pagesToSend = relevantPages.length > 0 ? relevantPages : model.pages.slice(0, 1);

    // Filter elements: only named interactive elements (links, buttons, menuitems,
    // textboxes, checkboxes, headings). Drops thousands of anonymous list/div/container
    // nodes that bloat the prompt without helping the LLM generate better IR.
    const INTERACTIVE_ROLES = new Set([
      "link", "button", "menuitem", "textbox", "checkbox", "radio",
      "combobox", "listbox", "option", "tab", "switch", "heading",
      "searchbox", "spinbutton", "slider",
    ]);
    const filteredPages = pagesToSend.map(p => ({
      ...p,
      elements: p.elements.filter(e =>
        e.name && e.name.trim() && INTERACTIVE_ROLES.has(e.role?.toLowerCase() ?? "")
      ),
    }));

    const liteFiltered = toLiteModel({ ...model, pages: filteredPages });
    const modelJson = JSON.stringify(liteFiltered);

    // Retries previously re-sent a byte-identical prompt and predictably got a
    // byte-identical answer back. Feeding the rejection reason in is what makes the
    // grounding and assertion guards actually able to converge.
    const correctionBlock = correction
      ? `\nYour previous attempt was REJECTED. Fix exactly this and return corrected IR:\n${correction}\n`
      : "";

    // Selectors the user wrote in their own request, filtered to the ones discovery has
    // actually seen. Verified against the CURRENT model, so a selector on a page reached
    // only after live-extend becomes usable once that page is modeled.
    const { usable, unknown } = verifyAgainstModel(extractPromptSelectors(sourcePrompt), model);
    if (unknown.length) {
      console.warn(
        "[ir] ignoring selector(s) from the request — not found in the discovered model:",
        unknown.map(u => u.css).join(", ")
      );
    }

    const prompt = `Application model: ${modelJson}
Test case: ${JSON.stringify(testCase)}
baseUrl (origin only): ${origin}
entry path (where the page under test lives): ${entryPath}
sourcePrompt: ${sourcePrompt}${promptSelectorHint(usable)}${correctionBlock}
Return IR JSON: { "meta": {feature,title,priority,sourcePrompt,baseUrl}, "steps":[{id,action,target,value,assertion}] }`;

    console.log("[ir] prompt chars:", prompt.length, "| approx tokens:", Math.round(prompt.length / 4), "| pages sent:", filteredPages.length, "/", model.pages.length);

    // Hard cap: if still over 30K chars, truncate the model JSON
    const MAX_CHARS = 30_000;
    if (prompt.length > MAX_CHARS) {
      console.warn("[ir] prompt exceeds", MAX_CHARS, "chars, truncating model JSON");
      const truncated = prompt.slice(0, MAX_CHARS) + `\n... (truncated from ${prompt.length} chars)`;
      return truncated;
    }
    return prompt;
  };

  // baseUrl is a fact we already know; and real credentials for known hosts are injected
  // into login fill steps so the generated test actually authenticates instead of using
  // the placeholder values the model invents. Skipped for a fromPrompt case: those steps
  // carry the user's own literal values on purpose (their real email/password, or a
  // taxonomy-style deliberately-wrong one) — silently swapping in the demo account would
  // just relocate the "system overrides what I asked for" bug to a different field.
  const finalize = (ir: IR): IR => {
    ir.meta.baseUrl = origin;
    ir.meta.hasTerminalAssertion = hasTerminalAssertion(ir.steps);
    if (creds) {
      applyCredentials(ir.steps, creds, credPolicy, legUrls(ir, currentModel, entryUrl),
        credentialFieldMap(currentModel));
    }
    llmCacheSet(cacheKey, ir);
    return ir;
  };

  let currentModel = appModel;
  let extensions = 0;
  // Each extension is one browser launch, so this is a real cost bound — but 2 was too
  // tight for ordinary shopping flows. "log in -> open a product -> add to cart -> open the
  // cart -> checkout" needs four hops, and at 2 the run truncated with
  // `Step s8 targets role="button" name="Checkout", which is not present in the application
  // model`. replayAndSnapshot() caches by step prefix, so re-reaching an already-seen state
  // is cheap; only genuinely new pages cost a launch.
  const MAX_EXTENSIONS = Number(process.env.MAX_LIVE_EXTENSIONS ?? 5);
  // Bound total groq calls so a broken app/prompt still fails fast. Was a hardcoded 8;
  // stacked with backoff.ts's per-call retries that made a single case's worst case 48
  // real Groq requests. Now env-overridable like MAX_LIVE_EXTENSIONS above.
  const MAX_ATTEMPTS = Number(process.env.MAX_IR_ATTEMPTS ?? 4);
  let lastErr = "";
  // Feedback for the NEXT attempt's prompt. Separate from lastErr, which also carries
  // live-extend failures that the model can't act on.
  let correction: string | undefined;
  let lastContradiction: { ir: IR; stepIds: string[]; message: string } | undefined;
  /** Longest grounded prefix seen across all attempts — the fallback that keeps a run alive
   *  when the attempt budget is spent extending the model rather than converging. */
  let bestPartial: { ir: IR; steps: Step[]; note: string } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (budget && !budget.hasBudget) {
      lastErr = `Groq per-run budget exhausted (${budget.snapshot().calls} calls)`;
      console.warn("[ir]", lastErr, "— stopping retries early");
      break;
    }
    console.log("[ir] attempt", attempt + 1, "/", MAX_ATTEMPTS);
    let parsed;
    try {
      const { content, usage } = await groq(buildUser(currentModel, correction), { system, json: true });
      budget?.record(usage);
      console.log("[ir] groq returned, length:", content.length);
      parsed = IR.safeParse(normalizeIR(parseJson(content)));
      console.log("[ir] parsed:", parsed.success ? "valid" : "INVALID");
    } catch (err: any) {
      budget?.record();
      lastErr = err?.message ?? String(err);
      console.error("[ir] groq/parse error:", lastErr);
      continue;
    }
    if (!parsed.success) {
      lastErr = parsed.error.message;
      correction = `The JSON did not match the required schema: ${lastErr}`;
      continue;
    }

    parsed.data.meta.baseUrl = origin;
    const ungrounded = groundingError(parsed.data, currentModel);
    if (!ungrounded) {
      const vacuous = vacuousAssertion(parsed.data, currentModel);
      if (vacuous) {
        console.log("[ir] vacuous assertion rejected:", vacuous.message);
        lastErr = vacuous.message;
        correction = vacuous.message;
        lastContradiction = { ir: parsed.data, ...vacuous };
        continue;
      }

      const urlMismatch = urlAssertionError(parsed.data, currentModel);
      if (urlMismatch) {
        console.log("[ir] hallucinated url_contains rejected:", urlMismatch.message);
        lastErr = urlMismatch.message;
        correction = urlMismatch.message;
        lastContradiction = {
          ir: parsed.data, stepIds: [parsed.data.steps[urlMismatch.index].id], message: urlMismatch.message,
        };
        continue;
      }

      const clickedHidden = clickedElementHiddenAssertion(parsed.data);
      if (clickedHidden) {
        console.log("[ir] assert-hidden on a merely-clicked element rejected:", clickedHidden.message);
        lastErr = clickedHidden.message;
        correction = clickedHidden.message;
        lastContradiction = { ir: parsed.data, ...clickedHidden };
        continue;
      }

      const incomplete = missingActions(parsed.data, testCase);
      if (incomplete) {
        console.log("[ir] IR does not carry out the case:", incomplete.message);
        lastErr = incomplete.message;
        correction = incomplete.message;
        continue;
      }

      // A pure-text terminal assertion (the one kind groundingError can't check — no
      // role/name to match against the discovered model) is otherwise just an unvalidated
      // LLM guess. Replay the prefix, read the real page, and correct the guess when it's
      // wrong instead of only pattern-matching for the specific "asserted the success
      // banner on a failing case" shape assertionContradictsCase below catches. Best-effort:
      // on replay failure this returns the IR unchanged and the existing guards still apply.
      if (isPureTextAssertion(parsed.data.steps[parsed.data.steps.length - 1])) {
        const { ir: reground } = await groundTerminalTextAssertion(parsed.data, currentModel, creds, credPolicy);
        // Only take the correction if it doesn't turn a negative case into a success
        // assertion. groundTerminalTextAssertion picks the message-shaped page line closest
        // in length to the guess — on a negative case whose replay actually succeeded, that
        // can be the success banner, which would be a false PASS. The guard below would
        // reject it anyway, but only at the cost of a whole attempt out of MAX_ATTEMPTS.
        // Keeping the model's guess instead lets the test fail honestly at execution.
        if (!assertionContradictsCase(reground, testCase)) parsed.data = reground;
      }

      const contradiction = assertionContradictsCase(parsed.data, testCase);
      if (contradiction) {
        console.log("[ir] inverted assertion rejected:", contradiction.message);
        lastErr = contradiction.message;
        correction = contradiction.message;
        lastContradiction = { ir: parsed.data, ...contradiction };
        continue;
      }
      console.log("[ir] all steps grounded, returning");
      return { ir: finalize(parsed.data), updatedAppModel: currentModel };
    }

    lastErr = ungrounded.message;
    correction = ungrounded.message;
    console.log("[ir] ungrounded step", ungrounded.index, ":", ungrounded.message);
    const prefix = parsed.data.steps.slice(0, ungrounded.index);

    // Remember the best partial test seen so far. The graceful "ship the grounded prefix"
    // return below is only reached when extension STOPS — so when every attempt ends in a
    // successful extend-and-retry, the loop simply runs out of attempts and falls through to
    // the hard throw at the end, killing the whole run. That is reachable with the shipped
    // defaults (MAX_IR_ATTEMPTS=4 < MAX_LIVE_EXTENSIONS=5) and it happened: an 11-step
    // signup+login+logout case died with "Step s10 targets ... Email Address" and produced
    // no test at all, when 9 grounded steps were available to run.
    if (prefix.length && prefix.length > (bestPartial?.steps.length ?? 0)) {
      bestPartial = { ir: parsed.data, steps: prefix, note: ungrounded.message };
    }

    if (extensions < MAX_EXTENSIONS && prefix.length) {
      try {
        const before = currentModel.pages.length;
        console.log("[ir] calling extendAppModel...");
        currentModel = await extendAppModel(currentModel, prefix, creds, credPolicy);
        console.log("[ir] extendAppModel returned,", currentModel.pages.length, "pages");
        extensions++;
        console.log(`[ir] live-extend: replayed ${prefix.length} step(s) past "${ungrounded.message.split(",")[0]}" — app model ${before} -> ${currentModel.pages.length} pages (${currentModel.pages.at(-1)?.url})`);
        continue;
      } catch (err: any) {
        if (err?.message?.includes("already in the model") && prefix.length > 0) {
          try {
            const before = currentModel.pages.length;
            console.log("[ir] calling refreshPageModel...");
            currentModel = await refreshPageModel(currentModel, prefix, creds, credPolicy);
            console.log("[ir] refreshPageModel returned,", currentModel.pages.length, "pages");
            extensions++;
            console.log(`[ir] refresh-page: refreshed page model at step ${prefix.length} — app model ${before} -> ${currentModel.pages.length} pages`);
            continue;
          } catch (refreshErr: any) {
            lastErr = `could not refresh state for step ${parsed.data.steps[ungrounded.index]?.id}: ${refreshErr?.message ?? refreshErr}`;
          }
        } else {
          lastErr = `could not reach the state needed for step ${parsed.data.steps[ungrounded.index]?.id}: ${err?.message ?? err}`;
        }
      }
    }

    // Can't extend further. Degrade to a real-but-partial test on the grounded prefix
    // instead of failing the whole run — verifying "reached the product page" beats
    // nothing. Only a fully ungrounded IR (empty prefix) falls through to a hard error.
    if (prefix.length) {
      const truncated: IR = { ...parsed.data, steps: prefix };
      truncated.meta = {
        ...parsed.data.meta, truncated: true, truncationNote: lastErr,
        hasTerminalAssertion: hasTerminalAssertion(prefix),
      };
      return { ir: finalize(truncated), updatedAppModel: currentModel };
    }
  }

  // Every attempt produced an inverted assertion. Shipping it would run a real test and
  // report the site broken when it isn't — the exact false negative this guard exists to
  // stop. Drop the bad terminal assertion instead and route it through the machinery that
  // already exists for "we ran something, but didn't verify what you asked": the run
  // reports `truncated_no_assertion` rather than a confident wrong answer.
  if (lastContradiction) {
    // Drop exactly the offending assert steps. Assertions only observe state, they never
    // advance it (see liveExtend's runStepLive, which skips them during replay), so
    // removing one from the middle leaves the rest of the flow intact.
    const drop = new Set(lastContradiction.stepIds);
    const steps = lastContradiction.ir.steps.filter(s => !drop.has(s.id));
    if (steps.length) {
      const stillAsserts = steps.some(s => s.action === "assert");
      console.warn(
        `[ir] all attempts asserted a success signal on a negative case — dropped step(s) ` +
        `${lastContradiction.stepIds.join(", ")}${stillAsserts ? "" : "; nothing left to verify"}`
      );
      const stripped: IR = {
        ...lastContradiction.ir,
        steps,
        meta: {
          ...lastContradiction.ir.meta,
          // If a correct assertion survives, this is still a real, complete negative test —
          // don't understate it. Only flag partial when nothing is left to verify.
          ...(stillAsserts ? {} : {
            truncated: true,
            truncationNote:
              `Could not produce a correct success criterion for this negative test case. ` +
              lastContradiction.message,
          }),
          hasTerminalAssertion: hasTerminalAssertion(steps),
        },
      };
      return { ir: finalize(stripped), updatedAppModel: currentModel };
    }
  }
  // Attempts exhausted without ever reaching the in-loop truncation path (every attempt ended
  // in a live extension, so the loop kept going until it ran out). Ship the longest grounded
  // prefix instead of failing the entire run — a partial test that really exercised 9 steps is
  // worth far more than a pipeline error, and it is reported honestly as truncated.
  if (bestPartial) {
    console.warn(
      `[ir] attempts exhausted while still extending — shipping the grounded prefix ` +
      `(${bestPartial.steps.length} of ${bestPartial.ir.steps.length} steps)`
    );
    const truncated: IR = {
      ...bestPartial.ir,
      steps: bestPartial.steps,
      meta: {
        ...bestPartial.ir.meta,
        truncated: true,
        truncationNote: bestPartial.note,
        hasTerminalAssertion: hasTerminalAssertion(bestPartial.steps),
      },
    };
    return { ir: finalize(truncated), updatedAppModel: currentModel };
  }

  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

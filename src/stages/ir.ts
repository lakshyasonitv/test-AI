import { gemini } from "../llm/gemini.js";
import { LlmBudget } from "../llm/llmBudget.js";
import { parseJson } from "../llm/json.js";
import { isRateLimitError } from "../llm/backoff.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import { AppModel, PageModel, DomForm, Element, type AuthOutcome, toLiteModel, toMicroModel, INTERACTIVE_ROLES } from "../schema/appModel.js";
import { cutAtBoundary } from "../text.js";
import { extendAppModel, refreshPageModel, groundTerminalTextAssertion, isPureTextAssertion } from "./liveExtend.js";
import {
  applyCredentials, credentialPolicyFor, promptCarriesCredentials,
  credentialFieldMap, credentialKindForTarget, credentialFieldsNeeded, envValueRef,
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
  "text_contains", "text_equals", "url_contains", "title_contains", "title_equals",
  "visible", "hidden", "enabled", "disabled",
] as const;

/** Assertions that check the PAGE, not an element — they take no target, and grounding must
 *  not try to resolve one for them (url_contains has always been in this class; the title
 *  pair joins it). See TECH_DEBT.md TD-06. */
const PAGE_LEVEL_ASSERTIONS = new Set(["url_contains", "title_contains", "title_equals"]);

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
 * The model reliably gets the IR's shape *close* but not exact: numeric ids,
 * empty-string targets instead of omitted ones, and — worst — an assertion
 * object like { text_contains: "...", visible: "" } instead of the single
 * enum string our schema (and the generator) require. Fold those into the
 * expected shape before validating; only the truly malformed still fails.
 *
 * Originally written against Groq/Llama's specific output quirks (IR generation moved to
 * Gemini — see DECISIONS.md D-21). Left in place rather than assumed unnecessary: it's a
 * defensive, idempotent correction that costs nothing when the shape is already right, whether
 * or not Gemini turns out to need the same corrections.
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

    // Same shape for the title pair: they're page-level and take no target, but a model that
    // has spent the whole IR attaching a target to every assert routinely attaches one here
    // too (usually { text: "<the title>" }). Fold that into `value` and drop the target, so a
    // title assertion the model *meant* correctly doesn't get rejected as vacuous — and, more
    // importantly, so it never silently compiles as if it were a body-text assertion, which is
    // the exact bug title_contains exists to eliminate. See TECH_DEBT.md TD-06.
    if (step.action === "assert" && PAGE_LEVEL_ASSERTIONS.has(step.assertion as string)
      && step.assertion !== "url_contains") {
      if (!step.value && typeof step.target?.text === "string" && step.target.text) {
        step.value = step.target.text;
      }
      delete step.target;
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

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

function findPageByUrl(appModel: AppModel, absoluteUrl: string): PageModel | null {
  const key = pageKey(absoluteUrl);
  return appModel.pages.find(p => pageKey(p.url) === key) ?? null;
}

/**
 * Every destination the application model can actually vouch for: each discovered page, plus
 * the resolved href of every discovered link. A navigate step to anything outside this set is
 * a route the model GUESSED rather than observed — see the navigate check in groundingError.
 */
function knownNavigationTargets(appModel: AppModel): Set<string> {
  const out = new Set<string>();
  const add = (u: string | null | undefined) => { if (u) out.add(pageKey(u)); };
  add(appModel.baseUrl);
  for (const page of appModel.pages) {
    add(page.url);
    for (const link of page.domLinks ?? []) {
      const href = link.href?.trim();
      if (!href || NON_NAVIGATING_HREF.test(href)) continue;
      add(resolveHref(page.url, href));
    }
  }
  return out;
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
 *
 * "Can't be confidently resolved" includes going STALE, which it previously didn't: a click
 * this function can't follow (a form submit, an SPA router button) may have moved the flow
 * anywhere, so from that point the cursor reports null until something re-resolves it. Leaving
 * it parked on the last known page instead is what truncated the learnvibes admin flow — every
 * step after "Sign In" was grounded against /login, so the dashboard's own sidebar button was
 * "not present in the application model" while sitting in the model.
 */
export function trackPages(ir: IR, appModel: AppModel): PageTrail {
  const pageAt: (PageModel | null)[] = [];
  const lastLinkHrefAt: (string | null)[] = [];
  let currentPage: PageModel | null = null;
  let lastLinkHref: string | null = null;
  // The cursor is only worth reporting while it still describes where the flow actually is.
  // A click that can navigate but whose destination we can't resolve (a form submit, an SPA
  // router button) leaves it describing the PREVIOUS page — stale, not unknown — and reporting
  // that as fact is a false negative, not conservatism. `currentPage` itself keeps updating
  // regardless, because the link-resolution branch below reads it.
  let stale = false;

  for (let i = 0; i < ir.steps.length; i++) {
    pageAt[i] = stale ? null : currentPage;
    lastLinkHrefAt[i] = lastLinkHref;

    const step = ir.steps[i];
    const t = step.target;
    lastLinkHref = null; // only survives to the very next step; re-set below if this one earns it

    if (step.action === "navigate" && t?.url) {
      const resolved = resolveHref(appModel.baseUrl, t.url);
      if (resolved) { currentPage = findPageByUrl(appModel, resolved); stale = false; }
    } else if (step.action === "click" || step.action === "press") {
      const link = currentPage && t?.role && norm(t.role) === "link" && t?.name
        ? findDomLink(currentPage, t.name) : null;
      const href = link?.href?.trim();
      if (href && NON_NAVIGATING_HREF.test(href)) {
        // Provably goes nowhere (an in-page anchor, a JS handler) — the cursor still holds.
      } else if (currentPage && href) {
        const resolved = resolveHref(currentPage.url, href);
        if (resolved) {
          lastLinkHref = resolved;
          currentPage = findPageByUrl(appModel, resolved) ?? currentPage;
          stale = false;
        }
      } else {
        // ponytail: anything else clickable might have navigated. Say "unknown" rather than
        // keep asserting the old page — callers already fall back to the whole model on null.
        stale = true;
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
 *
 * `kind` marks errors that live-extension can never resolve, so toIR doesn't spend its
 * extension budget replaying a prefix that cannot possibly teach the model anything new.
 */
/** Steps that DO something to an element, as opposed to asserting about one. */
const ACTION_STEPS = new Set(["click", "fill", "select", "check", "press"]);
/** Of those, the ones that can only ever act on a form control. */
const FIELD_ACTIONS = new Set(["fill", "select", "check"]);
/** The roles a fill/select/check can legitimately land on. Kept separate from the clickable
 *  group inside groundingError so a `fill` can never be grounded onto a link, and a `click`
 *  never onto a textbox. Module-scope because toIR's post-click reveal check needs it too, to
 *  decide whether a re-snapshot actually revealed anything FILLABLE. */
const FIELD_ROLE_GROUP = new Set(["textbox", "combobox", "searchbox", "checkbox", "radio", "spinbutton"]);

/**
 * The login steps discovery performed, as IR steps to run before the case's own.
 *
 * Why this exists: once discovery signs in, the AppModel holds the authenticated app, so the
 * model writes a case that starts at `/dashboard` and never logs in. The generated spec then runs
 * in a **fresh browser with no session**, `/dashboard` bounces to `/login`, and every later step
 * fails — reported as `element_missing`, which is why it took three sessions to find. Verified in
 * run 2026-08-22T07-04-23-933Z-04c5704b: IR was `navigate /dashboard` + `click "Admin"`, and
 * `final-page.txt` was the login screen.
 *
 * It goes in the IR rather than into generator.ts and liveExtend.ts separately because BOTH of
 * them read the IR — one definition, so there is no third copy to drift (TD-07 records exactly
 * that drift between generator and targetResolver). Placing it before grounding is also what
 * un-truncates the IR: liveExtend's replay runs the prefix and is therefore authenticated when it
 * snapshots the page the rest of the case needs.
 *
 * Selectors come from `auth.loginSteps`, captured live by `loginOnPage` — never re-derived from
 * the model, whose `forms[]` is empty on a form-less SPA login (the original defect).
 */
export function buildLoginPrefix(auth: AuthOutcome | undefined): Step[] {
  if (auth?.status !== "authenticated" || !auth.loginUrl || !auth.loginSteps?.length) return [];
  const steps: Step[] = [
    { id: "auth-0", action: "navigate", target: { url: auth.loginUrl } },
  ];
  auth.loginSteps.forEach((s, i) => {
    steps.push({
      id: `auth-${i + 1}`,
      action: s.action,
      target: { css: s.css },
      // Never the literal: runs/ is served publicly (TD-14), so the spec reads process.env at
      // run time and executor.ts injects the real value into the child process.
      ...(s.credential ? { value: envValueRef(s.credential) } : {}),
      ...(s.action === "press" ? { value: s.key ?? "Enter" } : {}),
    });
  });

  // WAIT for the login to land before the case's own steps run.
  //
  // Without this the prefix submits and immediately navigates on, racing the auth request.
  // Caught exactly that way: in run 2026-08-22T16-10-40-756Z-04cfa936 the credentials were
  // filled correctly (step-3.png) and step-4.png shows the "Sign In" button STILL SPINNING,
  // while the next step had already navigated to /dashboard — which bounced straight back to
  // /login. Discovery never had this bug because loginOnPage calls waitForAuthSettle(); the
  // generated spec had no equivalent, and that is the half that was missing when the login
  // moved into the IR.
  //
  // An assertion rather than a `wait`, deliberately: Playwright's toBeHidden() auto-waits, so
  // it costs nothing on a fast login and still covers a slow one, where any fixed sleep is
  // either too short or a tax on every run. It also turns a failed login into a loud failure
  // at the step that caused it, instead of a confusing error three steps later.
  //
  // ponytail: the password box vanishing is the signal. Ceiling — generator.ts emits a fixed
  // 10s timeout for assertions; a login slower than that (a cold serverless start) fails here
  // rather than hanging, which is the better of the two.
  const pw = auth.loginSteps.find((s) => s.credential === "password");
  if (pw) {
    steps.push({
      id: `auth-${auth.loginSteps.length + 1}`,
      action: "assert",
      target: { css: pw.css },
      assertion: "hidden",
    });
  }
  return steps;
}

/**
 * Should this case be signed in before its own steps run?
 *
 * Yes for everything except cases that are ABOUT the login page — the whole app is behind the
 * gate, so needing a session is the norm, not the exception.
 *
 * The gate this replaced asked `credentialPolicyFor(...) === "full"`, which was the wrong
 * question. That function ends `return category === "valid" ? "full" : "none"` and answers
 * "should this case's own field values be replaced with real credentials?" — about the case's
 * CONTENT. Whether a test needs a session first is about its PRECONDITION. Using one for the
 * other meant only `valid`/`fromPrompt` cases were ever signed in: in run
 * 2026-08-22T16-10-40-756Z-04cfa936 an `invalid-input` search case and a `state-change` sign-out
 * case both ran logged out and both failed on the login page.
 *
 * `targetUrl` vs the known gate URL is structural — the same comparison testCases.ts uses to cap
 * login cases — not a regex over the case title (CLAUDE.md's TD-01 rule).
 */
export function needsLoginPrefix(testCase: TestCase, auth: AuthOutcome | undefined): boolean {
  if (auth?.status !== "authenticated" || !auth.loginUrl) return false;
  // No targetUrl means no reason to think it is a login case — and defaulting to "sign in" is
  // the safer error, since a spurious login costs a few seconds while a missing one fails.
  return pageKey(testCase.targetUrl ?? "") !== pageKey(auth.loginUrl);
}

/** True if the IR already signs in on its own, so the prefix would log in twice. The login page
 *  is back in the AppModel, so the model can and does write these steps itself for login cases. */
export function irAlreadyLogsIn(ir: IR, auth: AuthOutcome | undefined, model: AppModel): boolean {
  const pwCss = auth?.loginSteps?.find((s) => s.credential === "password")?.css?.toLowerCase();
  const fieldMap = credentialFieldMap(model);
  return ir.steps.some((s) =>
    s.action === "fill"
    && ((pwCss && s.target?.css?.toLowerCase() === pwCss)
      || credentialKindForTarget(s.target, fieldMap) === "password"));
}

export function groundingError(
  ir: IR, appModel: AppModel,
): { index: number; message: string; kind?: "navigate-url" | "text-target" } | null {
  const allElements = appModel.pages.flatMap(p => p.elements);
  // Selectors the model is allowed to address directly, because discovery captured them.
  const knownSelectors = new Set<string>();
  // Selector -> the element it names, so a direct-css target can be visibility-checked too,
  // not just membership-checked against knownSelectors above.
  const bySelector = new Map<string, Element>();
  for (const e of allElements) {
    if (e.css) { knownSelectors.add(e.css.toLowerCase()); bySelector.set(e.css.toLowerCase(), e); }
    if (e.id) { knownSelectors.add(`#${e.id}`.toLowerCase()); bySelector.set(`#${e.id}`.toLowerCase(), e); }
    if (e.testId) {
      knownSelectors.add(`[data-test="${e.testId}"]`.toLowerCase());
      knownSelectors.add(`[data-testid="${e.testId}"]`.toLowerCase());
    }
  }
  // A responsive-hidden control (a hamburger menu-toggle is the common case — present in the
  // DOM, `display:none` at the current viewport) can be name-matched or directly css-targeted
  // just like any other element, but asserting it VISIBLE will always time out at execution.
  // Asserting it HIDDEN is exactly the point sometimes (e.g. a post-login "Sign In" check) —
  // this must only block the "visible" direction.
  const hiddenVisibleAssertError = (idx: number, roleOrCss: string, el: Element) =>
    el.visible === false && ir.steps[idx].assertion === "visible"
      ? { index: idx, message: `Step ${ir.steps[idx].id} targets ${roleOrCss}, which is currently ` +
          `hidden (likely a responsive/mobile-only control not shown at this viewport) — it cannot ` +
          `be asserted visible. Pick a different, currently-visible element instead.` }
      : null;
  // ponytail: strip decorative glyphs (+, emoji, bullets) for fuzzy name matching —
  // catches "+ Add New" vs "Add New" without the unsound reverse-direction check.
  const stripGlyphs = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  // Interactive controls a modern SPA frequently implements with the "wrong" semantic tag —
  // a sidebar/nav item as <button onClick=router.push(...)> instead of <a href>, most commonly.
  // Deliberately narrow: only roles where a same-named cross-role match is (a) plausible in
  // practice and (b) safe to click even if the guess was wrong — NOT textbox/checkbox/heading,
  // where matching the wrong role either can't work (.fill() on a heading) or changes what an
  // assertion actually proves. safeClick/locate() already tolerate exactly this mismatch at
  // runtime (their own css/text fallback chain), so this only stops grounding from being
  // stricter than the code it's protecting.
  const CLICKABLE_ROLE_GROUP = new Set(["link", "button", "menuitem", "tab"]);
  // Best name-tiered match among `elements` whose role satisfies `roleOk`. Factored out so the
  // exact-role pass and the compatible-role fallback pass share identical ranking logic.
  const bestNameMatch = (elements: Element[], name: string, sn: string, roleOk: (r: string) => boolean): Element | null => {
    let matched: Element | null = null;
    let bestTier = 99;
    let bestDelta = Infinity;
    for (const e of elements) {
      if (!roleOk(norm(e.role))) continue;
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
    return matched;
  };
  // A navigate step's URL is every bit as invented-able as a CSS selector or a role+name, and
  // nothing checked it: told to reach a destination through the UI ("open the Admin section via
  // the sidebar"), the model would guess a plausible-looking route for it instead. On a
  // client-routed app a guessed route typically loads a blank shell or bounces to a login
  // redirect, and every later step then grounds against a page that was never really reached.
  // Only destinations the model actually observed are allowed through.
  const knownNav = knownNavigationTargets(appModel);
  const baseOrigin = originOf(appModel.baseUrl);
  const sourcePrompt = ir.meta?.sourcePrompt ?? "";
  const navUrlAllowed = (url: string): boolean => {
    const resolved = resolveHref(appModel.baseUrl, url);
    if (!resolved) return true;                                  // unparseable — not this guard's business
    if (!baseOrigin || originOf(resolved) !== baseOrigin) return true; // off-origin is a separate concern
    if (knownNav.has(pageKey(resolved))) return true;
    // A path the USER typed themselves is authoritative — they know their own app's routes,
    // and that's a stated fact rather than a guess. Length > 1 so a bare "/" can't match
    // incidentally on essentially every prompt.
    const path = (() => { try { return new URL(resolved).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
    return path.length > 1 && sourcePrompt.includes(path);
  };
  const knownPathsHint = appModel.pages
    .map(p => { try { return new URL(p.url).pathname || "/"; } catch { return null; } })
    .filter(Boolean).slice(0, 6).join(", ") || "/";
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
    if (t?.css && knownSelectors.has(t.css.toLowerCase())) {
      const known = bySelector.get(t.css.toLowerCase());
      const hiddenErr = known && hiddenVisibleAssertError(index, `css="${t.css}"`, known);
      if (hiddenErr) return hiddenErr;
      continue;
    }
    // Step 0's navigate is the entry URL the pipeline itself supplied, never a guess.
    if (index > 0 && step.action === "navigate" && t?.url && !navUrlAllowed(t.url)) {
      return {
        index,
        kind: "navigate-url",
        message: `Step ${step.id} navigates to "${t.url}", which is not a page or link ` +
          `destination present in the application model — that route is a guess, and a guessed ` +
          `route usually loads a blank page or redirects, so everything after it runs against ` +
          `the wrong page. Reach that destination the way a user would instead: click the ` +
          `sidebar/menu control that leads there (it is an element in the application model). ` +
          `Known paths: ${knownPathsHint}.`,
      };
    }
    const elements = trail.pageAt[index]?.elements ?? allElements;

    // A bare `{ text: ... }` target on an ACTION step. The exemption below it — "no role+name,
    // nothing to check" — is right for an ASSERT (a flash message discovery never saw is the
    // whole reason target.text exists), and was being used as a way around grounding entirely:
    // in a real run every step after login was `{text:"Admin"}`, `{text:"users"}`,
    // `{text:"Name"}`. None was checked, so nothing was ever rejected, so live-extend never
    // ran, so the model still held only the login page when the run finished — and the fills
    // resolved to <label> elements at execution time. Clicking or filling something is exactly
    // as invented-able as addressing it by role+name, and deserves the same check.
    if (!t?.css && !t?.testId && t?.text && !t?.role && ACTION_STEPS.has(step.action)) {
      const hint = norm(t.text);
      const roleOk = FIELD_ACTIONS.has(step.action)
        ? (r: string) => FIELD_ROLE_GROUP.has(r)
        : (r: string) => CLICKABLE_ROLE_GROUP.has(r);
      const found = bestNameMatch(elements, hint, stripGlyphs(hint), roleOk);
      if (found) {
        // Upgrade the weak target into the verified one, exactly as the role+name path does
        // below: real role, model's literal name, plus whatever deterministic identity
        // discovery captured. "Name" becoming textbox "Full Name" happens here.
        t.role = found.role;
        t.name = found.name;
        delete t.text;
        if (found.css && !t.css) t.css = found.css;
        if (found.testId && !t.testId) t.testId = found.testId;
        continue;
      }
      return {
        index,
        kind: "text-target",
        message: `Step ${step.id} ${step.action}s an element identified only by the text ` +
          `"${t.text}", which no element in the application model matches. Target it by ` +
          `accessibility role + name from the application model instead — { "text": ... } is ` +
          `for asserting on content that appears only after an action, never for choosing ` +
          `what to click or fill.`,
      };
    }

    // A role WITH no name (undefined or "") took the same silent-skip path as a step with no
    // target at all — `!t?.name` is true for both. It reaches generation completely unchecked,
    // where resolveCode()'s `if (t.role && t.name)` gate is also false, falls through to
    // pick(t), finds no css/label/placeholder/text/testId, and throws — crashing spec
    // generation with no recovery. When this happens for the PRIMARY case (not a suite case),
    // there's no per-case isolation to catch it: the whole run dies with zero cases and zero
    // artifacts. Reproduced twice: an empty-string name on a `press` step (a keyboard-only
    // intent with nothing to anchor to), and a fully-absent name on a `heading`/`navigation`/
    // `main` landmark assertion (a thin AppModel left the model nothing specific to name).
    // Reject it the same way every other grounding failure is rejected — through the existing
    // correction/retry/truncate path — instead of letting it reach generation at all. See
    // TECH_DEBT.md TD-30.
    if (t?.role && !t?.name) {
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" with no name to identify which ` +
          `element it means. Every role target must name a specific element from the ` +
          `application model — if you meant "any element with this role", that isn't ` +
          `supported; pick the specific one you want by its accessible name instead, or use ` +
          `{ "text": "..." } for content that only appears after an action.`,
      };
    }

    if (!t?.role || !t?.name) continue; // navigate / text-only / wait steps
    const role = norm(t.role);
    const name = norm(t.name);

    // Rank candidates instead of taking the first substring hit. `en.includes(name)` alone
    // grounded "Continue" to "Continue Shopping" — a different control on a different page —
    // because that happened to come first in element order. An exact match must always beat
    // a partial one, and among partials the closest-length name is the least wrong.
    const sn = stripGlyphs(name);
    let matched = bestNameMatch(elements, name, sn, (r) => r === role);
    // Exact role found nothing — try again across the compatible-role group, but only when
    // the STEP'S OWN role is itself one of those roles (never widen a heading/textbox search).
    // An exact-role match always wins when one exists; this only runs when the pass above
    // found nothing at all.
    if (!matched && CLICKABLE_ROLE_GROUP.has(role)) {
      matched = bestNameMatch(elements, name, sn, (r) => CLICKABLE_ROLE_GROUP.has(r));
    }
    const matchedName = matched?.name ?? null;
    if (!matchedName) {
      const pageUrl = trail.pageAt[index]?.url ?? appModel.baseUrl;
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" name="${t.name}", which is not present under any compatible role on page "${pageUrl}". ` +
          `If this element loads dynamically, verify that the page completed hydration/API rendering; ` +
          `if it requires role-based access (e.g. Admin), verify that valid authorized credentials were provided.`,
      };
    }
    const hiddenErr = matched && hiddenVisibleAssertError(index, `role="${t.role}" name="${t.name}"`, matched);
    if (hiddenErr) return hiddenErr;
    // ponytail: self-correct to the app model's literal name so Playwright matches
    t.name = matchedName;
    // Same self-correction, for role: the compatible-role fallback above may have matched an
    // element under a DIFFERENT real role than the one guessed (a sidebar item implemented as
    // <button>, guessed as "link") — carry the real role through so the generated
    // getByRole(t.role, {name}) actually matches the live DOM.
    if (matched?.role && norm(matched.role) !== role) t.role = matched.role;
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
  const NEEDS_VALUE = new Set([
    "url_contains", "text_contains", "text_equals", "title_contains", "title_equals",
  ]);
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
 * Index of the first form-field step that fills something REVEALED BY A PRECEDING CLICK — a
 * modal/drawer/expanding panel — or -1.
 *
 * Why this shape and not something smarter: `groundingError` only asks "does an element with this
 * role and name exist", never "is it the RIGHT one". A modal opened by a button click never
 * changes the URL, so its fields are absent from the AppModel, and the model invents names for
 * them. When an invented name coincidentally collides with real page chrome, the step grounds and
 * a broken test ships. Confirmed against run 2026-08-10T11-15-46-262Z-1279794e, whose "fill the
 * ticket Title" step ground onto the page header's asset-search box, and whose "submit" step
 * ground onto an unrelated existing ticket's "open" status badge.
 *
 * The trigger is deliberately STRUCTURAL, not name-based — no reading of the click's wording for
 * "add"/"new"/"open" (this codebase has repeatedly regretted English-wording detection; see
 * PROJECT_SUMMARY's "wording-based detection, not structural"). Measured across all 43 IRs saved
 * under runs/ at the time this was written: fires on 13, all 13 genuine post-click-revealed forms
 * across two different sites, and on zero logins — in a login the fills come BEFORE the click, so
 * the shape simply never matches.
 *
 * Waits are transparent (a modal replay routinely has one). A `navigate` resets it: that's a page
 * load, not an in-page reveal, and live-extend's existing on-miss path already covers it. Links
 * are excluded for the same reason — a link click that goes somewhere is a navigation.
 */
export function postClickRevealIndex(ir: IR): number {
  let precedingClick = false;
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    if (step.action === "wait") continue;                       // transparent
    if (FIELD_ACTIONS.has(step.action) && precedingClick) return index;
    precedingClick = step.action === "click" && norm(step.target?.role ?? "") !== "link";
  }
  return -1;
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
// A case step "line" that names an action, vs. one that's purely a wait/verify. Deliberately
// the same verbs the presence check below already uses — this just counts them per-line
// instead of once across the whole case.
const CASE_ACTION_LINE = /\b(fill|enter|type|input|provide|supply|click|press|tap|select|check|submit|sign ?in|log ?in)\b/i;
const IR_ACTION_KINDS = new Set(["click", "press", "fill", "select", "check"]);

export function missingActions(ir: IR, testCase: TestCase): { message: string } | null {
  const steps = testCase.steps ?? [];
  const text = [testCase.title, ...steps, testCase.expected ?? ""].join(" ").toLowerCase();
  const has = (...actions: string[]) => ir.steps.some(s => actions.includes(s.action));
  const missing: string[] = [];

  if (/\b(fill|enter|type|input|provide|supply)\b|credential/.test(text) && !has("fill")) {
    missing.push(`the case describes entering values, but the IR has no "fill" step`);
  }
  if (/\b(submit|click|press|tap|sign in|log ?in|continue)\b/.test(text) && !has("click", "press")) {
    missing.push(`the case describes submitting or clicking, but the IR has no "click" or "press" step`);
  }

  // Presence isn't coverage: an IR that fills the login form and stops satisfies both checks
  // above even if the case's later steps (open Admin, open Users, ...) never ran. Count
  // action-bearing lines in the case vs. action steps the IR actually carries out, and reject
  // when the gap is more than the slack of one legitimate consolidation (e.g. "fill the login
  // form" being one case line but two IR fills). Caught in practice: a case naming 5 actions
  // whose IR carried out login, then stopped — 2 fills and a click can't cover 5 named steps.
  const caseActionLines = steps.filter(s => CASE_ACTION_LINE.test(s)).length;
  const irActionSteps = ir.steps.filter(s => IR_ACTION_KINDS.has(s.action)).length;
  if (caseActionLines >= 2 && irActionSteps < caseActionLines - 1) {
    missing.push(
      `the case describes ${caseActionLines} action steps but the IR only carries out ` +
      `${irActionSteps} — it stopped before completing the flow`
    );
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
 * Reject "click X, then assert X is hidden" unless X is an authentication form's own submit
 * button.
 *
 * The pattern is legitimate — and this file's own prompt recommends it — for a LOGIN submit
 * button: fill the form, press Sign In, and the button really is gone once auth succeeds. It is
 * meaningless for a navigation control (caught in practice: "Navigate to registration page"
 * compiled to `click "Sign Up"` then `assert "Sign Up" hidden`, which asserts nothing about the
 * app — only whether that click happened to navigate).
 *
 * It is ALSO wrong for any other kind of form submission — a contact form, a newsletter
 * signup, a search box. Caught in practice: a "Subscribe" button on a Mailchimp newsletter form
 * stayed visible after a successful subscription (the confirmation renders elsewhere, or
 * nothing about the button changes), and the assertion timed out against a perfectly working
 * site. The earlier version of this check only asked "was anything filled in first" — a
 * newsletter form satisfies that exactly as well as a login form, so it let both through.
 *
 * The discriminator now is not just "was anything filled," but "was a REAL AUTHENTICATION
 * field filled" — a password field the AppModel actually discovered (credentialFieldMap, the
 * same DOM-derived signal credential injection itself relies on), or, for a progressive login
 * where the password field isn't revealed yet, credentialFieldsNeeded's INTENT signal (the
 * case is about authentication and the page offers a way in). Neither a contact form nor a
 * newsletter form trips either signal.
 *
 * The zero-fills threshold from the original check is unchanged: a single-field flow (one
 * fill, then a "Continue" button) still needs at least one fill to be a submission at all.
 */
export function clickedElementHiddenAssertion(
  ir: IR, appModel: AppModel, testCase: TestCase,
): { stepIds: string[]; message: string } | null {
  const fieldMap = credentialFieldMap(appModel);
  for (let i = 1; i < ir.steps.length; i++) {
    const assertStep = ir.steps[i];
    if (assertStep.action !== "assert" || assertStep.assertion !== "hidden") continue;
    const clickStep = ir.steps[i - 1];
    if (clickStep.action !== "click") continue;

    const a = assertStep.target, c = clickStep.target;
    if (!a?.role || !c?.role) continue;
    if (norm(a.role) !== norm(c.role) || norm(a.name ?? "") !== norm(c.name ?? "")) continue;

    let fillsBefore = 0;
    let hasPasswordFill = false;
    for (let j = i - 2; j >= 0; j--) {
      if (ir.steps[j].action === "navigate") break;   // a new page starts a new form
      if (ir.steps[j].action === "fill") {
        fillsBefore++;
        if (credentialKindForTarget(ir.steps[j].target, fieldMap) === "password") hasPasswordFill = true;
      }
    }

    if (fillsBefore === 0) {
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

    // A real submission needs filling — but only an AUTHENTICATION submit reliably makes its
    // own button disappear. Require a structural signal this is actually a login, not just
    // "something was filled."
    if (hasPasswordFill || credentialFieldsNeeded(appModel, [testCase]).length > 0) continue;

    return {
      stepIds: [assertStep.id],
      message:
        `Step ${assertStep.id} asserts that "${c.name}" is hidden after clicking it, but nothing ` +
        `filled before it was an authentication field (no discovered password field was filled, ` +
        `and this case isn't about signing in), so this looks like a contact, newsletter, or ` +
        `other non-authentication submission. Those buttons routinely stay visible even after a ` +
        `successful submit — a confirmation message appears elsewhere, or nothing about the ` +
        `button itself changes — so asserting it hidden fails a correctly-working site. Assert ` +
        `something that actually confirms the submission worked instead: a success/confirmation ` +
        `message near the form, or the URL changing.`,
    };
  }
  return null;
}

/**
 * Reject a click step whose target belongs to a DIFFERENT form on the page than the fields
 * filled just before it in the same flow.
 *
 * Caught in practice: a contact-form case filled Name/Email/Comment (WPForms), then clicked
 * "Join our Newsletter" — the accessible name of a completely different Mailchimp signup
 * form's submit control, sitting in the page footer — instead of the contact form's own
 * "Submit" button. The model picked a plausible-sounding, existing button; `groundingError`
 * passed it (the element genuinely exists), and the case never actually submitted the form it
 * was testing.
 *
 * The discriminator is `page.forms[].fields[]` — deterministic, DOM-extracted data (not LLM
 * output) that's the only structural signal spanning both plain fill targets (inputs/textareas,
 * which never get a `genericPath` — see discovery.ts's CONTROLS selector list, which only
 * covers button/link-shaped elements) and a form's own submit control. A fill or click target's
 * accessible NAME can come from a different extraction path than the form field's own
 * label/name attribute for the same physical element (confirmed on a real page: one field's
 * accessible name was "Subscribe", the same physical input's form-field `name` attribute was
 * "subscribe") — so this matches liberally across label/name/placeholder, not just one.
 *
 * Fails open, deliberately, whenever the signal is inconclusive rather than contradictory:
 *  - the click target matches NO field in ANY form (most correct clicks land here — a real
 *    <button>Submit</button> isn't itself a form FIELD, so "no match" means "can't tell",
 *    not "wrong")
 *  - the click target matches fields in MORE than one form (an ambiguous name shared across
 *    forms — guessing which one is right would be worse than not checking at all)
 *
 * Deliberately does NOT reuse trackPages' page cursor: trackPages marks the cursor "unknown"
 * after any click that isn't a resolvable link (a JS-handled reveal, an anchor scroll, a modal
 * trigger) — the right call for a DESTINATION assertion, where a click really might have
 * navigated somewhere trackPages can't see. It is the wrong call here: a "click to reveal the
 * form" step (a real, common shape — `click "Let's Connect"` to scroll a contact form into
 * view before filling it) would blank the page cursor and make this check silently fail open
 * for every step after it, defeating the check on exactly the kind of flow it exists to catch.
 * This function only cares "which page's form set applies," which changes on a `navigate`, not
 * on an arbitrary click — so it tracks that itself, deliberately simpler and less conservative.
 */
export function crossFormBleedError(ir: IR, appModel: AppModel): { stepIds: string[]; message: string } | null {
  let currentPage: PageModel | null = null;

  const formIndicesForName = (forms: DomForm[], name: string | undefined): Set<number> => {
    const target = norm(name ?? "");
    const hits = new Set<number>();
    if (!target) return hits;
    forms.forEach((f, idx) => {
      const fields = f.fields ?? [];
      if (fields.some((fld) =>
        norm(fld.label ?? "") === target || norm(fld.name ?? "") === target || norm(fld.placeholder ?? "") === target
      )) hits.add(idx);
    });
    return hits;
  };

  let fillFormIndices = new Set<number>();

  for (let i = 0; i < ir.steps.length; i++) {
    const step = ir.steps[i];
    if (step.action === "navigate") {
      fillFormIndices = new Set();
      const resolved = step.target?.url ? resolveHref(appModel.baseUrl, step.target.url) : null;
      currentPage = resolved ? findPageByUrl(appModel, resolved) : currentPage;
      continue;
    }

    const forms = currentPage?.forms ?? [];
    if (!forms.length) continue; // no forms discovered on this page — nothing to check against

    if (step.action === "fill") {
      const hits = formIndicesForName(forms, step.target?.name);
      if (hits.size === 1) for (const h of hits) fillFormIndices.add(h);
      continue;
    }

    if (step.action !== "click") continue;
    if (fillFormIndices.size === 0) continue; // nothing filled yet this segment — nothing to bleed from

    const hits = formIndicesForName(forms, step.target?.name);
    if (hits.size !== 1) continue; // fail open: no field match, or ambiguous across forms
    const [formIdx] = hits;
    if (fillFormIndices.has(formIdx)) continue; // same form as the preceding fills — fine

    return {
      stepIds: [step.id],
      message:
        `Step ${step.id} clicks "${step.target?.name}", which belongs to a different form on ` +
        `this page than the field(s) filled just before it. Two different forms on the same ` +
        `page can each have a submit-shaped control — a contact form and a newsletter/subscribe ` +
        `form are a common pair — and this click targets the WRONG one. Pick the click target ` +
        `that actually belongs to the same form as the preceding fills.`,
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
  budget?: LlmBudget,
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
  const creds = credPolicy === "none" ? undefined : runCreds;
  // Never the secret itself: a secret run substitutes an env REFERENCE, so every such run
  // produces a byte-identical IR and this marker fully discriminates. Demo accounts are
  // published by the sites themselves, so keying on that username leaks nothing.
  const credKey = creds ? `${credPolicy}:${creds.secret ? "env" : creds.username}` : "no-creds";

  const system =
    `Convert ONE human-readable test case into a strict JSON test model (IR).
Address elements only by accessibility role + name taken from the application model.
Allowed actions: navigate, click, fill, select, check, press, wait, assert.
Allowed assertions: visible, hidden, text_equals, text_contains, url_contains, title_contains, title_equals, enabled, disabled.

Rules, follow exactly:
- CARRY OUT THE WHOLE CASE. Every action the test case describes — each field it says to fill, each button it says to click — must appear as a step, in order, before the assertion. An IR that skips the fill steps and jumps to an assertion verifies nothing even when it passes, and will be rejected.
- BUT ONLY THE CASE. Build the IR from "testCase"'s own title/steps/expected ONLY. "sourcePrompt" below is background context for vocabulary and credentials, not a second source of steps — never add an action that isn't implied by testCase itself just because sourcePrompt happens to mention it (e.g. a longer flow described elsewhere in the user's original request).
- "id" is always a string like "s1", "s2", never a number.
- "assertion" is a single string from the allowed list above — NEVER an object. Omit "assertion" entirely on steps whose action is not "assert".
- Omit "target" entirely for steps that don't need one (e.g. a "wait" step); never set it to an empty string.
- For an "assert" step needing a comparison value (text_equals, text_contains, url_contains, title_contains, title_equals), put that value in the step's "value" field, not inside "assertion".
- Never invent CSS selectors. The only exception is a selector explicitly listed as verified in the user's request section below — those may be used as "target.css" exactly as given.
- "meta.baseUrl" must be exactly the origin, with no path: ${origin}
- A "navigate" step's target.url is a path RELATIVE to that origin (it gets concatenated onto baseUrl) — for the page under test here, that path is exactly "${entryPath}". Do not repeat the origin inside it.
- Only "navigate" to a path that actually appears in the application model (a discovered page's URL, or a link's href). NEVER guess a route from a feature's name: a case step like "go to the Admin section via the sidebar" means CLICK the sidebar control named "Admin" — it does NOT mean navigate to "/admin". A guessed route typically loads a blank shell or bounces to a login redirect on a client-rendered app, and every step after it then runs against the wrong page. When the destination isn't a known path, reach it by clicking the control that leads there.
- "role" must be a real ARIA role (button, textbox, link, heading, checkbox, ...) for an element actually present in the application model. For asserting on plain visible text that ISN'T in the application model — e.g. an error/flash message that only appears after an action, so discovery never saw it — use target: { "text": "..." } instead. Never invent a role like "text" or "message".
- target: { "text": "..." } is for ASSERT steps ONLY. Never use it to choose what to click, fill, select, check or press — those must name a real element from the application model by role + name. A text target on an action step matches whatever element CONTAINS that text, which for a form field is its label, and a label cannot be filled. If the element you need isn't in the application model yet, still address it by the role + name you expect: it will be discovered and checked, and you'll be told if it isn't there.
- A page's "title" field is the browser tab / <title> tag — it is never rendered in the page body and can NEVER be the target of a visible-text assertion, no matter how relevant it looks. Only use target: { "text": "..." } for text that actually appears in the page's rendered content (the elements/markdown), never the page title.
- To verify a page TITLE, use assertion "title_contains" (or "title_equals" for an exact whole-title match) with the expected text in "value" and NO target at all — these check the <title> tag directly. This is the ONLY correct way to express "verify the page title is X". Do not express it as text_equals/text_contains with a { "text": ... } target: that searches the rendered body for a string that lives only in the tab title, and can never pass.
- When a case describes a navigation region by listing several of its items and only ONE element can be picked to ground a "visible" check for the whole thing, do NOT pick a control whose only job is to OPEN or COLLAPSE that region — a menu/drawer toggle, however it is named, including an icon-only one. Such controls are routinely shown at one viewport width and hidden at another, so the assertion can fail while the region itself is perfectly fine. Prefer a content-bearing item from the region — one that names a real destination or action.
- A success assertion must be FALSE before the action and TRUE only after it — otherwise it verifies nothing. Never assert on a persistent, site-wide element (a header, logo, or nav bar that appears on every page regardless of state) as proof an action succeeded; it was already visible before the action too. In the application model, a decorative/structural element like this typically has no "concept" (empty or absent) — treat that as a signal to avoid it as a success assertion.
- The application model only covers the page you start on, so you usually can't see the page a LOGIN action navigates to. When you can't ground a login success assertion on the destination page, assert instead that the LOGIN FORM'S OWN SUBMIT BUTTON goes "hidden" after you submit it — e.g. the "Sign In" button once login succeeds. That element is already in the model, and is a real discriminator: visible before, gone after.
- This applies ONLY to an authentication form's submit button (the form has a password field) after an actual submission. It does NOT apply to a contact form, a newsletter/subscribe form, a search box, or any other non-authentication submission — those buttons routinely stay on the page (a success message appears elsewhere, or nothing about the button changes) even when the submission worked, so asserting them hidden fails a correctly-working site. For a non-authentication form, ground success on the destination page or on text that appears near the form instead. Do NOT assert that a navigation link goes hidden after clicking it either, and never use this pattern as a substitute for performing the test: "click the Log in link, then assert the Log in link is hidden" carries out none of the case and verifies nothing.

Negative-path rules (CRITICAL — read the test case's own "expected" field first):
- Some test cases exist to prove an action FAILS: invalid password, empty required field, malformed email, SQL injection, unauthorized access. For these, the PASS condition is that the app REJECTED the input.
- For such a case, NEVER assert that a success message, welcome text, dashboard, or post-login page is visible. That asserts the opposite of the test, and it fails against a perfectly working site.
- Instead assert one of: the error/validation message the app shows on failure (target: { "text": "..." }), that the URL still contains the original page path, or that an element unique to the STARTING page (e.g. the login form's submit button) is still visible.
- If you don't know the exact wording of the app's error message, prefer the URL or starting-page-element assertion over guessing the error text. Never guess the SUCCESS text.

Navigation & Assertion rules (CRITICAL):
- NEVER assert that the clicked link/button itself is "visible" after clicking it — that is redundant and proves nothing. The element was already visible (that's why you could click it).
- After clicking a NAVIGATION link (role="link"), assert a heading or unique text on the DESTINATION page. Use "url_contains" only with a SPECIFIC path that the click actually leads to. Do NOT re-assert the link you just clicked.
- An assertion must be able to FAIL. Never assert url_contains "/" (it matches every page), and never assert the path you just navigated to when nothing has happened since — both pass no matter what the app does. Asserting you are STILL on a page after submitting a form is fine: that is a real result.
- Each navigation path should be INDEPENDENT: when a case covers several sibling destinations, each branch should start with its own "navigate" step from the base URL rather than chaining clicks from the previous destination. Test the first destination by navigating to the entry page then clicking it; test the second by navigating to the entry page again and clicking that one. This prevents one broken branch from cascading into the rest.
- When a click triggers a page navigation, the assertion should verify the DESTINATION state (URL or heading), not the source element.

Selector Specificity rules (CRITICAL for avoiding strict mode violations):
- If multiple elements share the same role+name (e.g., multiple "Student" links), use the "nth" field to disambiguate: { "role": "link", "name": "Student", "nth": 1 } for the second occurrence (0-indexed).
- When duplicate names exist, pick the occurrence by its position in the application model, not by assuming a layout. The elements are listed in document order, and each carries "containerRole"/"containerName"/"pageSection" when discovery could determine them — use those to tell two same-named controls apart, and set "nth" to that element's index among the duplicates. Do not assume the first occurrence is a header one or that later occurrences are in a sidebar or footer; that is true of some sites and false of many.
- Skip elements that cannot perform a navigation you need: links whose href is "#" or "javascript:void(0)" do not navigate, so never use one as the step that reaches another page.
- For URL assertions: use partial matching (url_contains) instead of exact matching when the destination URL may vary or include query parameters
- For dropdown menus: the parent menu item must be clicked/hovered first to reveal hidden child items. Add a "preAction" field naming the PARENT item from the application model: { "preAction": { "action": "click", "target": { "role": "link", "name": "<the parent menu item>" } } }

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
    { "id": "s2", "action": "fill", "target": { "role": "textbox", "name": "Username" }, "value": "<the identifier from the test case>" },
    { "id": "s3", "action": "fill", "target": { "role": "textbox", "name": "Password" }, "value": "<the password from the test case>" },
    { "id": "s4", "action": "click", "target": { "role": "button", "name": "Login" } },
    { "id": "s5", "action": "assert", "target": { "role": "button", "name": "Login" }, "assertion": "hidden" }
  ]
}

Example — dropdown menu with preAction (PARENT and CHILD stand for whatever the application
model's own menu items are called — never reuse these placeholder names):
{
  "meta": { "feature": "Navigation", "title": "Dropdown menu works", "priority": "medium", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/" } },
    { "id": "s2", "action": "click", "target": { "role": "link", "name": "PARENT" }, "preAction": { "action": "hover", "target": { "role": "link", "name": "PARENT" } } },
    { "id": "s3", "action": "click", "target": { "role": "link", "name": "CHILD" } },
    { "id": "s4", "action": "assert", "target": { "url": "/child-path" }, "assertion": "url_contains" }
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

  // Keyed AFTER `system` is built, and on `system` itself. The disk half of this cache never
  // expires, so anything the key omits is served stale forever — and the prompt was the
  // largest such omission: editing a rule changed nothing for any input already seen, which
  // made two verification runs look like the fix hadn't worked. Hashing the prompt text is
  // self-maintaining in a way a hand-bumped version constant is not: change a rule, get a new
  // key, with nobody having to remember. The model name is in for the same reason.
  const cacheKey = makeCacheKey(
    JSON.stringify(testCase), sourcePrompt, JSON.stringify(appModel), credKey,
    system, process.env.GEMINI_MODEL ?? "default");
  const cached = llmCacheGet<IR>(cacheKey);
  if (cached) return { ir: cached, updatedAppModel: appModel };

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

    // Lead page always kept first and never dropped below — everything else drops
    // lowest-relevance-last if the prompt is still over budget after toLiteModel's own
    // per-page array caps (see appModel.ts).
    //
    // WHICH page leads decides everything, because toMicroModel emits exactly ONE page. Two
    // silent fallbacks used to land on the same wrong answer, and they compounded:
    //
    //   1. `p.url.includes(entryPath)` with entryPath "/" is true for EVERY url, so a
    //      bare-origin entry ("https://site.app", no path) matched whichever page happened to
    //      be first rather than the entry page. It is not a path test at that point.
    //   2. toMicroModel then received `currentPageUrl: entryUrl`, matched no page by pageKey,
    //      and fell back to pages[0] — the same wrong page, chosen a second time.
    //
    // Measured on three saved runs (2026-08-24T11-10-01, 2026-08-24T14-52-21,
    // 2026-08-25T06-51-31): entry "https://learnvibes.vercel.app", pages /dashboard and
    // /login, case feature "Authentication". Both fallbacks picked /dashboard, so an
    // Authentication case was compiled with "Sign In", the email box and the password box
    // absent from the prompt entirely. The relevance filter above had correctly kept /login —
    // it was discarded afterwards.
    //
    // The fix reads the case's own `targetUrl`. That is a schema field (testCases.ts:259),
    // documented to the model as "when the model has multiple pages, this tells the later
    // stage which page to start from", and already compared with pageKey elsewhere in this
    // file (line 393) and in testCases.ts:104. It was simply never read here. Structural, not
    // a regex over prose.
    const targetPage = testCase.targetUrl
      ? pagesToSend.find(p => pageKey(p.url) === pageKey(testCase.targetUrl!))
      : undefined;
    // Only trust the path test when there IS a path; otherwise fall back to exact page identity.
    const entryPage = entryPath !== "/"
      ? pagesToSend.find(p => p.url.startsWith(entryOrigin) && p.url.includes(entryPath))
      : pagesToSend.find(p => pageKey(p.url) === pageKey(entryUrl));
    const leadPage = targetPage ?? entryPage;
    const orderedPages = leadPage ? [leadPage, ...pagesToSend.filter(p => p !== leadPage)] : pagesToSend;

    // Filter elements: only named interactive elements (links, buttons, menuitems,
    // textboxes, checkboxes, headings). Drops thousands of anonymous list/div/container
    // nodes that bloat the prompt without helping the LLM generate better IR.
    const withFilteredElements = (pages: PageModel[]) => pages.map(p => ({
      ...p,
      elements: p.elements.filter(e =>
        e.name && e.name.trim() && INTERACTIVE_ROLES.has(e.role?.toLowerCase() ?? "")
      ),
    }));
    // Hand toMicroModel the page THIS function already chose, rather than the raw entry URL it
    // then has to re-resolve. Passing entryUrl let it disagree with the ordering above and drop
    // to pages[0] whenever the entry was a bare origin — the second of the two fallbacks. The
    // page that leads `pages` is the page that should survive; say so explicitly.
    const modelJsonFor = (pages: PageModel[]) =>
      JSON.stringify(toMicroModel(
        { ...model, pages: withFilteredElements(pages) },
        { currentPageUrl: pages[0]?.url ?? entryUrl }
      ));

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

    const render = (modelJson: string) => `Application model: ${modelJson}
Test case: ${JSON.stringify(testCase)}
baseUrl (origin only): ${origin}
entry path (where the page under test lives): ${entryPath}
sourcePrompt: ${sourcePrompt}${promptSelectorHint(usable)}${correctionBlock}
Return IR JSON: { "meta": {feature,title,priority,sourcePrompt,baseUrl}, "steps":[{id,action,target,value,assertion}] }`;

    let pages = orderedPages;
    let modelJson = modelJsonFor(pages);
    let prompt = render(modelJson);
    console.log("[ir] prompt chars:", prompt.length, "| approx tokens:", Math.round(prompt.length / 4), "| pages sent:", pages.length, "/", model.pages.length);

    const MAX_CHARS = 30_000;
    // toLiteModel's own per-page array caps should make this rare now — this is the fallback
    // for when even capped pages, combined, are still too large. Drops lowest-relevance pages
    // one at a time (entry page always kept) rather than blindly slicing the assembled prompt.
    while (prompt.length > MAX_CHARS && pages.length > 1) {
      pages = pages.slice(0, -1);
      modelJson = modelJsonFor(pages);
      prompt = render(modelJson);
      console.warn("[ir] prompt still exceeds", MAX_CHARS, "chars — dropped to", pages.length, "page(s)");
    }
    if (prompt.length > MAX_CHARS) {
      // Last resort: cut the model JSON specifically, at a line boundary — never the whole
      // assembled prompt. The old `prompt.slice(0, MAX_CHARS)` landed anywhere in the
      // assembled string, including inside the testCase/sourcePrompt/instructions region that
      // follows the model JSON in the template — silently shipping incomplete instructions, not
      // just malformed JSON. cutAtBoundary cuts at the last "\n", falling back to the last " "
      // only if no "\n" is found early enough (src/text.ts) — a COMPACT JSON.stringify() has
      // neither, so it would degrade to the exact same mid-token blind slice this replaces.
      // Pretty-print JUST for this cut so there's an actual line break to land on.
      const prettyModelJson = JSON.stringify(
        toLiteModel({ ...model, pages: withFilteredElements(pages) }), null, 2);
      const overhead = prompt.length - modelJson.length;
      modelJson = cutAtBoundary(prettyModelJson, Math.max(0, MAX_CHARS - overhead));
      prompt = render(modelJson);
      console.warn("[ir] prompt still exceeds", MAX_CHARS, "chars at 1 page — cut model JSON at a line boundary (pretty-printed) instead of the whole prompt");
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
    if (!ir.meta.truncated) {
      llmCacheSet(cacheKey, ir);
    }
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
  // Bound total LLM calls so a broken app/prompt still fails fast. Was a hardcoded 8;
  // stacked with backoff.ts's per-call retries that made a single case's worst case 48
  // real requests (originally against Groq; the same shape applies to Gemini now — see
  // DECISIONS.md D-21). Now env-overridable like MAX_LIVE_EXTENSIONS above.
  const MAX_ATTEMPTS = Number(process.env.MAX_IR_ATTEMPTS ?? 4);
  let lastErr = "";
  // Feedback for the NEXT attempt's prompt. Separate from lastErr, which also carries
  // live-extend failures that the model can't act on.
  let correction: string | undefined;
  let lastContradiction: { ir: IR; stepIds: string[]; message: string } | undefined;
  /** Longest grounded prefix seen across all attempts — the fallback that keeps a run alive
   *  when the attempt budget is spent extending the model rather than converging. */
  let bestPartial: { ir: IR; steps: Step[]; note: string } | undefined;
  /** The post-click reveal check (see postClickRevealIndex) runs at most ONCE per toIR call.
   *  It costs a browser launch, and — more importantly — it is the mitigation for its own only
   *  real false-positive risk: a flow where a click reveals new fields but the step legitimately
   *  targets a pre-existing one. Bounding it to one firing caps that mistake at a single wasted
   *  attempt, after which the next IR is accepted on its own merits. */
  let postClickRefreshed = false;

  // Extra, separately-bounded retries for a rate-limit error that survived callWithPool's own
  // internal backoff (a persistent TPM squeeze, not a one-off spike). TD-03's originally
  // unimplemented clause: "a 429 backoff succeeding should not cost one of MAX_ATTEMPTS" — a
  // rate-limit failure isn't the same kind of failure as a genuine schema error, so it
  // shouldn't compete with real correction attempts for the same small budget. Bounded on its
  // own so a permanently rate-limited key still eventually gives up.
  let rateLimitRetries = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (budget && !budget.hasBudget) {
      lastErr = `LLM per-run budget exhausted (${budget.snapshot().calls} calls)`;
      console.warn("[ir]", lastErr, "— stopping retries early");
      break;
    }
    console.log("[ir] attempt", attempt + 1, "/", MAX_ATTEMPTS);
    let parsed;
    try {
      // temperature: 0.2, not Gemini's provider default — matches the value this call ran at
      // under Groq for this schema-constrained task; GeminiOpts has no built-in default the
      // way groq.ts did, so it has to be set explicitly here or IR would silently move to
      // whatever Gemini's own default is. model: GEMINI_MODEL (the full model, not LITE) —
      // IR is the hardest structured-output task in the pipeline (DOM + test case combined
      // into strict JSON), the same reason it needed a bigger context window under Groq.
      const { content, usage } = await gemini(buildUser(currentModel, correction), {
        systemInstruction: system, json: true, temperature: 0.2,
        model: process.env.GEMINI_MODEL, stage: "ir",
      });
      budget?.record("ir", usage);
      console.log("[ir] gemini returned, length:", content.length);
      parsed = IR.safeParse(normalizeIR(parseJson(content)));
      console.log("[ir] parsed:", parsed.success ? "valid" : "INVALID");
    } catch (err: any) {
      budget?.record("ir");
      lastErr = err?.message ?? String(err);

      // A definitively non-retryable infrastructure error (bad API key, a decommissioned/
      // mistyped model id) will never succeed by re-sending the same request — burning the
      // rest of MAX_ATTEMPTS on it just wastes budget, and worse, previously reported "IR
      // failed schema validation after retry" for what was actually an API-key/model problem
      // (problems.md Cross-cutting #1 — a user reading that message has no way to tell "your
      // site is broken" apart from "your credentials are wrong"). Fail fast, and mark the
      // thrown error structurally (`.isInfrastructureError`), not just in its message text, so
      // a caller can route it differently without string-matching — this is exactly the class
      // of check CLAUDE.md's central rule asks for: a structural signal, not a text guess.
      const status = err?.status;
      if (!isRateLimitError(err) && (status === 401 || status === 403 || status === 404)) {
        console.error("[ir] non-retryable infrastructure error, failing fast:", lastErr);
        const infraErr: any = new Error(`LLM infrastructure error, not a test failure (status ${status}): ${lastErr}`);
        infraErr.isInfrastructureError = true;
        infraErr.status = status;
        throw infraErr;
      }

      if (isRateLimitError(err) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries++;
        console.warn(`[ir] rate-limited (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} extra retries, not spending an attempt):`, lastErr);
        attempt--; // cancels this iteration's attempt++ below — a rate-limit retry is free
        continue;
      }

      console.error("[ir] gemini/parse error:", lastErr);
      continue;
    }
    if (!parsed.success) {
      lastErr = parsed.error.message;
      correction = `The JSON did not match the required schema: ${lastErr}`;
      continue;
    }

    parsed.data.meta.baseUrl = origin;

    // Sign in BEFORE grounding. The spec runs in a fresh browser with no session, and so does
    // liveExtend's grounding replay — without this the flow bounces to the login page and every
    // step past the first fails to ground.
    if (needsLoginPrefix(testCase, currentModel.auth)
      && !irAlreadyLogsIn(parsed.data, currentModel.auth, currentModel)) {
      const prefix = buildLoginPrefix(currentModel.auth);
      if (prefix.length) {
        parsed.data.steps = [...prefix, ...parsed.data.steps];
        console.log(`[ir] prepended ${prefix.length} login step(s) — the test signs in before its own steps`);
      }
    }

    /** Longest grounded prefix seen for THIS ungrounded result — updates bestPartial in
     *  place. Called both before each extension attempt and once more after the inner loop
     *  below exits, so the final state (whatever it ends up being) is always captured. Cheap
     *  to call twice for the same value: the length check makes repeats a no-op. */
    const trackBestPartial = (u: NonNullable<ReturnType<typeof groundingError>>) => {
      const prefix = parsed.data.steps.slice(0, u.index);
      if (prefix.length && prefix.length > (bestPartial?.steps.length ?? 0)) {
        bestPartial = { ir: parsed.data, steps: prefix, note: u.message };
      }
      return prefix;
    };

    let ungrounded = groundingError(parsed.data, currentModel);

    // Live-extend hops are cheap relative to a fresh LLM generation — no new attempt spent —
    // so keep extending and re-grounding the SAME already-parsed IR until it grounds, extension
    // genuinely can't proceed, or the extension budget runs out. Previously every hop happened
    // via `continue` back to the OUTER per-attempt loop, consuming one of only MAX_ATTEMPTS
    // attempts identically to a fresh generation — a flow needing several hops to fully
    // discover (e.g. login -> product -> cart -> checkout) could burn its entire attempt budget
    // just reaching the right page state, leaving none to actually use the now-correct model.
    // That's exactly what produced the stale "not present in the application model" truncation
    // notes seen in practice: true on an earlier attempt, false in the model shipped alongside
    // the note.
    while (ungrounded && extensions < MAX_EXTENSIONS) {
      lastErr = ungrounded.message;
      correction = ungrounded.message;
      console.log("[ir] ungrounded step", ungrounded.index, ":", ungrounded.message);
      const prefix = trackBestPartial(ungrounded);
      if (!prefix.length) break; // nothing to replay from — fall through, same as today
      // A guessed navigate URL is an AUTHORING mistake, not a discovery gap: replaying the
      // prefix can't make an invented route real, so extending here just drains the budget the
      // steps that genuinely need discovery are relying on. Go straight to the next attempt,
      // where the correction above tells the model to click through the UI instead.
      if (ungrounded.kind === "navigate-url") break;

      try {
        const before = currentModel.pages.length;
        console.log("[ir] calling extendAppModel...");
        currentModel = await extendAppModel(currentModel, prefix, creds, credPolicy);
        console.log("[ir] extendAppModel returned,", currentModel.pages.length, "pages");
        extensions++;
        console.log(`[ir] live-extend: replayed ${prefix.length} step(s) past "${ungrounded.message.split(",")[0]}" — app model ${before} -> ${currentModel.pages.length} pages (${currentModel.pages.at(-1)?.url})`);
      } catch (err: any) {
        if (err?.message?.includes("already in the model") && prefix.length > 0) {
          try {
            const before = currentModel.pages.length;
            console.log("[ir] calling refreshPageModel...");
            currentModel = await refreshPageModel(currentModel, prefix, creds, credPolicy);
            console.log("[ir] refreshPageModel returned,", currentModel.pages.length, "pages");
            extensions++;
            console.log(`[ir] refresh-page: refreshed page model at step ${prefix.length} — app model ${before} -> ${currentModel.pages.length} pages`);
          } catch (refreshErr: any) {
            lastErr = `could not refresh state for step ${parsed.data.steps[ungrounded.index]?.id}: ${refreshErr?.message ?? refreshErr}`;
            break; // extension genuinely can't proceed — fall through to truncation below
          }
        } else {
          lastErr = `could not reach the state needed for step ${parsed.data.steps[ungrounded.index]?.id}: ${err?.message ?? err}`;
          break;
        }
      }

      // Re-ground the SAME parsed IR against the newly-extended model — no fresh LLM call,
      // no attempt spent, just "does it ground now that the model has caught up."
      ungrounded = groundingError(parsed.data, currentModel);
    }

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

      const clickedHidden = clickedElementHiddenAssertion(parsed.data, currentModel, testCase);
      if (clickedHidden) {
        console.log("[ir] assert-hidden on a merely-clicked element rejected:", clickedHidden.message);
        lastErr = clickedHidden.message;
        correction = clickedHidden.message;
        lastContradiction = { ir: parsed.data, ...clickedHidden };
        continue;
      }

      const crossForm = crossFormBleedError(parsed.data, currentModel);
      if (crossForm) {
        console.log("[ir] cross-form target bleed rejected:", crossForm.message);
        lastErr = crossForm.message;
        correction = crossForm.message;
        lastContradiction = { ir: parsed.data, ...crossForm };
        continue;
      }

      const incomplete = missingActions(parsed.data, testCase);
      if (incomplete) {
        console.log("[ir] IR does not carry out the case:", incomplete.message);
        lastErr = incomplete.message;
        correction = incomplete.message;
        continue;
      }

      // Everything above is free. This one costs a browser launch, so it goes last among the
      // rejection checks — no point paying for a replay that a string comparison would have
      // rejected anyway.
      //
      // The gap it closes: live-extend only ever fires when grounding MISSES, so a step whose
      // invented target happens to COLLIDE with real page chrome is accepted and the modal it
      // meant to fill is never discovered. Proven by two cases of one real run (a5d729b1):
      // case-1 guessed a name that missed, live-extend fired, and its IR correctly targets the
      // modal's own fields; case-0 guessed a name matching the page header's search box, ground
      // clean, and shipped a test that filled the wrong control entirely.
      const revealIndex = postClickRevealIndex(parsed.data);
      if (revealIndex > 0 && !postClickRefreshed && extensions < MAX_EXTENSIONS) {
        postClickRefreshed = true;
        const revealStep = parsed.data.steps[revealIndex];
        // slice(0, revealIndex) is the same prefix convention the live-extend path uses: every
        // step BEFORE this one, which includes the click that opens the modal and any wait after
        // it. replayAndSnapshot's dialog branch (waitForSelector on [role="dialog"], plus the
        // vision merge for dialogs built without semantic HTML) engages on exactly this shape.
        const prefix = parsed.data.steps.slice(0, revealIndex);
        const pageBefore = trackPages(parsed.data, currentModel).pageAt[revealIndex];
        const beforeKeys = new Set(
          (pageBefore?.elements ?? currentModel.pages.flatMap(p => p.elements))
            .map(e => `${norm(e.role)}|${norm(e.name)}`)
        );
        try {
          console.log(`[ir] post-click reveal check: re-snapshotting after step ${parsed.data.steps[revealIndex - 1]?.id}`);
          const refreshed = await refreshPageModel(currentModel, prefix, creds, credPolicy);
          extensions++;
          // Unconditional, on the accept path as much as the reject path. The retry prompt is
          // built from currentModel, so a correction naming fields this model doesn't contain
          // would send the model straight into a grounding MISS and spend a live-extend hop
          // rediscovering what was just discovered. On the accept path it's plain profit: the
          // modal is now modelled for every later step.
          currentModel = refreshed;

          const revealed = refreshed.pages
            .flatMap(p => p.elements)
            .filter(e => !beforeKeys.has(`${norm(e.role)}|${norm(e.name)}`));
          const fillable = revealed.filter(e => FIELD_ROLE_GROUP.has(norm(e.role)));
          // Nothing fillable appeared — either no modal opened, or its fields share a name with
          // something already modelled (in which case the diff hides them and there is nothing
          // to redirect to). Either way a correction would name nothing useful, so accept.
          //
          // No "unless the target IS one of the revealed fields" escape hatch is needed here,
          // and one written earlier turned out to be unreachable: groundingError rewrites
          // t.name to the matched element's literal name, so by this point the target always
          // carries a name from the PRE-refresh model. The case it was meant to protect — the
          // model correctly naming a field it couldn't see — can't reach this code at all,
          // because such a name MISSES grounding and the live-extend path above owns it. That
          // is exactly what separates case-1 from case-0 in the run this fixes.
          if (fillable.length) {
            const names = fillable.map(e => `${e.role} "${e.name}"`).join(", ");
            const message =
              `Step ${revealStep.id} targets ${revealStep.target?.role ?? "an element"} ` +
              `"${revealStep.target?.name ?? revealStep.target?.text ?? ""}", which already existed on the ` +
              `page BEFORE the preceding click. Clicking ` +
              `"${parsed.data.steps[revealIndex - 1]?.target?.name ?? "that control"}" revealed a form that ` +
              `was not in the application model until now, so that target is almost certainly the wrong ` +
              `control (a page header, sidebar or list item that happens to share the name). Use one of the ` +
              `fields the click actually revealed: ${names}.`;
            console.log("[ir] post-click reveal rejected:", message);
            lastErr = message;
            correction = message;
            lastContradiction = { ir: parsed.data, stepIds: [revealStep.id], message };
            continue;
          }
        } catch (err: any) {
          // Best-effort, exactly like groundTerminalTextAssertion: a replay can fail for reasons
          // that have nothing to do with this step (site flakiness, a login that needs different
          // credentials this time). Leave the IR alone rather than failing the run.
          console.log("[ir] post-click reveal check: replay failed, leaving the step as-is:",
            err?.message ?? err);
        }
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

    // The inner loop above exits here for one of three reasons: extension genuinely can't
    // proceed (broke out early), the extension budget ran out while still ungrounded, or the
    // very first ungrounded step had no prefix to replay from at all. Either way, `ungrounded`
    // still describes the current, final unresolved reason — re-sync lastErr/correction/
    // bestPartial to it (idempotent if the top-of-loop tracking already covered this exact
    // value) and degrade to a real-but-partial test on the grounded prefix instead of failing
    // the whole run. Only a fully ungrounded IR (empty prefix) falls through to the next
    // outer-loop attempt (a fresh LLM generation).
    lastErr = ungrounded.message;
    correction = ungrounded.message;

    // A text-target rejection is a "we couldn't VERIFY this", not a "this cannot work". Its
    // whole purpose is to make live-extend run so the page gets discovered; once the budget is
    // spent, truncating on it would throw away a flow that has a real chance of executing —
    // the field helper resolves a control positionally, without needing a model entry at all.
    // Strictly better to run the step unverified than to ship a prefix that tests nothing:
    // the run that motivated this reported `truncated_no_assertion` and checked zero of the
    // user's eight steps. Every other rejection kind still truncates as before.
    if (ungrounded.kind === "text-target" && attempt === MAX_ATTEMPTS - 1) {
      console.log("[ir] shipping unverified text targets (best-effort):", ungrounded.message);
      return { ir: finalize(parsed.data), updatedAppModel: currentModel };
    }

    const prefix = trackBestPartial(ungrounded);
    if (prefix.length && attempt < MAX_ATTEMPTS - 1) {
      console.log(`[ir] grounding rejected step ("${ungrounded.message}") — retrying with feedback (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      continue;
    }
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

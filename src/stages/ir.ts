import { llm, providerFor, cacheModelDimension } from "../llm/client.js";
import { LlmBudget } from "../llm/llmBudget.js";
import { parseJson } from "../llm/json.js";
import { isRateLimitError } from "../llm/backoff.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import { AppModel, PageModel, DomForm, Element, type AuthOutcome, toLiteModel, toMicroModel, INTERACTIVE_ROLES, hiddenInputNames, isUsableElement } from "../schema/appModel.js";
import { cutAtBoundary, siteHost, pageKey } from "../text.js";
import { extendAppModel, refreshPageModel, captureScreenAt, groundTerminalTextAssertion, isPureTextAssertion } from "./liveExtend.js";
import { findScreen, screenElements, sameScreen, fingerprintOf } from "./screens.js";
import { networkSettleEnabled } from "./networkSettle.js";
import { screenMapEnabled, loadScreenMap, recordIntoScreenMap, writeRunScreenMap, screenFromPage, edgeForCapture, routeToControl, type ScreenMapControl, type ScreenMapScreen, type ScreenMapEdge } from "./screenMap.js";
import { currentRunTargetApp } from "../runTarget.js";
import { requestValues, stepsMissingValues } from "./requestValues.js";
import {
  applyCredentials, credentialPolicyFor, promptCarriesCredentials,
  credentialFieldMap, credentialKindForTarget, credentialFieldsNeeded, envValueRef,
  NEGATIVE_CATEGORIES, type Credentials,
} from "./credentials.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, isCacheableResult, llmCacheVersion } from "../kb/llmCache.js";
import { salesforceGuidance } from "./salesforceGuidance.js";
import { extractPromptSelectors, verifyAgainstModel, promptSelectorHint } from "./promptSelectors.js";
import { llmCacheDimension } from "../llm/llmContext.js";
// The generator's OWN rule for when a step becomes `field(page, hint, …)` and which slot supplies
// the hint — imported, never restated, so the guard below cannot drift from what is emitted (TD-07).
import { fieldHint, isFieldAction } from "./targetResolver.js";

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

/**
 * Host + path, ignoring scheme, port, `www.`, query and hash — enough to match a discovered
 * page's URL against a resolved href without tracking params throwing off the comparison.
 *
 * THE SCHEME IS DELIBERATELY NOT IN THE KEY (TD-82). It used to be `u.origin + path`, and that
 * is what rejected a correct IR on run `2026-09-06T15-42-48-000Z-61e01731`: the user entered
 * `http://veterans.my.site.com/s/`, the site redirected to `https://`, so every discovered
 * `page.url` was `https://…` while `appModel.baseUrl` kept the typed `http://…`. A navigate step
 * to `/s/` resolved against the base to `http://…/s`, which is not `https://…/s`, so the guard
 * refused the very path its own hint then listed as known.
 *
 * Normalising the base URL at discovery (see `landedOrigin` in hybridDiscovery.ts) fixes the
 * cause; this is the second line of defence, and the one that keeps an AppModel cached before
 * that fix from failing the same way. Same normalisation as `isSameSite`, via one shared
 * `siteHost`.
 */
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
// Fields a value is TYPED into. A `select` aimed at one of these becomes a `fill` (TD-125).
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
// Controls worth naming to the model when describing a captured screen: what a step can act on.
// spinbutton/searchbox included — "Min Budget (AED)" is an <input type=number>, and leaving it out
// meant no rejection ever told the model the field's real name (TD-122).
const SCREEN_CONTROL_ROLES = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem", "combobox", "textbox", "searchbox", "spinbutton",
]);
/**
 * TD-131: re-grounding the final text assertion would REPLACE text the person quoted in their request.
 *
 * Run 2026-10-15T17-13-59: the request said check that "Thank You" is shown. The model clicked Next
 * past a screen without filling it, the replay ended on that screen's validation error, and
 * groundTerminalTextAssertion's fallback (any message-shaped line, "please" included) rewrote the
 * assertion to "Please select a purpose (Self Use or Investment)." The case reported PASSED on a form
 * that was never submitted.
 *
 * The person's quoted text is the success criterion; the model's guess is not. So when the guess IS
 * one of the request's quoted phrases, only a respelling of it is accepted (the corrected text still
 * contains it, ignoring case, spacing and punctuation). Anything else means the replay did not reach
 * it, and the test must fail on it. Reads the person's request, not model prose (the same input
 * TD-127 reads).
 */
export function replacesQuotedSuccessText(guessed: string, corrected: string, request: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const g = n(guessed);
  if (!g || n(corrected) === g) return false;
  const quoted = [...request.matchAll(/"([^"]{2,200})"|'([^']{2,200})'|“([^”]{2,200})”/g)].map((m) => n(m[1] ?? m[2] ?? m[3]));
  return quoted.includes(g) && !n(corrected).includes(g);
}

/** `needle` occurs in `hay` as whole words: "self" in "self use", never "use" in "user" (TD-126).
 *  Both already lower-cased and space-collapsed by `norm`. */
const hasWholeWords = (hay: string, needle: string): boolean => {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u").test(hay);
};

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
    // A two-screen login's wait for the password box (D-46). An assertion, not a `wait`, for the
    // same reason as the closing one below: toBeVisible() auto-waits, so it costs nothing when the
    // box is quick and still covers a slow one, and a username the provider refuses fails HERE,
    // at the step that caused it. liveExtend's replay skips assert steps; its fill auto-waits for
    // the same selector, so the grounding replay needs no separate wait.
    if (s.action === "waitFor") {
      steps.push({ id: `auth-${i + 1}`, action: "assert", target: { css: s.css }, assertion: "visible" });
      return;
    }
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
 * After the login prefix, a case's own first `navigate` to the LOGIN page is sent to the page the
 * login landed on instead (TD-140). Returns the moved step's id, or undefined.
 *
 * Every case is compiled with the run's entry URL as "the page under test", and on a site whose
 * entry URL is its login page that is where the case then navigates — straight back to the login
 * form, after signing in. Run 2026-10-16T08-34-26 (saucedemo): the prefix landed on
 * /inventory.html, the case navigated to "/", and "Add to cart" was never on the page. Signing in
 * and then opening the login form is never what a signed-in case means; the landing page is where
 * discovery itself arrived (`auth.url`). Decided by URLs only — the step's own target and the
 * login outcome — and only for the FIRST step after the prefix.
 */
export function redirectPostLoginNavigate(
  steps: Step[], prefixLength: number, auth: AuthOutcome | undefined, origin: string,
): string | undefined {
  const first = steps[prefixLength];
  if (!first || first.action !== "navigate" || !first.target?.url || !auth?.url || !auth.loginUrl) return undefined;
  if (pageKey(auth.url) === pageKey(auth.loginUrl)) return undefined;
  let to: string;
  try { to = new URL(first.target.url, origin).href; } catch { return undefined; }
  if (pageKey(to) !== pageKey(auth.loginUrl)) return undefined;
  const landed = new URL(auth.url);
  if (siteHost(landed.href) !== siteHost(origin)) return undefined;
  first.target.url = landed.pathname + landed.search;
  return first.id;
}

/**
 * TD-146: for a role+name that matched nothing, the elements of a compatible role that ARE there,
 * closest first, as a sentence — "" when there are none. Duplicated names carry their test ids, the
 * one thing that tells them apart (and TD-141 grounds a test id given as the name).
 *
 * Run 2026-10-16T12-08-10 (saucedemo): the model asked for button "Add to cart - Sauce Labs Backpack"
 * on two attempts. An ordinary run's rejection said only "not present", so the retry had nothing to
 * choose from; a Salesforce run already lists its screen's controls (TD-124). Closeness is the number
 * of words the wanted name shares with an element's name or test id. Pure, generic to any site.
 */
export function similarElementsHint(pages: { url: string; elements: Element[] }[], role: string, name: string): string {
  const clickable = new Set(["link", "button", "menuitem", "tab"]);
  const roleOk = (r: string) => {
    const e = norm(r);
    return e === role || (clickable.has(role) && clickable.has(e)) || (FIELD_ROLE_GROUP.has(role) && FIELD_ROLE_GROUP.has(e));
  };
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  const want = words(name);
  // Which page the flow is on is unknown when more than one page is given: then each element says
  // where it is, so a field of an undiscovered page is never swapped for a same-kind field elsewhere
  // (run 13-33-16 filled the LOGIN form's Username after "Checkout" when only its name was listed).
  const many = pages.length > 1;
  const pathOf = (url: string) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
  const groups = new Map<string, { role: string; name: string; page: string; ids: string[]; twins: number; score: number; order: number }>();
  let order = 0;
  for (const p of pages) {
    for (const e of p.elements) {
      order++;
      if (!e.name?.trim() || e.visible === false || !roleOk(e.role)) continue;
      const page = many ? pathOf(p.url) : "";
      const key = `${norm(e.role)}\u0000${e.name}\u0000${page}`;
      const have = new Set([...words(e.name), ...words(e.testId ?? "")]);
      const score = [...want].filter((w) => have.has(w)).length;
      const g = groups.get(key) ?? { role: e.role, name: e.name, page, ids: [], twins: 0, score: 0, order };
      g.twins++;
      g.score = Math.max(g.score, score);
      if (e.testId && !g.ids.includes(e.testId)) g.ids.push(e.testId);
      groups.set(key, g);
    }
  }
  const ranked = [...groups.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 10);
  if (!ranked.length) return "";
  const show = ranked.map((g) => {
    // Most client sites have no test ids: then the only way to say which twin is its position (nth).
    const ids = g.twins <= 1 ? ""
      : g.ids.length ? ` (${g.twins} of them; test ids: ${g.ids.slice(0, 8).join(", ")})`
        : ` (${g.twins} of them, in page order: pick one with "nth", 0 = first)`;
    return `${g.role} "${g.name}"${ids}${g.page ? ` on ${g.page}` : ""}`;
  });
  return ` Elements of that kind the application model does have, closest first: ${show.join(", ")}. ` +
    `Use one of these names exactly when it is the element meant; where several share a name, name the one ` +
    `meant by its test id.` + (many ? ` Each is on the page shown: an element of a page not discovered yet is ` +
    `not among them, so keep the name the test case uses for it rather than borrowing one from another page.` : "");
}

/** Page regions present on every page of a site: a check on one of their controls proves nothing. */
const CHROME_LANDMARKS = new Set(["nav", "header", "footer"]);

/**
 * TD-148: the case's success check is only site chrome. Every assertion after the last action is
 * `visible` on an element of the header / navigation / footer that was ALREADY visible on the page
 * the flow started from, so it passes whatever the actions did. Null otherwise. Pure.
 *
 * Run 2026-10-16T13-40 (sf-smoke): click "Explore Projects", then assert link "Projects" visible —
 * the site header's link, on every page. Allowed: a check after only opening a page (nothing acted
 * on), an element not in a chrome landmark, and one discovery saw hidden (a menu that opens). The
 * landmark comes from discovery's DOM path (`landmark`), never from names or page text.
 */
export function chromeSuccessAssertion(ir: IR, appModel: AppModel): { stepIds: string[]; message: string } | null {
  const steps = ir.steps;
  let lastAction = -1;
  steps.forEach((s, i) => { if (ACTION_STEPS.has(s.action)) lastAction = i; });
  if (lastAction < 0) return null;
  const asserts = steps.slice(lastAction + 1).filter((s) => s.action === "assert");
  if (!asserts.length) return null;
  let nav = -1;
  for (let i = 0; i < lastAction; i++) if (steps[i].action === "navigate") nav = i;
  if (nav < 0 || !steps[nav].target?.url) return null;
  let startKey: string;
  try { startKey = pageKey(new URL(steps[nav].target!.url!, appModel.baseUrl).href); } catch { return null; }
  const start = appModel.pages.find((p) => pageKey(p.url) === startKey);
  if (!start) return null;
  const chromeOf = (s: Step) => {
    const t = s.target;
    if (s.assertion !== "visible" || !t?.role || !t?.name) return undefined;
    return start.elements.find((e) => norm(e.role) === norm(t.role!) && e.name === t.name
      && e.visible !== false && CHROME_LANDMARKS.has(norm(e.landmark ?? "")));
  };
  const chrome = asserts.map(chromeOf);
  if (chrome.some((e) => !e)) return null;
  const a = asserts.at(-1)!;
  return {
    stepIds: asserts.map((s) => s.id),
    message: `Step ${a.id} asserts ${a.target!.role} "${a.target!.name}" is visible, but that element is part of ` +
      `the site's ${chrome.at(-1)!.landmark} and was already visible before the steps before it ran, so the ` +
      `check passes whatever those steps do. Assert something the action itself makes appear: a heading, a ` +
      `message, or an element of the page or section it opens.`,
  };
}

/** Text-entry input types a person types into (a checkbox, button or hidden input is not one). */
const TYPED_INPUT_TYPES = new Set(["text", "email", "password", "tel", "number", "search", "url", "date", ""]);

/**
 * TD-145: what a form the steps before `index` partly filled still needs: `empty`, its typed fields
 * no step filled, and `submit`, its own submit control when no click/press after the last fill
 * submitted it. `{ empty: [] }` when no step filled a discovered form. Pure.
 *
 * Run 2026-10-16T10-59-00 (saucedemo checkout): the case typed "Test User" into First Name, left Last
 * Name empty and clicked Continue, so "Finish" never appeared. Run 11-39-31: the same case filled the
 * form and went straight to "Finish" without clicking Continue. Both times "Finish" was reported
 * missing with nothing pointing at the cause. The form comes from discovery (`page.forms`), so a search box
 * elsewhere on the page is never named; a field counts as filled when a fill step's target names it
 * (label, aria-label, placeholder or name) or its css carries the field's id or name.
 */
export function unfilledFormFields(ir: IR, appModel: AppModel, index: number): { empty: string[]; submit?: string } {
  const before = ir.steps.slice(0, index);
  if (!before.some((s) => s.action === "fill" && s.target)) return { empty: [] };
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const fieldName = (f: DomForm["fields"][number]) => f.label || f.ariaLabel || f.placeholder || f.name;
  /** Index of the last step before `index` that fills this field, or -1. */
  const filledAt = (f: DomForm["fields"][number]): number => {
    const names = [f.label, f.ariaLabel, f.placeholder, f.name].filter(Boolean).map(n);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i];
      if (s.action !== "fill" || !s.target) continue;
      const t = s.target;
      if (t.name && names.includes(n(t.name))) return i;
      if (t.label && names.includes(n(t.label))) return i;
      const css = (t.css ?? "").toLowerCase();
      if (css && [f.id, f.name].filter(Boolean).some((v) => css.includes(v.toLowerCase()))) return i;
    }
    return -1;
  };
  for (const page of appModel.pages) {
    for (const form of page.forms ?? []) {
      const typed = form.fields.filter((f) => (f.tag === "textarea" || (f.tag === "input" && TYPED_INPUT_TYPES.has(f.inputType.toLowerCase())))
        && fieldName(f));
      const lastFill = Math.max(-1, ...typed.map(filledAt));
      if (lastFill < 0) continue;
      const empty = [...new Set(typed.filter((f) => filledAt(f) < 0).map(fieldName))].slice(0, 6);
      // Submitted = some click/press after the last fill into this form. If not, name its own submit.
      const submitted = before.slice(lastFill + 1).some((s) => s.action === "click" || s.action === "press");
      const control = form.fields.find((f) => f.tag === "input" && ["submit", "button"].includes(f.inputType.toLowerCase())
        && (f.value || f.ariaLabel));
      const submit = !submitted && control ? (control.value || control.ariaLabel) : undefined;
      if (empty.length || submit) return { empty, ...(submit ? { submit } : {}) };
    }
  }
  return { empty: [] };
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

/**
 * Options for grounding an EDIT rather than a fresh compile.
 *
 * The fresh-run path never passes these — it is grounding an IR a model just invented, where every
 * step is equally unverified and checking all of them is the whole point.
 */
export interface GroundingScope {
  /**
   * The steps this pass is actually verifying. A step NOT listed is skipped — but only if it is
   * already grounded (carries `css` or `testId`), because that grounding is the proof it was
   * checked against a real page once and nothing about it has changed since.
   *
   * WHY THIS EXISTS (TD-86). `groundingError` walks every step, and the only existing skip is
   * "this step's css is in the model's `knownSelectors`". During an EDIT the model is whatever
   * the walk could reach — often near-empty when the case's source run folder is gone — so that
   * skip essentially never fires, and every untouched step gets re-matched by name against a
   * model that does not contain its page. Steps inside a modal, or on the login form, are then
   * reported as "not present on the page" although the user never touched them: a ghost
   * rejection that blames the edit for the walk's blind spots.
   *
   * Both conditions matter. Skipping an unlisted step that is NOT grounded would silently accept
   * a step nothing has ever verified.
   */
  onlyIndexes?: number[];
  /**
   * Where the walk actually landed for a given step index, when it walked one.
   *
   * `trackPages` gives up ("stale") after any click that is not a plain link, and a stale cursor
   * falls back to matching against EVERY page's elements at once. That is how an untouched
   * "Save" can bind to a Save button on a different page. A URL the walk really reached is
   * strictly better evidence than that fallback, so it wins where it exists.
   */
  reachedUrlAt?: Map<number, string>;
  /**
   * SCREENS (D-52). Each entry says: from step `at` on, the flow is on the screen whose key is
   * `key` (a page in the model, `screens.ts`). A step uses the latest entry at or before it, until
   * a `navigate` or a move to another URL ends that screen. A step with a screen is grounded
   * against THAT screen's elements only — never the merged pool, which is how a second screen's
   * "Next" bound to the first screen's "Next" — and a verified selector is accepted only when it
   * is on that screen.
   */
  screenAt?: { at: number; key: string }[];
  /**
   * Step indexes that need a screen captured before they can be grounded: the first element step
   * after a click that may have replaced the DOM. Reported as kind "screen-uncaptured", in step
   * order with every other grounding error, so toIR captures exactly where the flow needs it.
   */
  captureBefore?: Set<number>;
  /**
   * Salesforce runs with a screen map (TD-142): given the screen a step is on and the name it
   * misses, the sentence naming the click(s) that lead from that screen to the one holding it —
   * or undefined when the map does not know. Hints only (D-54): it changes a rejection's wording,
   * never what grounds.
   */
  mapRoute?: (fromKey: string, name: string) => string | undefined;
}

/**
 * A step the generator will emit as `field(page, hint, action)` whose hint cannot be proved to
 * exist on the recorded page — or null when it can, or when the step is not a `field()` step at
 * all (D-48).
 *
 * WHY. `field()` resolves by label, placeholder and accessible name (then by visible text next
 * to a control). A hint that is none of those resolves nothing, and the step sits out its full
 * timeout at RUN time with an error that names no cause. A real Salesforce run emitted
 * `field(page, "passwordShown", "fill")`: `passwordShown` is the NAME of
 * `<input type="hidden" name="passwordShown" value="false">` on Salesforce's login page — the only
 * thing on screen 1 with "password" in it, reached by grounding's substring tier.
 *
 * STRUCTURE ONLY, never page or prompt wording (CLAUDE.md's central rule, TD-01). Proof is one of:
 *   - a non-hidden form field whose recorded `label`, `placeholder` or `ariaLabel` IS the hint;
 *   - a visible, usable field-role element whose recorded `name` IS the hint — unless that name is
 *     only a hidden input's name/value (`hiddenInputNames`) or only an HTML `name` attribute a
 *     form field records separately from its human-facing names.
 * Comparison is case- and whitespace-insensitive, so a capitalisation slip is not a rejection.
 *
 * Known gap, stated rather than hidden: an element OUTSIDE any <form> whose name came from its
 * HTML `name` attribute or was derived from an id is indistinguishable here — the AppModel does not
 * record where an element's name came from, and the Element schema is not this change's to extend.
 */
function fieldHintError(
  step: Step, index: number, pages: PageModel[],
): { index: number; message: string } | null {
  const t = step.target;
  // Exactly resolveCode()'s condition for emitting field(): a verified css wins first.
  if (!t || t.css || !isFieldAction(step.action)) return null;
  const hint = fieldHint(t);
  if (!hint.trim()) return null;
  const want = norm(hint);

  const offered = new Set<string>();
  let proved = false;
  let hiddenOnly = false;
  let attributeOnly = false;
  for (const p of pages) {
    const hidden = hiddenInputNames(p);
    if ([...hidden].some((h) => norm(h) === want)) hiddenOnly = true;
    // HTML `name` attributes a form field records apart from its human-facing names. An element
    // NAMED one of these got that name from the attribute, which field() never matches.
    const attributeNames = new Set<string>();
    for (const form of p.forms ?? []) {
      for (const fld of form.fields ?? []) {
        if (fld.inputType === "hidden") continue;
        const human = [fld.label, fld.placeholder, fld.ariaLabel].filter((v) => v && v.trim());
        for (const v of human) offered.add(v.trim());
        if (human.some((v) => norm(v) === want)) proved = true;
        if (fld.name && !human.some((v) => norm(v) === norm(fld.name))) attributeNames.add(norm(fld.name));
      }
    }
    if (attributeNames.has(want)) attributeOnly = true;
    for (const e of p.elements) {
      if (!FIELD_ROLE_GROUP.has(norm(e.role ?? ""))) continue;
      if (e.visible === false || !isUsableElement(e, hidden)) continue;
      const n = norm(e.name);
      if (attributeNames.has(n)) continue;
      offered.add(e.name.trim());
      if (n === want) proved = true;
    }
  }
  if (proved) return null;

  const where = pages.length === 1 ? `on ${pages[0].url}` : "on any page in the application model";
  const why = hiddenOnly
    ? "it is only the name or value of a hidden input, which nothing can type into"
    : attributeOnly
      ? "it is only an HTML name attribute, which the field lookup never matches"
      : "no field there is called that";
  const list = [...offered].slice(0, 15).map((s) => `"${s}"`).join(", ");
  return {
    index,
    message: `Step ${step.id} ${step.action}s the field "${hint}", which is not a label, ` +
      `placeholder or accessible name of any field ${where} — ${why}. ` +
      (list ? `Fields actually there: ${list}. ` : `No usable fields were recorded there. `) +
      `Target one of those by its exact name; if the field only appears after an earlier action, ` +
      `that action must come first.`,
  };
}

/**
 * Where a screen must be captured before grounding can go on (D-52): the first step that needs an
 * element after a click or key press that may have replaced the DOM without a navigation — any
 * click whose target is not a link (links are followed by `trackPages` and the URL-keyed
 * live-extend). `wait` steps are skipped, so the replay that captures the screen includes them.
 */
export function screenBoundaries(ir: IR): number[] {
  const out: number[] = [];
  for (let i = 1; i < ir.steps.length; i++) {
    const prev = ir.steps[i - 1];
    if (prev.action !== "click" && prev.action !== "press") continue;
    if (norm(prev.target?.role ?? "") === "link") continue;
    let j = i;
    while (j < ir.steps.length && ir.steps[j].action === "wait") j++;
    const next = ir.steps[j];
    if (!next) continue;
    // A url_contains right after a button click is a guess about where the click leads (TD-147):
    // capture there too, so the assertion is checked against the URL the flow really reaches.
    if (ACTION_STEPS.has(next.action) || (next.action === "assert" && (next.target?.role || next.assertion === "url_contains"))) {
      if (!out.includes(j)) out.push(j);
    }
  }
  return out;
}

/** Every selector string an element list makes addressable — the same forms `groundingError`'s
 *  `knownSelectors` collects, lowercased. */
function selectorsOf(elements: Element[]): Set<string> {
  const out = new Set<string>();
  for (const e of elements) {
    if (e.css) out.add(e.css.toLowerCase());
    if (e.id) out.add(`#${e.id}`.toLowerCase());
    if (e.testId) {
      out.add(`[data-test="${e.testId}"]`.toLowerCase());
      out.add(`[data-testid="${e.testId}"]`.toLowerCase());
    }
  }
  return out;
}

export function groundingError(
  ir: IR, appModel: AppModel, scope?: GroundingScope,
): { index: number; message: string; kind?: "navigate-url" | "text-target" | "screen-uncaptured" | "disabled-target" } | null {
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
  //
  // `preferVisible` (LS-2): between two matches that are otherwise EQUAL (same tier, same length
  // delta), a visible element beats one recorded `visible: false`. Before this, whichever came first
  // in document order won — and Salesforce's login puts a hidden password MIRROR ahead of the real
  // box, so a fill grounded to an element no one can type into. Only a tie-break: a hidden exact match
  // still beats a visible partial one, and hidden elements stay in the model. Callers pass false for
  // a step asserting something is HIDDEN, where the hidden element may be the one meant — that step
  // keeps the old first-in-order choice.
  //
  // `preferEnabled`, the same kind of tie-break one rank below visibility: for a step that ACTS on
  // the element, an enabled twin beats one discovery measured as disabled (`enabled: false` —
  // `:disabled` or `aria-disabled="true"`). A real Salesforce Experience site lists one
  // "Select for EOI" button per unit, the first unit's disabled; first-in-order grounded onto it and
  // the click waited out its timeout on "element is not enabled". Assertions pass false: asserting
  // a disabled button is visible is legitimate.
  const bestNameMatch = (
    elements: Element[], name: string, sn: string, roleOk: (r: string) => boolean, preferVisible: boolean,
    preferEnabled = false,
  ): Element | null => {
    let matched: Element | null = null;
    let bestTier = 99;
    let bestDelta = Infinity;
    let bestHidden = 3;
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
      // Rank of the tie-break: visibility first (2), then enabled (1). Lower is better.
      const hidden = (preferVisible && e.visible === false ? 2 : 0) + (preferEnabled && e.enabled === false ? 1 : 0);
      if (tier < bestTier || (tier === bestTier && delta < bestDelta)
        || (tier === bestTier && delta === bestDelta && hidden < bestHidden)) {
        matched = e; bestTier = tier; bestDelta = delta; bestHidden = hidden;
        if (tier === 0 && delta === 0 && hidden === 0) break;       // can't do better
      }
    }
    return matched;
  };

  // LS-1: the `nth` duplicate the step means, and that element's position among the elements sharing
  // its css — which is what `.nth()` on that css actually counts in the browser.
  //
  // Grounding used to attach the FIRST duplicate's css and keep `nth`, emitting e.g.
  // `page.locator("#add-1").nth(1)`: a unique selector has no second match, so 0 elements. Now the
  // nth exact twin (same role, same name, model order) is chosen, and `nth` is rebased onto its css —
  // dropped when that css names one element (`#add-2` alone), kept as an index when the css is shared
  // (`[data-test="add"]` across a list relies on `.nth()`). Structure only: role, name, css, order.
  const nthTwin = (elements: Element[], chosen: Element, nth: number | undefined): Element => {
    if (nth === undefined || nth === null || nth < 1) return chosen;
    const twins = elements.filter((e) => norm(e.role) === norm(chosen.role) && norm(e.name) === norm(chosen.name));
    return twins[nth] ?? chosen; // out of range: leave the match and `nth` exactly as before
  };
  const rebaseNth = (t: NonNullable<Step["target"]>, chosen: Element, elements: Element[]): void => {
    if (t.nth === undefined || t.nth === null || !chosen.css || t.css !== chosen.css) return;
    // An nth past the duplicates the model holds was NOT resolved by nthTwin; rebasing it would
    // silently retarget the step at the first duplicate. Leave it failing loudly, as before.
    const twins = elements.filter((e) => norm(e.role) === norm(chosen.role) && norm(e.name) === norm(chosen.name));
    if (t.nth >= twins.length) return;
    const css = chosen.css.toLowerCase();
    const sameCss = elements.filter((e) => e.css?.toLowerCase() === css);
    const pos = sameCss.indexOf(chosen);
    if (sameCss.length <= 1) delete t.nth;
    else if (pos >= 0) t.nth = pos;
  };
  // A navigate step's URL is every bit as invented-able as a CSS selector or a role+name, and
  // nothing checked it: told to reach a destination through the UI ("open the Admin section via
  // the sidebar"), the model would guess a plausible-looking route for it instead. On a
  // client-routed app a guessed route typically loads a blank shell or bounces to a login
  // redirect, and every later step then grounds against a page that was never really reached.
  // Only destinations the model actually observed are allowed through.
  const knownNav = knownNavigationTargets(appModel);
  const sourcePrompt = ir.meta?.sourcePrompt ?? "";
  const baseHost = siteHost(appModel.baseUrl);
  const navUrlAllowed = (url: string): boolean => {
    const resolved = resolveHref(appModel.baseUrl, url);
    if (!resolved) return true;                                  // unparseable — not this guard's business
    // Off-SITE is a separate concern. Compared by host, not by origin string: with the entered
    // scheme in baseUrl and the landed scheme on every page, an origin comparison answers a
    // question about redirects rather than about which site this is (TD-82).
    if (!baseHost || siteHost(resolved) !== baseHost) return true;
    if (knownNav.has(pageKey(resolved))) return true;
    // A path the USER typed themselves is authoritative — they know their own app's routes,
    // and that's a stated fact rather than a guess. Length > 1 so a bare "/" can't match
    // incidentally on essentially every prompt.
    const path = (() => { try { return new URL(resolved).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
    return path.length > 1 && sourcePrompt.includes(path);
  };
  /**
   * The paths to offer as alternatives when a navigate target is refused.
   *
   * Built from the SAME key the check uses, and with the rejected path removed. The old version
   * did neither, and produced the single most confusing message this pipeline has emitted:
   *
   *     Step s4 navigates to "/s/", which is not a page ... Known paths: /s/, /vetforce/s/login/.
   *
   * — refusing a path and then listing it as known, on run
   * `2026-09-06T15-42-48-000Z-61e01731`. A hint that contradicts its own verdict is worse than no
   * hint: the model cannot act on it, so it re-sends the same answer until the attempt budget is
   * gone. If removing the rejected path leaves nothing to suggest, say so plainly instead of
   * offering a list that is now empty. TD-82.
   */
  const knownPathsHintFor = (rejectedUrl: string): string => {
    const rejectedKey = (() => {
      const resolved = resolveHref(appModel.baseUrl, rejectedUrl);
      return resolved ? pageKey(resolved) : null;
    })();
    const paths = appModel.pages
      .filter(p => !rejectedKey || pageKey(p.url) !== rejectedKey)
      .map(p => { try { return new URL(p.url).pathname || "/"; } catch { return null; } })
      .filter((p): p is string => !!p);
    const unique = Array.from(new Set(paths)).slice(0, 6);
    return unique.length ? `Known paths: ${unique.join(", ")}.` : "No other page in the model has a different path.";
  };
  // Which page the flow is actually on at each step — an element grounded only against
  // some OTHER page (never the current one) shouldn't pass just because it exists
  // somewhere in the model. Falls back to allElements wherever the cursor is unresolved.
  const trail = trackPages(ir, appModel);
  const onlySet = scope?.onlyIndexes ? new Set(scope.onlyIndexes) : null;
  /** The captured screen step `index` is on, or undefined when none applies (D-52): the latest
   *  `screenAt` entry at or before it, ended by a navigate or by the page cursor moving to another
   *  URL in between. */
  const screenAtStep = (index: number): { page: PageModel; at: number; key: string } | undefined => {
    let best: { at: number; key: string } | undefined;
    for (const s of scope?.screenAt ?? []) if (s.at <= index && (!best || s.at >= best.at)) best = s;
    if (!best) return undefined;
    for (let k = best.at + 1; k <= index; k++) if (ir.steps[k]?.action === "navigate") return undefined;
    const page = findScreen(appModel, best.key);
    const cursor = trail.pageAt[index];
    if (!page || (cursor && pageKey(cursor.url) !== pageKey(page.url))) return undefined;
    return { page, at: best.at, key: best.key };
  };
  /**
   * The controls on the captured screen step `index` is on (disabled ones marked), as a sentence for a rejection
   * message — or "" when no screen applies. The prompt's application model carries only the entry
   * page (toMicroModel, TD-122), so without this a model told "X is not on this screen" has nothing
   * to choose the missing step from. Names come from the capture, never invented (TD-124).
   */
  const screenControlsHint = (index: number, exclude = ""): string => {
    const scr = screenAtStep(index);
    if (!scr) return "";
    const names = Array.from(new Set(scr.page.elements
      .filter((e) => e.visible !== false && e.name?.trim()
        && SCREEN_CONTROL_ROLES.has(norm(e.role))
        && norm(e.name) !== norm(exclude))
      // Disabled ones too, marked: "Express Interest (disabled)" beside "Select for EOI" is what
      // tells the model the order the page expects.
      .map((e) => `${e.role} "${e.name}"${e.enabled === false ? " (disabled)" : ""}`))).slice(0, 25);
    return names.length ? ` Controls on the screen the flow is on at this step: ${names.join(", ")}.` : "";
  };
  /** For a step whose target is missing from its captured screen: what IS there, and the likely
   *  cause — the step that opens the screen holding it was left out (TD-124). */
  const missingOnScreenHint = (index: number): string => {
    const controls = screenControlsHint(index);
    if (!controls) return "";
    // TD-142: when the screen map knows which click leads from here to the screen holding it, say
    // so — "a step is probably missing" alone left the model guessing which one.
    const scr = screenAtStep(index);
    const t = ir.steps[index]?.target;
    const route = scr && scope?.mapRoute ? scope.mapRoute(scr.key, t?.name ?? t?.text ?? "") : undefined;
    return ` It is not on the screen the flow is on at this step (seen in a live capture after the steps ` +
      `before it). ` + (route ?? (unclickedButtonsHint(index) || `A step that opens the screen holding it is ` +
      `probably missing before this one — for example clicking a button that opens the form.`)) +
      emptyScreenFieldsHint(index) + controls;
  };
  /**
   * TD-151: the fields the current screen shows that NO step fills. Run 2026-10-17T18-29-40: the case
   * left out the contact fields (the request never mentioned them), the IR clicked "Next" on an empty
   * form, the form stayed put, and the hint only said "click Next" — which had been done. Fields come
   * from the live capture (text boxes, dropdowns, number boxes); a field counts as filled when any step
   * before this one fills or selects it by name. Wording only.
   */
  const emptyScreenFieldsHint = (index: number): string => {
    const scr = screenAtStep(index);
    if (!scr) return "";
    const filled = new Set(ir.steps.slice(0, index).filter((s) => s.action === "fill" || s.action === "select" || s.action === "check")
      .map((s) => norm(s.target?.name ?? s.target?.label ?? "")));
    const empty = [...new Set(scr.page.elements.filter((e) => (TEXT_ENTRY_ROLES.has(norm(e.role)) || norm(e.role) === "combobox")
      && e.name?.trim() && e.visible !== false && e.enabled !== false && !filled.has(norm(e.name)))
      .map((e) => `${e.role} "${e.name}"`))].slice(0, 8);
    return empty.length
      ? ` This screen still shows fields no step fills: ${empty.join(", ")}. A form does not move on while its ` +
        `required fields are empty, so fill them first (with realistic test data where the test case gives none), ` +
        `then click its forward button.`
      : "";
  };
  /**
   * TD-149: with no screen map yet (a site's first run), name the buttons this screen brought that no
   * step has clicked since it appeared. Run 2026-10-16T17-12-23 (live, empty map): screen 1 of a
   * 3-screen form was filled, then a screen-2 field was looked for without clicking "Next"; the
   * generic hint listed ~25 controls, header ones included, and the retry still left "Next" out.
   * "Brought" = not on the screen before it (header and page chrome repeat, so they drop out). From
   * the captures and the steps only; never a button-name list.
   */
  const unclickedButtonsHint = (index: number): string => {
    const scr = screenAtStep(index);
    if (!scr) return "";
    // Chrome = what the page had before the flow's FIRST screen. Not the screen just before this one:
    // every screen of a wizard has its own "Next", and comparing with the previous screen dropped it
    // (cold-start run 2026-10-16T17-54-21 listed only "Investment" and "Back").
    const earliest = (scope?.screenAt ?? []).filter((s) => s.at < scr.at).sort((a, b) => a.at - b.at)[0];
    const prevPage = earliest ? findScreen(appModel, earliest.key) : trail.pageAt[scr.at];
    const before = new Set((prevPage?.elements ?? []).filter((e) => norm(e.role) === "button").map((e) => norm(e.name)));
    const clicked = new Set(ir.steps.slice(scr.at, index).filter((s) => s.action === "click" || s.action === "press")
      .map((s) => norm(s.target?.name ?? "")));
    const fresh = [...new Set(scr.page.elements.filter((e) => norm(e.role) === "button" && e.name?.trim()
      && e.visible !== false && e.enabled !== false && !before.has(norm(e.name)) && !clicked.has(norm(e.name)))
      .map((e) => e.name))].slice(0, 8);
    return fresh.length
      ? `No step since this screen appeared clicks the buttons it brought: ${fresh.map((n) => `button "${n}"`).join(", ")}. ` +
        `On a form spread over several screens, the next screen's fields appear only after its forward button ` +
        `is clicked: add that click before this step, and put this step after it.`
      : "";
  };
  /** TD-145: after a submitted form left fields empty, name them — a required one keeps the form
   *  from moving on, which is why this step's element never appears. */
  const unfilledHint = (index: number): string => {
    const { empty, submit } = unfilledFormFields(ir, appModel, index);
    let out = "";
    if (empty.length) {
      out += ` The steps before it leave ${empty.map((f) => `"${f}"`).join(", ")} empty in the form they fill. A ` +
        `required field left empty keeps the form from moving on, so this element never appears: fill every ` +
        `field the form needs, splitting a value the test case gives (a full name into first and last name) where needed.`;
    }
    if (submit) {
      out += ` That form is never submitted: no step clicks its "${submit}" button after filling it, so the page ` +
        `holding this element is never reached. Click "${submit}" first.`;
    }
    return out;
  };
  /**
   * An acting step bound to an element its screen shows as DISABLED (D-52, TD-121). Clicking it
   * waits out the whole timeout at run time ("element is not enabled"). Two cases:
   *   - the screen was captured at an EARLIER step: anything since (a fill, a choice) may have
   *     enabled it, so ask for a capture at exactly this step — kind "screen-uncaptured";
   *   - the screen was captured AT this step: it really is disabled when the flow gets here, so a
   *     step that enables it is missing. Rejected with that reason, for the model to fix.
   * Only with a captured screen: a discovery snapshot predates every step, and a form's Submit is
   * routinely disabled until it is filled in.
   */
  const disabledTargetErr = (index: number, step: Step, matched: Element | null | undefined) => {
    const scr = screenAtStep(index);
    if (!scr || !matched || matched.enabled !== false || !ACTION_STEPS.has(step.action)) return null;
    if (scr.at !== index) {
      return {
        index, kind: "screen-uncaptured" as const,
        message: `Step ${step.id} acts on ${matched.role} "${matched.name}", which was disabled when this ` +
          `screen was captured; capturing it again at this step.`,
      };
    }
    return {
      index, kind: "disabled-target" as const,
      message: `Step ${step.id} ${step.action}s ${matched.role} "${matched.name}", but that element is ` +
        `DISABLED at this point in the flow (seen in a live capture of the page after the steps before ` +
        `it). Clicking it can never work. Something earlier in the flow must enable it — a step is ` +
        `missing before this one (for example choosing or selecting an item on the page first). Add ` +
        `the step that enables it before this step.` + screenControlsHint(index, matched.name),
    };
  };
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    const t = step.target;
    // Not one of the steps this pass is verifying. Skip it without any lookup — re-matching it by
    // name against a model built from wherever the walk happened to land is how an untouched step
    // gets rejected for being absent from a page it was never on. TD-86.
    //
    // THIS WAS ORIGINALLY "not listed AND already grounded", and a live run proved that too
    // narrow. Adding `Click on button "Admin"` to the LMS login case still failed — on step 2,
    // the email box — because that case's login steps carry no `css` at all, so the second
    // condition never held and they were re-matched against the post-login dashboard, which
    // naturally has no login form on it. The user's edit was blamed for a step they never
    // touched, which is the entire defect.
    //
    // Skipping regardless is correct for an EDIT: every unlisted step was already in the saved
    // case, so it was accepted once and this save is not the moment to re-litigate it. The
    // trade-off, stated plainly: an untouched step that was never grounded STAYS never grounded.
    // That is the status quo for it, not a regression — and the alternative is refusing edits to
    // any case with an ungrounded step anywhere in it.
    //
    // A genuinely NEW step is always listed (it is a changed row by construction), so nothing
    // unverified enters the case through this door. The fresh-run compile path passes no scope
    // and still checks every step.
    if (onlySet && !onlySet.has(index)) continue;
    // The DOM may have changed under this step (a click on a button, not a link) and that screen
    // has not been captured yet. Before the selector skip below: a selector known from ANOTHER
    // screen of the same URL would otherwise wave the step through. D-52.
    if (scope?.captureBefore?.has(index)) {
      return {
        index,
        kind: "screen-uncaptured",
        message: `Step ${step.id} runs after a click that can change the screen without changing the ` +
          `URL; that screen has not been captured yet.`,
      };
    }
    const screenPage = screenAtStep(index)?.page;
    // TD-147: a url_contains checked against the URL a live capture reached at this very step. Run
    // 2026-10-16T12-14-09 asserted "/project" after "Explore Projects", which scrolls the home page;
    // the URL never changes, so the test could only fail. Salesforce screen mode only (screenAt).
    if (step.action === "assert" && step.assertion === "url_contains" && screenPage && screenAtStep(index)?.at === index) {
      const want = (step.value ?? t?.url ?? "").trim();
      if (want && !screenPage.url.toLowerCase().includes(want.toLowerCase())) {
        return {
          index,
          message: `Step ${step.id} asserts url_contains "${want}", but after the steps before it the page is at ` +
            `"${screenPage.url}" (seen in a live capture at this step): that click does not lead to such a URL. ` +
            `Assert something visible on the screen it does show instead.` + screenControlsHint(index),
        };
      }
    }
    // A verified selector from a DIFFERENT screen of this URL resolves to nothing (or to a hidden
    // twin) at run time. Not grounded: fall through to the name match on this screen, which either
    // finds this screen's own control or reports the step as missing from it.
    if (screenPage && t?.css && knownSelectors.has(t.css.toLowerCase())
      && !selectorsOf(screenPage.elements).has(t.css.toLowerCase())) {
      if (!t.role && !t.text) {
        return {
          index,
          message: `Step ${step.id} targets css="${t.css}", which is on a different screen of this ` +
            `page than the one the flow is on at that step. Target an element of the current screen.`,
        };
      }
      delete t.css;
      delete t.testId;
      delete t.frame;
    }
    // A target carrying a selector discovery verified is already grounded — that IS the
    // proof the element exists, and it's stronger than a role+name match. Covers the
    // selectors a user names in their own request.
    if (t?.css && knownSelectors.has(t.css.toLowerCase())) {
      // On a captured screen, the screen's own element for this selector (its state is the one
      // that holds at this step), else the model-wide one.
      const known = (screenPage?.elements.find((e) => e.css?.toLowerCase() === t.css!.toLowerCase()))
        ?? bySelector.get(t.css.toLowerCase());
      const hiddenErr = known && hiddenVisibleAssertError(index, `css="${t.css}"`, known);
      if (hiddenErr) return hiddenErr;
      const disErr = disabledTargetErr(index, step, known);
      if (disErr) return disErr;
      // A verified selector inside an iframe resolves only within that frame, so the frame comes
      // with it — from the element discovery verified, never from the model (Target.frame).
      if (known?.frame && !t.frame) t.frame = known.frame;
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
          `${knownPathsHintFor(t.url)}`,
      };
    }
    // Where to look for this step's element, best evidence first:
    //   1. the page a WALK actually reached for this step (an observed fact)
    //   2. the page `trackPages` believes the flow is on (an inference)
    //   3. every page in the model (a fallback that can match the right name on the wrong page)
    //
    // (1) exists because (2) gives up after any click that is not a plain link, and (3) is how an
    // untouched "Save" can silently bind to a Save button somewhere else entirely. TD-86.
    const reached = scope?.reachedUrlAt?.get(index);
    const reachedPage = reached
      ? appModel.pages.find((p) => pageKey(p.url) === pageKey(reached))
      : undefined;
    // A captured screen beats all three (D-52): it is an observed fact about this exact step, and
    // the URL-keyed evidence cannot tell one screen of a URL from another.
    //
    // Within a screen that has a dialog open, the dialog's own control wins when it has one by the
    // step's exact name: behind a modal the page is inert, and Lightning puts "Save", "New" and
    // "Cancel" both in the dialog and on the page behind it. Exact name only — anything looser
    // looks at the whole screen as before.
    const screenDialog = screenPage?.elements.filter((e) => e.visible !== false
      && (norm(e.containerRole ?? "") === "dialog" || norm(e.pageSection ?? "") === "dialog")) ?? [];
    const wanted = norm(t?.name ?? t?.text ?? "");
    const dialogFirst = !!wanted && screenDialog.some((e) => norm(e.name) === wanted);
    const elements = (dialogFirst ? screenDialog : undefined)
      ?? screenPage?.elements ?? reachedPage?.elements ?? trail.pageAt[index]?.elements ?? allElements;
    // The same page evidence, as pages, for the field-hint guard (D-48).
    const stepPage = screenPage ?? reachedPage ?? trail.pageAt[index] ?? null;
    const stepPages = stepPage ? [stepPage] : appModel.pages;

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
      const preferVisible = step.assertion !== "hidden";
      const best = bestNameMatch(elements, hint, stripGlyphs(hint), roleOk, preferVisible, true);
      // LS-1: the duplicate the step's `nth` means, not the first one found.
      const found = best ? nthTwin(elements, best, t.nth) : null;
      if (found) {
        const disErr = disabledTargetErr(index, step, found);
        if (disErr) return disErr;
        // Upgrade the weak target into the verified one, exactly as the role+name path does
        // below: real role, model's literal name, plus whatever deterministic identity
        // discovery captured. "Name" becoming textbox "Full Name" happens here.
        t.role = found.role;
        t.name = found.name;
        delete t.text;
        if (found.css && !t.css) t.css = found.css;
        if (found.testId && !t.testId) t.testId = found.testId;
        if (found.frame && !t.frame) t.frame = found.frame;
        rebaseNth(t, found, elements);
        continue;
      }
      return {
        index,
        kind: "text-target",
        message: `Step ${step.id} ${step.action}s an element identified only by the text ` +
          `"${t.text}", which no element in the application model matches. Target it by ` +
          `accessibility role + name from the application model instead — { "text": ... } is ` +
          `for asserting on content that appears only after an action, never for choosing ` +
          `what to click or fill.` + missingOnScreenHint(index),
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

    if (!t?.role || !t?.name) {
      // A label-, placeholder- or name-only fill/select/check skips every name check below, and is
      // exactly what reaches the generator as field(page, hint). Prove the hint first (D-48).
      const hintErr = fieldHintError(step, index, stepPages);
      if (hintErr) return hintErr;
      continue; // navigate / text-only / wait steps
    }
    const role = norm(t.role);
    const name = norm(t.name);

    // Rank candidates instead of taking the first substring hit. `en.includes(name)` alone
    // grounded "Continue" to "Continue Shopping" — a different control on a different page —
    // because that happened to come first in element order. An exact match must always beat
    // a partial one, and among partials the closest-length name is the least wrong.
    const sn = stripGlyphs(name);
    const preferVisible = step.assertion !== "hidden"; // LS-2, see bestNameMatch
    const preferEnabled = ACTION_STEPS.has(step.action);
    let matched = bestNameMatch(elements, name, sn, (r) => r === role, preferVisible, preferEnabled);
    // Exact role found nothing — try again across the compatible-role group, but only when
    // the STEP'S OWN role is itself one of those roles (never widen a heading/textbox search).
    // An exact-role match always wins when one exists; this only runs when the pass above
    // found nothing at all.
    if (!matched && CLICKABLE_ROLE_GROUP.has(role)) {
      matched = bestNameMatch(elements, name, sn, (r) => CLICKABLE_ROLE_GROUP.has(r), preferVisible, preferEnabled);
    }
    // LS-1: the duplicate the step's `nth` means, not the first one found.
    if (matched) matched = nthTwin(elements, matched, t.nth);
    // TD-141: no element has that NAME, but one has it as its test id or id, exactly. Six buttons
    // all named "Add to cart" leave the model one way to say which: the id discovery recorded
    // ("add-to-cart-sauce-labs-backpack"), and it used it as the name. That identifies one element
    // without guessing, so the step is pinned to it (its css follows below), and `nth` goes: the id
    // already chose. Exact equality only, and only when the name found nothing.
    if (!matched && t.name.trim()) {
      const want = t.name.trim().toLowerCase();
      const roleOk = (r: string) => norm(r) === role || (CLICKABLE_ROLE_GROUP.has(role) && CLICKABLE_ROLE_GROUP.has(norm(r)));
      const byId = elements.filter((e) => roleOk(e.role) && (e.css || e.testId)
        && (e.testId?.toLowerCase() === want || e.id?.toLowerCase() === want));
      // The same element captured on two pages (or twice on one) is still one element.
      if (byId.length && byId.every((e) => (e.css ?? e.testId) === (byId[0].css ?? byId[0].testId))) {
        matched = byId[0];
        delete t.nth;
        console.log(`[ir] step ${step.id}: "${t.name}" is an element's id -> ${matched.role} "${matched.name}"`);
      }
    }
    // TD-143: a field named by its words, not its exact label: "zip code" for "Zip/Postal Code"
    // (run 2026-10-16T09-38-53, saucedemo checkout; rejected three times). Text-entry fields only,
    // at least two words, every word whole in the field's name, and exactly ONE such field: with
    // two, which one is meant is a guess, and the step is rejected as before.
    if (!matched && TEXT_ENTRY_ROLES.has(role)) {
      const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (words.length >= 2) {
        const hits = elements.filter((e) => norm(e.role) === role && e.visible !== false && e.name
          && words.every((w) => hasWholeWords(norm(e.name), w)));
        const one = new Set(hits.map((e) => e.css ?? e.testId ?? e.name));
        if (hits.length && one.size === 1) {
          matched = hits[0];
          console.log(`[ir] step ${step.id}: "${t.name}" -> the one ${matched.role} whose name has those words: "${matched.name}"`);
        }
      }
    }
    // TD-125: a `select` whose dropdown is not on the captured screen, where the screen's control
    // of that name is a TEXT BOX. The request said "in the Min Budget (AED) combobox, select 40";
    // the live page has an <input> there, so the model followed the wording and the step was
    // rejected until TD-74 cut the case short. Typing the value is what the step means, so it
    // becomes a `fill` on that box — the same in-place self-correction as the name and role ones
    // below. Decided only by role + accessible name from the screen capture, never page text.
    // Salesforce screen mode only (D-52): an ordinary run is unchanged. A real dropdown of that
    // name always wins, because this runs only when the step's own role matched nothing.
    if (!matched && screenPage && step.action === "select") {
      const box = bestNameMatch(elements, name, sn, (r) => TEXT_ENTRY_ROLES.has(r), preferVisible, preferEnabled);
      if (box) {
        matched = nthTwin(elements, box, t.nth);
        step.action = "fill";
        console.log(`[ir] step ${step.id}: select on a textbox -> fill (the page's field is a text box)`);
      }
    }
    // TD-125, part B: the "dropdown" is a group of buttons ("Purpose": "Self Use" / "Investment"),
    // so the step's VALUE names the control to press — among the visible, enabled buttons and
    // radios on the screen. An exact name wins. Failing that, a WHOLE-WORD partial match either way
    // ("Self" in "Self Use"), but only when exactly one control matches: with two, which one is
    // meant is a guess, so the step is rejected naming them (TD-126).
    if (!matched && screenPage && step.action === "select" && step.value) {
      const want = norm(step.value);
      const pressable = elements.filter((e) => (norm(e.role) === "button" || norm(e.role) === "radio")
        && e.visible !== false && e.enabled !== false && norm(e.name));
      const exact = pressable.filter((e) => norm(e.name) === want);
      const options = exact.length ? exact
        : pressable.filter((e) => hasWholeWords(norm(e.name), want) || hasWholeWords(want, norm(e.name)));
      if (options.length > 1) {
        return {
          index,
          message: `Step ${step.id} selects "${step.value}" in "${t.name}", which is not a dropdown on this ` +
            `screen; it is a group of buttons, and ${options.length} of them match "${step.value}": ` +
            `${options.map((e) => `${e.role} "${e.name}"`).join(", ")}. Click the one that is meant, by ` +
            `its exact name, instead of selecting.`,
        };
      }
      if (options.length === 1) {
        matched = options[0];
        step.action = "click";
        delete step.value;
        delete t.nth; // counted the dropdowns the model imagined, not these buttons
        console.log(`[ir] step ${step.id}: select on a button group -> click ${matched.role} "${matched.name}"`);
      }
    }
    // TD-152: a click on a HEADING when the same page has a LINK of exactly that name means the link —
    // a product card's title is a heading wrapping its link. Clicking the heading does open the page at
    // run time, but the flow tracker only follows links, so the next step was looked for on the page
    // the flow had left (demoblaze, run 2026-10-17T18-46-08: "Add to cart" not found after clicking
    // heading "Samsung galaxy s6"). Exact name, and exactly one such link on the page.
    if (matched && step.action === "click" && norm(matched.role) === "heading") {
      const links = elements.filter((e) => norm(e.role) === "link" && norm(e.name) === norm(matched!.name) && e.visible !== false);
      if (links.length === 1) {
        console.log(`[ir] step ${step.id}: click on heading "${matched.name}" -> its link of the same name`);
        matched = links[0];
        delete t.nth;
      }
    }
    const matchedName = matched?.name ?? null;
    if (!matchedName) {
      const pageUrl = trail.pageAt[index]?.url ?? appModel.baseUrl;
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" name="${t.name}", which is not present under any compatible role on page "${pageUrl}". ` +
          `If this element loads dynamically, verify that the page completed hydration/API rendering; ` +
          `if it requires role-based access (e.g. Admin), verify that valid authorized credentials were provided.` +
          (missingOnScreenHint(index) || similarElementsHint(stepPage && elements !== allElements ? [{ url: stepPage.url, elements }] : appModel.pages, role, name)) + unfilledHint(index),
      };
    }
    const disErr = disabledTargetErr(index, step, matched);
    if (disErr) return disErr;
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
    // The iframe path, copied like css and testId from the element discovery verified — never
    // written by the model (Target.frame). Only set when the element has one, so a target in the
    // top-level document stays key-for-key what it was.
    if (matched?.frame && !t.frame) t.frame = matched.frame;
    // LS-1: `nth` now indexes the elements sharing the css just attached — or goes, if it is unique.
    if (matched) rebaseNth(t, matched, elements);
    // Checked LAST, after the self-correction above: a matched element with a css is emitted by
    // selector and never reaches field(); one without is emitted as field(page, <its name>), and
    // a substring match can have just renamed the step to something that is no field's name —
    // `{role:"textbox", name:"Password"}` became "passwordShown" exactly that way (D-48).
    const hintErr = fieldHintError(step, index, stepPages);
    if (hintErr) return hintErr;
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
  // TD-132 (Salesforce runs): a case whose structured category is "valid" is a success case, full
  // stop — the wording regexes below are for cases that carry no category. Run 2026-10-15T18-02-40:
  // a category-"valid" case expected "...the user is not left on the BLANK form screen", NEGATIVE_CASE
  // matched "blank", "Thank You" was rejected twice as a contradiction, and the model fell back to a
  // url_contains that proved nothing — on a flow that had in fact reached the Thank You page.
  if (testCase.category === "valid" && currentRunTargetApp() === "salesforce") return null;
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
    // Two shapes that can never be a page's URL, whatever the model clicked before them. Seen on a
    // real run (2026-10-13T11-06-23-259Z-5afedf16): `url_contains "tel:+91"` after clicking a
    // phone link — a tel:/mailto: link hands off to another app and the page URL never changes —
    // and `url_contains "#"`, true of nothing but a URL fragment the browser may drop.
    const raw = (step.value ?? step.target?.url ?? "").trim();
    if (/^(tel|mailto|sms|javascript):/i.test(raw)) {
      return {
        index,
        message: `Step ${step.id} asserts url_contains "${raw}", but a ${raw.split(":")[0]}: link never ` +
          `changes the page's URL — the browser hands it to another application. Assert something ` +
          `visible on the page instead, or end the case after the click.`,
      };
    }
    if (raw && !/[\p{L}\p{N}]/u.test(raw)) {
      return {
        index,
        message: `Step ${step.id} asserts url_contains "${raw}", which names no page — it is only ` +
          `punctuation. Assert the real destination path, or something visible on the page.`,
      };
    }
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
// `check` is deliberately NOT in this alternation. It is the one verb in the list that means
// opposite things in the two vocabularies this function straddles:
//
//   case prose:      "Check that the heading is visible"   -> an ASSERTION
//   STEP_VOCABULARY: `Check checkbox "Name"`               -> an ACTION (tick a checkbox)
//
// With bare `check` here, a case whose steps are three "Check that ..." verifications counted as
// three ACTIONS, while the IR correctly emitted three `assert` steps and therefore zero actions —
// so the guard rejected a correct IR on all four attempts and the run died. Observed on a real run
// against a blog page (`qable.io/blog/happy-path-testing`); this is TECH_DEBT.md TD-01's open
// class, and the second run-killing false positive it has produced.
//
// CHECK_ACTION_LINE below restores the genuine action case by anchoring to what STEP_VOCABULARY
// says an action-`check` looks like: a checkbox is named. "Check the Terms checkbox" still counts;
// "Check that X is visible" never does. Anchoring to the system's own closed grammar rather than to
// prose is what CLAUDE.md asks for — structure over wording.
const CASE_ACTION_LINE = /\b(fill|enter|type|input|provide|supply|click|press|tap|select|submit|sign ?in|log ?in)\b/i;
/** An English "check" that is an ACTION: something in the same line names a checkbox. */
const CHECK_ACTION_LINE = /\bcheck(?:s|ed|ing)?\b[^.]*\bcheck ?box(?:es)?\b/i;
const IR_ACTION_KINDS = new Set(["click", "press", "fill", "select", "check"]);

export function missingActions(ir: IR, testCase: TestCase): { message: string } | null {
  const steps = testCase.steps ?? [];
  // Quoted spans are the case's DATA, not its instructions: a page heading, a value to type, a
  // button's visible label. Regexing them for action verbs is how TD-01's original false positive
  // happened — a correct IR rejected because the page's own heading contained the word "Click".
  // Stripped before any test below, so only the case's own wording is read.
  const unquoted = (s: string) => s.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
  const text = [testCase.title, ...steps, testCase.expected ?? ""].map(unquoted).join(" ").toLowerCase();
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
  // Same quote-stripping as above, and for the same reason: a step whose quoted VALUE contains
  // "click" is not a step that clicks.
  const caseActionLines = steps
    .map(unquoted)
    .filter(s => CASE_ACTION_LINE.test(s) || CHECK_ACTION_LINE.test(s)).length;
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
  const { pathname, search } = new URL(entryUrl);
  const entryPath = pathname + search || "/";
  // The ORIGIN comes from the app model, not from what the user typed: discovery sets
  // `appModel.baseUrl` to where the browser actually landed, so this is the origin the pages in
  // the model genuinely live on. Using the entered origin here is what put `http://` into
  // `meta.baseUrl` — and therefore into the generated `page.goto` — for a site that serves
  // `https://` (TD-82). The PATH still comes from the entered URL: that is the page the user
  // asked about, and a redirect of the origin does not change which page they meant.
  const origin = (() => {
    try { return new URL(appModel.baseUrl).origin; } catch { return new URL(entryUrl).origin; }
  })();

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

  const baseSystem =
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
  // "" unless this is a Salesforce run — then `system`, and the cache key that hashes it, differ.
  const system = baseSystem + salesforceGuidance("ir");

  // Keyed AFTER `system` is built, and on `system` itself. The disk half of this cache never
  // expires, so anything the key omits is served stale forever — and the prompt was the
  // largest such omission: editing a rule changed nothing for any input already seen, which
  // made two verification runs look like the fix hadn't worked. Hashing the prompt text is
  // self-maintaining in a way a hand-bumped version constant is not: change a rule, get a new
  // key, with nobody having to remember. The model name is in for the same reason.
  // `entryUrl` is a REAL input to the prompt — `buildUser` derives `entryPath` from it and the
  // system prompt states that path as the navigate target — but it was never in the key. Two runs
  // with the same test case and the same model but different entry pages would therefore share a
  // cache entry and the second would get an IR built for the first one's page. The disk half of
  // this cache never expires, so it could not heal on its own. `CLAUDE.md`'s cache rule,
  // `TECH_DEBT.md` TD-22, `DECISIONS.md` D-10 — the same omission those record, a third time.
  //
  // `appModel` is serialised whole, so the normalised `baseUrl` is already in the key
  // transitively: normalising it changes the key by construction and no stale pre-TD-82 entry
  // can be served to a post-TD-82 run.
  // Handoff Phase 2: the site's stored screen map (SCREEN_MAP_ENABLED, Salesforce runs only). Hints
  // for the prompt, never grounding evidence (D-54). Loaded before the key because it changes the
  // prompt; flag off or map empty, the key is byte-identical to before.
  const useScreenMap = currentRunTargetApp() === "salesforce" && screenMapEnabled();
  const storedMap = useScreenMap ? loadScreenMap(origin, creds, new Date()) : undefined;
  const storedScreens = storedMap?.screens ?? [];
  const mapSignature = storedScreens.length
    ? [JSON.stringify([storedScreens.map((s) => [s.key, s.controls]), storedMap!.edges.map((e) => [e.from, e.action, e.to])])]
    : [];
  if (storedScreens.length) console.log(`[ir] screen map: ${storedScreens.length} screens, ${storedMap!.edges.length} edges stored for ${storedMap!.site}`);
  const cacheKey = makeCacheKey(
    JSON.stringify(testCase), sourcePrompt, JSON.stringify(appModel), credKey,
    entryUrl, system, cacheModelDimension("main"), llmCacheDimension("main"), llmCacheVersion(), ...mapSignature,
    // TD-139: an IR cached before the request-values check could replay one that drops the values.
    ...(currentRunTargetApp() === "salesforce" ? ["ir-values:1"] : []));
  const cached = llmCacheGet<IR>(cacheKey);
  if (cached) return { ir: cached, updatedAppModel: appModel };

  // TD-122: the screens a live capture has reached during THIS compile, by key, in the order they
  // were first captured (a re-capture that replaces a screen swaps its key in place). The prompt's
  // application model is the entry page only, so without these a model writing a later screen's
  // steps borrows names from the entry page — run 2026-10-15T03-01-14 asked for combobox
  // "Budget Range", the HOME page's search filter, for the EOI form's "Min Budget (AED)".
  const capturedScreenKeys: string[] = [];
  /** On a RETRY of a Salesforce run only: each captured screen's control names, as captured — names
   *  only, at most SCREEN_NAMES_CAP per screen, and at most `maxScreens` screens, the NEWEST kept (the
   *  screen the failing step is on is the last one reached). "" with 0 screens otherwise, so every
   *  other prompt is unchanged (tests/fixtures/salesforceTarget/retry-prompt-ordinary.json). */
  const SCREEN_NAMES_CAP = 30;
  const SCREENS_CAP = 8;
  /** A screen's controls as the block (and the screen map) show them: named, of a control role, a
   *  dialog's own controls first (screenElements), deduped, at most SCREEN_NAMES_CAP. */
  const controlsOf = (p: PageModel): ScreenMapControl[] => {
    const seen = new Set<string>();
    const out: ScreenMapControl[] = [];
    for (const e of screenElements(p.elements)) {
      if (!e.name?.trim() || !SCREEN_CONTROL_ROLES.has(norm(e.role))) continue;
      const id = `${e.role}\u0000${e.name}\u0000${e.enabled === false}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ role: e.role, name: e.name, ...(e.enabled === false ? { enabled: false } : {}) });
    }
    return out.slice(0, SCREEN_NAMES_CAP);
  };
  const namesOf = (controls: ScreenMapControl[]) =>
    controls.map((c) => `${c.role} "${c.name}"${c.enabled === false ? " (disabled)" : ""}`).join(", ");
  const capturedScreensBlock = (model: AppModel, maxScreens = SCREENS_CAP): { text: string; screens: number } => {
    if (currentRunTargetApp() !== "salesforce") return { text: "", screens: 0 };
    const lines = new Set<string>();
    // Phase 2: stored screens first (oldest first), so the cap below drops them before this run's.
    // A stored screen this compile has captured again is shown once, as captured.
    const captured = capturedScreenKeys.map((k) => findScreen(model, k)).filter((p): p is PageModel => !!p);
    const storedLines = new Set<string>();
    for (const s of [...storedScreens].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))) {
      const fp = { url: s.url, fp: { key: s.key, title: s.title, tab: s.tab, labels: s.labels } };
      if (captured.some((p) => sameScreen({ url: p.url, fp: fingerprintOf(p) }, fp)) || !s.controls.length) continue;
      const openedBy = Array.from(new Set(storedMap!.edges.filter((e) => e.to === s.key)
        .map((e) => `${e.action.role} "${e.action.name}"`))).slice(0, 3);
      const line = `- ${s.url}${s.title ? ` ("${s.title}")` : ""}: ${namesOf(s.controls)}` +
        `${openedBy.length ? `; opened by clicking ${openedBy.join(" or ")}` : ""} (from an earlier run — may have changed)`;
      lines.add(line);
      storedLines.add(line);
    }
    for (const p of captured) {
      const controls = controlsOf(p);
      if (controls.length) lines.add(`- ${p.url}${p.title ? ` ("${p.title}")` : ""}: ${namesOf(controls)}`);
    }
    // Not `.slice(-maxScreens)`: at 0 that is `.slice(-0)`, which keeps everything.
    const kept = [...lines].slice(Math.max(0, lines.size - Math.max(0, maxScreens)));
    if (!kept.length) return { text: "", screens: 0 };
    const header = kept.some((l) => storedLines.has(l))
      ? `\nScreens of this application, with the controls each one shows (names exactly as captured). Lines marked ` +
        `"from an earlier run" were seen by an earlier run on this site and may have changed; the others were ` +
        `reached by your earlier steps in this run. A step on one of these screens must use a name from THAT ` +
        `screen, never a name from the application model's page or from another screen, and a screen that is ` +
        `"opened by clicking" a control needs that click first:\n`
      : `\nScreens your earlier steps reached in a live run, in order, with the controls each one shows ` +
        `(names exactly as captured). A step on one of these screens must use a name from THAT screen, ` +
        `never a name from the application model's page or from another screen:\n`;
    return { text: `${header}${kept.join("\n")}\n`, screens: kept.length };
  };

  const buildUser = (model: AppModel, correction?: string) => {
    // Only send pages relevant to this test case: the entry page + pages whose
    // concepts or URL overlap with the test feature. Never send the full model.
    const entryHost = siteHost(entryUrl);
    const featureLower = testCase.feature.toLowerCase();
    const relevantPages = model.pages.filter(p => {
      // Always include the entry page. Compared by HOST, not by an origin string prefix: with a
      // redirected site the entered origin is `http://…` and every page is `https://…`, so
      // `startsWith` matched nothing and the entry page — the one page always worth sending —
      // was silently dropped from the prompt (TD-82, same root cause as the navigate guard).
      if (entryHost && siteHost(p.url) === entryHost && entryPath && p.url.includes(entryPath)) return true;
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
    // Host, not origin prefix — third occurrence of the same scheme trap in this function
    // (TD-82). With a redirected site this matched nothing, so the entry page never became the
    // lead page and the model was handed the app's pages in discovery order instead.
    const entryPage = entryPath !== "/"
      ? pagesToSend.find(p => siteHost(p.url) === entryHost && p.url.includes(entryPath))
      : pagesToSend.find(p => pageKey(p.url) === pageKey(entryUrl));
    const leadPage = targetPage ?? entryPage;
    const orderedPages = leadPage ? [leadPage, ...pagesToSend.filter(p => p !== leadPage)] : pagesToSend;

    // Filter elements: only named interactive elements (links, buttons, menuitems,
    // textboxes, checkboxes, headings) that a test could actually act on. Drops thousands of
    // anonymous list/div/container nodes that bloat the prompt without helping the LLM.
    //
    // "Named and interactive" was not enough on its own — TD-62. It let hidden form inputs and
    // skip-links through as ordinary controls, and toMicroModel then caps at 30, so they competed
    // for slots against real ones. Measured on the amazon run: 11 of the 30 elements the model
    // saw were things no test can interact with — two `add-new` inputs, a CSRF token,
    // `IP2LOCATION`, and six keyboard skip-links — while `link "Electronics"`,
    // `link "Fashion"`, `link "Prime"` and eight more real category links never reached it.
    //
    // `isUsableElement` lives in appModel.ts next to INTERACTIVE_ROLES so this filter and the
    // test-case projection cannot drift apart; a second copy is how they diverged in the first
    // place. Playwright would refuse to act on these anyway — its actionability checks require
    // visibility — so a case written against one could never have passed.
    const withFilteredElements = (pages: PageModel[]) => pages.map(p => ({
      ...p,
      elements: p.elements.filter(e => isUsableElement(e, hiddenInputNames(p))),
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
    // `let`: the MAX_CHARS loop below shrinks the screens block before it drops any page.
    // Retries only — or, with a stored screen map (Phase 2), the first attempt too.
    let screens = correction || storedScreens.length ? capturedScreensBlock(model) : { text: "", screens: 0 };
    const screensAtStart = screens.screens;
    const correctionHead = correction
      ? `\nYour previous attempt was REJECTED. Fix exactly this and return corrected IR:\n${correction}\n`
      : "";
    let correctionBlock = correctionHead + screens.text;

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
    // Over budget with a screens block (Salesforce retries only): drop its OLDEST screen first, one
    // at a time, before any page goes. The newest screen is where the failing step is.
    while (prompt.length > MAX_CHARS && screens.screens > 0) {
      screens = capturedScreensBlock(model, screens.screens - 1);
      correctionBlock = correctionHead + screens.text;
      prompt = render(modelJson);
      console.warn("[ir] prompt still exceeds", MAX_CHARS, "chars — dropped the oldest captured screen,", screens.screens, "left");
    }
    if (screensAtStart) console.log(`[ir] screens block: ${screens.screens} screens, ${screens.text.length} chars`);
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
      if (isCacheableResult(ir)) llmCacheSet(cacheKey, ir);
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
  // SCREEN MODE (D-52) — Salesforce runs only, so every other run takes exactly the code path it
  // took before. A Lightning form changes the DOM without changing the URL, so each screen the
  // flow reaches is captured and each step grounded against its own screen. Separate budget: one
  // capture per screen boundary is the expected cost, not a sign of a flow failing to converge.
  const screenMode = currentRunTargetApp() === "salesforce";
  const MAX_SCREEN_CAPTURES = Number(process.env.MAX_SCREEN_CAPTURES ?? 16);
  let screenCaptures = 0;
  /** Phase 2: what this compile's captures add to the screen map (also `runs/<id>/09-screen-map.json`). */
  const runMapScreens: ScreenMapScreen[] = [];
  const runMapEdges: Omit<ScreenMapEdge, "seen">[] = [];
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
  let bestPartial: { ir: IR; steps: Step[]; note: string; kind?: string } | undefined;
  /** The truncated IR shipped from `bestPartial`. One builder for both exits that ship it. */
  const fromBestPartial = (bp: NonNullable<typeof bestPartial>): IR => ({
    ...bp.ir,
    steps: bp.steps,
    meta: {
      ...bp.ir.meta,
      truncated: true,
      truncationNote: bp.note,
      ...(bp.kind ? { truncationKind: bp.kind } : {}),
      hasTerminalAssertion: hasTerminalAssertion(bp.steps),
    },
  });
  // Set when the screen-capture budget runs out, so a truncation note says so instead of the
  // misleading "that screen has not been captured yet" (TD-128).
  let captureBudgetSpent = false;
  /**
   * Screens already captured in THIS compile, keyed by the steps that reach them (TD-128). A retry
   * writes a fresh IR whose first steps are usually the same clicks as before, and every attempt
   * used to replay and re-capture each of those screens from scratch: run 2026-10-15T05-37-13 spent
   * 15 of its 16 captures re-taking screens it already had, and its last attempt stopped at step 2
   * for want of one more. Same steps reach the same screen, so the earlier capture is reused —
   * no browser, no budget. A key replaced by a newer capture of the same screen follows the swap.
   */
  const capturedByPrefix = new Map<string, string>();
  /** TD-153: exact step lists live-extend has already replayed in this compile. */
  const replayedPrefixes = new Set<string>();
  const prefixSignature = (steps: Step[]): string => JSON.stringify(steps
    // waits and assertions do not move the flow, so a retry adding or dropping one is the same path
    .filter((s) => s.action !== "wait" && s.action !== "assert")
    .map((s) => [s.action, s.target?.css ?? "", norm(s.target?.role ?? ""), norm(s.target?.name ?? ""),
      s.target?.text ?? "", s.target?.url ?? "", s.target?.frame ?? "", s.target?.nth ?? "", s.value ?? ""]));

  /**
   * Grounding rejections already seen, so an unfixable one is not paid for four times.
   *
   * Keyed on the IR TARGET's own fields, never on the message string — `CLAUDE.md`'s central
   * design rule, and here it is also simply more correct: the same absent element comes back at a
   * different step index on the next attempt, so the message differs ("Step s6…" then "Step s8…")
   * while the thing that cannot be grounded is identical. `server.log` lines 107/124/141 show
   * exactly that: `button "Add User"` rejected three times with identical feedback, then again as
   * s8. The index is deliberately NOT part of the key.
   *
   * When a target repeats, the model is not going to fix it: the element is absent from the page,
   * usually because it needs a role the test does not have. At ~3,800 prompt tokens per IR call
   * (measured across every run in `runs/`), each further attempt buys nothing.
   */
  const seenRejections = new Set<string>();
  const rejectionKey = (u: NonNullable<ReturnType<typeof groundingError>>, ir: IR): string => {
    const t = ir.steps[u.index]?.target ?? {};
    return JSON.stringify({
      kind: u.kind ?? "role-name",
      role: t.role ?? null,
      name: t.name ?? null,
      text: t.text ?? null,
      url: t.url ?? null,
    });
  };
  /**
   * Salesforce runs only (handoff Phase 1c): a repeat is fatal only when it carries no new
   * information. TD-74's premise — "the element is absent, so more attempts cannot ground it" — is
   * false in two cases, both seen on real runs, and both read from IR structure, never wording:
   *   1. The target WAS grounded in an earlier attempt's prefix, so it exists. Run
   *      2026-10-15T08-19-57: button "Select for EOI" rejected in attempt 1, grounded in attempt 2
   *      (which reached step 21), rejected again in attempt 3 — and TD-74 stopped there.
   *   2. This attempt got further than when the target was last rejected (more grounded steps,
   *      waits and asserts not counted), so the model is converging, not repeating itself.
   * Otherwise it is still a stop, as before: run 2026-10-15T16-39-13 repeated "Full Name" with the
   * same grounded prefix plus one wait. MAX_ATTEMPTS still bounds the cost either way.
   */
  const targetKey = (t: Step["target"] | undefined): string =>
    JSON.stringify({ role: t?.role ?? null, name: t?.name ?? null, text: t?.text ?? null, url: t?.url ?? null });
  const reach = (steps: Step[]): number => steps.filter((s) => s.action !== "wait" && s.action !== "assert").length;
  const groundedTargets = new Set<string>();
  const rejectedReach = new Map<string, number>();
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

  // TD-150: a Salesforce flow is discovered one screen per attempt on a site the screen map has not
  // learned yet (run 2026-10-16T17-35-53, cold start: the 4th attempt reached form screen 2, then the
  // loop ended). While the previous attempt got FURTHER (a longer grounded prefix), grant one more,
  // at most SCREEN_EXTRA_ATTEMPTS times. An attempt without progress still ends it, as before.
  const SCREEN_EXTRA_ATTEMPTS = 3;
  let attemptCap = MAX_ATTEMPTS;
  const reachAt: number[] = [];
  for (let attempt = 0; attempt < attemptCap; attempt++) {
    reachAt[attempt] = bestPartial?.steps.length ?? 0;
    if (screenMode && attempt === attemptCap - 1 && attemptCap < MAX_ATTEMPTS + SCREEN_EXTRA_ATTEMPTS
      && attempt > 0 && reachAt[attempt] > reachAt[attempt - 1]) {
      attemptCap++;
      console.log(`[ir] the last attempt got further (${reachAt[attempt - 1]} -> ${reachAt[attempt]} grounded steps): one more attempt (${attemptCap})`);
    }
    if (budget && !budget.hasBudget) {
      lastErr = `LLM per-run budget exhausted (${budget.snapshot().calls} calls)`;
      console.warn("[ir]", lastErr, "— stopping retries early");
      break;
    }
    console.log("[ir] attempt", attempt + 1, "/", attemptCap);
    /**
     * Set the retry state AND record why, so the run's own 08-llm-usage.json can answer
     * "what were all these attempts spent on" without anyone reading container logs.
     *
     * The retry count is the dominant cost here — a real saucedemo run spent 20 IR calls on 5
     * cases (exactly MAX_ATTEMPTS each) and produced zero passing tests. `kind` is what makes
     * that answerable: grouping by it separates a retry that cannot ever succeed from ordinary
     * correction. Recording is fire-and-forget and never affects control flow.
     */
    const reject = (kind: string, message: string): void => {
      lastErr = message;
      correction = message;
      budget?.recordRetry({ stage: "ir", caseTitle: testCase.title, attempt: attempt + 1, kind, reason: message });
    };
    let parsed;
    try {
      // temperature: 0.2, not Gemini's provider default — matches the value this call ran at
      // under Groq for this schema-constrained task; GeminiOpts has no built-in default the
      // way groq.ts did, so it has to be set explicitly here or IR would silently move to
      // whatever Gemini's own default is. model: GEMINI_MODEL (the full model, not LITE) —
      // IR is the hardest structured-output task in the pipeline (DOM + test case combined
      // into strict JSON), the same reason it needed a bigger context window under Groq.
      const { content, usage } = await llm(buildUser(currentModel, correction), {
        systemInstruction: system, json: true, temperature: 0.2,
        role: "main", stage: "ir",
      });
      budget?.record("ir", usage, providerFor("main"));
      console.log("[ir] gemini returned, length:", content.length);
      parsed = IR.safeParse(normalizeIR(parseJson(content)));
      console.log("[ir] parsed:", parsed.success ? "valid" : "INVALID");
    } catch (err: any) {
      budget?.record("ir", undefined, providerFor("main"));
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
      reject("schema", `The JSON did not match the required schema: ${parsed.error.message}`);
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
        const moved = redirectPostLoginNavigate(parsed.data.steps, prefix.length, currentModel.auth, origin);
        if (moved) console.log(`[ir] step ${moved}: navigate to the login page after signing in -> the page the login lands on`);
      }
    }

    /** Longest grounded prefix seen for THIS ungrounded result — updates bestPartial in
     *  place. Called both before each extension attempt and once more after the inner loop
     *  below exits, so the final state (whatever it ends up being) is always captured. Cheap
     *  to call twice for the same value: the length check makes repeats a no-op. */
    const trackBestPartial = (u: NonNullable<ReturnType<typeof groundingError>>) => {
      const prefix = parsed.data.steps.slice(0, u.index);
      if (prefix.length && prefix.length > (bestPartial?.steps.length ?? 0)) {
        bestPartial = { ir: parsed.data, steps: prefix, note: u.message, kind: u.kind };
      }
      return prefix;
    };

    // Screen state for THIS parsed IR: where each captured screen starts. Rebuilt per attempt —
    // a fresh IR has different steps — while the screens themselves stay in currentModel.
    const screenAt: { at: number; key: string }[] = [];
    const scopeFor = (): GroundingScope | undefined => {
      if (!screenMode) return undefined;
      const captured = new Set(screenAt.map((s) => s.at));
      return {
        screenAt,
        captureBefore: new Set(screenBoundaries(parsed.data).filter((i) => !captured.has(i))),
        // TD-142: this run's own screens and edges count too, so a first run can name the route.
        ...(useScreenMap ? {
          mapRoute: (from: string, name: string) => routeToControl({
            screens: [...runMapScreens, ...(storedMap?.screens ?? [])],
            edges: [...runMapEdges, ...(storedMap?.edges ?? [])],
          }, from, name),
        } : {}),
      };
    };
    // Phase 2: say where the stored map expects each screen-changing click to lead. A log only — the
    // capture still happens (skipping it waits until the map has proven accurate).
    if (storedMap?.edges.length) {
      for (const at of screenBoundaries(parsed.data)) {
        const click = parsed.data.steps.slice(0, at).filter((st) => st.action === "click" || st.action === "press").at(-1);
        const to = storedMap.edges.filter((e) => click?.target?.name && e.action.name === click.target.name &&
          norm(e.action.role) === norm(click.target.role ?? "")).map((e) => storedMap.screens.find((x) => x.key === e.to)).filter(Boolean);
        if (to.length) console.log(`[ir] screen map predicts: ${click!.target!.role} "${click!.target!.name}" -> ${to.map((x) => `"${x!.title || x!.url}"`).join(" or ")}`);
      }
    }
    let ungrounded = groundingError(parsed.data, currentModel, scopeFor());

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
      reject(ungrounded.kind ?? "grounding", ungrounded.message);
      console.log("[ir] ungrounded step", ungrounded.index, ":", ungrounded.message);
      const prefix = trackBestPartial(ungrounded);
      if (!prefix.length) break; // nothing to replay from — fall through, same as today
      // A guessed navigate URL is an AUTHORING mistake, not a discovery gap: replaying the
      // prefix can't make an invented route real, so extending here just drains the budget the
      // steps that genuinely need discovery are relying on. Go straight to the next attempt,
      // where the correction above tells the model to click through the UI instead.
      if (ungrounded.kind === "navigate-url") break;

      // A disabled target seen in a capture taken AT this step is a fact about the flow, not a gap
      // in discovery: no capture can change it. Back to the model with the reason (TD-121).
      if (ungrounded.kind === "disabled-target") break;

      if (screenMode) {
        // Capture the screen the flow is on at this step — whether the step is the first after a
        // DOM-changing click or simply missing from the screen it is on. Once per step index: a
        // second miss at the same point means the element is genuinely not on that screen (a
        // removed field), and that is reported, not papered over by a lookup in other screens.
        if (screenAt.some((s) => s.at === ungrounded!.index)) {
          lastErr = `step ${parsed.data.steps[ungrounded.index]?.id} is not on the screen the flow reaches there: ${ungrounded.message}`;
          break;
        }
        // The same steps were already captured in an earlier attempt: reuse that screen (TD-128).
        const sig = prefixSignature(prefix);
        const reuse = capturedByPrefix.get(sig);
        if (reuse && findScreen(currentModel, reuse)) {
          screenAt.push({ at: ungrounded.index, key: reuse });
          console.log(`[ir] screen at step ${parsed.data.steps[ungrounded.index]?.id}: reused screen ${reuse}, captured earlier for the same steps (no replay)`);
          ungrounded = groundingError(parsed.data, currentModel, scopeFor());
          continue;
        }
        if (screenCaptures >= MAX_SCREEN_CAPTURES) {
          lastErr = `screen capture budget (MAX_SCREEN_CAPTURES=${MAX_SCREEN_CAPTURES}) spent before step ${parsed.data.steps[ungrounded.index]?.id}`;
          captureBudgetSpent = true;
          break;
        }
        try {
          const before = currentModel.pages.length;
          const cap = await captureScreenAt(currentModel, prefix, creds, credPolicy);
          screenCaptures++;
          currentModel = cap.model;
          // A replaced screen has a new key; every step already pointing at it follows.
          if (cap.replacedKey) for (const s of screenAt) if (s.key === cap.replacedKey) s.key = cap.key;
          screenAt.push({ at: ungrounded.index, key: cap.key });
          if (cap.replacedKey) for (const [k, v] of capturedByPrefix) if (v === cap.replacedKey) capturedByPrefix.set(k, cap.key);
          capturedByPrefix.set(sig, cap.key);
          // The compile-wide list the retry prompt reads (TD-122): same key swap, then append if new.
          const was = cap.replacedKey ? capturedScreenKeys.indexOf(cap.replacedKey) : -1;
          if (was >= 0) capturedScreenKeys[was] = cap.key;
          if (!capturedScreenKeys.includes(cap.key)) capturedScreenKeys.push(cap.key);
          // Phase 2: remember the screen, and the click that led to it from the screen before
          // (role + name only, never css). Best-effort: a map that cannot be written costs nothing.
          if (useScreenMap) {
            try {
              const page = findScreen(currentModel, cap.key);
              if (page) {
                const now = new Date();
                // The click that opened this screen, only when unambiguous (edgeForCapture).
                const screen = screenFromPage(page, controlsOf(page), now);
                const found = edgeForCapture(screenAt, prefix, ungrounded!.index, cap.key);
                const edge = found ? [found] : [];
                runMapScreens.push(screen);
                runMapEdges.push(...edge);
                recordIntoScreenMap(origin, creds, [screen], edge, now);
                writeRunScreenMap(origin, creds, runMapScreens, runMapEdges);
              }
            } catch (err: any) {
              console.log("[ir] screen map: could not record the capture:", err?.message ?? err);
            }
          }
          console.log(`[ir] screen capture at step ${parsed.data.steps[ungrounded.index]?.id}: ${cap.replacedKey ? "replaced" : "added"} screen ${cap.key} (${cap.reachedUrl}) — app model ${before} -> ${currentModel.pages.length} pages`);
        } catch (err: any) {
          lastErr = `could not capture the screen for step ${parsed.data.steps[ungrounded.index]?.id}: ${err?.message ?? err}`;
          console.log("[ir]", lastErr);
          // The truncation note is otherwise "that screen has not been captured yet", which hides
          // WHY: usually a step before it could not be replayed (a disabled button, a slow page).
          if (bestPartial && bestPartial.steps.length === ungrounded.index) {
            bestPartial = { ...bestPartial, note: `${ungrounded.message} The capture failed: ${String(err?.message ?? err).split("\n")[0]}` };
          }
          break;
        }
        ungrounded = groundingError(parsed.data, currentModel, scopeFor());
        continue;
      }

      // TD-153: never replay the EXACT same steps twice in one compile. The walk cache hands the
      // second replay the identical snapshot, so it can teach nothing — but it still spent one of
      // MAX_EXTENSIONS. Traced 2026-10-18 (saucedemo): attempt 1 omitted "Continue", replayed the
      // same 11 steps four times looking for "Finish", and spent the whole budget; attempt 2 had
      // the right steps and could not replay them, so the case stopped. Exact JSON (waits
      // included, as in the walk key), so a retry that only adds a wait still replays.
      const exactPrefix = JSON.stringify(prefix);
      if (replayedPrefixes.has(exactPrefix)) {
        console.log(`[ir] live-extend: these ${prefix.length} step(s) were already replayed and did not reach step ${parsed.data.steps[ungrounded.index]?.id} — not replaying them again`);
        break;
      }
      replayedPrefixes.add(exactPrefix);
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
      ungrounded = groundingError(parsed.data, currentModel, scopeFor());
    }

    if (!ungrounded) {
      const chrome = chromeSuccessAssertion(parsed.data, currentModel);
      if (chrome) {
        console.log("[ir] site-chrome success assertion rejected:", chrome.message);
        reject("chrome-assertion", chrome.message);
        lastContradiction = { ir: parsed.data, ...chrome };
        continue;
      }
      const vacuous = vacuousAssertion(parsed.data, currentModel);
      if (vacuous) {
        console.log("[ir] vacuous assertion rejected:", vacuous.message);
        reject("vacuous-assertion", vacuous.message);
        lastContradiction = { ir: parsed.data, ...vacuous };
        continue;
      }

      const urlMismatch = urlAssertionError(parsed.data, currentModel);
      if (urlMismatch) {
        console.log("[ir] hallucinated url_contains rejected:", urlMismatch.message);
        reject("url-mismatch", urlMismatch.message);
        lastContradiction = {
          ir: parsed.data, stepIds: [parsed.data.steps[urlMismatch.index].id], message: urlMismatch.message,
        };
        continue;
      }

      const clickedHidden = clickedElementHiddenAssertion(parsed.data, currentModel, testCase);
      if (clickedHidden) {
        console.log("[ir] assert-hidden on a merely-clicked element rejected:", clickedHidden.message);
        reject("clicked-element-hidden", clickedHidden.message);
        lastContradiction = { ir: parsed.data, ...clickedHidden };
        continue;
      }

      const crossForm = crossFormBleedError(parsed.data, currentModel);
      if (crossForm) {
        console.log("[ir] cross-form target bleed rejected:", crossForm.message);
        reject("cross-form-bleed", crossForm.message);
        lastContradiction = { ir: parsed.data, ...crossForm };
        continue;
      }

      const incomplete = missingActions(parsed.data, testCase);
      if (incomplete) {
        console.log("[ir] IR does not carry out the case:", incomplete.message);
        reject("missing-actions", incomplete.message);
        // Remember this IR as a shippable partial before retrying.
        //
        // THIS IS WHAT STOPS THE GUARD KILLING RUNS. Every GROUNDING rejection already calls
        // trackBestPartial, so attempts-exhausted ships a truncated result. This path did not: it
        // only set lastErr and continued, so when the loop ran out `bestPartial` was undefined and
        // the throw at the bottom took the entire run with it. Observed twice, both times on a
        // CORRECT IR that the prose regex misread.
        //
        // `missingActions` is a heuristic over model-authored prose, and CLAUDE.md is explicit
        // that such a check can never be made reliably deterministic — so it must not be able to
        // be the sole cause of a dead run. It still rejects and still retries, which is the
        // protection it was built for (an IR that filled nothing once reported PASSED); what
        // changes is the floor: a false positive now costs a result marked truncated, not the run.
        //
        // The steps are the WHOLE IR, not a prefix: grounding succeeded, so every step is real and
        // executable. The doubt is about coverage, not reach — hence its own truncationKind, and
        // `hasTerminalAssertion` still decides truncated vs truncated_no_assertion downstream.
        if (parsed.data.steps.length > (bestPartial?.steps.length ?? 0)) {
          bestPartial = {
            ir: parsed.data,
            steps: parsed.data.steps,
            note: incomplete.message,
            kind: "incomplete-coverage",
          };
        }
        continue;
      }

      // TD-139: the request's values must reach the steps, not just the case. Salesforce runs, the
      // fromPrompt case only (a negative suite case leaves values out on purpose). Same floor as
      // missingActions above: it rejects and retries, and the IR is kept as a partial so a run is
      // never lost to it.
      if (screenMode && testCase.fromPrompt) {
        const lost = stepsMissingValues(parsed.data.steps, testCase, requestValues(sourcePrompt));
        if (lost.length) {
          const message = `The steps leave out ${lost.map((v) => `"${v}"`).join(", ")}, which the test case ` +
            `uses. Carry out the WHOLE case: each value goes in the step where the case uses it (a value ` +
            `chosen or typed in a field is that step's "value", a button or link is the target of its ` +
            `click, an expected message is the final assertion's text). Do not skip a form screen.`;
          console.log("[ir] request values missing from the steps:", lost.join(", "));
          reject("missing-values", message);
          if (parsed.data.steps.length > (bestPartial?.steps.length ?? 0)) {
            bestPartial = { ir: parsed.data, steps: parsed.data.steps, note: message, kind: "incomplete-coverage" };
          }
          continue;
        }
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
      // Not in screen mode: there every click that can reveal a form already had the screen after
      // it captured and its steps grounded against that screen alone — and this check's
      // refreshPageModel replaces by URL, which would throw away the other screens (D-52).
      if (!screenMode && revealIndex > 0 && !postClickRefreshed && extensions < MAX_EXTENSIONS) {
        postClickRefreshed = true;
        const revealStep = parsed.data.steps[revealIndex];
        // slice(0, revealIndex) is the same prefix convention the live-extend path uses: every
        // step BEFORE this one, which includes the click that opens the modal and any wait after
        // it. replayAndSnapshot's dialog branch (waitForSelector on [role="dialog"], plus the
        // vision merge for dialogs built without semantic HTML) engages on exactly this shape.
        const prefix = parsed.data.steps.slice(0, revealIndex);
        const pageBefore = trackPages(parsed.data, currentModel).pageAt[revealIndex];
        // Captured BEFORE the refresh below replaces currentModel (the TD-158 check needs them too).
        const beforeEls = pageBefore?.elements ?? currentModel.pages.flatMap(p => p.elements);
        const beforeKeys = new Set(beforeEls.map(e => `${norm(e.role)}|${norm(e.name)}`));
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

          const afterEls = refreshed.pages.flatMap(p => p.elements);
          let revealed = afterEls.filter(e => !beforeKeys.has(`${norm(e.role)}|${norm(e.name)}`));
          // TD-158 (with NETWORK_SETTLE_ENABLED, the Phase 1 follow-up). New NAMES alone miss a form
          // whose fields discovery already holds, hidden, because its modal was closed: the click
          // reveals nothing new by name, and a fill bound to an unrelated HIDDEN field (Demoblaze:
          // the Sign-up "Username:" instead of the order form's field) was accepted. Settled
          // discovery makes that shape common. So, by css (structure, never text): a field HIDDEN
          // before the click and VISIBLE after it is revealed too, and a target still hidden after the
          // click is wrong. A target the click itself made visible is exactly right: nothing to redirect.
          let targetStillHidden = false;
          if (networkSettleEnabled()) {
            const cssOf = (e: Element) => e.css?.toLowerCase();
            const targetCss = revealStep.target?.css?.toLowerCase();
            const hiddenBefore = new Set(beforeEls.filter(e => e.visible === false && e.css).map(e => cssOf(e)!));
            const nowVisible = afterEls.filter(e => e.visible !== false && e.css && hiddenBefore.has(cssOf(e)!));
            if (targetCss && nowVisible.some(e => cssOf(e) === targetCss)) {
              revealed = [];
            } else {
              for (const e of nowVisible) if (!revealed.includes(e)) revealed.push(e);
              if (targetCss) revealed = revealed.filter(e => cssOf(e) !== targetCss);
              targetStillHidden = !!targetCss && afterEls.find(e => cssOf(e) === targetCss)?.visible === false;
            }
          }
          const fillable = revealed.filter(e => FIELD_ROLE_GROUP.has(norm(e.role))
            && (!networkSettleEnabled() || e.visible !== false));
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
              `"${revealStep.target?.name ?? revealStep.target?.text ?? ""}", which ` +
              (targetStillHidden
                ? `is still hidden on the page after the preceding click (it belongs to another, closed form). Clicking `
                : `already existed on the page BEFORE the preceding click. Clicking `) +
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
        const guessed = parsed.data.steps[parsed.data.steps.length - 1]?.target?.text ?? "";
        const regrounded = reground.steps[reground.steps.length - 1]?.target?.text ?? "";
        if (screenMode && replacesQuotedSuccessText(guessed, regrounded, sourcePrompt)) {
          console.log(`[ir] kept the request's own success text "${guessed}" rather than "${regrounded}" — the replay did not reach it, so the test should fail, not pass on another message`);
        } else if (!assertionContradictsCase(reground, testCase)) parsed.data = reground;
      }

      const contradiction = assertionContradictsCase(parsed.data, testCase);
      if (contradiction) {
        console.log("[ir] inverted assertion rejected:", contradiction.message);
        reject("contradicts-case", contradiction.message);
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
    reject(ungrounded.kind ?? "grounding", ungrounded.message);

    // A text-target rejection is a "we couldn't VERIFY this", not a "this cannot work". Its
    // whole purpose is to make live-extend run so the page gets discovered; once the budget is
    // spent, truncating on it would throw away a flow that has a real chance of executing —
    // the field helper resolves a control positionally, without needing a model entry at all.
    // Strictly better to run the step unverified than to ship a prefix that tests nothing:
    // the run that motivated this reported `truncated_no_assertion` and checked zero of the
    // user's eight steps. Every other rejection kind still truncates as before.
    if (ungrounded.kind === "text-target" && attempt === attemptCap - 1) {
      console.log("[ir] shipping unverified text targets (best-effort):", ungrounded.message);
      return { ir: finalize(parsed.data), updatedAppModel: currentModel };
    }

    const prefix = trackBestPartial(ungrounded);

    // Second time this exact target has been rejected: stop. The page does not have it, and
    // another generation cannot change that — it can only spend another ~3,800 prompt tokens
    // arriving at the same answer. Falls through to the truncation path below, which ships the
    // grounded prefix and records `truncationNote`, so the UI already has the reason and needs
    // no new status. TECH_DEBT.md TD-74.
    const key = rejectionKey(ungrounded, parsed.data);
    let repeated = seenRejections.has(key);
    seenRejections.add(key);
    if (screenMode) {
      const rejectedTarget = targetKey(parsed.data.steps[ungrounded.index]?.target);
      if (repeated && groundedTargets.has(rejectedTarget)) {
        repeated = false;
        console.log(`[ir] target rejected again, but an earlier attempt grounded it — it exists, retrying`);
      } else if (repeated && reach(prefix) > (rejectedReach.get(key) ?? Infinity)) {
        repeated = false;
        console.log(`[ir] target rejected again, but this attempt got further (${reach(prefix)} grounded steps, was ${rejectedReach.get(key)}) — retrying`);
      }
      rejectedReach.set(key, reach(prefix));
      for (const s of prefix) if (s.target) groundedTargets.add(targetKey(s.target));
    }

    if (prefix.length && attempt < attemptCap - 1 && !repeated) {
      console.log(`[ir] grounding rejected step ("${ungrounded.message}") — retrying with feedback (attempt ${attempt + 1}/${attemptCap})`);
      continue;
    }
    if (repeated) {
      console.log(
        `[ir] the same target was rejected twice ("${ungrounded.message}") — not retrying: ` +
        `the element is absent from the page, so more attempts cannot ground it`,
      );
    }
    if (prefix.length) {
      // TD-128: an EARLIER attempt may have grounded further than this one. Run
      // 2026-10-15T05-37-13: attempt 2 grounded 27 steps, the last attempt 2 — and the 2 shipped.
      // The longest grounded prefix is the test worth running, whichever attempt produced it.
      if (bestPartial && bestPartial.steps.length > prefix.length) {
        console.log(`[ir] shipping the best attempt's ${bestPartial.steps.length} grounded steps, not this attempt's ${prefix.length}`);
        return { ir: finalize(fromBestPartial(bestPartial)), updatedAppModel: currentModel };
      }
      const truncated: IR = { ...parsed.data, steps: prefix };
      truncated.meta = {
        ...parsed.data.meta, truncated: true,
        truncationNote: captureBudgetSpent
          ? `${lastErr} The screen-capture budget (MAX_SCREEN_CAPTURES=${MAX_SCREEN_CAPTURES}) was spent before this step.`
          : lastErr,
        // Structured, so isHealable can decide without reading the prose note (TD-83).
        ...(ungrounded.kind ? { truncationKind: ungrounded.kind } : {}),
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
    return { ir: finalize(fromBestPartial(bestPartial)), updatedAppModel: currentModel };
  }

  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

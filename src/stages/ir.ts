import { groq } from "../llm/groq.js";
import { parseJson } from "../llm/json.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import { AppModel, toLiteModel } from "../schema/appModel.js";
import { extendAppModel, refreshPageModel } from "./liveExtend.js";
import { credentialsFor, applyCredentials, shouldSkipCredentialSubstitution, NEGATIVE_CATEGORIES } from "./credentials.js";
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
  const elements = appModel.pages.flatMap(p => p.elements);
  // Selectors the model is allowed to address directly, because discovery captured them.
  const knownSelectors = new Set<string>();
  for (const e of elements) {
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

    // Rank candidates instead of taking the first substring hit. `en.includes(name)` alone
    // grounded "Continue" to "Continue Shopping" — a different control on a different page —
    // because that happened to come first in element order. An exact match must always beat
    // a partial one, and among partials the closest-length name is the least wrong.
    let matched: typeof elements[number] | null = null;
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
export function vacuousAssertion(ir: IR): { stepIds: string[]; message: string } | null {
  const NEEDS_VALUE = new Set(["url_contains", "text_contains", "text_equals"]);
  const offending = ir.steps.filter(s =>
    s.action === "assert" && s.assertion && NEEDS_VALUE.has(s.assertion) &&
    !(s.value ?? (s.assertion === "url_contains" ? s.target?.url : undefined) ?? "").trim()
  );
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
 * Check whether the surviving (after truncation) step list ends in a real assertion.
 * An assertion earlier in the sequence with non-assertion steps after it does not count
 * — only the final step's action discriminator determines whether the test actually
 * verified anything before the ungrounded tail was cut off.
 */
export function hasTerminalAssertion(steps: Step[]): boolean {
  if (steps.length === 0) return false;
  return steps[steps.length - 1].action === "assert";
}

export async function toIR(
  testCase: TestCase, appModel: AppModel, sourcePrompt: string, entryUrl: string
): Promise<IRResult> {
  // Compute these ourselves rather than trust the model: baseUrl must be the origin
  // (generator.ts appends relative step paths to it), and entryPath is where the
  // actual page under test lives — telling the model both up front heads off the
  // double-path bug ("https://host/login" + "/login" -> 404) at the source.
  const { origin, pathname, search } = new URL(entryUrl);
  const entryPath = pathname + search || "/";

  const cacheKey = makeCacheKey(JSON.stringify(testCase), sourcePrompt, JSON.stringify(appModel));
  const cached = llmCacheGet<IR>(cacheKey);
  if (cached) return { ir: cached, updatedAppModel: appModel };

  const system =
    `Convert ONE human-readable test case into a strict JSON test model (IR).
Address elements only by accessibility role + name taken from the application model.
Allowed actions: navigate, click, fill, select, check, press, wait, assert.
Allowed assertions: visible, hidden, text_equals, text_contains, url_contains, enabled, disabled.

Rules, follow exactly:
- "id" is always a string like "s1", "s2", never a number.
- "assertion" is a single string from the allowed list above — NEVER an object. Omit "assertion" entirely on steps whose action is not "assert".
- Omit "target" entirely for steps that don't need one (e.g. a "wait" step); never set it to an empty string.
- For an "assert" step needing a comparison value (text_equals, text_contains, url_contains), put that value in the step's "value" field, not inside "assertion".
- Never invent CSS selectors. The only exception is a selector explicitly listed as verified in the user's request section below — those may be used as "target.css" exactly as given.
- "meta.baseUrl" must be exactly the origin, with no path: ${origin}
- A "navigate" step's target.url is a path RELATIVE to that origin (it gets concatenated onto baseUrl) — for the page under test here, that path is exactly "${entryPath}". Do not repeat the origin inside it.
- "role" must be a real ARIA role (button, textbox, link, heading, checkbox, ...) for an element actually present in the application model. For asserting on plain visible text that ISN'T in the application model — e.g. an error/flash message that only appears after an action, so discovery never saw it — use target: { "text": "..." } instead. Never invent a role like "text" or "message".
- A success assertion must be FALSE before the action and TRUE only after it — otherwise it verifies nothing. Never assert on a persistent, site-wide element (a header, logo, or nav bar that appears on every page regardless of state) as proof an action succeeded; it was already visible before the action too. In the application model, a decorative/structural element like this typically has no "concept" (empty or absent) — treat that as a signal to avoid it as a success assertion.
- The application model only covers the page you start on, so you usually can't see the page an action like login navigates to. When you can't ground a success assertion on the destination page, assert instead that something from the STARTING page disappears because of the action — e.g. the login form's own submit button going "hidden" once login succeeds. That element is already in the model (grounded, no extra discovery needed), and is a real discriminator: visible before, gone after.

Negative-path rules (CRITICAL — read the test case's own "expected" field first):
- Some test cases exist to prove an action FAILS: invalid password, empty required field, malformed email, SQL injection, unauthorized access. For these, the PASS condition is that the app REJECTED the input.
- For such a case, NEVER assert that a success message, welcome text, dashboard, or post-login page is visible. That asserts the opposite of the test, and it fails against a perfectly working site.
- Instead assert one of: the error/validation message the app shows on failure (target: { "text": "..." }), that the URL still contains the original page path, or that an element unique to the STARTING page (e.g. the login form's submit button) is still visible.
- If you don't know the exact wording of the app's error message, prefer the URL or starting-page-element assertion over guessing the error text. Never guess the SUCCESS text.

Navigation & Assertion rules (CRITICAL):
- NEVER assert that the clicked link/button itself is "visible" after clicking it — that is redundant and proves nothing. The element was already visible (that's why you could click it).
- After clicking a NAVIGATION link (role="link"), assert the result using "url_contains" (check the URL changed to the expected path) or assert a heading/unique text on the DESTINATION page. Do NOT re-assert the link you just clicked.
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
  const creds = (testCase.fromPrompt || shouldSkipCredentialSubstitution(testCase)) ? undefined : credentialsFor(entryUrl);
  const finalize = (ir: IR): IR => {
    ir.meta.baseUrl = origin;
    ir.meta.hasTerminalAssertion = hasTerminalAssertion(ir.steps);
    if (creds) applyCredentials(ir.steps, creds, testCase);
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
  const MAX_ATTEMPTS = 8;     // bound total groq calls so a broken app/prompt still fails fast
  let lastErr = "";
  // Feedback for the NEXT attempt's prompt. Separate from lastErr, which also carries
  // live-extend failures that the model can't act on.
  let correction: string | undefined;
  let lastContradiction: { ir: IR; stepIds: string[]; message: string } | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    console.log("[ir] attempt", attempt + 1, "/", MAX_ATTEMPTS);
    let parsed;
    try {
      const raw = await groq(buildUser(currentModel, correction), { system, json: true });
      console.log("[ir] groq returned, length:", raw.length);
      parsed = IR.safeParse(normalizeIR(parseJson(raw)));
      console.log("[ir] parsed:", parsed.success ? "valid" : "INVALID");
    } catch (err: any) {
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
      const vacuous = vacuousAssertion(parsed.data);
      if (vacuous) {
        console.log("[ir] vacuous assertion rejected:", vacuous.message);
        lastErr = vacuous.message;
        correction = vacuous.message;
        lastContradiction = { ir: parsed.data, ...vacuous };
        continue;
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

    if (extensions < MAX_EXTENSIONS && prefix.length) {
      try {
        const before = currentModel.pages.length;
        console.log("[ir] calling extendAppModel...");
        currentModel = await extendAppModel(currentModel, prefix, creds);
        console.log("[ir] extendAppModel returned,", currentModel.pages.length, "pages");
        extensions++;
        console.log(`[ir] live-extend: replayed ${prefix.length} step(s) past "${ungrounded.message.split(",")[0]}" — app model ${before} -> ${currentModel.pages.length} pages (${currentModel.pages.at(-1)?.url})`);
        continue;
      } catch (err: any) {
        if (err?.message?.includes("already in the model") && prefix.length > 0) {
          try {
            const before = currentModel.pages.length;
            console.log("[ir] calling refreshPageModel...");
            currentModel = await refreshPageModel(currentModel, prefix, creds);
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
  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

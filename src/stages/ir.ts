import { groq } from "../llm/groq.js";
import { parseJson } from "../llm/json.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import { AppModel, toLiteModel } from "../schema/appModel.js";
import { extendAppModel, refreshPageModel } from "./liveExtend.js";
import { resolveAgainstModel, type ModelMatch } from "./targetResolver.js";
import { embedText, cosineSimilarity } from "../llm/embeddings.js";
import { credentialsFor, applyCredentials, shouldSkipCredentialSubstitution } from "./credentials.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

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
function normalizeIR(raw: any): any {
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
  // ponytail: strip decorative glyphs (+, emoji, bullets) for fuzzy name matching —
  // catches "+ Add New" vs "Add New" without the unsound reverse-direction check.
  const stripGlyphs = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    const t = step.target;
    if (!t?.role || !t?.name) continue; // navigate / text-only / wait steps
    const role = norm(t.role);
    const name = norm(t.name);
    let matchedName: string | null = null;
    for (const e of elements) {
      if (norm(e.role) !== role) continue;
      const en = norm(e.name);
      if (en === name || en.includes(name)) { matchedName = e.name; break; }
      const sn = stripGlyphs(name);
      const sen = stripGlyphs(en);
      if (sn && sen && sn === sen) { matchedName = e.name; break; }
    }
    if (!matchedName) {
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" name="${t.name}", ` +
          `which is not present in the application model — the page under test does not have this element.`,
      };
    }
    // ponytail: self-correct to the app model's literal name so Playwright matches
    t.name = matchedName;
  }
  return null;
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
- Never use CSS selectors.
- "meta.baseUrl" must be exactly the origin, with no path: ${origin}
- A "navigate" step's target.url is a path RELATIVE to that origin (it gets concatenated onto baseUrl) — for the page under test here, that path is exactly "${entryPath}". Do not repeat the origin inside it.
- "role" must be a real ARIA role (button, textbox, link, heading, checkbox, ...) for an element actually present in the application model. For asserting on plain visible text that ISN'T in the application model — e.g. an error/flash message that only appears after an action, so discovery never saw it — use target: { "text": "..." } instead. Never invent a role like "text" or "message".
- A success assertion must be FALSE before the action and TRUE only after it — otherwise it verifies nothing. Never assert on a persistent, site-wide element (a header, logo, or nav bar that appears on every page regardless of state) as proof an action succeeded; it was already visible before the action too. In the application model, a decorative/structural element like this typically has no "concept" (empty or absent) — treat that as a signal to avoid it as a success assertion.
- The application model only covers the page you start on, so you usually can't see the page an action like login navigates to. When you can't ground a success assertion on the destination page, assert instead that something from the STARTING page disappears because of the action — e.g. the login form's own submit button going "hidden" once login succeeds. That element is already in the model (grounded, no extra discovery needed), and is a real discriminator: visible before, gone after.

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

  const buildUser = (model: AppModel) => {
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

    const prompt = `Application model: ${modelJson}
Test case: ${JSON.stringify(testCase)}
baseUrl (origin only): ${origin}
entry path (where the page under test lives): ${entryPath}
sourcePrompt: ${sourcePrompt}
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
    if (creds) applyCredentials(ir.steps, creds);
    llmCacheSet(cacheKey, ir);
    return ir;
  };

  let currentModel = appModel;
  let extensions = 0;
  const MAX_EXTENSIONS = 2;   // bound the extra browser launches + LLM calls on the failure path
  const MAX_ATTEMPTS = 4;     // bound total groq calls so a broken app/prompt still fails fast
  let lastErr = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    console.log("[ir] attempt", attempt + 1, "/", MAX_ATTEMPTS);
    let parsed;
    try {
      const raw = await groq(buildUser(currentModel), { system, json: true });
      console.log("[ir] groq returned, length:", raw.length);
      parsed = IR.safeParse(normalizeIR(parseJson(raw)));
      console.log("[ir] parsed:", parsed.success ? "valid" : "INVALID");
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      console.error("[ir] groq/parse error:", lastErr);
      continue;
    }
    if (!parsed.success) { lastErr = parsed.error.message; continue; }

    parsed.data.meta.baseUrl = origin;
    const ungrounded = groundingError(parsed.data, currentModel);
    if (!ungrounded) {
      console.log("[ir] all steps grounded, returning");
      return { ir: finalize(parsed.data), updatedAppModel: currentModel };
    }

    lastErr = ungrounded.message;
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
  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

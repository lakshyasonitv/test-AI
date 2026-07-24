import { groq } from "../llm/groq.js";
import { parseJson } from "../llm/json.js";
import { IR, type Step } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";
import { extendAppModel, refreshPageModel } from "./liveExtend.js";
import { credentialsFor, applyCredentials, shouldSkipCredentialSubstitution } from "./credentials.js";

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
    if (step.value === "" ) delete step.value;

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
  for (let index = 0; index < ir.steps.length; index++) {
    const step = ir.steps[index];
    const t = step.target;
    if (!t?.role || !t?.name) continue; // navigate / text-only / wait steps
    const role = norm(t.role);
    const name = norm(t.name);
    const hit = elements.some(e => {
      if (norm(e.role) !== role) return false;
      const en = norm(e.name);
      return en === name || en.includes(name) || name.includes(en);
    });
    if (!hit) {
      return {
        index,
        message: `Step ${step.id} targets role="${t.role}" name="${t.name}", ` +
          `which is not present in the application model — the page under test does not have this element.`,
      };
    }
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
Return ONLY the JSON object, no prose, no markdown fences.

Example of the exact shape required — note the login case asserts NEW dynamic content that couldn't have existed before submission, and the success case asserts the login control disappearing rather than a page it can't see yet:
{
  "meta": { "feature": "Login", "title": "...", "priority": "high", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/login" } },
    { "id": "s2", "action": "fill", "target": { "role": "textbox", "name": "Username" }, "value": "tomsmith" },
    { "id": "s3", "action": "click", "target": { "role": "button", "name": "Login" } },
    { "id": "s4", "action": "assert", "target": { "text": "Invalid credentials" }, "assertion": "visible" }
  ]
}
For a case that instead expects login to SUCCEED, the last step would ground on the login button itself going away, not on anything from a page discovery hasn't seen:
{ "id": "s4", "action": "assert", "target": { "role": "button", "name": "Login" }, "assertion": "hidden" }`;

  // Rebuilt each attempt because the model grows as live-extension discovers new pages.
  const buildUser = (model: AppModel) =>
`Application model: ${JSON.stringify(model)}
Test case: ${JSON.stringify(testCase)}
baseUrl (origin only): ${origin}
entry path (where the page under test lives): ${entryPath}
sourcePrompt: ${sourcePrompt}
Return IR JSON: { "meta": {feature,title,priority,sourcePrompt,baseUrl}, "steps":[{id,action,target,value,assertion}] }`;

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
<<<<<<< HEAD
    if (creds) applyCredentials(ir.steps, creds, testCase);
=======
    if (creds) applyCredentials(ir.steps, creds);
>>>>>>> a406f2070172444d68df0761f4cfb621bffac50c
    return ir;
  };

  let currentModel = appModel;
  let extensions = 0;
  const MAX_EXTENSIONS = 2;   // bound the extra browser launches + LLM calls on the failure path
  const MAX_ATTEMPTS = 4;     // bound total groq calls so a broken app/prompt still fails fast
  let lastErr = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let parsed;
    try {
      parsed = IR.safeParse(normalizeIR(parseJson(await groq(buildUser(currentModel), { system, json: true }))));
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      continue;
    }
    if (!parsed.success) { lastErr = parsed.error.message; continue; }

    parsed.data.meta.baseUrl = origin;
    const ungrounded = groundingError(parsed.data, currentModel);
    if (!ungrounded) return { ir: finalize(parsed.data), updatedAppModel: currentModel };

    lastErr = ungrounded.message;
    const prefix = parsed.data.steps.slice(0, ungrounded.index);

    // Try to reach and model the missing state by replaying the grounded prefix live,
    // then retry generation against the enriched model. Bounded; needs a prefix to replay.
    if (extensions < MAX_EXTENSIONS && prefix.length) {
      try {
        const before = currentModel.pages.length;
        currentModel = await extendAppModel(currentModel, prefix, creds);
        extensions++;
        // A browser launch is expensive and otherwise invisible — say when it happened.
        console.log(`[ir] live-extend: replayed ${prefix.length} step(s) past "${ungrounded.message.split(",")[0]}" — app model ${before} -> ${currentModel.pages.length} pages (${currentModel.pages.at(-1)?.url})`);
        continue;
      } catch (err: any) {
        // If extendAppModel fails because the URL is already known (SPA state changed),
        // fall back to refreshPageModel to capture dynamic content on the same page.
        if (err?.message?.includes("already in the model") && prefix.length > 0) {
          try {
            const before = currentModel.pages.length;
            currentModel = await refreshPageModel(currentModel, prefix, creds);
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
<<<<<<< HEAD
      return { ir: finalize(truncated), updatedAppModel: currentModel };
=======
      return finalize(truncated);
>>>>>>> a406f2070172444d68df0761f4cfb621bffac50c
    }
  }
  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

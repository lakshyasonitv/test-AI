import { groq } from "../llm/groq.js";
import { parseJson } from "../llm/json.js";
import { IR } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";

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
 * messages) that isn't in the discovery snapshot. Returns a human-readable reason
 * for the first ungrounded target, or null if the whole IR is grounded.
 */
export function groundingError(ir: IR, appModel: AppModel): string | null {
  const elements = appModel.pages.flatMap(p => p.elements);
  for (const step of ir.steps) {
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
      return `Step ${step.id} targets role="${t.role}" name="${t.name}", ` +
        `which is not present in the application model — the page under test does not have this element.`;
    }
  }
  return null;
}

export async function toIR(
  testCase: TestCase, appModel: AppModel, sourcePrompt: string, entryUrl: string
): Promise<IR> {
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
Return ONLY the JSON object, no prose, no markdown fences.

Example of the exact shape required:
{
  "meta": { "feature": "Login", "title": "...", "priority": "high", "sourcePrompt": "...", "baseUrl": "https://example.com" },
  "steps": [
    { "id": "s1", "action": "navigate", "target": { "url": "/login" } },
    { "id": "s2", "action": "fill", "target": { "role": "textbox", "name": "Username" }, "value": "tomsmith" },
    { "id": "s3", "action": "click", "target": { "role": "button", "name": "Login" } },
    { "id": "s4", "action": "assert", "target": { "text": "Invalid credentials" }, "assertion": "visible" }
  ]
}`;

  const user =
`Application model: ${JSON.stringify(appModel)}
Test case: ${JSON.stringify(testCase)}
baseUrl (origin only): ${origin}
entry path (where the page under test lives): ${entryPath}
sourcePrompt: ${sourcePrompt}
Return IR JSON: { "meta": {feature,title,priority,sourcePrompt,baseUrl}, "steps":[{id,action,target,value,assertion}] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await groq(user, { system, json: true });
    try {
      const parsed = IR.safeParse(normalizeIR(parseJson(raw)));
      if (parsed.success) {
        // baseUrl is a fact we already know, not something worth trusting the model on.
        parsed.data.meta.baseUrl = origin;
        // Reject an IR that addresses elements the AppModel never contained; on the
        // first attempt this falls through to a retry (the model may recover), on the
        // last it surfaces as a clear error instead of a test doomed to time out.
        const ungrounded = groundingError(parsed.data, appModel);
        if (!ungrounded) return parsed.data;
        lastErr = ungrounded;
        continue;
      }
      lastErr = parsed.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`IR failed schema validation after retry: ${lastErr}`);
}

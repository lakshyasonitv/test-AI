import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";

// Models sometimes ignore case ("High") or return an array where a string was asked for
// ("expected": [...]) — normalize before validating rather than rejecting valid content.
const Priority = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["low", "medium", "high", "critical"])
).default("medium");
const StringOrJoinedArray = z.preprocess(
  (v) => (Array.isArray(v) ? v.join(" ") : v),
  z.string()
);

export const TestCase = z.object({
  title: z.string(),
  priority: Priority,
  feature: z.string(),
  steps: z.array(z.string()).min(1),
  expected: StringOrJoinedArray,
});
export type TestCase = z.infer<typeof TestCase>;

// Grounding is deliberately NOT checked here. This stage only ever sees the entry-page model
// (extension enriches the model later, inside toIR), so a fuzzy check here can't tell a
// hallucinated element from one on a page discovery hasn't reached yet — it just killed
// legitimate multi-page cases before they got to the stage that can resolve them. ir.ts's
// groundingError (exact role+name) plus extendAppModel is the single grounding authority.
export async function toTestCases(p: Plan, appModel: AppModel): Promise<TestCase[]> {
  const system =
`You write concrete, human-readable QA test cases from a plan and an application model. Output ONLY a JSON array, no prose, no markdown fences.

The application model describes ONLY the entry page. A later stage drives the app for real and
verifies steps against each page as it reaches them, so steps beyond the entry page are expected.

Rules, follow exactly:
- For the CURRENT page — the entry page, before any navigating action (login submit, add to cart, checkout) in this test case — every UI element, label, or button name you mention must be taken verbatim from the application model. Never invent an element on that page.
- AFTER a navigating action, the next page isn't in the model yet. Still write those steps: describe the real next action in plain language (e.g. "Add the backpack to the cart", "Complete checkout"). Do not invent a specific element NAME for a page you can't see — describe the intent and let the later stage resolve it against the real page.
- Never drop a step the plan calls for just because its page isn't in the model. Cover the whole requested flow.
- "feature" must be one of the application model's concepts.
- "steps" are concrete, ordered, human-readable actions (e.g. "Click the 'Log in' button"), not vague ("Test the login").
- "expected" is the concrete, observable outcome — an element becoming visible, a URL changing, specific text appearing — not a vague pass/fail statement.

Example of the exact shape required — note the first four steps name real entry-page elements
verbatim, and the steps after the login click describe intent for pages not yet in the model:
[ { "title": "Buy an item after logging in", "priority": "high", "feature": "Login",
    "steps": ["Navigate to /login", "Fill 'Username' with 'tomsmith'", "Fill 'Password' with 'SuperSecretPassword!'", "Click 'Login'", "Add the backpack to the cart", "Open the cart", "Complete checkout"],
    "expected": "An order confirmation is displayed" } ]`;
  const user =
`Plan: ${JSON.stringify(p)}
Application model: ${JSON.stringify(appModel)}
Return JSON array: [ { "title","priority","feature","steps":string[],"expected" } ]`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, { systemInstruction: system, json: true });
    try {
      const parsed: any = parseJson(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed.testCases ?? [];
      const result = z.array(TestCase).safeParse(arr);
      if (result.success) return result.data;
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Test cases failed schema validation after retry: ${lastErr}`);
}

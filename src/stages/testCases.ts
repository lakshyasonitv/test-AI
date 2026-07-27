import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import type { Plan } from "./planner.js";
import type { Coverage } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { toLiteModel } from "../schema/appModel.js";
import { strategyFor, unmatchedConcepts, filterByScope, ALL_SCOPES } from "../kb/testStrategy.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

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

/** Priority ranking for sorting (lower number = higher priority). */
const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Limit test cases based on coverage level.
 * - "minimal": Only the fromPrompt case + 1 highest-priority case
 * - "standard": fromPrompt case + top 3 highest-priority cases
 * - "full": All cases (no limiting)
 * Always keeps the fromPrompt case regardless of limits.
 */
function limitByCoverage(cases: TestCase[], coverage: Coverage): TestCase[] {
  if (coverage === "full") return cases;

  const fromPrompt = cases.find(c => c.fromPrompt);
  const others = cases.filter(c => !c.fromPrompt);

  // Sort others by priority (critical first, then high, medium, low)
  const sorted = [...others].sort((a, b) => {
    const ra = rank[a.priority] ?? 2;
    const rb = rank[b.priority] ?? 2;
    return ra - rb;
  });

  switch (coverage) {
    case "minimal":
      // fromPrompt + 1 highest priority
      return fromPrompt
        ? [fromPrompt, ...sorted.slice(0, 1)]
        : sorted.slice(0, 1);

    case "standard":
    default:
      // fromPrompt + top 3
      return fromPrompt
        ? [fromPrompt, ...sorted.slice(0, 3)]
        : sorted.slice(0, 4);
  }
}

export const TestCase = z.object({
  title: z.string(),
  priority: Priority,
  feature: z.string(),
  steps: z.array(z.string()).min(1),
  expected: StringOrJoinedArray,
  // True for the ONE case that's a direct translation of the user's own plan/request,
  // literal values and all. "priority" ranks coverage cases by severity for an eventual
  // multi-case run — it was never meant to pick a single winner, so at N=1 a "critical"
  // taxonomy case (e.g. SQL injection) was silently outranking and replacing whatever the
  // user actually asked to test. Orchestrator prefers this flag over priority for the
  // single case it runs today.
  fromPrompt: z.boolean().optional().default(false),
  category: z.string().optional(),
  // The specific page URL this case targets. Set when the application model contains
  // multiple pages — tells later stages which page to start from / focus on. Optional
  // for backward compatibility with single-page runs.
  targetUrl: z.string().optional(),
  // Distinguishes upfront generation (before execution) from reactive generation
  // (after primary-case execution discovers new pages via live-extend). Used to
  // avoid regenerating cases for pages we already covered. Stamped in code, never
  // produced by the LLM — excluded from the LLM-facing schema below.
  generatedFrom: z.enum(["upfront", "reactive"]).optional().default("upfront"),
});
export type TestCase = z.infer<typeof TestCase>;

// LLM-facing schema: same as TestCase but WITHOUT generatedFrom — the model never
// produces this field, it's stamped in code after parsing.
const LLMTestCase = TestCase.omit({ generatedFrom: true });

// Grounding is deliberately NOT checked here. This stage only ever sees the entry-page model
// (extension enriches the model later, inside toIR), so a fuzzy check here can't tell a
// hallucinated element from one on a page discovery hasn't reached yet — it just killed
// legitimate multi-page cases before they got to the stage that can resolve them. ir.ts's
// groundingError (exact role+name) plus extendAppModel is the single grounding authority.
export async function toTestCases(p: Plan, appModel: AppModel): Promise<TestCase[]> {
  // A human QA engineer doesn't stop at the happy path. Pull the standard coverage
  // categories for whatever features discovery found, and require one case per category —
  // this is what turns "test the login" (one bare case before) into a real suite.
  const concepts = [...new Set(appModel.pages.flatMap(pg => pg.concepts))];
  const categories = strategyFor(concepts);
  const strategyList = categories.map(c => `- [${c.priority}] ${c.title}: ${c.intent}`).join("\n");
  const gaps = unmatchedConcepts(concepts);

  const system =
    `You write concrete, human-readable QA test cases from a plan and an application model. Output ONLY a JSON array, no prose, no markdown fences.

You write a SUITE, not a single happy-path case — the way a QA engineer covers a feature:
valid path, invalid inputs, empty fields, boundaries, and security.

A coverage checklist is provided below for common feature types (login, checkout, search, ...).
It is a KNOWN-RELIABLE FLOOR, not the ceiling of what to test — it exists because past runs
proved that asking for coverage with no guidance produces one bare happy-path case and nothing
else. Produce at least one case per applicable checklist item, using the tag shown as that
case's "priority".

The checklist does not cover every kind of feature. For EVERY concept in the application model
— whether or not it's on the checklist — additionally reason from first principles using these
QA dimensions, applied to the actual elements you see for that concept, not just the checklist:
  1. Valid / expected use
  2. Invalid or malformed input
  3. Empty or boundary values
  4. Security — injection/XSS — wherever a free-text input exists
  5. A verifiable state change the action should cause
This applies with extra weight to any concept with no checklist entry: don't fall back to a
single generic case for it — work out real coverage for what that feature actually does.

The application model may describe one or more pages. Each page has its own URL, concepts, and
elements. A later stage drives the app for real and verifies steps against each page as it
reaches them, so steps beyond the first page are expected.

Exactly ONE case — the direct, literal translation of the plan itself — must be tagged
"fromPrompt": true. Its steps must use whatever concrete values the plan/request actually gave
(a specific email, password, search term, etc.) VERBATIM, never a different placeholder. This is
the case a later stage runs today when it can only execute one; it must be the one the user
actually asked for, not whichever checklist item happens to rank most severe. Every other case
(checklist or first-principles) omits "fromPrompt" or sets it false.

Rules, follow exactly:
- For the CURRENT page — the page this case targets, before any navigating action (login submit, add to cart, checkout) in this test case — every UI element, label, or button name you mention must be taken verbatim from the application model. Never invent an element on that page.
- AFTER a navigating action, the next page isn't in the model yet. Still write those steps: describe the real next action in plain language (e.g. "Add the backpack to the cart", "Complete checkout"). Do not invent a specific element NAME for a page you can't see — describe the intent and let the later stage resolve it against the real page.
- Only write a case whose FIRST action targets an element that actually exists on the target page. Skip a checklist item if the target page has no element to start it (e.g. no search box → skip search cases).
- "targetUrl" must be the URL of the page this case tests, taken verbatim from the application model's pages array. When the model has multiple pages, this tells the later stage which page to start from. When there is only one page, set it to that page's URL.
- "feature" must be one of the application model's concepts.
- "category" is an optional string. For any test case generated to match a checklist item, set "category" to the corresponding category title (e.g., "Invalid password", "Valid credentials", "SQL injection in login", etc.) to identify its intent.
- "steps" are concrete, ordered, human-readable actions (e.g. "Click the 'Log in' button"), not vague ("Test the login").
- "expected" is the concrete, observable outcome — an element becoming visible, a URL changing, specific text appearing — not a vague pass/fail statement.
- Do not invent custom categories; when generating checklist cases, use the exact checklist item title as the "category".

Example of the exact shape required — note the first steps name real entry-page elements
verbatim, steps after a navigating action describe intent for pages not yet in the model, category is populated,
targetUrl points to the page being tested, and
exactly one case (the plan's own literal ask) carries "fromPrompt": true:
[ { "title": "Log in with the given credentials", "priority": "high", "feature": "Login", "fromPrompt": true, "category": "Valid credentials", "targetUrl": "https://example.com/login",
    "steps": ["Navigate to /login", "Fill 'Email' with 'lakshya.soni@thinkvibes.com'", "Fill 'Password' with '123456'", "Click 'Sign In'"],
    "expected": "Login succeeds and the authenticated area is shown" },
  { "title": "Login with invalid password", "priority": "high", "feature": "Login", "category": "Invalid password", "targetUrl": "https://example.com/login",
    "steps": ["Navigate to /login", "Fill 'Email' with 'user@test.com'", "Fill 'Password' with 'wrongpass'", "Click 'Sign In'"],
    "expected": "An 'invalid credentials' error is shown and the user stays on the login page" } ]`;
  const gapsLine = gaps.length
    ? `\nConcepts with NO checklist entry — apply the 5 reasoning dimensions above to these directly, do not just emit one generic case: ${gaps.join(", ")}\n`
    : "";
  const liteModel = toLiteModel(appModel);
  const cacheKey = makeCacheKey(JSON.stringify(p), JSON.stringify(liteModel));
  const cachedCases = llmCacheGet<TestCase[]>(cacheKey);
  if (cachedCases) return cachedCases;

  const user =
    `Plan: ${JSON.stringify(p)}
Application model: ${JSON.stringify(liteModel)}

Coverage checklist floor (produce one grounded case per applicable item):
${strategyList}
${gapsLine}
Return JSON array: [ { "title","priority","feature","steps":string[],"expected","fromPrompt","category","targetUrl" } ]`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, { systemInstruction: system, json: true });
    try {
      const parsed: any = parseJson(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed.testCases ?? [];
      // Parse against LLM-facing schema (no generatedFrom) — the model never produces it.
      const result = z.array(LLMTestCase).safeParse(arr);
      if (result.success) {
        // Stamp generatedFrom in code — this is pipeline provenance, not LLM output.
        const stamped: TestCase[] = result.data.map(c => ({ ...c, generatedFrom: "upfront" as const }));
        const scope = (p.testTypeScope ?? ALL_SCOPES) as typeof ALL_SCOPES;
        const scopedCases = filterByScope(stamped, scope);
        // Apply coverage limiting based on user's chosen level
        const finalCases = limitByCoverage(scopedCases, p.coverage);
        llmCacheSet(cacheKey, finalCases);
        return finalCases;
      }
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Test cases failed schema validation after retry: ${lastErr}`);
}

/**
 * Generate test cases for pages that were discovered reactively during primary-case
 * execution (via live-extend). Filters the updated AppModel to only include pages
 * not present in the original page URLs, then generates cases for those new pages.
 * All generated cases are tagged with `generatedFrom: "reactive"` to distinguish
 * them from upfront-generated cases.
 */
export async function generateCasesForNewPages(
  updatedAppModel: AppModel,
  originalPageUrls: string[],
  plan: Plan,
  prompt: string
): Promise<TestCase[]> {
  // Filter to only new pages not in the original set
  const originalUrlsSet = new Set(originalPageUrls);
  const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));

  if (newPages.length === 0) {
    return []; // No new pages discovered
  }

  // Create a filtered AppModel with only new pages
  const filteredModel: AppModel = {
    baseUrl: updatedAppModel.baseUrl,
    pages: newPages,
  };

  // Generate cases for the new pages
  const cases = await toTestCases(plan, filteredModel);

  // Tag all as reactive
  return cases.map(c => ({ ...c, generatedFrom: "reactive" as const }));
}

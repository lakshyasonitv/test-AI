import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { strategyFor, unmatchedConcepts } from "../kb/defaultStrategy.js";
import { buildRagContext } from "../kb/rag/context.js";
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
  // True for the ONE case that's a direct translation of the user's own plan/request,
  // literal values and all. "priority" ranks coverage cases by severity for an eventual
  // multi-case run — it was never meant to pick a single winner, so at N=1 a "critical"
  // taxonomy case (e.g. SQL injection) was silently outranking and replacing whatever the
  // user actually asked to test. Orchestrator prefers this flag over priority for the
  // single case it runs today.
  fromPrompt: z.boolean().optional().default(false),
});
export type TestCase = z.infer<typeof TestCase>;

// Grounding is deliberately NOT checked here. This stage only ever sees the entry-page model
// (extension enriches the model later, inside toIR), so a fuzzy check here can't tell a
// hallucinated element from one on a page discovery hasn't reached yet — it just killed
// legitimate multi-page cases before they got to the stage that can resolve them. ir.ts's
// groundingError (exact role+name) plus extendAppModel is the single grounding authority.
export async function toTestCases(p: Plan, appModel: AppModel, rawPrompt: string): Promise<TestCase[]> {  // A human QA engineer doesn't stop at the happy path. Pull the standard coverage
  // categories for whatever features discovery found, and require one case per category —
  // this is what turns "test the login" (one bare case before) into a real suite.
  const concepts = [...new Set(appModel.pages.flatMap(pg => pg.concepts))];
  const categories = strategyFor(concepts);

  let ragContext = "";
try {
  ragContext = await buildRagContext({
    url: appModel.baseUrl,
    userPrompt: rawPrompt,
    concepts,
  });
} catch (err: any) {
  // RAG is an enhancement, not a hard dependency — a failed embedding call (rate limit,
  // network blip, expired key) should degrade to "no extra context" for this run, not
  // fail the entire test-generation stage. ragContext stays "" and the prompt template
  // below already handles that case cleanly (no section gets inserted).
  console.warn(`RAG context unavailable, continuing without it: ${err?.message ?? err}`);
}
  const strategyList = categories.map(c => `- [${c.priority}] ${c.title}: ${c.intent}`).join("\n");
  const gaps = unmatchedConcepts(concepts);

  const system =
`You are a Senior QA Automation Engineer responsible for generating precise, executable, and context-aware test cases.

You are provided with:

• User Request
• Current URL
• Current Page
• Discovered UI Elements
• Navigation History (optional)
• Current Application State
• Relevant Knowledge retrieved from the RAG Knowledge Base

################################################################################
PRIMARY OBJECTIVE
################################################################################

Generate a focused and complete test suite that validates ONLY the functionality requested by the user.

Your responsibility is NOT to generate a regression suite.

Your responsibility is to generate all and only the tests required to validate the requested workflow.

################################################################################
REASONING PROCESS
################################################################################

Before generating test cases, internally perform the following reasoning:

STEP 1

Determine exactly what functionality the user wants to validate.

Extract:

• Primary feature
• Requested workflow
• Functional behaviors
• Expected outcome

STEP 2

Review every retrieved RAG item.

For each RAG item ask:

"Does this directly help validate the user's requested workflow?"

If YES

Use it.

If NO

Ignore it completely.

Never generate tests simply because they exist in the retrieved knowledge.

The RAG is guidance, NOT a checklist.

STEP 3

Merge

• User Request
• Discovered Application
• Relevant RAG Knowledge

Generate the final test suite from the merged understanding.

################################################################################
RAG USAGE POLICY
################################################################################

The RAG contains:

• business rules
• workflow knowledge
• expected application behaviour
• feature guidance
• common validations

Use RAG ONLY to

• improve assertions
• improve priorities
• improve expected results
• identify missing workflow validations
• understand business behaviour

DO NOT use RAG to automatically generate every known test for a feature.

Example

User Request

"Login and add Sauce Labs Fleece Jacket to cart."

RAG

Login Feature

- Invalid password
- Empty username
- SQL Injection
- Locked user
- XSS

Correct Behaviour

Ignore these because authentication is only a prerequisite.

Instead use RAG to improve

✓ login success assertion
✓ cart assertion
✓ cart badge verification
✓ item verification

################################################################################
SCOPE CONTROL
################################################################################

Generate tests ONLY for the requested workflow.

If a feature is used only to reach another feature, it is considered a prerequisite.

Do not generate prerequisite feature test suites.

Examples

Request

Login then add item to cart.

Generate

✓ successful login
✓ add item
✓ verify item
✓ verify cart badge
✓ remove item (if directly related)
✓ cart persistence (if directly related)

Do NOT generate

✗ invalid password
✗ empty password
✗ SQL injection
✗ XSS
✗ locked user

because authentication is not the feature under test.

################################################################################
WORKFLOW COVERAGE
################################################################################

Identify every distinct behavior inside the requested workflow.

Generate one or more test cases for each unique behavior.

Examples

Workflow

Upload PDF

Behaviors

• upload valid file
• reject invalid format
• reject oversized file
• preview uploaded file

Generate tests for these behaviors.

Workflow

Shopping Cart

Behaviors

• add item
• verify badge
• verify item in cart
• remove item
• quantity update (if supported)

Generate tests for each supported behavior.

################################################################################
DO NOT GENERATE
################################################################################

Unless the user explicitly requests them or they are essential to the requested workflow:

• SQL Injection
• XSS
• CSRF
• Security testing
• Accessibility testing
• Browser compatibility
• Performance testing
• Load testing
• Random negative testing
• Generic regression tests

################################################################################
QUALITY RULES
################################################################################

Every generated test must

• validate one unique behavior

• have deterministic expected results

• use discovered UI labels

• use discovered URLs

• use discovered controls

• avoid duplicate coverage

• avoid assumptions

• avoid invented functionality

• avoid redundant steps

################################################################################
TEST COUNT
################################################################################

Do NOT generate exactly one test.

Do NOT generate every possible test.

Generate enough test cases so that every unique behavior of the requested workflow is validated exactly once.

Stop when the requested workflow is completely covered.

################################################################################
OUTPUT
################################################################################

Return ONLY a valid JSON array.

Each object must contain

- title
- priority
- feature
- category
- targetUrl
- steps
- expected
- fromPrompt
- generatedFrom

Do not return markdown.

Do not explain your reasoning.

Do not output any text outside the JSON array.`;
  const gapsLine = gaps.length
    ? `\nConcepts with NO checklist entry — apply the 5 reasoning dimensions above to these directly, do not just emit one generic case: ${gaps.join(", ")}\n`
    : "";
  const user =
`Plan: ${JSON.stringify(p)}
Application model: ${JSON.stringify(appModel)}

Coverage checklist floor (produce one grounded case per applicable item):
${strategyList}
${gapsLine}
${ragContext ? `\n${ragContext}\n` : ""}
Return JSON array: [ { "title","priority","feature","steps":string[],"expected","fromPrompt" } ]`;

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

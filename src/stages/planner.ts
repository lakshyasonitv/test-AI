import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { classifyScope, ALL_SCOPES } from "../kb/testStrategy.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

// Derive the Zod enum directly from ALL_SCOPES so it can never drift out of sync.
const TestTypeScopeEnum = z.enum(ALL_SCOPES as [string, ...string[]]);

export type Coverage = "minimal" | "standard" | "full";

export const Plan = z.object({
  goal: z.string(),
  steps: z.array(z.string()).min(1),
  testTypeScope: z.array(TestTypeScopeEnum).default(ALL_SCOPES),
  coverage: z.enum(["minimal", "standard", "full"]).default("standard"),
});
export type Plan = z.infer<typeof Plan>;

export async function plan(
  prompt: string, 
  url: string, 
  coverage: Coverage = "standard"
): Promise<Plan> {
  const testTypeScope = classifyScope(prompt);
  const scopeNote = testTypeScope.length < ALL_SCOPES.length
    ? `\nTest-type scope for this run: ${testTypeScope.join(", ")}. Only generate test cases belonging to these categories.`
    : "";

  const cacheKey = makeCacheKey(prompt, url, coverage, testTypeScope.join(","), process.env.GEMINI_MODEL_LITE ?? "default");
  const cached = llmCacheGet<Plan>(cacheKey);
  if (cached) return cached;

  const system =
`You are a QA planner. Convert a natural-language testing request into an ordered list of high-level test steps. Output ONLY the JSON object, no prose, no markdown fences.

Rules, follow exactly:
- Steps are high-level intentions ("Log in with valid credentials", "Verify the dashboard loads"), never code, CSS/ARIA selectors, or concrete UI element names — that translation happens in a later stage.
- Stay on the feature(s) the request names — don't wander into unrelated features (a "test login" request shouldn't plan checkout). But DON'T strip the plan down to only the happy path: a later stage expands each named feature into a full coverage suite (invalid input, empty fields, security), so plan the primary flow plainly and let that stage add the variations.
- "goal" is a one-sentence restatement of what the request is testing, not a summary of the steps.
- Keep steps in the order a real user would perform them.
- "testTypeScope" must be exactly the scope values listed above. Valid values are "functional" and "security". Use ["functional","security"] as the default when no scope is specified.${scopeNote}
- "coverage" indicates how much to cover: "minimal" (just the core flow), "standard" (core flow + common checks), or "full" (broadest QA coverage). A later stage caps how many cases actually run, so propose good coverage and let it select. Pass through the value provided.

Example of the exact shape required:
{ "goal": "Verify a user can log in with valid credentials and reach the dashboard.",
  "steps": ["Navigate to the login page", "Enter valid credentials", "Submit the login form", "Verify the dashboard is displayed"],
  "testTypeScope": ["functional", "security"],
  "coverage": "standard" }`;
  const user = `Request: ${prompt}\nTarget URL: ${url}\nCoverage: ${coverage}\nReturn JSON: { "goal": string, "steps": string[], "testTypeScope": ("functional"|"security")[], "coverage": ("minimal"|"standard"|"full") }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, { systemInstruction: system, json: true, model: process.env.GEMINI_MODEL_LITE });
    try {
      const parsed = parseJson(raw);
      // Override the LLM's scope with our heuristic — the heuristic is authoritative.
      parsed.testTypeScope = testTypeScope;
      // Override coverage with user-provided value
      parsed.coverage = coverage;
      const result = Plan.safeParse(parsed);
      if (result.success) {
        llmCacheSet(cacheKey, result.data);
        return result.data;
      }
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Plan failed schema validation after retry: ${lastErr}`);
}

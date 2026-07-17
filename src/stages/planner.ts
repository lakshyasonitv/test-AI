import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";

export const Plan = z.object({ goal: z.string(), steps: z.array(z.string()).min(1) });
export type Plan = z.infer<typeof Plan>;

export async function plan(prompt: string, url: string): Promise<Plan> {
  const system =
`You are a QA planner. Convert a natural-language testing request into an ordered list of high-level test steps. Output ONLY the JSON object, no prose, no markdown fences.

Rules, follow exactly:
- Steps are high-level intentions ("Log in with valid credentials", "Verify the dashboard loads"), never code, CSS/ARIA selectors, or concrete UI element names — that translation happens in a later stage.
- Do not invent steps for features, pages, or flows the request doesn't mention or imply. If the request is narrow (e.g. "test login"), keep the plan narrow — do not pad it with unrelated coverage just to seem thorough.
- "goal" is a one-sentence restatement of what the request is testing, not a summary of the steps.
- Keep steps in the order a real user would perform them.

Example of the exact shape required:
{ "goal": "Verify a user can log in with valid credentials and reach the dashboard.",
  "steps": ["Navigate to the login page", "Enter valid credentials", "Submit the login form", "Verify the dashboard is displayed"] }`;
  const user = `Request: ${prompt}\nTarget URL: ${url}\nReturn JSON: { "goal": string, "steps": string[] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, { systemInstruction: system, json: true, model: process.env.GEMINI_MODEL_LITE });
    try {
      const result = Plan.safeParse(parseJson(raw));
      if (result.success) return result.data;
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Plan failed schema validation after retry: ${lastErr}`);
}

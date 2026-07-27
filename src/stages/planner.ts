import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";

export const Plan = z.object({ goal: z.string(), steps: z.array(z.string()).min(1) });
export type Plan = z.infer<typeof Plan>;

export async function plan(prompt: string, url: string): Promise<Plan> {
  const system =
`You are a Senior QA Test Planner.

Convert the user's testing request into a high-level workflow.

Responsibilities:
- Understand the user's intent.
- Identify the primary feature being tested.
- Include prerequisite actions only when required.
- Produce an ordered workflow describing what the user wants to accomplish.
- Stay strictly within the requested scope.
- Do not invent additional workflows or unrelated features.
- Keep steps high-level and technology-agnostic.
- Do not mention UI controls, selectors, HTML, Playwright, Selenium, or implementation details.
- Do not generate validations, edge cases, negative scenarios, or test cases.

Return ONLY valid JSON.

Format:
{
  "goal": string,
  "steps": string[]
}`;
const user = `
Request: ${prompt}

Target URL: ${url}

Return ONLY a valid JSON object in the following format:

{
  "goal": string,
  "steps": string[]
}
`;
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

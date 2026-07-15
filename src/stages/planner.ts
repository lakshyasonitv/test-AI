import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";

export const Plan = z.object({ goal: z.string(), steps: z.array(z.string()).min(1) });
export type Plan = z.infer<typeof Plan>;

export async function plan(prompt: string, url: string): Promise<Plan> {
  const system = `You are a QA planner. Convert a natural-language testing request into an ordered list of high-level steps. Do NOT write code, selectors, or concrete values. Output JSON only.`;
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

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

export async function toTestCases(p: Plan, appModel: AppModel): Promise<TestCase[]> {
  const system = `You write concrete, human-readable QA test cases from a plan and an application model. Use ONLY elements present in the application model. Output a JSON array only.`;
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

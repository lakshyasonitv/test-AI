import { z } from "zod";
import { readFileSync } from "node:fs";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { findScreenshot } from "./executor.js";
import type { IR } from "../schema/ir.js";
import type { ExecResult } from "./executor.js";

const KNOWN_CATEGORIES = ["selector_changed","element_missing","timeout","assertion_failed","navigation_error","other"] as const;

// Falls back to "other" for anything outside the known set (e.g. Gemini describing a
// real Playwright error like "strict mode violation" accurately but outside our
// vocabulary) instead of failing schema validation and losing an otherwise-good
// diagnosis — same fallback-to-safe-default pattern as KNOWN_ROLES in ir.ts.
const Category = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const norm = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return (KNOWN_CATEGORIES as readonly string[]).includes(norm) ? norm : "other";
  },
  z.enum(KNOWN_CATEGORIES)
);

export const Diagnosis = z.object({
  failingStepId: z.string().nullable(),
  category: Category,
  explanation: z.string(),
  suggestedFix: z.string(),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

/**
 * Pull the real failure text out of Playwright's JSON report. The top-level `errors`
 * array is only populated for config/compile-time errors — for an ordinary test failure
 * it is `[]`, and the actual message/stack lives deep in
 * suites[].specs[].tests[].results[].errors[]. Reading the top-level field left the
 * diagnosis LLM with "[]" and forced it to guess from the screenshot alone.
 */
function extractErrors(raw: any): unknown[] {
  const top = raw?.errors;
  if (Array.isArray(top) && top.length) return top;

  const found: unknown[] = [];
  for (const suite of raw?.suites ?? []) {
    for (const spec of suite?.specs ?? []) {
      for (const t of spec?.tests ?? []) {
        for (const r of t?.results ?? []) {
          for (const e of r?.errors ?? []) found.push(e);
        }
      }
    }
  }
  return found;
}

export async function analyzeFailure(ir: IR, result: ExecResult): Promise<Diagnosis> {
  const errors = extractErrors(result.raw);
  const errorText = JSON.stringify(errors.length ? errors : result.raw ?? {}, null, 2).slice(0, 8000);
  const shot = findScreenshot(result.artifactsDir);
  const system = `You diagnose a failed Playwright test. Identify which IR step failed and the most likely cause. Output JSON only.
Allowed categories: ${KNOWN_CATEGORIES.join(", ")}. If the failure doesn't clearly match one of the first five, use "other".`;
  const user =
`IR: ${JSON.stringify(ir)}
Execution error output:
${errorText}
Return JSON: { "failingStepId", "category", "explanation", "suggestedFix" }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system,
      json: true,
      imageBase64: shot ? readFileSync(shot).toString("base64") : undefined,
      imageMime: "image/png",
    });
    try {
      const parsed = Diagnosis.safeParse(parseJson(raw));
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Diagnosis failed schema validation after retry: ${lastErr}`);
}

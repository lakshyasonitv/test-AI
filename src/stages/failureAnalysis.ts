import { z } from "zod";
import { readFileSync } from "node:fs";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { findScreenshot } from "./executor.js";
import { KNOWN_CATEGORIES, findFailingStepId, classify } from "./classify.js";
import type { IR } from "../schema/ir.js";
import type { ExecResult } from "./executor.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

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

export function errorTextFrom(result: ExecResult): string {
  const errors = extractErrors(result.raw);
  return JSON.stringify(errors.length ? errors : result.raw ?? {}, null, 2).slice(0, 8000);
}

/** Extract only the failing element + nearby ancestors/siblings from a full ARIA snapshot. */
function compressSnapshot(snapshot: string, target?: { role?: string; name?: string }): string {
  if (!target?.role && !target?.name) {
    return snapshot.split('\n').slice(-200).join('\n');
  }
  const lines = snapshot.split('\n');
  const role = (target.role ?? '').toLowerCase();
  const name = (target.name ?? '').toLowerCase();

  const matchIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (role && line.includes(role) && (!name || line.includes(name))) {
      for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 3); j++) {
        matchIndices.add(j);
      }
    }
  }

  if (matchIndices.size === 0) {
    return lines.slice(-100).join('\n');
  }

  const sorted = [...matchIndices].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= end + 2) {
      end = sorted[i];
    } else {
      ranges.push(lines.slice(start, end + 1).join('\n'));
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(lines.slice(start, end + 1).join('\n'));
  return ranges.join('\n...\n');
}

export async function analyzeFailure(ir: IR, result: ExecResult): Promise<Diagnosis> {
  const errorText = errorTextFrom(result);

  // Deterministic classifier first — free, instant, and anchored to real Playwright error
  // strings. This used to call failure/ruleAnalysis.ts, which was coarser AND hard-coded
  // `failingStepId: null` in every branch. That null was fatal to self-healing: the
  // orchestrator needs a failing step id to compute a replay prefix, so heal could never
  // fire — including for the two categories ruleAnalysis itself reported as healable.
  const deterministic = classify(errorText);
  if (deterministic) {
    return {
      failingStepId: findFailingStepId(ir, errorText),
      category: deterministic.category,
      explanation: deterministic.explanation,
      suggestedFix: deterministic.suggestedFix,
    };
  }

  const cacheKey = makeCacheKey(errorText, JSON.stringify(ir.steps.slice(-5)));
  const cached = llmCacheGet<Diagnosis>(cacheKey);
  if (cached) return cached;

  const shot = result.screenshot ?? findScreenshot(result.artifactsDir);
  const failingTarget = ir.steps.find(s => s.id === findFailingStepId(ir, errorText))?.target;
  const snapshotBlock = result.accessibilitySnapshot
    ? `\nPage accessibility snapshot at the moment of failure (ARIA tree — this is ground truth for what was actually rendered/visible, more reliable than inferring from the screenshot):\n${compressSnapshot(result.accessibilitySnapshot, failingTarget)}\n`
    : "";

  let currentUrl = result.currentUrl;
  if (!currentUrl) {
    const lastNavigate = ir.steps.slice().reverse().find(s => s.action === "navigate");
    const lastPath = lastNavigate?.target?.url ?? "/";
    currentUrl = lastPath.startsWith("http") ? lastPath : (ir.meta.baseUrl.replace(/\/$/, "") + lastPath);
  }
  const urlBlock = `\nPage URL at failure: ${currentUrl}\n`;
  
  const relevantSteps = ir.steps.slice(-5);
  
  const system = `You diagnose a failed Playwright test. Identify which IR step failed and the most likely cause. Output JSON only.
Allowed categories: ${KNOWN_CATEGORIES.join(", ")}.
- "element_missing" = element was NOT found in the DOM at all (zero matches).
- "element_not_interactable" = element WAS found but was hidden, off-screen, or not enabled (visible=false, display:none, outside viewport, covered by overlay).
- "element_hidden" = element was found but its visibility assertion failed.
If the failure doesn't clearly match one of the above, use "other".
Do NOT repeat Playwright's message verbatim. Only infer causes that cannot be determined from the raw error.
Never invent selectors or missing elements.
Treat the accessibility snapshot as the primary source of truth (more reliable than inferring from the screenshot).`;
  
  const user = `IR Steps: ${JSON.stringify(relevantSteps)}
Execution error output:
${errorText}
${urlBlock}${snapshotBlock}
Return JSON: { "failingStepId", "category", "explanation", "suggestedFix" }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system,
      json: true,
      model: process.env.GEMINI_MODEL_LITE,
      imageBase64: shot ? readFileSync(shot).toString("base64") : undefined,
      imageMime: "image/png",
    });
    try {
      const parsed = Diagnosis.safeParse(parseJson(raw));
      if (parsed.success) {
        llmCacheSet(cacheKey, parsed.data);
        return parsed.data;
      }
      lastErr = parsed.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Diagnosis failed schema validation after retry: ${lastErr}`);
}

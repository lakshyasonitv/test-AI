import { z } from "zod";
import { llm } from "../llm/client.js";
import { parseJson } from "../llm/json.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, llmCacheVersion } from "../kb/llmCache.js";
import { llmCacheDimension } from "../llm/llmContext.js";
import { extractControlNames } from "./controlNames.js";
import type { TestCase } from "./testCases.js";

/**
 * Gap 5 (TD-136): the request's own values must survive into the primary test case.
 *
 * Run 2026-10-15T18-02-40, a short request: "...Self Use as purpose, Buying Timeline "Later",
 * Preferred Project "The Sanctuary", Preferred Areas "Abu Dhabi", Preferred Unit Type "Office"...".
 * The case writer turned that into "provide valid preference selections" — every value gone — and
 * the IR stage builds from the CASE's steps only, so nothing downstream could get them back. TD-127
 * restores a name the case still contains in another spelling; it cannot restore one that was
 * dropped.
 *
 * The check is plain code over the person's request and the case's text (the same inputs TD-127
 * reads): every quoted value and every multi-word Capitalised name the person wrote must appear in
 * the fromPrompt case. When some are missing, ONE focused model call rewrites that case's steps to
 * carry them, and code checks the rewrite: it is taken only if it is strictly better and loses
 * nothing the case already had. Salesforce runs only; general to any Salesforce site.
 */

/** Imperative verbs that open a request clause; "Click Explore Projects" names "Explore Projects". */
const LEADING_VERBS = new Set([
  "click", "fill", "select", "enter", "type", "choose", "pick", "check", "verify", "submit", "open",
  "press", "tap", "tick", "navigate", "go", "then", "and",
]);

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"']/g, "").replace(/\s+/g, " ").trim();

/** The values and names a request commits the primary case to, exact text kept, longest first. */
export function requestValues(request: string): string[] {
  const out = new Set<string>();
  for (const name of extractControlNames(request)) {
    // A Capitalised run can cross a sentence end ("Express Interest. Fill"): split it there.
    for (const piece of name.split(/(?<=[.!?;:])\s+/)) {
      const raw = piece.replace(/[.!?;:,]+$/, "").trim();
      const words = raw.split(/\s+/);
      while (words.length > 1 && LEADING_VERBS.has(words[0].toLowerCase())) words.shift();
      const v = words.join(" ").trim();
      // A single word is required only when the person wrote it as a name on its own (quoted, or
      // before a control noun) — never a lone leftover like the "Fill" that opens a sentence.
      const standalone = piece === name && raw === v;
      if (v.length >= 2 && (words.length > 1 || standalone)) out.add(v);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The values a case does not mention anywhere in its steps or expected outcome. */
export function missingValues(c: Pick<TestCase, "steps" | "expected">, values: string[]): string[] {
  const text = norm([...c.steps, c.expected ?? ""].join("\n"));
  return values.filter((v) => !text.includes(norm(v)));
}

const Rewrite = z.object({ steps: z.array(z.string().min(1)).min(1), expected: z.string().min(1) });

const SYSTEM = `You repair ONE QA test case so it carries the concrete values the person asked for. Output ONLY a JSON object {"steps": string[], "expected": string}, no prose, no markdown fences.

Rules, follow exactly:
- Keep the case's flow, order and wording; change only what is needed.
- Every listed value must appear VERBATIM, in quotes, in the step where the person's request uses it (a value chosen in a field goes in the step that fills or selects that field; a button or link name goes in the step that clicks it; an expected message goes in "expected").
- Never drop a value or element name the case already has, never invent an element, never add a step the request does not describe.`;

/**
 * Restore dropped request values into every fromPrompt case. Returns the cases (new objects only for
 * the ones changed) and how many were fixed. Never throws: a failed repair keeps the original case.
 */
export async function restoreDroppedValues(
  cases: TestCase[], request: string, screens = "",
): Promise<{ cases: TestCase[]; fixed: number }> {
  const values = requestValues(request);
  if (!values.length) return { cases, fixed: 0 };
  let fixed = 0;
  const out: TestCase[] = [];
  for (const c of cases) {
    const missing = c.fromPrompt ? missingValues(c, values) : [];
    if (!missing.length) { out.push(c); continue; }
    const repaired = await repairCase(c, request, values, missing, screens);
    if (repaired) { out.push(repaired); fixed++; } else out.push(c);
  }
  return { cases: out, fixed };
}

async function repairCase(
  c: TestCase, request: string, values: string[], missing: string[], screens: string,
): Promise<TestCase | null> {
  const key = makeCacheKey("request-values:1", JSON.stringify({ steps: c.steps, expected: c.expected }), request,
    JSON.stringify(missing), SYSTEM, llmCacheDimension("main"), llmCacheVersion(), ...(screens ? [screens] : []));
  let rewrite = llmCacheGet<z.infer<typeof Rewrite>>(key, "requestvalues");
  if (!rewrite) {
    const user = `The person's request:\n${request}\n\nThe test case:\n${JSON.stringify({ title: c.title, steps: c.steps, expected: c.expected })}\n\n` +
      `Values from the request that the case DROPPED — put each one back, verbatim and quoted:\n${missing.map((m) => `- "${m}"`).join("\n")}` +
      // Gap 1: which screen holds which field, so each value lands in the step for ITS screen.
      (screens ? `\n${screens}` : "");
    try {
      const { content } = await llm(user, { systemInstruction: SYSTEM, json: true, role: "main", stage: "testcases-values" });
      const parsed = Rewrite.safeParse(parseJson(content));
      if (!parsed.success) { console.log("[testCases] value repair returned an invalid shape; keeping the case as written"); return null; }
      rewrite = parsed.data;
    } catch (err: any) {
      console.log("[testCases] value repair failed; keeping the case as written:", err?.message ?? err);
      return null;
    }
  }
  const after = missingValues(rewrite, values);
  const lost = after.filter((v) => !missing.includes(v));
  if (lost.length || after.length >= missing.length) {
    console.log(`[testCases] value repair rejected: still missing ${after.length}/${missing.length}${lost.length ? `, and it lost ${lost.map((l) => `"${l}"`).join(", ")}` : ""}`);
    return null;
  }
  llmCacheSet(key, rewrite, "requestvalues");
  console.log(`[testCases] restored ${missing.length - after.length} dropped request value(s) into "${c.title}"` +
    (after.length ? `; still missing ${after.map((a) => `"${a}"`).join(", ")}` : ""));
  return { ...c, steps: rewrite.steps, expected: rewrite.expected };
}

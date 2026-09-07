import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { findScreenshot } from "./executor.js";
import { siteHost } from "../text.js";
import { KNOWN_CATEGORIES, findFailingStepId, classify } from "./classify.js";
import type { IR } from "../schema/ir.js";
import type { ExecResult } from "./executor.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";
import { cutAtBoundary } from "../text.js";

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
  /** Set only when verifyDiagnosisText() independently confirmed a quoted string from
   *  explanation/suggestedFix actually appears in the page's own captured accessibility
   *  snapshot at the moment of failure — deterministic, structural confirmation, not the LLM's
   *  self-report. Deliberately kept separate from `suggestedFix`/`explanation` rather than
   *  edited in place, so "the model's guess" and "independently confirmed against real
   *  captured DOM state" stay visibly distinct wherever a Diagnosis is read or rendered. See
   *  TECH_DEBT.md TD-38 for why this isn't (yet) fed back into toIR or heal's eligibility. */
  verifiedText: z.string().optional(),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

// A short-ish quoted substring inside a diagnosis sentence — "the real text is 'X'" — is
// almost always where a diagnosis states the actual page text it observed, distinct from the
// narrative padding around it (which never matches the snapshot verbatim, so checking the
// WHOLE sentence would essentially never confirm anything). Length-bounded to skip both
// trivial single-character quotes and implausibly long "quotes" that are really just prose
// that happened to be wrapped in stray quote characters.
function extractQuotedCandidates(text: string): string[] {
  const out: string[] = [];
  const re = /['"“”]([^'"“”]{3,120})['"“”]/g; // fresh instance per call — a shared regex with
  let m: RegExpExecArray | null;              // the "g" flag carries lastIndex across calls,
  while ((m = re.exec(text))) out.push(m[1]); // a real bug if this were module-level.
  return out;
}

/**
 * Independently confirms (or doesn't) a diagnosis's claimed replacement text against the
 * page's own captured accessibility snapshot — Playwright's auto-captured `error-context`
 * output, deterministic ground truth about what was actually rendered, not an LLM's report
 * about it. `Diagnosis.suggestedFix`/`explanation` are free text from a Gemini call (the
 * deterministic classify() path never reaches here); trusting them at face value for anything
 * downstream (like feeding a "corrected" assertion back into IR generation) risks over-firing
 * on a plausible-sounding but wrong guess. This function is the deterministic check that
 * decides whether a claim is trustworthy enough to act on — see CLAUDE.md's central rule that
 * every model claim needs a structural verifier, not a trust-and-hope.
 *
 * Returns the first confirmed quoted candidate, or undefined if none of them appear in the
 * snapshot (including when there's no snapshot to check against at all).
 */
export function verifyDiagnosisText(diagnosis: Diagnosis, result: ExecResult): string | undefined {
  const snapshot = result.accessibilitySnapshot;
  if (!snapshot) return undefined;
  const normSnapshot = snapshot.toLowerCase().replace(/\s+/g, " ");
  const candidates = [
    ...extractQuotedCandidates(diagnosis.suggestedFix),
    ...extractQuotedCandidates(diagnosis.explanation),
  ];
  for (const candidate of candidates) {
    const normCandidate = candidate.toLowerCase().replace(/\s+/g, " ").trim();
    if (normCandidate.length >= 3 && normSnapshot.includes(normCandidate)) return candidate.trim();
  }
  return undefined;
}

// Module-level so the cache key can hash it before the call is built — the key is computed
// early, and a prompt defined inside the function would be unavailable at that point.
const SYSTEM = `You diagnose a failed Playwright test. Identify which IR step failed and the most likely cause. Output JSON only.
Allowed categories: ${KNOWN_CATEGORIES.join(", ")}.
- "element_missing" = element was NOT found in the DOM at all (zero matches).
- "element_not_interactable" = element WAS found but was hidden, off-screen, or not enabled (visible=false, display:none, outside viewport, covered by overlay).
- "element_hidden" = element was found but its visibility assertion failed.
If the failure doesn't clearly match one of the above, use "other".
Do NOT repeat Playwright's message verbatim. Only infer causes that cannot be determined from the raw error.
Never invent selectors or missing elements.
Treat the accessibility snapshot as the primary source of truth (more reliable than inferring from the screenshot).`;

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
  return cutAtBoundary(JSON.stringify(errors.length ? errors : result.raw ?? {}, null, 2), 8000);
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

/**
 * The run ended back on the login page — so it was never authenticated, whatever the Playwright
 * error happens to say.
 *
 * Worth its own branch because the generic classifier is actively misleading here. Run
 * 2026-08-22T07-04-23-933Z-04c5704b failed with `element_missing` — *"the element may have been
 * renamed, moved behind another interaction, or removed entirely"* — and sent two debugging
 * sessions looking for a renamed button. `final-page.txt` said the flow was sitting on
 * `/login`, showing "Welcome back / Email / Password". Nothing was renamed; the test simply
 * never signed in.
 *
 * Structural on purpose: it compares the final URL against the login URL discovery recorded, and
 * never reads the page's prose (CLAUDE.md's TD-01 rule). `final-page.txt` is `url + "\n" + text`
 * — generator.ts writes it in a `test.afterEach`, so it exists on failures too.
 */
function endedOnLoginPage(result: ExecResult, loginUrl?: string): string | null {
  if (!loginUrl) return null;
  try {
    const body = readFileSync(path.join(result.artifactsDir, "final-page.txt"), "utf8");
    const finalUrl = body.split("\n")[0]?.trim();
    if (!finalUrl) return null;
    // Host + path, not origin + path: both URLs here are normally post-redirect, but a
    // `loginUrl` carried over from an entered address would differ only by scheme and this
    // check would silently stop recognising the login page. Same trap as TD-82.
    const a = new URL(finalUrl), b = new URL(loginUrl);
    return siteHost(finalUrl) === siteHost(loginUrl) && a.pathname === b.pathname ? finalUrl : null;
  } catch {
    return null;   // no artifact, or an unparseable URL — not a reliable signal
  }
}

export async function analyzeFailure(
  ir: IR, result: ExecResult,
  /** `AppModel.auth.loginUrl`. Present only when discovery found a login gate. */
  loginUrl?: string,
): Promise<Diagnosis> {
  const errorText = errorTextFrom(result);

  // Before the generic classifier: an un-authenticated run misreports as whatever the first
  // missing element happened to be, which is the wrong thing to go looking for.
  const bounced = endedOnLoginPage(result, loginUrl);
  if (bounced) {
    return {
      failingStepId: findFailingStepId(ir, errorText),
      category: "navigation_error",
      explanation:
        `The test was not signed in — it finished on the login page (${bounced}). Every step after ` +
        `the app redirected there acts on the login screen, so whatever it reported as missing was ` +
        `simply not on that page.`,
      suggestedFix:
        `Check the credentials for this site are still valid, and that discovery's recorded login ` +
        `steps still match the live login form (AppModel.auth.loginSteps).`,
    };
  }

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

  // SYSTEM joins the key so editing a diagnosis rule actually reaches errors already seen —
  // the disk cache has no expiry, so anything left out is served stale permanently.
  const cacheKey = makeCacheKey(
    errorText, JSON.stringify(ir.steps.slice(-5)),
    SYSTEM, process.env.GEMINI_MODEL_LITE ?? "default");
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
  
  const system = SYSTEM;

  const user = `IR Steps: ${JSON.stringify(relevantSteps)}
Execution error output:
${errorText}
${urlBlock}${snapshotBlock}
Return JSON: { "failingStepId", "category", "explanation", "suggestedFix" }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content: raw } = await gemini(user, {
      systemInstruction: system,
      json: true,
      model: process.env.GEMINI_MODEL_LITE,
      imageBase64: shot ? readFileSync(shot).toString("base64") : undefined,
      imageMime: "image/png",
      stage: "failure_analysis",
    });
    try {
      const parsed = Diagnosis.safeParse(parseJson(raw));
      if (parsed.success) {
        const verifiedText = verifyDiagnosisText(parsed.data, result);
        const diagnosis = verifiedText ? { ...parsed.data, verifiedText } : parsed.data;
        llmCacheSet(cacheKey, diagnosis);
        return diagnosis;
      }
      lastErr = parsed.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Diagnosis failed schema validation after retry: ${lastErr}`);
}

import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { llm, cacheModelDimension } from "../llm/client.js";
import { parseJson } from "../llm/json.js";
import { findScreenshot, extractFailureDetail } from "./executor.js";
import { siteHost } from "../text.js";
import { KNOWN_CATEGORIES, findFailingStepId, classify } from "./classify.js";
import type { IR } from "../schema/ir.js";
import type { ExecResult } from "./executor.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, isCacheableResult, llmCacheVersion } from "../kb/llmCache.js";
import { cutAtBoundary } from "../text.js";
import { llmCacheDimension } from "../llm/llmContext.js";

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
/**
 * Which IR step ACTUALLY failed, from Playwright's own structured report.
 *
 * This is ground truth, not inference. `extractFailureDetail` reads the position of the first
 * step carrying an error, and `generateSpec` emits exactly one `test.step()` per IR step in order,
 * so that position maps straight onto `ir.steps`. Contrast `findFailingStepId`, which regexes the
 * error TEXT to guess — fine as a fallback, but it is reading prose.
 *
 * Returns undefined when the report has no step-level error (an older report, a crash before any
 * step ran). Callers must treat that as "no ground truth" and not reject anything.
 */
export function recordedFailingStepId(ir: IR, result: ExecResult): string | undefined {
  const { failedStep } = extractFailureDetail(result.raw);
  if (typeof failedStep !== "number") return undefined;
  return ir.steps[failedStep - 1]?.id;   // failedStep is 1-based
}

/**
 * Does this diagnosis blame a step or an element other than the one that actually failed?
 *
 * Two structural checks, both against the IR rather than against prose:
 *
 *  1. **Step.** `failingStepId` must be the recorded one. Exact id comparison.
 *  2. **Element.** A quoted string in the diagnosis that matches SOME OTHER step's target name,
 *     while matching nothing on the failing step's own target, means the sentence is describing
 *     the wrong control. Deliberately narrow: it only fires when the quote names another step's
 *     element *specifically*, so ordinary prose that happens to quote page text is untouched.
 *
 * Returns a reason string, or undefined when the diagnosis is consistent — or when there is no
 * ground truth to compare against, in which case nothing is rejected.
 */
export function diagnosisBlamesWrongStep(
  diagnosis: Diagnosis, ir: IR, recordedId: string | undefined,
): string | undefined {
  if (!recordedId) return undefined;

  if (diagnosis.failingStepId && diagnosis.failingStepId !== recordedId) {
    return `names step ${diagnosis.failingStepId}, but ${recordedId} is the step that failed`;
  }

  const failing = ir.steps.find((s) => s.id === recordedId);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const ownNames = new Set(
    [failing?.target?.name, failing?.target?.text, failing?.value]
      .filter((v): v is string => typeof v === "string" && v.length > 0).map(norm),
  );
  const otherNames = new Map<string, string>();
  for (const s of ir.steps) {
    if (s.id === recordedId) continue;
    for (const v of [s.target?.name, s.target?.text]) {
      if (typeof v === "string" && v.length >= 3 && !ownNames.has(norm(v))) otherNames.set(norm(v), s.id);
    }
  }

  for (const quoted of [
    ...extractQuotedCandidates(diagnosis.suggestedFix),
    ...extractQuotedCandidates(diagnosis.explanation),
  ]) {
    const hit = otherNames.get(norm(quoted));
    if (hit) return `blames "${quoted}", which belongs to step ${hit}, not to ${recordedId}`;
  }
  return undefined;
}

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
    SYSTEM, cacheModelDimension("lite"), llmCacheDimension("lite"), llmCacheVersion());
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
  
  // Centre the window on the step that ACTUALLY failed, not on the end of the case.
  //
  // This was `ir.steps.slice(-5)` — the last five steps regardless of where the failure was. On a
  // long case the failing step could fall outside that window entirely, and even inside it the
  // model was choosing among five candidates with nothing saying which one Playwright recorded as
  // failing. Naming the wrong step makes the explanation and the suggested fix wrong too.
  //
  // Playwright's report knows the answer exactly (see recordedFailingStepId), so hand it over
  // instead of asking the model to infer it. The two preceding steps stay for context — what a
  // step was acting on usually depends on what came before it.
  const recordedId = recordedFailingStepId(ir, result);
  const failingIdx = recordedId ? ir.steps.findIndex((s) => s.id === recordedId) : -1;
  const relevantSteps = failingIdx >= 0
    ? ir.steps.slice(Math.max(0, failingIdx - 2), failingIdx + 1)
    : ir.steps.slice(-5);   // no step-level error recorded — fall back to the old window

  const system = SYSTEM;

  // Stated separately from the steps so it cannot be mistaken for one more candidate.
  const recordedBlock = recordedId
    ? `\nPlaywright recorded step "${recordedId}" as the one that failed. Diagnose THAT step. Do not attribute the failure to a different step or to a different element.\n`
    : "";

  const baseUser = `IR Steps: ${JSON.stringify(relevantSteps)}
Execution error output:
${errorText}
${urlBlock}${recordedBlock}${snapshotBlock}
Return JSON: { "failingStepId", "category", "explanation", "suggestedFix" }`;

  let lastErr = "";
  let wrongStep = "";   // set when the previous attempt blamed the wrong step/element
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = wrongStep
      ? `${baseUser}\n\nYour previous answer ${wrongStep}. Diagnose the recorded failing step itself.`
      : baseUser;
    const { content: raw } = await llm(user, {
      systemInstruction: system,
      json: true,
      role: "lite",
      imageBase64: shot ? readFileSync(shot).toString("base64") : undefined,
      imageMime: "image/png",
      stage: "failure_analysis",
    });
    try {
      const parsed = Diagnosis.safeParse(parseJson(raw));
      if (parsed.success) {
        // Reject a diagnosis that blames a step or element other than the recorded one — then
        // retry ONCE with the reason, because a wrong step usually means a wrong explanation too.
        const blames = diagnosisBlamesWrongStep(parsed.data, ir, recordedId);
        if (blames && attempt === 0) {
          console.log(`[diagnosis] rejected: ${blames} — retrying`);
          wrongStep = blames;
          lastErr = blames;
          continue;
        }

        // Still wrong on the last attempt: CORRECT it rather than reject it. We already know the
        // right step id structurally, and a guard over model output must never be the sole cause
        // of a dead run — that is TD-01's whole lesson, and this function throws below. The
        // explanation may still be off, so say so rather than silently presenting it as verified.
        const corrected = blames
          ? { ...parsed.data, failingStepId: recordedId ?? parsed.data.failingStepId,
              explanation: `${parsed.data.explanation} (Note: this explanation ${blames}; the step above is the one Playwright recorded as failing.)` }
          : parsed.data;
        if (blames) console.log(`[diagnosis] still ${blames} after retry — overriding failingStepId`);

        const verifiedText = verifyDiagnosisText(corrected, result);
        const diagnosis = verifiedText ? { ...corrected, verifiedText } : corrected;
        if (isCacheableResult(diagnosis)) llmCacheSet(cacheKey, diagnosis);
        return diagnosis;
      }
      lastErr = parsed.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Diagnosis failed schema validation after retry: ${lastErr}`);
}

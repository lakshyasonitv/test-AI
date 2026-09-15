import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toIR } from "./ir.js";
import { generateSpec } from "./generator.js";
import { runSpec, type ExecResult } from "./executor.js";
import { refreshPageModel } from "./liveExtend.js";
import { credentialPolicyFor, promptCarriesCredentials, credentialEnvVars, type Credentials } from "./credentials.js";
import { healStepTarget, type DeterministicHealResult } from "./deterministicHeal.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";
import type { IR, Step } from "../schema/ir.js";
import type { Diagnosis } from "./failureAnalysis.js";
import type { LlmBudget } from "../llm/llmBudget.js";

export interface HealArgs {
  testCase: TestCase;
  ir: IR;
  appModel: AppModel;
  diagnosis: Diagnosis;
  /**
   * True when the failing case runs a hand-written script instead of its IR.
   *
   * Healing MUST NOT run for such a case, and this is the most destructive of the three
   * IR-assuming flows: `attemptHeal` rebuilds the IR from scratch via `toIR` and regenerates the
   * spec from it, never looking at the existing one. On an overridden case a "successful" heal
   * would therefore discard the author's script, run something they never wrote, and report a
   * pass — a green run for code nobody reviewed. Optional and defaulting to false, so every
   * existing caller is unaffected.
   */
  scriptOverridden?: boolean;
  sourcePrompt: string;
  entryUrl: string;
  // Optional, matching toIR's own signature — a heal attempt still works without one, it just
  // isn't budget-tracked (the same behavior an untracked toIR call already has).
  llmBudget?: LlmBudget;
  runCreds?: Credentials;
  /** Caller-owned output directory — a "healed" subdirectory is created inside it. Pass the
   *  run's own directory for the primary case, or a case's own directory for a suite case. */
  outDir: string;
}

export interface HealResult {
  ir: IR;
  result: ExecResult;
  specCode: string;
  /** When true, the heal used the deterministic (structural) path — no LLM call, no
   *  re-snapshot. Present so callers can distinguish cheap heals from expensive ones
   *  in logs and UI without inspecting the heal artifact directory. */
  deterministic?: boolean;
}

/**
 * Grounding rejections a fresh snapshot cannot resolve, so a heal is pure waste.
 *
 * `navigate-url` is the guard refusing an INVENTED route. Re-snapshotting and regenerating cannot
 * make a route real: `toIR` applies the identical deterministic guard against the new model and
 * reaches the identical verdict, at the cost of a full IR regeneration (~3.8k prompt tokens
 * measured across `runs/`). Worse, `attemptHeal` then throws the result away regardless, because
 * "a heal that truncates isn't a heal" — so the spend buys nothing even in principle.
 *
 * Deliberately NARROW. `element_missing` as a RUNTIME diagnosis stays healable: an element that
 * was there at discovery and gone at run time is precisely what heal exists for. What is excluded
 * is only the case where GROUNDING already refused, deterministically, before the test ever ran.
 */
const UNHEALABLE_TRUNCATIONS = new Set(["navigate-url"]);

/**
 * Does a run self-heal when the client says nothing about it?
 *
 * ONE definition, because two consumers have to agree: the orchestrator uses it as the fallback
 * for `options.selfHeal`, and `/api/health` advertises it so the Settings toggle opens in the
 * state the server is actually in. They were separately hardcoded `true`, so the answer was
 * un-configurable and the user could not turn it off for a demo without touching the toggle
 * every time.
 *
 * Defaults to OFF (platform rule 2: a new capability ships behind a flag defaulting off — and a
 * heal is a second full test run plus a full IR regeneration, which should be asked for rather
 * than assumed). Read at call time, not at import, so a test can set the env per case.
 */
export function selfHealDefault(): boolean {
  return process.env.SELF_HEAL_DEFAULT === "true";
}

/** The same gate `attemptHeal` applies internally, exported so a caller can decide whether to
 *  emit a "heal started" event at all (a UI/observability concern) without duplicating the
 *  condition itself — asking twice would risk the two copies drifting apart. */
export function isHealable(diagnosis: Diagnosis, ir: IR): boolean {
  // Read from the structured field, never from `truncationNote` — that note is prose written for
  // a model, and branching on its wording is the failure CLAUDE.md's central rule and TD-01 both
  // record. TD-83.
  if (ir.meta?.truncated && ir.meta.truncationKind
      && UNHEALABLE_TRUNCATIONS.has(ir.meta.truncationKind)) {
    return false;
  }
  const healable = diagnosis.category === "selector_changed" || diagnosis.category === "element_missing";
  const failIdx = diagnosis.failingStepId ? ir.steps.findIndex((s) => s.id === diagnosis.failingStepId) : -1;
  return healable && failIdx > 0;
}

/** True when the DETERMINISTIC_HEAL env flag is set to "true". Read per-call, not at module
 *  load, so tests can set the env var without vi.resetModules() (same pattern as
 *  appModel.ts's liteCaps). */
export function isDeterministicHealEnabled(): boolean {
  return process.env.DETERMINISTIC_HEAL === "true";
}

/**
 * Deterministic, structural self-heal: re-match the failing step's IR target against
 * the AppModel without re-snapshotting the page or calling an LLM. Returns a modified
 * IR + spec that can be re-run directly.
 *
 * This is the cheap first pass — no browser relaunch, no model cost. It covers the
 * common case where an element was renamed, moved, or its role changed but is still
 * discoverable in the current AppModel. Returns null when no deterministic match is
 * found, signaling the caller to fall back to the LLM-based path.
 */
export async function attemptDeterministicHeal(args: HealArgs): Promise<HealResult | null> {
  const { testCase, ir, appModel, diagnosis, runCreds, outDir } = args;

  if (!isHealable(diagnosis, ir)) return null;
  const failIdx = ir.steps.findIndex((s) => s.id === diagnosis.failingStepId);
  if (failIdx < 0) return null;

  const failingStep = ir.steps[failIdx];
  const healed = healStepTarget(failingStep, appModel);
  if (!healed) return null;

  // Build a new IR with the healed step.
  const healedIr: IR = {
    ...ir,
    steps: ir.steps.map((s, i) => (i === failIdx ? healed.step : s)),
  };

  const healedDir = path.join(outDir, "healed");
  mkdirSync(healedDir, { recursive: true });
  const healedSpec = generateSpec(healedIr, path.join(healedDir, "artifacts"));
  const healedRun = await runSpec(healedSpec, healedDir, credentialEnvVars(runCreds));
  if (!healedRun.passed) return null;

  writeFileSync(path.join(healedDir, "generated.spec.ts"), healedSpec);
  writeFileSync(path.join(healedDir, "ir.json"), JSON.stringify(healedIr, null, 2));
  writeFileSync(path.join(healedDir, "deterministic-heal.json"), JSON.stringify({
    failingStepId: diagnosis.failingStepId,
    confidence: healed.confidence,
    changeDescription: healed.changeDescription,
    matchedElement: { role: healed.matchedElement.role, name: healed.matchedElement.name },
  }, null, 2));
  return { ir: healedIr, result: healedRun, specCode: healedSpec, deterministic: true };
}

/**
 * One bounded, one-shot self-heal attempt: re-snapshot the live page up to the failing step,
 * regenerate IR fresh against that snapshot, and accept only if the regenerated test both
 * still covers the whole case (isn't truncated) and actually passes.
 *
 * Extracted from orchestrator.ts's original inline heal block (unchanged logic, just made
 * reusable) so suiteRunner.ts can call the exact same, already-proven sequence for non-primary
 * cases instead of having no retry path at all — see DECISIONS.md D-33 for why this was
 * extracted as one shared function rather than restated per caller (this codebase has already
 * paid for that mistake once, see TECH_DEBT.md TD-07).
 *
 * Deliberately emit-agnostic: it does not call `onEvent`/`emit` at all. Each caller emits
 * progress in its own stage idiom — orchestrator.ts keeps emitting its "heal" StageName (which
 * drives the primary-only phase-4 tracker in public/app.js); suiteRunner.ts instead folds
 * `healed: true` into its own existing "suite"-stage event data. The two must never emit the
 * same "heal" StageName, or a suite case's heal would corrupt that primary-only tracker.
 *
 * Returns null for "not attempted" (wrong diagnosis category, or no valid failing step to
 * replay from) or "attempted but the healed run still didn't pass" — the caller decides what
 * either case means for its own status/reporting. Throws on a genuine error (a failed
 * toIR/refreshPageModel/runSpec call) rather than swallowing it — callers wrap the call in
 * their own try/catch, matching this project's existing convention that a failed heal attempt
 * never masks the original failure with a different, unrelated error.
 */
export async function attemptHeal(args: HealArgs): Promise<HealResult | null> {
  const { testCase, ir, appModel, diagnosis, sourcePrompt, entryUrl, llmBudget, runCreds, outDir } = args;

  // A hand-written script is not healable by construction: healing works by re-deriving the IR
  // against a fresh page model, and the IR is not what ran. Returning null is exactly the
  // "not attempted" signal every other guard here uses, so callers need no new branch.
  if (args.scriptOverridden) return null;

  // A step with no real prefix (first step, or an id toIR never emitted) has nothing to
  // replay from — skip healing, same guard orchestrator.ts's original inline version used.
  if (!isHealable(diagnosis, ir)) return null;

  // When DETERMINISTIC_HEAL is on, try the cheap structural fix first. This avoids a
  // browser re-snapshot and an LLM call for the common case where an element was renamed
  // or moved but is still discoverable in the current AppModel. Only falls through to
  // the expensive LLM path when no deterministic match is found.
  if (isDeterministicHealEnabled()) {
    const deterministicResult = await attemptDeterministicHeal(args);
    if (deterministicResult) return deterministicResult;
  }
  const failIdx = ir.steps.findIndex((s) => s.id === diagnosis.failingStepId);

  const prefix = ir.steps.slice(0, failIdx);
  const credPolicy = credentialPolicyFor(testCase, promptCarriesCredentials(sourcePrompt));
  const freshModel = await refreshPageModel(appModel, prefix, runCreds, credPolicy);
  const { ir: healedIr } = await toIR(testCase, freshModel, sourcePrompt, entryUrl, llmBudget, runCreds);

  // A heal that truncates isn't a heal: it means the failing step still can't be grounded even
  // against a fresh snapshot (genuinely gone, not just renamed), and toIR silently fell back to
  // the safe prefix. Running just that prefix would "pass" without ever exercising the thing
  // that broke — a false positive of exactly the kind this project has hit before. Only accept
  // a heal that still covers the full, originally-intended test case.
  if (healedIr.meta.truncated) return null;

  const healedDir = path.join(outDir, "healed");
  mkdirSync(healedDir, { recursive: true });
  const healedSpec = generateSpec(healedIr, path.join(healedDir, "artifacts"));
  const healedRun = await runSpec(healedSpec, healedDir, credentialEnvVars(runCreds));
  if (!healedRun.passed) return null;

  writeFileSync(path.join(healedDir, "generated.spec.ts"), healedSpec);
  writeFileSync(path.join(healedDir, "ir.json"), JSON.stringify(healedIr, null, 2));
  return { ir: healedIr, result: healedRun, specCode: healedSpec };
}

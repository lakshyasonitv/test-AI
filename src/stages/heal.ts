import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toIR } from "./ir.js";
import { generateSpec } from "./generator.js";
import { runSpec, type ExecResult } from "./executor.js";
import { refreshPageModel } from "./liveExtend.js";
import { credentialPolicyFor, promptCarriesCredentials, credentialEnvVars, type Credentials } from "./credentials.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";
import type { IR } from "../schema/ir.js";
import type { Diagnosis } from "./failureAnalysis.js";
import type { GroqBudget } from "../llm/groqBudget.js";

export interface HealArgs {
  testCase: TestCase;
  ir: IR;
  appModel: AppModel;
  diagnosis: Diagnosis;
  sourcePrompt: string;
  entryUrl: string;
  // Optional, matching toIR's own signature — a heal attempt still works without one, it just
  // isn't budget-tracked (the same behavior an untracked toIR call already has).
  groqBudget?: GroqBudget;
  runCreds?: Credentials;
  /** Caller-owned output directory — a "healed" subdirectory is created inside it. Pass the
   *  run's own directory for the primary case, or a case's own directory for a suite case. */
  outDir: string;
}

export interface HealResult {
  ir: IR;
  result: ExecResult;
  specCode: string;
}

/** The same gate `attemptHeal` applies internally, exported so a caller can decide whether to
 *  emit a "heal started" event at all (a UI/observability concern) without duplicating the
 *  condition itself — asking twice would risk the two copies drifting apart. */
export function isHealable(diagnosis: Diagnosis, ir: IR): boolean {
  const healable = diagnosis.category === "selector_changed" || diagnosis.category === "element_missing";
  const failIdx = diagnosis.failingStepId ? ir.steps.findIndex((s) => s.id === diagnosis.failingStepId) : -1;
  return healable && failIdx > 0;
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
  const { testCase, ir, appModel, diagnosis, sourcePrompt, entryUrl, groqBudget, runCreds, outDir } = args;

  // A step with no real prefix (first step, or an id toIR never emitted) has nothing to
  // replay from — skip healing, same guard orchestrator.ts's original inline version used.
  if (!isHealable(diagnosis, ir)) return null;
  const failIdx = ir.steps.findIndex((s) => s.id === diagnosis.failingStepId);

  const prefix = ir.steps.slice(0, failIdx);
  const credPolicy = credentialPolicyFor(testCase, promptCarriesCredentials(sourcePrompt));
  const freshModel = await refreshPageModel(appModel, prefix, runCreds, credPolicy);
  const { ir: healedIr } = await toIR(testCase, freshModel, sourcePrompt, entryUrl, groqBudget, runCreds);

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

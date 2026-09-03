import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { toIR } from "./ir.js";
import type { LlmBudget } from "../llm/llmBudget.js";
import { generateSpec } from "./generator.js";
import { runSpec, findScreenshot, findVideo, detectBlocked } from "./executor.js";
import { credentialEnvVars, type Credentials } from "./credentials.js";
import { analyzeFailure } from "./failureAnalysis.js";
import { attemptHeal, isHealable } from "./heal.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";
import type { OnEvent, StageEvent } from "../orchestrator.js";
import { store } from "../runStore.js";
import type { ExecResult } from "./executor.js";
import type { IR } from "../schema/ir.js";

/** Already-computed result for the primary case, passed in from the main pipeline
 *  so runSuite can reuse it instead of regenerating IR and re-executing. */
export interface PrimaryCaseResult {
  /** The exact TestCase object the orchestrator executed. Matched by identity below —
   *  a flag can be set on more than one case, an object reference cannot. */
  testCase: TestCase;
  ir: IR;
  result: ExecResult;
  specCode: string;
  healed: boolean;
  /** True when `healed` is set and the heal used the deterministic (no-LLM) path. */
  deterministicHeal?: boolean;
}

export interface CaseRunResult {
  caseId: string;
  title: string;
  status: "passed" | "failed" | "truncated" | "truncated_no_assertion" | "blocked";
  /** Set when the flow hit something automation cannot pass (emailed code, external
   *  sign-in). Carries the proof screenshot. */
  blockedBy?: string;
  blockedScreenshot?: string;
  irPath: string;
  resultPath: string;
  diagnosisPath?: string;
  /** LLM calls/tokens spent generating this case's IR. Omitted for the reused primary
   *  case, whose usage is already counted in the run's top-level llm-usage.json. */
  llmCalls?: number;
  llmTokens?: number;
  /** Plain-English "what this check proves", for the UI. `whyItMatters` (required in the
   *  TestCase schema) is the primary headline — a real-world consequence sentence with no QA
   *  vocabulary. `intent` is the model's QA-toned reasoning, kept for the technical-details
   *  panel. `expected` is required in the schema, so it is the final fallback if both are
   *  somehow missing. */
  whyItMatters?: string;
  intent?: string;
  expected?: string;
  /** True when the case initially failed (element_missing/selector_changed) and a one-shot
   *  self-heal (src/stages/heal.ts) produced a passing retry — see runSuite's non-primary
   *  branch. Absent/false for every other case, including a passing case that never failed. */
  healed?: boolean;
  /** True when `healed` is set AND the heal used the deterministic (structural, no-LLM)
   *  path rather than the LLM-based re-snapshot path. Lets the UI distinguish a cheap heal
   *  from an expensive one without inspecting the heal artifact directory. Absent when the
   *  case didn't heal, or when the heal went through the LLM path. */
  deterministicHeal?: boolean;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  truncated: number;
  truncated_no_assertion: number;
  blocked: number;
  cases: {
    caseId: string; title: string; status: string; resultPath: string;
    llmCalls?: number; llmTokens?: number; blockedBy?: string;
    whyItMatters?: string; intent?: string; expected?: string; healed?: boolean;
    // Already returned by buildSuiteSummary below but never declared here — the same silent
    // interface/implementation drift that let whyItMatters go missing once. Declared now so a
    // future field never repeats it unnoticed.
    screenshotUrl?: string;
    /** Set only for a failed/blocked case with a retained Playwright video — see findVideo. */
    videoUrl?: string;
    /** Distinguishes a deterministic (no-LLM) heal from an LLM-based one. See CaseRunResult. */
    deterministicHeal?: boolean;
  }[];
}

/** Origin of a url, for deciding whether a flow left the application. */
function originOf(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Pure summary-building step, pulled out of runSuite so it's unit-testable without mocking
 *  the whole pipeline (toIR/generateSpec/runSpec/analyzeFailure). Exported specifically so a
 *  test can assert that every field on CaseRunResult actually survives into SuiteSummary —
 *  `whyItMatters` silently failed to make this trip once already (it was on the TestCase and
 *  on CaseRunResult, but three `results.push()` call sites never copied it across), and
 *  nothing caught it because `preview.js`'s fixtures hardcode the field instead of exercising
 *  this mapping. */
export function buildSuiteSummary(results: CaseRunResult[], runDir: string): SuiteSummary {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const truncated = results.filter((r) => r.status === "truncated").length;
  const truncatedNoAssertion = results.filter((r) => r.status === "truncated_no_assertion").length;
  const blockedCount = results.filter((r) => r.status === "blocked").length;

  return {
    total: results.length,
    passed,
    failed,
    truncated,
    truncated_no_assertion: truncatedNoAssertion,
    blocked: blockedCount,
    cases: results.map((r) => {
      // Search the case's artifacts directory. The previous
      // `findScreenshot(path.join(runDir, r.resultPath))` double-counted runDir —
      // r.resultPath already starts with it — so the path never existed and every case in
      // every summary on disk had screenshotUrl: null. The UI's screenshot grid and
      // per-case thumbnails therefore never rendered.
      const caseDir = path.join(runDir, "cases", r.caseId);
      // A healed case's meaningful (passing) screenshot lives under caseDir/healed/artifacts —
      // caseDir/artifacts still holds the ORIGINAL failed attempt's screenshots, which would
      // show a "passed" card next to a failure frame if checked first.
      const shot = r.blockedScreenshot
        ?? (r.healed ? findScreenshot(path.join(caseDir, "healed", "artifacts")) : undefined)
        ?? findScreenshot(path.join(caseDir, "artifacts")) ?? findScreenshot(caseDir);
      const screenshotUrl = shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined;
      // Unlike screenshotUrl, never check caseDir/healed/artifacts here: video is
      // retain-on-failure, and a heal only "counts" once the retry PASSES — a passing
      // Playwright run never keeps a video. The only place a video could ever exist is the
      // original (failing) attempt, healed or not.
      const video = findVideo(path.join(caseDir, "artifacts")) ?? findVideo(caseDir);
      const videoUrl = video ? "/" + path.relative(".", video).replace(/\\/g, "/") : undefined;
      return {
        caseId: r.caseId,
        title: r.title,
        status: r.status,
        // Forward slashes: this is consumed as a URL fragment by the frontend.
        resultPath: `cases/${r.caseId}`,
        screenshotUrl,
        videoUrl,
        llmCalls: r.llmCalls,
        llmTokens: r.llmTokens,
        blockedBy: r.blockedBy,
        whyItMatters: r.whyItMatters,
        intent: r.intent,
        expected: r.expected,
        healed: r.healed,
        deterministicHeal: r.deterministicHeal,
      };
    }),
  };
}

function emit(
  runId: string, stage: string, status: StageEvent["status"],
  data?: unknown, error?: string, onEvent?: OnEvent
) {
  const event: StageEvent = { runId, stage: stage as any, status, data, error, ts: Date.now() };
  store.append(event);
  if (onEvent) onEvent(event);
}

export async function runSuite(
  cases: TestCase[],
  appModel: AppModel,
  runDir: string,
  sourcePrompt: string,
  entryUrl: string,
  onEvent?: OnEvent,
  primaryResult?: PrimaryCaseResult,
  llmBudget?: LlmBudget,
  /** Credentials the user supplied for this run, shared by every case. */
  runCreds?: Credentials,
  /** Per-run self-heal switch (orchestrator.ts RunOptions). Defaults on, matching
   *  the behaviour before the switch existed. */
  selfHeal = true
): Promise<CaseRunResult[]> {
  const results: CaseRunResult[] = [];
  const runId = path.basename(runDir);

  // A suite can have several element_missing/selector_changed cases in one pass — each heal
  // attempt is a fresh Groq call plus a full extra Playwright run, so cap the total per suite
  // rather than let one bad run multiply the spend unboundedly.
  const MAX_SUITE_HEALS = Number(process.env.MAX_SUITE_HEALS ?? 3);
  let healsUsed = 0;

  emit(runId, "suite", "started", { total: cases.length }, undefined, onEvent);

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const caseId = `case-${i}`;
    const caseDir = path.join(runDir, "cases", caseId);
    mkdirSync(caseDir, { recursive: true });

    emit(runId, "suite", "started", { caseId, title: tc.title }, undefined, onEvent);

    // Detect if this case is the one the main pipeline already executed. Identity, not the
    // fromPrompt flag: reactive generation can legitimately produce a second flagged case,
    // and matching on the flag grafted the primary's result onto both of them.
    const isPrimary = primaryResult !== undefined && tc === primaryResult.testCase;

    if (isPrimary) {
      // Reuse the already-executed result — copy artifacts into the suite's expected location
      // so downstream consumers see a uniform cases/case-N/ structure.
      try {
        const irPath = path.join(caseDir, "04-ir.json");
        writeFileSync(irPath, JSON.stringify(primaryResult.ir, null, 2));

        const specPath = path.join(caseDir, "generated.spec.ts");
        writeFileSync(specPath, primaryResult.specCode);

        // Compute honest status from the final (post-heal) result. The primary case is REUSED
        // rather than re-executed, so its blocked check reads the artifacts the main pipeline
        // already produced — without this the run verdict said "blocked" while this case's own
        // card still said "passed".
        const primaryBlocked = detectBlocked(primaryResult.result.artifactsDir, originOf(entryUrl));
        let status: CaseRunResult["status"];
        if (primaryBlocked) {
          status = "blocked";
        } else if (primaryResult.ir.meta.truncated && !primaryResult.ir.meta.hasTerminalAssertion) {
          status = "truncated_no_assertion";
        } else if (primaryResult.ir.meta.truncated) {
          status = "truncated";
        } else if (primaryResult.result.passed) {
          status = "passed";
        } else {
          status = "failed";
        }

        const resultPath = path.join(caseDir, "05-result.json");
        writeFileSync(resultPath, JSON.stringify({
          passed: status === "passed" || status === "truncated",
          intent: tc.intent, expected: tc.expected,
          blockedBy: primaryBlocked?.reason,
          status: status !== "passed" ? status : undefined,
          exitCode: primaryResult.result.exitCode,
          artifactsDir: primaryResult.result.artifactsDir,
          resultsJsonPath: primaryResult.result.resultsJsonPath,
          raw: primaryResult.result.raw,
        }, null, 2));

        // Copy the artifacts directory so screenshots/traces live under the case slot.
        const destArtifacts = path.join(caseDir, "artifacts");
        cpSync(primaryResult.result.artifactsDir, destArtifacts, { recursive: true });

        let diagnosisPath: string | undefined;
        if (!primaryResult.result.passed) {
          const diagnosis = await analyzeFailure(primaryResult.ir, primaryResult.result, appModel.auth?.loginUrl);
          diagnosisPath = path.join(caseDir, "06-diagnosis.json");
          writeFileSync(diagnosisPath, JSON.stringify(diagnosis, null, 2));
        }

        results.push({
          caseId, title: tc.title, status, irPath, resultPath, diagnosisPath,
          whyItMatters: tc.whyItMatters, intent: tc.intent, expected: tc.expected,
          blockedBy: primaryBlocked?.reason,
          // Point at the copy inside the case dir — the source artifacts were copied there above.
          blockedScreenshot: primaryBlocked?.screenshot
            ? path.join(destArtifacts, path.basename(primaryBlocked.screenshot)) : undefined,
          // Reflects whatever orchestrator.ts's own heal already did for the primary case —
          // this branch reuses that result, not a second heal attempt.
          healed: primaryResult.healed,
          ...(primaryResult.deterministicHeal ? { deterministicHeal: true } : {}),
        });
        emit(runId, "suite", "completed", { caseId, title: tc.title, status, reused: true, healed: primaryResult.healed, deterministicHeal: primaryResult.deterministicHeal }, undefined, onEvent);
      } catch (err: any) {
        results.push({ caseId, title: tc.title, status: "failed", irPath: "", resultPath: "" });
        emit(runId, "suite", "failed", { caseId, title: tc.title }, err?.message ?? String(err), onEvent);
      }
    } else {
      // Non-primary case: execute as before (IR generation + Playwright run).
      try {
        console.log("================================");
        console.log("Running:", tc.title);

        console.log("Generating IR...");
        const usageBefore = llmBudget?.snapshot();
        let { ir } = await toIR(tc, appModel, sourcePrompt, entryUrl, llmBudget, runCreds);
        const usageAfter = llmBudget?.snapshot();
        const llmCalls = usageAfter && usageBefore ? usageAfter.calls - usageBefore.calls : undefined;
        const llmTokens = usageAfter && usageBefore ? usageAfter.totalTokens - usageBefore.totalTokens : undefined;
        console.log("IR generated");
        const irPath = path.join(caseDir, "04-ir.json");
        writeFileSync(irPath, JSON.stringify(ir, null, 2));

        console.log("Generating spec...");
        // Per-case screenshot dir, so cases in one suite don't overwrite each other.
        let spec = generateSpec(ir, path.join(caseDir, "artifacts"));
        console.log("Spec generated");
        const specPath = path.join(caseDir, "generated.spec.ts");
        writeFileSync(specPath, spec);

        console.log("Running Playwright...");
        let result = await runSpec(spec, caseDir, credentialEnvVars(runCreds));
        console.log("Playwright finished");

        console.log(result);

        // Determine honest status before saving the result.
        // A wall the test can't pass outranks every other verdict: "passed" would be a lie and
        // "failed" would blame the application for something that isn't its fault.
        const computeStatus = (theIr: typeof ir, theResult: typeof result, theBlocked: ReturnType<typeof detectBlocked>): CaseRunResult["status"] => {
          if (theBlocked) return "blocked";
          if (theIr.meta.truncated && !theIr.meta.hasTerminalAssertion) return "truncated_no_assertion";
          if (theIr.meta.truncated) return "truncated";
          return theResult.passed ? "passed" : "failed";
        };

        let blocked = detectBlocked(path.join(caseDir, "artifacts"), originOf(entryUrl));
        let status = computeStatus(ir, result, blocked);

        let diagnosisPath: string | undefined;
        let healed = false;
        let deterministicHeal = false;
        if (!result.passed) {
          const diagnosis = await analyzeFailure(ir, result, appModel.auth?.loginUrl);
          diagnosisPath = path.join(caseDir, "06-diagnosis.json");
          writeFileSync(diagnosisPath, JSON.stringify(diagnosis, null, 2));

          // Same bounded, one-shot heal orchestrator.ts already runs for the primary case —
          // suite cases never got it at all until now, even though this category is exactly
          // what heal was built for. Recompute status/blocked against the HEALED ir/result, not
          // the original, or a healed-and-passing case would still get reported truncated/failed.
          if (selfHeal && healsUsed < MAX_SUITE_HEALS && isHealable(diagnosis, ir)) {
            healsUsed++;
            try {
              const healedOutcome = await attemptHeal({
                testCase: tc, ir, appModel, diagnosis, sourcePrompt, entryUrl, llmBudget,
                runCreds, outDir: caseDir,
              });
              if (healedOutcome) {
                ir = healedOutcome.ir;
                result = healedOutcome.result;
                spec = healedOutcome.specCode;
                healed = true;
                deterministicHeal = healedOutcome.deterministic === true;
                // Unlike orchestrator.ts's primary case — which also has a live "done" event
                // payload carrying the healed ir/spec directly — a suite case's ONLY channel to
                // the frontend is these on-disk files (loadCaseDetails fetches 04-ir.json and
                // generated.spec.ts straight from caseDir). Leaving them as the original,
                // pre-heal attempt would show a spec that doesn't match the reported "passed"
                // status, so overwrite them here. attemptHeal's own caseDir/healed/* copy is
                // kept too, as the forensic record of what heal specifically produced.
                writeFileSync(irPath, JSON.stringify(ir, null, 2));
                writeFileSync(specPath, spec);
                // The healed run's own artifacts live under caseDir/healed/artifacts — check
                // there for a block wall too, not the original (failed) attempt's directory.
                blocked = detectBlocked(path.join(caseDir, "healed", "artifacts"), originOf(entryUrl));
                status = computeStatus(ir, result, blocked);
              }
            } catch (err: any) {
              // Original diagnosis and result stand unchanged — same "never mask the real
              // failure" rule orchestrator.ts's heal already follows.
              console.log("[suite] heal attempt failed:", err?.message ?? err);
            }
          }
        }

        const resultPath = path.join(caseDir, "05-result.json");
        writeFileSync(resultPath, JSON.stringify({
          passed: status === "passed" || status === "truncated",
          blockedBy: blocked?.reason,
          status: status !== "passed" ? status : undefined,
          exitCode: result.exitCode,
          artifactsDir: result.artifactsDir,
          resultsJsonPath: result.resultsJsonPath,
          raw: result.raw,
        }, null, 2));

        results.push({
          caseId, title: tc.title, status, irPath, resultPath, diagnosisPath, llmCalls, llmTokens, healed,
          whyItMatters: tc.whyItMatters, intent: tc.intent, expected: tc.expected,
          blockedBy: blocked?.reason, blockedScreenshot: blocked?.screenshot ?? undefined,
          ...(deterministicHeal ? { deterministicHeal: true } : {}),
        });

        emit(runId, "suite", "completed", { caseId, title: tc.title, status, healed, deterministicHeal }, undefined, onEvent);
      } catch (err: any) {
        results.push({
          caseId, title: tc.title, status: "failed",
          irPath: "", resultPath: "",
        });

        emit(runId, "suite", "failed", { caseId, title: tc.title },
          err?.message ?? String(err), onEvent);
      }
    } // end non-primary else branch
  }

  const summary = buildSuiteSummary(results, runDir);

  const summaryPath = path.join(runDir, "07-suite-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  emit(runId, "suite", "completed", { summary }, undefined, onEvent);

  return results;
}

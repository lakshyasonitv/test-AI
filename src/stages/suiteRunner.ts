import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { toIR } from "./ir.js";
import type { GroqBudget } from "../llm/groqBudget.js";
import { generateSpec } from "./generator.js";
import { runSpec, findScreenshot, detectBlocked } from "./executor.js";
import { credentialEnvVars, type Credentials } from "./credentials.js";
import { analyzeFailure } from "./failureAnalysis.js";
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
  /** Groq calls/tokens spent generating this case's IR. Omitted for the reused primary
   *  case, whose usage is already counted in the run's top-level groq-usage.json. */
  groqCalls?: number;
  groqTokens?: number;
  /** Plain-English "what this check proves", for the UI. `intent` is the model's own words
   *  and is optional in the schema; `expected` is required, so it is the guaranteed fallback. */
  intent?: string;
  expected?: string;
}

interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  truncated: number;
  truncated_no_assertion: number;
  blocked: number;
  cases: {
    caseId: string; title: string; status: string; resultPath: string;
    groqCalls?: number; groqTokens?: number; blockedBy?: string;
    intent?: string; expected?: string;
  }[];
}

/** Origin of a url, for deciding whether a flow left the application. */
function originOf(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
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
  groqBudget?: GroqBudget,
  /** Credentials the user supplied for this run, shared by every case. */
  runCreds?: Credentials
): Promise<CaseRunResult[]> {
  const results: CaseRunResult[] = [];
  const runId = path.basename(runDir);

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
          const diagnosis = await analyzeFailure(primaryResult.ir, primaryResult.result);
          diagnosisPath = path.join(caseDir, "06-diagnosis.json");
          writeFileSync(diagnosisPath, JSON.stringify(diagnosis, null, 2));
        }

        results.push({
          caseId, title: tc.title, status, irPath, resultPath, diagnosisPath,
          intent: tc.intent, expected: tc.expected,
          blockedBy: primaryBlocked?.reason,
          // Point at the copy inside the case dir — the source artifacts were copied there above.
          blockedScreenshot: primaryBlocked?.screenshot
            ? path.join(destArtifacts, path.basename(primaryBlocked.screenshot)) : undefined,
        });
        emit(runId, "suite", "completed", { caseId, title: tc.title, status, reused: true }, undefined, onEvent);
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
        const usageBefore = groqBudget?.snapshot();
        const { ir } = await toIR(tc, appModel, sourcePrompt, entryUrl, groqBudget, runCreds);
        const usageAfter = groqBudget?.snapshot();
        const groqCalls = usageAfter && usageBefore ? usageAfter.calls - usageBefore.calls : undefined;
        const groqTokens = usageAfter && usageBefore ? usageAfter.totalTokens - usageBefore.totalTokens : undefined;
        console.log("IR generated");
        const irPath = path.join(caseDir, "04-ir.json");
        writeFileSync(irPath, JSON.stringify(ir, null, 2));

        console.log("Generating spec...");
        // Per-case screenshot dir, so cases in one suite don't overwrite each other.
        const spec = generateSpec(ir, path.join(caseDir, "artifacts"));
        console.log("Spec generated");
        const specPath = path.join(caseDir, "generated.spec.ts");
        writeFileSync(specPath, spec);

        console.log("Running Playwright...");
        const result = await runSpec(spec, caseDir, credentialEnvVars(runCreds));
        console.log("Playwright finished");

        console.log(result);

        // Determine honest status before saving the result.
        // A wall the test can't pass outranks every other verdict: "passed" would be a lie and
        // "failed" would blame the application for something that isn't its fault.
        const blocked = detectBlocked(path.join(caseDir, "artifacts"), originOf(entryUrl));
        let status: CaseRunResult["status"];
        if (blocked) {
          status = "blocked";
        } else if (ir.meta.truncated && !ir.meta.hasTerminalAssertion) {
          status = "truncated_no_assertion";
        } else if (ir.meta.truncated) {
          status = "truncated";
        } else if (result.passed) {
          status = "passed";
        } else {
          status = "failed";
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

        let diagnosisPath: string | undefined;
        if (!result.passed) {
          const diagnosis = await analyzeFailure(ir, result);
          diagnosisPath = path.join(caseDir, "06-diagnosis.json");
          writeFileSync(diagnosisPath, JSON.stringify(diagnosis, null, 2));
        }

        results.push({
          caseId, title: tc.title, status, irPath, resultPath, diagnosisPath, groqCalls, groqTokens,
          intent: tc.intent, expected: tc.expected,
          blockedBy: blocked?.reason, blockedScreenshot: blocked?.screenshot ?? undefined,
        });

        emit(runId, "suite", "completed", { caseId, title: tc.title, status }, undefined, onEvent);
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

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const truncated = results.filter((r) => r.status === "truncated").length;
  const truncatedNoAssertion = results.filter((r) => r.status === "truncated_no_assertion").length;
  const blockedCount = results.filter((r) => r.status === "blocked").length;

  const summary: SuiteSummary = {
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
      // For a blocked case, the proof is the frame showing the wall — not just any screenshot.
      const shot = r.blockedScreenshot
        ?? findScreenshot(path.join(caseDir, "artifacts")) ?? findScreenshot(caseDir);
      const screenshotUrl = shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined;
      return {
        caseId: r.caseId,
        title: r.title,
        status: r.status,
        // Forward slashes: this is consumed as a URL fragment by the frontend.
        resultPath: `cases/${r.caseId}`,
        screenshotUrl,
        groqCalls: r.groqCalls,
        groqTokens: r.groqTokens,
        blockedBy: r.blockedBy,
        intent: r.intent,
        expected: r.expected,
      };
    }),
  };

  const summaryPath = path.join(runDir, "07-suite-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  emit(runId, "suite", "completed", { summary }, undefined, onEvent);

  return results;
}

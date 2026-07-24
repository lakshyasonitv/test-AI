import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toIR } from "./ir.js";
import { generateSpec } from "./generator.js";
import { runSpec } from "./executor.js";
import { analyzeFailure } from "./failureAnalysis.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";
import type { OnEvent, StageEvent } from "../orchestrator.js";
import { store } from "../runStore.js";

export interface CaseRunResult {
  caseId: string;
  title: string;
  status: "passed" | "failed" | "truncated" | "truncated_no_assertion";
  irPath: string;
  resultPath: string;
  diagnosisPath?: string;
}

interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  truncated: number;
  truncated_no_assertion: number;
  cases: { caseId: string; title: string; status: string; resultPath: string }[];
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
  onEvent?: OnEvent
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

    try {
      const ir = await toIR(tc, appModel, sourcePrompt, entryUrl);
      const irPath = path.join(caseDir, "04-ir.json");
      writeFileSync(irPath, JSON.stringify(ir, null, 2));

      const spec = generateSpec(ir);
      const specPath = path.join(caseDir, "generated.spec.ts");
      writeFileSync(specPath, spec);

      const result = await runSpec(spec, caseDir);

      // Determine honest status before saving the result.
      let status: CaseRunResult["status"];
      if (ir.meta.truncated && !ir.meta.hasTerminalAssertion) {
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

      results.push({ caseId, title: tc.title, status, irPath, resultPath, diagnosisPath });

      emit(runId, "suite", "completed", { caseId, title: tc.title, status }, undefined, onEvent);
    } catch (err: any) {
      results.push({
        caseId, title: tc.title, status: "failed",
        irPath: "", resultPath: "",
      });

      emit(runId, "suite", "failed", { caseId, title: tc.title },
        err?.message ?? String(err), onEvent);
    }
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const truncated = results.filter((r) => r.status === "truncated").length;
  const truncatedNoAssertion = results.filter((r) => r.status === "truncated_no_assertion").length;

  const summary: SuiteSummary = {
    total: results.length,
    passed,
    failed,
    truncated,
    truncated_no_assertion: truncatedNoAssertion,
    cases: results.map((r) => ({
      caseId: r.caseId,
      title: r.title,
      status: r.status,
      resultPath: path.join("cases", r.caseId),
    })),
  };

  const summaryPath = path.join(runDir, "07-suite-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  emit(runId, "suite", "completed", { summary }, undefined, onEvent);

  return results;
}

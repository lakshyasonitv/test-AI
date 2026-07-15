import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plan } from "./stages/planner.js";
import { discover } from "./stages/discovery.js";
import { toTestCases } from "./stages/testCases.js";
import { toIR } from "./stages/ir.js";
import { generateSpec } from "./stages/generator.js";
import { runSpec } from "./stages/executor.js";
import { analyzeFailure } from "./stages/failureAnalysis.js";
import { store } from "./runStore.js";

export type StageName =
  | "input" | "plan" | "discovery" | "testcases" | "ir"
  | "generate" | "execute" | "failure_analysis" | "done" | "error";

export interface StageEvent {
  runId: string;
  stage: StageName;
  status: "started" | "completed" | "failed";
  data?: unknown;
  error?: string;
  ts: number;
}

export type OnEvent = (e: StageEvent) => void;

export async function runPipeline(
  { prompt, url }: { prompt: string; url: string },
  onEvent: OnEvent = () => {},
  presetRunId?: string
) {
  const runId = presetRunId ?? makeRunId();
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

  const save = (name: string, data: unknown) =>
    writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 2));

  const emit = (stage: StageName, status: StageEvent["status"], data?: unknown, error?: string) => {
    const event: StageEvent = { runId, stage, status, data, error, ts: Date.now() };
    store.append(event); // durable log first, so a crash mid-callback still records the event
    onEvent(event);
  };

  /** Wrap a stage: emit started -> run -> save -> emit completed (or failed). */
  async function step<T>(stage: StageName, filename: string | null, fn: () => Promise<T>): Promise<T> {
    emit(stage, "started");
    try {
      const result = await fn();
      if (filename) save(filename, result);
      emit(stage, "completed", result);
      return result;
    } catch (err: any) {
      emit(stage, "failed", undefined, err?.message ?? String(err));
      throw err;
    }
  }

  try {
    save("00-input.json", { prompt, url });
    emit("input", "completed", { prompt, url });

    const thePlan = await step("plan", "01-plan.json", () => plan(prompt, url));
    const appModel = await step("discovery", "02-appmodel.json", () => discover(url));
    const cases = await step("testcases", "03-cases.json", () => toTestCases(thePlan, appModel));

    const primary = [...cases].sort(byPriority)[0];
    if (!primary) throw new Error("No test cases produced");

    const ir = await step("ir", "04-ir.json", () => toIR(primary, appModel, prompt, url));

    const spec = await step("generate", null, async () => generateSpec(ir));
    writeFileSync(path.join(runDir, "generated.spec.ts"), spec);

    const result = await step("execute", "05-result.json", async () => {
      const r = await runSpec(spec, runDir);
      return { passed: r.passed, exitCode: r.exitCode, artifactsDir: r.artifactsDir, resultsJsonPath: r.resultsJsonPath, raw: r.raw };
    });

    let diagnosis = null;
    if (!result.passed) {
      diagnosis = await step("failure_analysis", "06-diagnosis.json", () => analyzeFailure(ir, result as any));
    }

    emit("done", "completed", { passed: result.passed });
    return { runId, runDir, result, diagnosis };
  } catch (err: any) {
    emit("error", "failed", undefined, err?.message ?? String(err));
    throw err;
  }
}

const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const byPriority = (a: { priority: string }, b: { priority: string }) => rank[a.priority] - rank[b.priority];

/** Shared run-id format so the server can generate one before starting the pipeline. */
export function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}

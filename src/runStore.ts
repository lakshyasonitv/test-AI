import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { StageEvent } from "./orchestrator.js";
import { findScreenshot } from "./stages/executor.js";

/**
 * Durable per-run event log — the one seam that separates "demo" from "product".
 * Every stage event is appended here as it happens, so SSE reconnects and server
 * restarts can replay a run's full history instead of losing it (the old in-memory
 * Map vanished on restart).
 *
 * ponytail: file-backed (one NDJSON file per run) — zero new services, zero deps.
 * The whole point of this interface is that going to Postgres later is a swap of
 * THIS module's body only; every caller uses just append()/read(). Upgrade when a
 * single box's local disk stops being enough (multi-worker / multi-server).
 */
export interface RunStore {
  append(event: StageEvent): void;
  read(runId: string): StageEvent[];
}

const fileFor = (runId: string) => path.join("runs", runId, "events.ndjson");

export const store: RunStore = {
  append(event) {
    const f = fileFor(event.runId);
    mkdirSync(path.dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(event) + "\n", "utf8");
  },
  read(runId) {
    let events: StageEvent[] = [];
    const f = fileFor(runId);
    let fromNdjson = false;

    if (existsSync(f)) {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
      if (lines.length > 0) {
        events = lines.map((l) => JSON.parse(l) as StageEvent);
        fromNdjson = true;
      }
    }

    // Fallback for runs where events.ndjson is missing/empty: reconstruct events from stage JSON files
    if (events.length === 0) {
      const input = readJson(runId, "00-input.json");
      if (!input) return [];

      events.push({ runId, stage: "input", status: "completed", data: input, ts: Date.now() });

      const planData = readJson(runId, "01-plan.json");
      if (planData) events.push({ runId, stage: "plan", status: "completed", data: planData, ts: Date.now() });

      const appModel = readJson(runId, "02-appmodel.json");
      if (appModel) events.push({ runId, stage: "discovery", status: "completed", data: appModel, ts: Date.now() });

      const cases = readJson(runId, "03-cases.json");
      if (cases) events.push({ runId, stage: "testcases", status: "completed", data: cases, ts: Date.now() });

      const ir = readJson(runId, "04-ir.json");
      if (ir) events.push({ runId, stage: "ir", status: "completed", data: ir, ts: Date.now() });

      const result = readJson(runId, "05-result.json");
      if (result) events.push({ runId, stage: "execute", status: "completed", data: result, ts: Date.now() });

      const diagnosis = readJson(runId, "06-diagnosis.json");
      if (diagnosis) events.push({ runId, stage: "failure_analysis", status: "completed", data: diagnosis, ts: Date.now() });
    }

    // For legacy runs without events.ndjson: guarantee the event stream ends with a
    // 'done' event so the frontend doesn't poll forever.  When events.ndjson EXISTS
    // the events are authoritative — the run is either still in progress (no "done"
    // yet) or has completed with a real "done"/"error" event.  Injecting a synthetic
    // "done" with passed:false for an in-progress run would prematurely mark all
    // in-progress phases as "failed" on the frontend.
    const last = events[events.length - 1];
    if (!fromNdjson && last && last.stage !== "done" && last.stage !== "error") {
      const result = readJson(runId, "05-result.json");
      const suite = readJson(runId, "07-suite-summary.json");
      const cases = readJson(runId, "03-cases.json");
      const primaryTest = Array.isArray(cases) && cases[0] ? { title: cases[0].title, steps: cases[0].steps, expected: cases[0].expected } : undefined;

      // Compute screenshotUrl from artifactsDir if not already present
      let screenshotUrl = result?.screenshotUrl;
      if (!screenshotUrl && result?.artifactsDir) {
        const shot = findScreenshot(result.artifactsDir);
        if (shot) screenshotUrl = "/" + path.relative(".", shot).replace(/\\/g, "/");
      }

      events.push({
        runId,
        stage: "done",
        status: "completed",
        data: {
          passed: result?.passed ?? (suite ? suite.passed === suite.total : false),
          status: result?.status,
          screenshotUrl,
          test: primaryTest,
          suite,
        },
        ts: Date.now(),
      });
    }

    return events;
  },
};

export interface RunSummary {
  runId: string;
  url: string;
  prompt: string;
  status: "passed" | "failed" | "error" | "incomplete" | "truncated_no_assertion";
  startedAt: number;
  /** False for runs that predate events.ndjson — nothing to replay via SSE for those. */
  hasEvents: boolean;
  suite?: {
    total: number;
    passed: number;
    failed: number;
    truncated: number;
    truncated_no_assertion: number;
    cases: { caseId: string; title: string; status: string; resultPath: string }[];
  };
}

function readJson(runId: string, name: string): any {
  const f = path.join("runs", runId, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
}

/**
 * All runs, newest first. Reads the durable event log where it exists and falls back
 * to the stage json files (00-input.json / 05-result.json) for runs that predate
 * events.ndjson — both are already written by the orchestrator for every run.
 */
export function listRuns(): RunSummary[] {
  const root = "runs";
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_cache")
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a)) // runId is ISO-prefixed -> lexicographic = chronological
    .slice(0, 20)                       // only the newest 20 — keeps the history list usable and
                                        // skips reading every run dir on disk as they accumulate
    .map((runId) => {
      const events = store.read(runId);
      const inputData = events.find((e) => e.stage === "input")?.data as
        { prompt?: string; url?: string } | undefined;
      const fallbackInput = inputData ? undefined : readJson(runId, "00-input.json");

      const last = events[events.length - 1];
      let status: RunSummary["status"] = "incomplete";
      if (last?.stage === "done") {
        const doneData = last.data as { passed?: boolean; status?: string } | undefined;
        if (doneData?.status === "truncated_no_assertion") {
          status = "truncated_no_assertion";
        } else {
          status = doneData?.passed ? "passed" : "failed";
        }
      } else if (last?.stage === "error") {
        status = "error";
      } else if (!events.length) {
        const result = readJson(runId, "05-result.json") as { passed?: boolean; status?: string } | undefined;
        if (result) {
          status = result.status === "truncated_no_assertion" ? "truncated_no_assertion" : result.passed ? "passed" : "failed";
        }
      }

      // Read suite summary if available
      const suiteSummary = readJson(runId, "07-suite-summary.json") as RunSummary["suite"] | undefined;

      return {
        runId,
        url: inputData?.url ?? fallbackInput?.url ?? "",
        prompt: inputData?.prompt ?? fallbackInput?.prompt ?? "",
        status,
        startedAt: statSync(path.join(root, runId)).birthtimeMs,
        hasEvents: events.length > 0,
        suite: suiteSummary,
      };
    });
}

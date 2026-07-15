import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { StageEvent } from "./orchestrator.js";

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
    const f = fileFor(runId);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as StageEvent);
  },
};

export interface RunSummary {
  runId: string;
  url: string;
  prompt: string;
  status: "passed" | "failed" | "error" | "incomplete";
  startedAt: number;
  /** False for runs that predate events.ndjson — nothing to replay via SSE for those. */
  hasEvents: boolean;
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
    .map((runId) => {
      const events = store.read(runId);
      const inputData = events.find((e) => e.stage === "input")?.data as
        { prompt?: string; url?: string } | undefined;
      const fallbackInput = inputData ? undefined : readJson(runId, "00-input.json");

      const last = events[events.length - 1];
      let status: RunSummary["status"] = "incomplete";
      if (last?.stage === "done") {
        status = (last.data as { passed?: boolean } | undefined)?.passed ? "passed" : "failed";
      } else if (last?.stage === "error") {
        status = "error";
      } else if (!events.length) {
        const result = readJson(runId, "05-result.json") as { passed?: boolean } | undefined;
        if (result) status = result.passed ? "passed" : "failed";
      }

      return {
        runId,
        url: inputData?.url ?? fallbackInput?.url ?? "",
        prompt: inputData?.prompt ?? fallbackInput?.prompt ?? "",
        status,
        startedAt: statSync(path.join(root, runId)).birthtimeMs,
        hasEvents: events.length > 0,
      };
    });
}

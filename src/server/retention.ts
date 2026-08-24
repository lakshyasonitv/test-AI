import { readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { store } from "../runStore.js";

/**
 * Retention pruning (TECH_DEBT.md TD-16), flag-gated off by default per implentationplan.md
 * Rule 1 — `RUN_RETENTION_DAYS` unset or `0` means this file's only externally-observable effect
 * is that `startRetentionJob()` exists; nothing runs, nothing logs, nothing is ever deleted.
 */

const RUNS_DIR = path.resolve("runs");
// Hard floor regardless of RUN_RETENTION_DAYS — never prune a run less than a day old, in case
// it's mid-write from an unusual path (a crashed server, a very long-running case).
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A run is only ever a pruning candidate once its event log ends in a terminal stage — reuses
 *  the same "done"/"error" signal src/runStore.ts's listRuns() already derives status from,
 *  rather than inventing a second way to ask "is this run still in progress". */
function isTerminal(runId: string): boolean {
  const events = store.read(runId);
  const last = events[events.length - 1];
  return last?.stage === "done" || last?.stage === "error";
}

function pruneOnce(retentionDays: number): void {
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let entries: string[];
  try {
    entries = readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_cache")
      .map((d) => d.name);
  } catch {
    return; // runs/ doesn't exist yet — nothing to prune
  }

  for (const runId of entries) {
    const dirPath = path.join(RUNS_DIR, runId);
    let ageMs: number;
    try {
      ageMs = now - statSync(dirPath).birthtimeMs;
    } catch {
      continue; // disappeared between readdir and stat — nothing to do
    }
    if (ageMs < MIN_AGE_MS) continue;   // hard floor, regardless of setting
    if (ageMs < cutoffMs) continue;     // not old enough for the configured window yet
    if (!isTerminal(runId)) continue;   // still in progress (or unreadable) — never prune

    // Same delete mechanism the existing DELETE /api/runs/:runId route already uses.
    console.log(
      `[retention] deleting ${runId} — age ${(ageMs / 86_400_000).toFixed(1)}d exceeds RUN_RETENTION_DAYS=${retentionDays}`
    );
    rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Starts the retention job if, and only if, RUN_RETENTION_DAYS is set to a positive number.
 * Called once from src/server/index.ts, inside the same "only when run as main" guard that gates
 * app.listen() — so importing the app for tests never starts a background timer.
 */
export function startRetentionJob(): void {
  const days = Number(process.env.RUN_RETENTION_DAYS ?? 0);
  if (!Number.isFinite(days) || days <= 0) return; // default/off — do nothing at all

  console.log(
    `[retention] enabled: pruning terminal runs older than ${days}d (checked every 6h, never below 24h)`
  );
  pruneOnce(days);
  setInterval(() => pruneOnce(days), INTERVAL_MS).unref();
}

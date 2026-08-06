import type { CaseSelectionDecision } from "../schema/caseSelection.js";
import type { TestCase } from "../stages/testCases.js";

/**
 * The waiting half of the case-selection gate. A paused run parks a promise here; the
 * selection endpoint resolves it when the user picks cases or asks for another round.
 *
 * In-memory on purpose — this holds a promise resolver, which cannot be persisted. A
 * server restart therefore drops any pending selection: the run dies with the process
 * anyway, so there is nothing to resume.
 */
interface PendingSelection {
  runId: string;
  batch: TestCase[];
  attempt: number;
  resolve: (decision: CaseSelectionDecision) => void;
  timeout: NodeJS.Timeout;
}

const pending = new Map<string, PendingSelection>();

// A paused run is still holding its MAX_CONCURRENT_RUNS slot, so this can't wait forever.
// On timeout the gate closes with no cases accepted, exactly as if the user had said done.
const DEFAULT_WAIT_MS = 10 * 60 * 1000;

function waitMs(): number {
  const raw = Number(process.env.CASE_SELECTION_WAIT_MS ?? DEFAULT_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WAIT_MS;
}

/** Park until the user decides, or time runs out. */
export function awaitCaseSelection(
  runId: string, batch: TestCase[], attempt: number
): Promise<CaseSelectionDecision> {
  // A second prompt for the same run shouldn't leave the first one parked forever.
  resolveCaseSelection(runId, { action: "done", selectedIndexes: [] });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(runId);
      resolve({ action: "done", selectedIndexes: [] });
    }, waitMs());
    // Don't hold the event loop open on this timer alone.
    timeout.unref?.();
    pending.set(runId, { runId, batch, attempt, resolve, timeout });
  });
}

/** Resolve a pending selection. Returns false when nothing was waiting (already answered,
 *  timed out, or a stale request posting to a finished run). */
export function resolveCaseSelection(runId: string, decision: CaseSelectionDecision): boolean {
  const entry = pending.get(runId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  pending.delete(runId);
  entry.resolve(decision);
  return true;
}

export function getPendingSelection(runId: string): PendingSelection | undefined {
  return pending.get(runId);
}

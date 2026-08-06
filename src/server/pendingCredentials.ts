import type { Credentials } from "../stages/credentials.js";
import type { CredentialRequest } from "../orchestrator.js";

/**
 * The waiting half of the credential prompt. A paused run parks a promise here; the POST
 * endpoint resolves it when the user submits or skips.
 *
 * In-memory on purpose — this holds a promise resolver, which cannot be persisted, and the
 * values passing through are the user's real credentials, which must never touch disk (runs/
 * is served publicly). A server restart therefore drops any pending prompt: the run dies
 * with the process anyway, so there is nothing to resume.
 */
interface Waiter {
  resolve: (creds: Credentials | null) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Map<string, Waiter>();

// A paused run is still holding its MAX_CONCURRENT_RUNS slot, so this can't wait forever —
// three abandoned prompts would wedge the whole server at the default cap of 3. On timeout
// the run continues without credentials, which is exactly what it did before this existed.
const DEFAULT_WAIT_MS = 5 * 60 * 1000;

function waitMs(): number {
  const raw = Number(process.env.CREDENTIAL_WAIT_MS ?? DEFAULT_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WAIT_MS;
}

/** The orchestrator's `askCredentials`: park until the user answers, skips, or time runs out. */
export function askCredentials(request: CredentialRequest): Promise<Credentials | null> {
  // A second prompt for the same run shouldn't leave the first one parked forever.
  settle(request.runId, null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log("[credentials] no answer for", request.runId, "- continuing without credentials");
      settle(request.runId, null);
    }, waitMs());
    // Don't hold the event loop open on this timer alone.
    timer.unref?.();
    waiters.set(request.runId, { resolve, timer });
  });
}

/** Resolve a pending prompt. Returns false when nothing was waiting (already answered,
 *  timed out, or a stale browser tab posting to a finished run). */
export function settle(runId: string, creds: Credentials | null): boolean {
  const waiter = waiters.get(runId);
  if (!waiter) return false;
  waiters.delete(runId);
  clearTimeout(waiter.timer);
  waiter.resolve(creds);
  return true;
}

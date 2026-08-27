import type { Response } from "express";
import type { StageEvent } from "../orchestrator.js";

/**
 * Re-grounding as an async job — the same shape a run already is.
 *
 * Saving an edited case can take a minute of real browser time, so it cannot be a blocking
 * request: a blocking one can report no progress, give no estimate, and cannot be cancelled — the
 * client can only abandon it while the server keeps spending. Runs solved this already
 * (`POST /api/runs` -> `202 {runId}`, progress over SSE, `/state` as the poll fallback), so this
 * follows that pattern rather than inventing a second progress mechanism.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE RUN REGISTRY:
 *
 *  1. **In memory, not on disk.** `runRegistry` persists through `store.append`, which writes
 *     `runs/<id>/events.ndjson`. A re-ground produces no artifacts and is not a run — writing it
 *     under `runs/` would put it in run history, in the sidebar, and in the Step 3.2 shadow
 *     comparison as a row the database has never heard of. Durability buys nothing here either:
 *     if the server restarts mid-job the edit is simply not saved, which is the correct outcome.
 *
 *  2. **The events are `StageEvent`s verbatim**, with the job id in `runId`. That field name is
 *     the one wart, and it is deliberate — reusing the exact type means the client's existing
 *     event handling applies unchanged, and `stage: "ir"` is not a stretched analogy: grounding
 *     IS the IR stage's work, just re-run on one edited case.
 */

interface Job {
  id: string;
  userId: string;
  caseId: string;
  events: StageEvent[];
  subscribers: Set<Response>;
  cancelled: boolean;
  finishedAt: number | null;
}

const jobs = new Map<string, Job>();

/** Finished jobs linger briefly so a client that reconnects can still read the outcome, then are
 *  swept so a long-lived process cannot accumulate them. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

function sweep(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > KEEP_FINISHED_MS) {
      for (const res of job.subscribers) { try { res.end(); } catch { /* already gone */ } }
      jobs.delete(id);
    }
  }
}

export function createJob(id: string, userId: string, caseId: string): Job {
  sweep();
  const job: Job = { id, userId, caseId, events: [], subscribers: new Set(), cancelled: false, finishedAt: null };
  jobs.set(id, job);
  return job;
}

/** A job, but only for the user who started it. Editing sessions are personal — another account
 *  has no business reading or cancelling one, even inside the same organisation. */
export function getJob(id: string, userId: string): Job | null {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return null;
  return job;
}

export function emitJobEvent(
  id: string, stage: StageEvent["stage"], status: StageEvent["status"], data?: unknown, error?: string,
): void {
  const job = jobs.get(id);
  if (!job) return;
  const event: StageEvent = { runId: id, stage, status, data, error, ts: Date.now() };
  job.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.subscribers) { try { res.write(line); } catch { /* closed */ } }
  if (stage === "done" || stage === "error") {
    job.finishedAt = Date.now();
    for (const res of job.subscribers) { try { res.end(); } catch { /* closed */ } }
    job.subscribers.clear();
  }
}

/** SSE: replay what has happened, then stream. Mirrors `runRegistry.subscribe`. */
export function subscribeJob(job: Job, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  if (job.finishedAt !== null) { res.end(); return; }
  job.subscribers.add(res);
  res.on("close", () => job.subscribers.delete(res));
}

/** The poll fallback, for the same reason runs have one: SSE buffers behind a Cloudflare tunnel. */
export function jobEvents(job: Job): StageEvent[] {
  return job.events;
}

/**
 * Ask a job to stop. Read by the walk between snapshots, so it takes effect before the next
 * browser launch rather than mid-Playwright-call — an in-flight snapshot finishes and closes its
 * own browser, and nothing is ever written, because the caller never reaches the database.
 */
export function cancelJob(job: Job): void {
  job.cancelled = true;
}

export function isCancelled(id: string): boolean {
  return jobs.get(id)?.cancelled ?? false;
}

/** Test seam — jobs are module state, and cases must not inherit each other's. */
export function resetJobs(): void {
  for (const job of jobs.values()) {
    for (const res of job.subscribers) { try { res.end(); } catch { /* ignore */ } }
  }
  jobs.clear();
}

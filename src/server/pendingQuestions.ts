import crypto from "node:crypto";
import type { AskQuestion } from "../orchestrator.js";

/**
 * The waiting half of a run question (DECISIONS.md D-51) — the same shape as pendingCredentials.ts,
 * for a question that is not a username and password.
 *
 * A paused run parks a promise here; POST /api/runs/:runId/question resolves it with the person's
 * answer, or null on a skip. In memory on purpose, for the reason pendingCredentials.ts gives: a
 * promise resolver cannot be persisted, and an answer can be a secret (a verification code), which
 * must never touch disk. A server restart drops the question; the run dies with the process anyway.
 *
 * One question per run at a time. Each carries an id, so an answer typed into a stale modal for an
 * EARLIER question cannot be taken as the answer to the current one.
 */

interface Waiter {
  questionId: string;
  resolve: (answer: string | null) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Map<string, Waiter>();

// A paused run holds its MAX_CONCURRENT_RUNS slot, so this cannot wait forever (the same argument
// as CREDENTIAL_WAIT_MS). On timeout the run carries on as if the person skipped.
const DEFAULT_WAIT_MS = 5 * 60 * 1000;

function waitMs(): number {
  const raw = Number(process.env.QUESTION_WAIT_MS ?? DEFAULT_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WAIT_MS;
}

/** Park until the person answers, skips, or time runs out. */
export const askQuestion: AskQuestion = (request, onAsked) => {
  // A new question for the same run must not leave the previous one parked forever.
  const previous = waiters.get(request.runId);
  if (previous) settleQuestion(request.runId, previous.questionId, null);

  const questionId = crypto.randomUUID();
  const answer = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      console.log("[question] no answer for", request.runId, "- continuing without one");
      settleQuestion(request.runId, questionId, null);
    }, waitMs());
    timer.unref?.();
    waiters.set(request.runId, { questionId, resolve, timer });
  });
  onAsked(questionId);
  return answer;
};

/** Resolve a pending question. False when nothing matching was waiting (already answered, timed
 *  out, a different question, or a finished run). */
export function settleQuestion(runId: string, questionId: string, answer: string | null): boolean {
  const waiter = waiters.get(runId);
  if (!waiter || waiter.questionId !== questionId) return false;
  waiters.delete(runId);
  clearTimeout(waiter.timer);
  waiter.resolve(answer);
  return true;
}

import { store } from "../runStore.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { toTestCases, filterNovelCases, type TestCase } from "./testCases.js";
import { awaitCaseSelection } from "../server/pendingCaseSelection.js";
import {
  appendAcceptedCases,
  getAllAcceptedCases,
  hasAcceptedPrimary,
  remainingCapacity,
  MAX_ACCUMULATED_CASES,
} from "../server/caseAccumulator.js";
import {
  appendRoundToHistory,
  buildHistoryPromptBlock,
  getRejectedTitles,
  getRoundCount,
} from "../server/caseHistoryLedger.js";

export const MAX_CASE_REGEN_ATTEMPTS = Number(process.env.MAX_CASE_REGEN_ATTEMPTS ?? 3);

export interface CaseSelectionGateParams {
  runId: string;
  plan: Plan;
  appModel: AppModel;
  /** The original user prompt. The Plan type does not carry it, but the gate needs it to seed
   *  the "prompt that generated the current batch" that round 1 is attributed to. */
  sourcePrompt: string;
}

export interface CaseSelectionGateResult {
  finalCases: TestCase[];
  /** True when the gate ends with nothing accepted at all — the only way to reach this is a
   *  round timing out (CASE_SELECTION_WAIT_MS) on the very first round before anything was
   *  ever picked, since anything accepted in an earlier round survives a later round's timeout.
   *  A distinct, honest outcome for the caller to report — not an error to throw and crash the
   *  run over, the same way the credential prompt's own timeout just continues without
   *  credentials instead of failing the run. */
  noCasesSelected?: boolean;
}

/** Generate one round's batch. Round 1 is the plain upfront call (mints its own primary);
 *  later rounds extend the suite — never restating already-accepted titles, never re-proposing
 *  a title the user already rejected, and minting a fresh primary only while none has been
 *  accepted yet. The round's own prompt (the source prompt for round 1, the user's refinement
 *  for later rounds) is threaded through so a "not satisfied, focus on X" reply actually steers
 *  the next batch instead of being recorded and ignored. */
async function caseSelectionBatch(
  plan: Plan,
  appModel: AppModel,
  attempt: number,
  acceptedTitles: string[],
  rejectedTitles: string[],
  forcePrimary: boolean,
  latestPrompt: string,
  sourcePrompt: string
): Promise<TestCase[]> {
  if (attempt === 1) {
    return toTestCases(plan, appModel, undefined, { sourcePrompt });
  }
  return toTestCases(plan, appModel, {
    existingTitles: acceptedTitles,
    rejectedTitles,
    mintPrimary: forcePrimary,
    latestPrompt,
  }, { sourcePrompt });
}

/**
 * The gate around upfront case generation. Generates a batch, parks the run on a selection
 * prompt, and on "not satisfied" regenerates against the running history — until the user
 * says done, the pool fills, or the regeneration budget is spent. Emits one store event per
 * round so a restarting server / reconnecting SSE client can replay what the user picked.
 */
export async function runCaseSelectionGate({
  runId,
  plan,
  appModel,
  sourcePrompt,
}: CaseSelectionGateParams): Promise<CaseSelectionGateResult> {
  let attempt = 1;
  let promptThatGeneratedCurrentBatch = sourcePrompt;

  while (attempt <= MAX_CASE_REGEN_ATTEMPTS) {
    // Seen = accepted (already in the pool) + rejected (user said no). Both are excluded from
    // regeneration: accepted titles never reappear, and a rejected case is never offered again.
    const acceptedTitles = getAllAcceptedCases(runId).map((c) => c.title);
    const rejectedTitles = getRejectedTitles(runId);
    const seenTitles = [...acceptedTitles, ...rejectedTitles];
    const forcePrimary = attempt === 1 ? true : !hasAcceptedPrimary(runId);
    const generated = await caseSelectionBatch(
      plan, appModel, attempt, acceptedTitles, rejectedTitles, forcePrimary,
      promptThatGeneratedCurrentBatch, sourcePrompt
    );

    // Hard filter: the model (or the LLM cache) may restate an already-seen case despite the
    // prompt. Drop anything overlapping an accepted OR rejected title so round N+1 literally
    // contains only cases the user hasn't already seen. Round 1 passes through untouched.
    const batch = filterNovelCases(generated, seenTitles);

    if (batch.length === 0) {
      // Nothing new exists to offer — the generation engine is exhausted, not the pool.
      store.append({
        runId,
        stage: "testcases",
        status: "completed",
        data: { attempt, action: "case_end_of_capacity", seenTitles },
        ts: Date.now(),
      });
      break;
    }

    store.append({
      runId,
      stage: "testcases",
      status: "started",
      data: {
        batch,
        attempt,
        action: "case_round_requested",
        prompt: promptThatGeneratedCurrentBatch,
        history: buildHistoryPromptBlock(runId, promptThatGeneratedCurrentBatch),
      },
      ts: Date.now(),
    });

    const decision = await awaitCaseSelection(runId, batch, attempt);

    store.append({
      runId,
      stage: "testcases",
      status: "completed",
      data: { batch, attempt, action: "case_round_resolved", decision },
      ts: Date.now(),
    });

    const { overflowIndexes } = appendAcceptedCases(
      runId,
      attempt,
      promptThatGeneratedCurrentBatch,
      batch,
      decision.selectedIndexes
    );
    appendRoundToHistory(runId, attempt, promptThatGeneratedCurrentBatch, batch, decision.selectedIndexes, overflowIndexes);

    if (decision.action === "done") break;

    promptThatGeneratedCurrentBatch = decision.newPrompt;

    const poolFull = remainingCapacity(runId) === 0;
    if (poolFull) {
      store.append({
        runId,
        stage: "testcases",
        status: "completed",
        data: { attempt, action: "case_pool_cap_warning", poolCap: MAX_ACCUMULATED_CASES },
        ts: Date.now(),
      });
    }
    if (attempt >= MAX_CASE_REGEN_ATTEMPTS) {
      store.append({
        runId,
        stage: "testcases",
        status: "completed",
        data: { attempt, action: "case_regen_limit_reached" },
        ts: Date.now(),
      });
      break;
    }
    if (poolFull) break;
    attempt++;
  }

  const finalCases = getAllAcceptedCases(runId);
  if (finalCases.length === 0) {
    store.append({
      runId,
      stage: "testcases",
      status: "completed",
      data: { finalCases: [], action: "case_selection_finalized", noCasesSelected: true },
      ts: Date.now(),
    });
    return { finalCases: [], noCasesSelected: true };
  }
  if (!hasAcceptedPrimary(runId)) {
    throw new Error(`No primary case accepted for run ${runId}: the user selected cases but none was the direct translation of the plan.`);
  }

  store.append({
    runId,
    stage: "testcases",
    status: "completed",
    data: { finalCases, action: "case_selection_finalized" },
    ts: Date.now(),
  });

  return { finalCases };
}

/**
 * A second kind of round, run AFTER the upfront gate has already finalized: cases generated
 * reactively for a page live-extend discovered while executing the primary case. Offered
 * through the exact same review mechanism as the upfront batch instead of being silently merged
 * in — the gate's whole premise (nothing runs without being shown to you first) otherwise only
 * held for the upfront batch, not anything reactive. Returns just the cases actually accepted
 * from THIS round (a subset of `reactiveCases`, possibly empty) — the caller merges them into
 * the final list itself; this never touches anything the upfront gate already decided.
 */
export async function runReactiveCaseRound(
  runId: string, reactiveCases: TestCase[]
): Promise<TestCase[]> {
  const acceptedTitles = getAllAcceptedCases(runId).map((c) => c.title);
  const rejectedTitles = getRejectedTitles(runId);
  const seenTitles = [...acceptedTitles, ...rejectedTitles];
  const batch = filterNovelCases(reactiveCases, seenTitles);
  if (batch.length === 0) return [];

  const beforeTitles = new Set(acceptedTitles);
  const attempt = getRoundCount(runId) + 1;
  const roundPrompt = "A new page was discovered while running the primary case — review these additional cases.";

  store.append({
    runId,
    stage: "testcases",
    status: "started",
    data: { batch, attempt, action: "case_round_requested", prompt: roundPrompt, reactive: true },
    ts: Date.now(),
  });

  const decision = await awaitCaseSelection(runId, batch, attempt);

  store.append({
    runId,
    stage: "testcases",
    status: "completed",
    data: { batch, attempt, action: "case_round_resolved", decision },
    ts: Date.now(),
  });

  const { overflowIndexes } = appendAcceptedCases(runId, attempt, roundPrompt, batch, decision.selectedIndexes);
  appendRoundToHistory(runId, attempt, roundPrompt, batch, decision.selectedIndexes, overflowIndexes);

  // Closes the panel again — it was reopened for this round after the upfront gate's own
  // "finalized" event already closed it once.
  store.append({
    runId,
    stage: "testcases",
    status: "completed",
    data: { action: "case_selection_finalized" },
    ts: Date.now(),
  });

  return getAllAcceptedCases(runId).filter((c) => !beforeTitles.has(c.title));
}

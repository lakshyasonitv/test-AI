import { store } from "../runStore.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { toTestCases, type TestCase } from "./testCases.js";
import { awaitCaseSelection } from "../server/pendingCaseSelection.js";
import {
  appendAcceptedCases,
  getAllAcceptedCases,
  hasAcceptedPrimary,
  remainingCapacity,
  MAX_ACCUMULATED_CASES,
} from "../server/caseAccumulator.js";
import { appendRoundToHistory, buildHistoryPromptBlock } from "../server/caseHistoryLedger.js";

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
}

/** Generate one round's batch. Round 1 is the plain upfront call (mints its own primary);
 *  later rounds extend the suite — never restating already-accepted titles, and minting a
 *  fresh primary only while none has been accepted yet. */
async function caseSelectionBatch(
  plan: Plan,
  appModel: AppModel,
  attempt: number,
  seenTitles: string[],
  forcePrimary: boolean
): Promise<TestCase[]> {
  if (attempt === 1) {
    return toTestCases(plan, appModel);
  }
  return toTestCases(plan, appModel, { existingTitles: seenTitles, mintPrimary: forcePrimary });
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
    const seenTitles = getAllAcceptedCases(runId).map((c) => c.title);
    const forcePrimary = attempt === 1 ? true : !hasAcceptedPrimary(runId);
    const batch = await caseSelectionBatch(plan, appModel, attempt, seenTitles, forcePrimary);

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
    throw new Error(`No test cases were selected for run ${runId}`);
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

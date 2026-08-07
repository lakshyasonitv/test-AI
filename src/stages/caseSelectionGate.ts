// --- In src/stages/caseSelectionGate.ts ---

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
import { 
  appendRoundToHistory, 
  buildHistoryPromptBlock, 
  getAllHistoryTitles // <--- ADDED IMPORT
} from "../server/caseHistoryLedger.js";

export const MAX_CASE_REGEN_ATTEMPTS = Number(process.env.MAX_CASE_REGEN_ATTEMPTS ?? 3);

export interface CaseSelectionGateParams {
  runId: string;
  plan: Plan;
  appModel: AppModel;
  sourcePrompt: string;
}

export interface CaseSelectionGateResult {
  finalCases: TestCase[];
}

/** Updated helper to pass refinedPrompt */
async function caseSelectionBatch(
  plan: Plan,
  appModel: AppModel,
  attempt: number,
  seenTitles: string[],
  forcePrimary: boolean,
  refinedPrompt?: string // <--- ADDED PARAMETER
): Promise<TestCase[]> {
  if (attempt === 1) {
    return toTestCases(plan, appModel);
  }
  return toTestCases(plan, appModel, { 
    existingTitles: seenTitles, 
    mintPrimary: forcePrimary,
    refinedPrompt // <--- PASSED TO GENERATOR
  });
}

export async function runCaseSelectionGate({
  runId,
  plan,
  appModel,
  sourcePrompt,
}: CaseSelectionGateParams): Promise<CaseSelectionGateResult> {
  let attempt = 1;
  let promptThatGeneratedCurrentBatch = sourcePrompt;

  while (attempt <= MAX_CASE_REGEN_ATTEMPTS) {
    // FIX 1: Fetch ALL titles shown in past rounds (accepted + rejected)
    const seenTitles = getAllHistoryTitles(runId);
    
    const forcePrimary = attempt === 1 ? true : !hasAcceptedPrimary(runId);
    
    // FIX 2: Pass promptThatGeneratedCurrentBatch into batch generator
    const batch = await caseSelectionBatch(
      plan, 
      appModel, 
      attempt, 
      seenTitles, 
      forcePrimary,
      attempt > 1 ? promptThatGeneratedCurrentBatch : undefined
    );

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
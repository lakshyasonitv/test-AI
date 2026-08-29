import { TestCase as TestCaseSchema, type TestCase } from "../stages/testCases.js";
import type { CaseSelectionDecision, GateCaseAdd } from "../schema/caseSelection.js";

/**
 * Fold a reviewer's edits and hand-written cases into the batch they were shown, producing the
 * batch the rest of the gate should act on.
 *
 * WHY THIS IS THE ONLY SERVER-SIDE CHANGE THE FEATURE NEEDS. `caseSelectionGate.ts` resolves a
 * round and then calls two functions that both address cases by position:
 *
 *     appendAcceptedCases(runId, attempt, prompt, batch, decision.selectedIndexes)
 *     appendRoundToHistory(runId, attempt, prompt, batch, decision.selectedIndexes, overflow)
 *
 * Both read `batch[i]`. So substituting the edited batch between the decision and those two calls
 * makes all of it correct at once, with no edit to either module: the accumulator persists the
 * EDITED case because that is what sits at `batch[i]`; `MAX_ACCUMULATED_CASES` counts a
 * user-written case because it is a real member of the batch and of `selectedIndexes`; and the
 * ledger records the final titles. Downstream stages receive ordinary `TestCase` objects and
 * cannot tell who wrote them, which is the requirement, not an accident — there is deliberately
 * no origin field for a later stage to branch on.
 *
 * INDEX STABILITY IS THE INVARIANT. Edits address existing positions and never move them; added
 * cases are appended to the END, in arrival order. Nothing is ever spliced out — "remove this
 * case" reaches the server as "not in selectedIndexes", so a removed case still occupies its slot
 * and is still recorded as rejected, which is what stops a later round proposing it again.
 * Physically deleting it would renumber every later case and silently change what an index means.
 */

/** Fields a person may author. Everything else on a `TestCase` is routing state the pipeline
 *  stamps, and is filled in here rather than accepted from the request. */
function buildUserCase(add: GateCaseAdd, feature: string): TestCase {
  // Parsed through the real schema rather than cast, so a user-written case is subject to exactly
  // the same coercions (priority, category normalisation, expected-array joining) as a
  // model-written one. If the two could diverge, "downstream cannot tell them apart" would be a
  // claim rather than a property.
  return TestCaseSchema.parse({
    title: add.title,
    priority: "medium",
    feature,
    steps: add.steps,
    expected: add.expected,
    // A person writing a case is saying what matters about it in their own words; when they leave
    // it blank the concrete outcome is the honest stand-in, not invented prose.
    whyItMatters: add.whyItMatters || add.expected,
    intent: add.whyItMatters || add.title,
    category: "functional-other",
    fromPrompt: false,
    generatedFrom: "upfront",
  });
}

export interface ApplyGateEditsOptions {
  /** Whether an earlier round already accepted the plan's primary case. Read from the accumulator
   *  by the caller, because that state is per-run and sticky across rounds. */
  alreadyHasPrimary: boolean;
}

export function applyGateEdits(
  batch: TestCase[],
  decision: CaseSelectionDecision,
  { alreadyHasPrimary }: ApplyGateEditsOptions
): TestCase[] {
  const edits = decision.editedCases ?? [];
  const additions = decision.addedCases ?? [];
  if (edits.length === 0 && additions.length === 0) return batch;

  // A fresh array of fresh objects: the original batch was already published in the
  // `case_round_requested` event, and mutating it in place would retroactively rewrite what the
  // run's own event log says the user was offered.
  const effective: TestCase[] = batch.map((c) => ({ ...c }));

  for (const edit of edits) {
    const target = effective[edit.index];
    // Out of range is skipped rather than thrown, matching how `appendAcceptedCases` already
    // treats an index it cannot resolve. A stale client should not be able to fail a live run.
    if (!target) continue;
    if (edit.title !== undefined) target.title = edit.title;
    if (edit.steps !== undefined) target.steps = edit.steps;
    if (edit.expected !== undefined) target.expected = edit.expected;
    if (edit.whyItMatters !== undefined) target.whyItMatters = edit.whyItMatters;
  }

  // Added cases inherit the batch's feature so they group with the suite they were written
  // alongside; with an empty batch there is nothing to inherit from.
  const feature = batch[0]?.feature || "User-written";
  const firstAddedIndex = effective.length;
  for (const add of additions) effective.push(buildUserCase(add, feature));

  promotePrimaryIfNeeded(effective, decision.selectedIndexes, firstAddedIndex, alreadyHasPrimary);
  return effective;
}

/**
 * Keep the gate's "some accepted case is the direct translation of the plan" invariant reachable
 * when the reviewer has replaced the model's primary with their own case.
 *
 * `runCaseSelectionGate` throws if no accepted case carries `fromPrompt`. Unchecking the primary
 * could already reach that throw before this feature existed, but "remove this case" and "write
 * my own" make it an ordinary thing to do: delete the model's primary, write the case you
 * actually wanted, approve, and the run would die after the review rather than during it.
 *
 * A case the user typed IS the direct translation of their own request, so marking the first
 * selected user-written case `fromPrompt` states something true. Note what this is not: it is not
 * an origin marker. `fromPrompt` already exists and already means "this case is the user's own
 * ask", and no stage can use it to distinguish authorship — a model-written primary carries it too.
 *
 * Only fires when nothing else supplies a primary, so a run that keeps the model's primary is
 * completely unaffected.
 */
function promotePrimaryIfNeeded(
  effective: TestCase[],
  selectedIndexes: number[],
  firstAddedIndex: number,
  alreadyHasPrimary: boolean
): void {
  if (alreadyHasPrimary) return;
  const selected = selectedIndexes.filter((i) => effective[i]);
  if (selected.some((i) => effective[i].fromPrompt)) return;
  // Lowest selected index among the added cases, so the promoted case is the earliest one the
  // reviewer wrote. That also gives it the best chance of landing inside MAX_ACCUMULATED_CASES:
  // the cap is applied in selection order, and a promoted case that overflows would not set
  // `hasAcceptedPrimary` at all.
  const promotable = selected.filter((i) => i >= firstAddedIndex).sort((a, b) => a - b)[0];
  if (promotable === undefined) return;
  effective[promotable] = { ...effective[promotable], fromPrompt: true };
}

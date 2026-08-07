# Case-Selection Feature — Implementation Document

This document records the **full lifecycle** of the case-selection gate feature: the phases that
were originally specified (Aug 5), what was actually implemented, the corrections made to make it
work, and every later change from the original design up to the current working tree.

---

## 1. Overview

The case-selection gate pauses a run **after** test-case generation, shows the generated batch in
the web UI, and lets the user:

- **Done** — accept the checked cases and run the suite (must select at least one case),
- **Not Satisfied** — keep the checked cases, write a refinement prompt, and regenerate a new
  batch.

Accepted cases accumulate across rounds (up to `MAX_ACCUMULATED_CASES`). Regeneration is bounded
by `MAX_CASE_REGEN_ATTEMPTS` and is told which titles were already shown (accepted **and**
rejected) so it never restates them. The whole feature is **opt-in** behind
`ENABLE_CASE_SELECTION_GATE=true`; when unset/off, the pipeline is byte-for-byte identical to the
old flow.

Files involved:

| File | Role |
|------|------|
| `.env.example` | Feature flag + 3 gate knobs |
| `src/schema/caseSelection.ts` | Zod schema for the user decision + on-disk shapes |
| `src/server/caseAccumulator.ts` | Persists accepted cases (`accepted-cases.json`) |
| `src/server/caseHistoryLedger.ts` | Persists per-round history (`case-history.json`) |
| `src/server/pendingCaseSelection.ts` | In-memory parking for the waiting run |
| `src/stages/testCases.ts` | `ExtendContext` (reuse/regeneration hooks) |
| `src/stages/caseSelectionGate.ts` | The round loop |
| `src/orchestrator.ts` | One wiring point + reactive-case gating |
| `src/server/index.ts` | 3 new API routes |
| `public/index.html`, `public/app.js` | Selection UI panel |

---

## 2. The Phases as Originally Given (from the Aug 5 session)

### Phase 0 — Feature flag

Add `ENABLE_CASE_SELECTION_GATE` to `.env.example` with the comment noting the pipeline
behaves exactly as today when not explicitly `"true"`, and that later phases (1–8) check it in
**exactly one place** (`orchestrator.ts`, described there as Phase 7). Document it in
`README.md`'s Configuration section. No other change.

### Phase 1 — Schema (`src/schema/caseSelection.ts`)

Entirely new file, imported by nothing yet. Provide:

- `CaseSelectionDecisionSchema` — a `z.discriminatedUnion` on `action`:
  - `done` with `caseIds: string[]`,
  - `not_satisfied` with `caseIds: string[]` and `newPrompt` (min 1 char).
- `AcceptedCasesFile` — `runId`, `hasAcceptedPrimary`, `rounds[]` (each with `attempt`,
  `prompt`, `acceptedCases: TestCase[]`, `overflowCaseIds: string[]`).
- `CaseHistoryFile` — `runId`, `rounds[]` with per-case `normalizedTitle` / `originalTitle` /
  `status` (`selected | selected_but_capped | rejected`).

Import `TestCase` from `src/stages/testCases.ts` — do not redefine. Add the three gate env vars
to `.env.example` (`CASE_SELECTION_WAIT_MS=600000`, `MAX_CASE_REGEN_ATTEMPTS=3`,
`MAX_ACCUMULATED_CASES=5`). Write `src/schema/caseSelection.test.ts` (valid `done`,
valid `not_satisfied`, empty `newPrompt` rejected, unknown action rejected).

### Phase 2 — Persistence (`caseAccumulator.ts` + `caseHistoryLedger.ts`)

Both new, imported by nothing yet.

- `caseAccumulator.ts`: `MAX_ACCUMULATED_CASES`, file helpers on `runs/<runId>/accepted-cases.json`,
  `appendAcceptedCases(runId, attempt, prompt, batch, checkedCaseIds)` (id-based, sets
  `hasAcceptedPrimary` from `c.fromPrompt`, over-cap goes to overflow), `getAllAcceptedCases`
  (dedupe by `c.id`), `hasAcceptedPrimary`, `remainingCapacity`.
- `caseHistoryLedger.ts`: `normalizeTitle`, `appendRoundToHistory` (dedupes titles within a
  round), `buildHistoryPromptBlock` (prompt trail + labeled title breakdown).

### Phase 3 — Parking (`src/server/pendingCaseSelection.ts`)

Mirror `pendingCredentials.ts`. `awaitCaseSelection(runId, batch, attempt)` returns a promise
parked in a `Map` with a `CASE_SELECTION_WAIT_MS` timeout resolving `{ action: "done", caseIds: [] }`;
`resolveCaseSelection` clears + resolves; `getPendingSelection` reads the map. Write
`pendingCaseSelection.test.ts` (resolve, unknown run, double-resolve, timeout path with fake
timers).

### Phase 4 — TestCases gate generation (original approach — later abandoned)

Extend `src/stages/testCases.ts` **additively** (do not touch `generateTestCases`):
`generateTestCasesForGate(plan, appModel, strategy, { attempt, forcePrimary, regeneration })`
plus `buildRegenerationPromptForGate(...)`. It reuses the existing `buildBaseCoveragePrompt` and
`callGeminiForCases` helpers, assigns ids like `r<attempt>-c<n>`, forces exactly one
`fromPrompt` case when `forcePrimary` (falling back to highest priority).

> Note: `generateTestCases` / `buildBaseCoveragePrompt` / `callGeminiForCases` were names from an
> earlier codebase state; by the time implementation landed, `toTestCases` was the real function.

### Phase 5 — Reuse `toTestCases` via `ExtendContext.mintPrimary`

Instead of a parallel generator, extend `toTestCases`:

- Add `mintPrimary?: boolean` to `ExtendContext` (default preserves today's behavior: never mint
  a primary on an extend call).
- Split the `fromPromptRule` ternary: `mintPrimary=true` → "no primary accepted yet, exactly one
  fromPrompt case, don't restate covered titles"; otherwise the existing "never set fromPrompt"
  wording.
- Tests: `mintPrimary:false` → all `fromPrompt:false`; `mintPrimary:true` → exactly one
  `fromPrompt:true`; no `ExtendContext` → exactly one `fromPrompt:true` (unchanged behavior).

### Phase 6 — API routes (`src/server/index.ts`)

Add, without touching existing routes:

- `POST /api/runs/:runId/case-selection` — 409 if no pending round, 400 on schema failure, 400 on
  `done` with nothing accumulated/selected, 409 on double-resolve, 200 → `{ ok: true }`.
- `GET /api/runs/:runId/accepted-cases` — pool state (`cases`, `count`, `cap`, `remainingCapacity`).
- `GET /api/runs/:runId/case-selection-status` — snapshot of the pending round (Cloudflare-tunnel
  friendly polling; not a new event type).

API tests: no-pending → 409; bad body → 400; empty `done` → 400; valid `done` → 200 + resolves;
valid `not_satisfied` → 200.

### Phase 7 — Gate loop (`src/stages/caseSelectionGate.ts`) — Part A

A `caseSelectionBatch(plan, appModel, attempt, forcePrimary, seenTitles)` wrapper: attempt 1 →
`toTestCases(plan, appModel)`; later attempts →
`toTestCases(plan, appModel, { existingTitles: seenTitles, mintPrimary: forcePrimary })`.
`runCaseSelectionGate(params)` loops: emit `case_round_requested` to the store → `awaitCaseSelection`
→ accumulate accepted + append history → `done` breaks, `not_satisfied` regenerates with the new
prompt — bounded by `MAX_CASE_REGEN_ATTEMPTS` and pool capacity.

> The original spec read `plan.sourcePrompt` and `CaseSelectionGateParams` without `sourcePrompt`.
> The final implementation passes `sourcePrompt` as an explicit parameter from the orchestrator,
> because `Plan` carries no source prompt (see section 4).

### Phase 8 — UI (`public/index.html` + `public/app.js`)

Add a `#case-selection-panel` section: round label, pool counter, case checklist (Primary badge,
priority chip, `escapeHtml` titles), Select All / Select None, a "Not Satisfied — Refine"
textarea, "Done — Run Selected", and a regen-attempts-left hint. Wire `renderCaseSelectionPanel`,
checkbox → `updateDoneButtonState`, fetch to `/api/runs/:runId/case-selection`, and polling of
`/case-selection-status` for the pending round.

### Orchestrator wiring (the "Phase 7" hook point referenced in Phase 0)

In `runPipeline`, the `testcases` step branches on the flag:
`ENABLE_CASE_SELECTION_GATE === "true"` → dynamically `import("./stages/caseSelectionGate.js")`
and call `runCaseSelectionGate({ runId, plan, appModel, sourcePrompt: prompt })`; otherwise the
normal `toTestCases` path. This is the single place the flag is checked.

---

## 3. Changes Made to Make It Work (deviations & fixes)

### 3.1 id-based → index-based redesign (Aug 5, 14:41)

The original phases used `TestCase.id` / `caseIds` / `overflowCaseIds`. **`TestCase` has no `id`
field** in this codebase, so selection was switched to **positional indexes into the round's
batch array**:

- `CaseSelectionDecisionSchema`: `caseIds: string[]` → `selectedIndexes: z.array(z.number().int().nonnegative())` on **both** branches.
- `AcceptedCasesFile`: `overflowCaseIds` → `overflowIndexes: number[]`.
- `caseAccumulator.appendAcceptedCases`: `checkedCaseIds` → `selectedIndexes`; replace
  `batch.filter(c => checkedCaseIds.includes(c.id))` with iterating `selectedIndexes` and reading
  `batch[i]`, **skipping** out-of-range indexes; return `overflowIndexes`; `getAllAcceptedCases`
  dedupes by **normalized title**, not id.
- `caseHistoryLedger.appendRoundToHistory`: `acceptedIds/overflowIds` → `acceptedIndexes/overflowIndexes`,
  matching `batch.reduce((acc, c, i) => ...)`.
- `pendingCaseSelection.ts` needed **zero** changes (it never referenced `.id`).
- Tests updated to the index-based shape.

### 3.2 Phase 4's parallel generator was abandoned

The `generateTestCasesForGate` + `buildRegenerationPromptForGate` approach would have duplicated
prompt-building, retry, and caching logic. It was replaced by **reusing `toTestCases`** with
`ExtendContext.mintPrimary` (Phase 5). The committed code has no `generateTestCasesForGate`.

### 3.3 `pendingCaseSelection.ts` hardening vs the original snippet

- **Double-prompt guard:** `awaitCaseSelection` now first `resolveCaseSelection(runId, { done, [] })`
  so a second prompt for the same run can't leave the first parked forever.
- **`timeout.unref?.()`** so the timer alone doesn't hold the event loop open.
- **`waitMs()`** reads `CASE_SELECTION_WAIT_MS` at call time (falling back to 10 min).

### 3.4 `sourcePrompt` moved to a parameter

Original gate spec used `plan.sourcePrompt`; `Plan` has no such field. `CaseSelectionGateParams`
gained `sourcePrompt`, supplied by the orchestrator (`sourcePrompt: prompt`). `caseSelectionGate.ts`
also emits `case_round_requested` / `case_round_resolved` / `case_pool_cap_warning` /
`case_regen_limit_reached` / `case_selection_finalized` store events so a restarting server can
replay what happened.

---

## 4. Other Changes from Original — up to the Current Working Tree

These are the **latest uncommitted refinements** (present in the working tree, not yet in a commit):

### 4.1 FIX 1 — dedupe against ALL shown titles (`caseSelectionGate.ts`)

`seenTitles` was previously `getAllAcceptedCases(runId).map(c => c.title)` (accepted only).
Now it uses `getAllHistoryTitles(runId)` — **accepted AND rejected** titles from every round —
so regeneration never restates a case the user already saw and rejected.

### 4.2 FIX 2 — thread the refined prompt through (`testCases.ts` + `caseSelectionGate.ts`)

- `ExtendContext` gained `refinedPrompt?: string`.
- The LLM **cache key** now includes `extend?.refinedPrompt ?? ""` so a refinement round never
  hits the cache of a previous prompt.
- The user prompt now builds a `planContext`: the original plan **plus** the refined request for
  this round, instead of the plan alone.
- `caseSelectionBatch` takes `refinedPrompt` and `caseSelectionGate` passes
  `attempt > 1 ? promptThatGeneratedCurrentBatch : undefined` (the prompt that produced the batch
  the user is refining).

### 4.3 `caseHistoryLedger.ts` refactor

- `normalizeTitle` is now exported and normalized differently: strip **non-alphanumeric**
  characters (previous version only stripped trailing punctuation).
- New `getAllHistoryTitles(runId)` returns every `originalTitle` across all rounds.
- `appendRoundToHistory` no longer dedupes within a round — **every** entry is recorded with its
  status, so the history is a faithful log.
- `buildHistoryPromptBlock` simplified: per-round `Attempt N Prompt`, then `[status] title` lines,
  then the current-round prompt.

### 4.4 Reactive new-page cases gated off under the flag (`orchestrator.ts`)

The block that generates cases for pages discovered at execution time
(`generateCasesForNewPages`) is now wrapped in
`if (process.env.ENABLE_CASE_SELECTION_GATE !== "true")`. Rationale: when the gate owns case
selection, new reactive cases would bypass the user's selection. **Side effect (known issue):**
with the flag on, pages found via live-extend are never turned into cases (see section 6).

### 4.5 Test-file removals (uncommitted)

Eight test files were deleted in the working tree (they exist in commit `18a19a5`):
`src/orchestrator.test.ts`, `src/schema/caseSelection.test.ts`, `src/server/caseAccumulator.test.ts`,
`src/server/caseHistoryLedger.test.ts`, `src/server/index.test.ts`,
`src/server/pendingCaseSelection.test.ts`, `src/stages/caseSelectionGate.test.ts`,
`src/stages/testCases.test.ts`.

---

## 5. How It Works Now — Step by Step

1. **Start:** `POST /api/runs` → `runPipeline` → `plan` → `discovery` (single entry page modeled).
2. **Test-case step** (`orchestrator.ts`): if `ENABLE_CASE_SELECTION_GATE === "true"`, import
   `caseSelectionGate` and run the gate; else `toTestCases` as before.
3. **Gate round 1:** `caseSelectionBatch(attempt=1)` → plain `toTestCases` (mints the primary).
   Batch is emitted (`case_round_requested`) and the run **parks** on `awaitCaseSelection`.
4. **User decides:** the UI shows the panel; `POST /case-selection` resolves the parked promise.
   - `done` with selections → `appendAcceptedCases` + `appendRoundToHistory` → break.
   - `not_satisfied` → accumulate checked cases, append history, set the refined prompt, bump
     `attempt`, regenerate with `{ existingTitles: allHistoryTitles, mintPrimary: !hasAcceptedPrimary, refinedPrompt }`.
   - Timeout (600 s default) → resolves as `done` with nothing → gate throws
     `"No test cases were selected"` if the pool is empty.
5. **Finalize:** `getAllAcceptedCases` → the suite runs those cases (primary included, `fromPrompt`
   tracked via `hasAcceptedPrimary`).
6. **Reactive pages** are only generated when the flag is OFF; with the gate on, only the user's
   selected cases run.

Gate config (all in `.env`):

| Var | Default | Effect |
|-----|---------|--------|
| `ENABLE_CASE_SELECTION_GATE` | off | `"true"` activates the gate |
| `CASE_SELECTION_WAIT_MS` | 600000 | park timeout per round |
| `MAX_CASE_REGEN_ATTEMPTS` | 3 | max refine rounds |
| `MAX_ACCUMULATED_CASES` | 5 | accepted-case pool cap |

---

## 6. Known Issues

1. **Login/signup-only suites.** Discovery models only the entry URL, so suites are generated
   from just that page's concepts (e.g. `Authentication` → login checklist). Product/cart/checkout
   pages only enter the model at execution time via live-extend. See `UPDATES.md` §5.1.
2. **New-page engine disabled under the gate.** `orchestrator.ts` skips `generateCasesForNewPages`
   when the gate flag is on, so live-extend discoveries never become cases (see §4.4).
3. **Empty selection crash.** A `done` with no selections is rejected by the server (400), but the
   round then sits until the timeout, which auto-resolves as `done/[]` and crashes the run with
   `"No test cases were selected for run <id>"`.

---

## 7. Source of This Document

- User phase prompts: recovered from the opencode session history DB (session
  `ses_04e587b9fffeDeUJ4DqB9zyjbK`, Aug 5).
- Committed feature: git commit `18a19a5` ("select cases feature implemented").
- Working-tree refinements: `git diff` of `src/orchestrator.ts`, `src/stages/testCases.ts`,
  `src/stages/caseSelectionGate.ts`, `src/server/caseHistoryLedger.ts`, plus the 8 deleted test files.

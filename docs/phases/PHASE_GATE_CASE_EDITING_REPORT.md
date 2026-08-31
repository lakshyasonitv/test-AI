# Phase — editing cases at the selection gate

The case-selection gate could already show you what the model proposed and let you accept or
reject it. What it could not do was let you *change* it. A case that was 90% right had two
outcomes: run it wrong, or throw the whole batch away and regenerate, hoping the next guess was
closer.

This phase brings the case detail screen's step editor to the point where cases are first
generated — before anything is compiled, grounded, or run.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/schema/caseSelection.ts` | `GateCaseEditSchema`, `GateCaseAddSchema`, and two **optional** fields — `editedCases`, `addedCases` — on both arms of the decision union. |
| `src/server/gateCaseEdits.ts` | **New.** `applyGateEdits()` — folds edits and written cases into the batch. The only server-side logic this feature needed. |
| `src/stages/caseSelectionGate.ts` | One `applyGateEdits` call between the decision and the two persistence calls, in both the upfront gate and the reactive round. Emits `gateRewrite` on the round event. |
| `src/server/rewrite.ts` | **New** `proposeGateRewrite()` and `gateRewriteEnabled()`. `proposeRewrite` / `proposeStepTranslation` untouched. |
| `src/server/index.ts` | **New** route `POST /api/runs/:runId/case-selection/rewrite`. No existing route's shape changed. |
| `public/app.js` | The gate panel's cases became editable cards. |
| `public/index.html` | One button, `#case-write-own-btn`, inside the gate panel's own action row. |
| `tests/caseSelectionGate.test.ts` | +14 cases. |
| `tests/tenancy.test.ts` | +1 row: the new run-scoped route joins the cross-tenant isolation table. |
| `.env.example` | `GATE_CASE_EDIT_AI`, documented, `false`. |

**761 passing** across 49 files (was 743/48 — +18, including the three guard tests from section 9b). `tsc --noEmit` clean. `node --check public/app.js` clean.

## 2. THE STRUCTURAL POINT

`caseSelectionGate.ts` resolves a round and then calls two functions that both address cases by
**position**:

```ts
appendAcceptedCases(runId, attempt, prompt, batch, decision.selectedIndexes)
appendRoundToHistory(runId, attempt, prompt, batch, decision.selectedIndexes, overflow)
```

Both read `batch[i]`. So substituting the edited batch between the decision and those calls makes
every downstream concern correct at once, and `caseAccumulator.ts` and `caseHistoryLedger.ts` were
**not modified at all**:

- the accumulator persists the edited case, because that is what sits at `batch[i]`;
- `MAX_ACCUMULATED_CASES` counts a written case, because it is a real member of the batch;
- the ledger records final titles;
- downstream stages receive ordinary `TestCase` objects.

**There is no origin field.** A written case is built through the real `TestCase` schema, so it is
subject to the same coercions a model-written one is. `tests/caseSelectionGate.test.ts` asserts its
key set equals a schema-parsed model case's, which is what makes "downstream cannot tell them
apart" a property rather than a claim.

## 3. INDEX STABILITY, AND WHAT "REMOVE" MEANS

`selectedIndexes` means positions in the batch. Nothing is ever spliced out of it:

- **Edits** address existing positions and never move them.
- **Written cases** are appended to the end, in arrival order, which is the order the client
  numbered them in.
- **Removing** a model-written case reaches the server as "not in `selectedIndexes`". It keeps its
  slot and is recorded as **rejected** — which is also what stops a later refine round proposing it
  straight back. Physically deleting it would renumber every case after it and silently change what
  an index means.

Removing and unticking therefore converge to the same server-side outcome. The difference is the
affordance: an unticked case stays on screen and can be re-ticked, a removed one disappears.

## 4. THE LEDGER — AN EXPLICIT CHOICE

**One record per case, recording the EDITED version.** The ledger is keyed by normalised title and
feeds `getRejectedTitles` → `filterNovelCases`. `getAllAcceptedCases` already returns edited
titles, so recording the edited title keeps the accepted pool and the ledger telling the same
story about the same case.

**The cost, stated rather than buried:** rename a case and the model's *original* title is no
longer blocked, so a later round could propose it again. One consistent record was judged better
than two records of one case in different states. `tests/caseSelectionGate.test.ts` pins this
deliberately, so a future change has to argue with it rather than drift past it.

## 5. A PRE-EXISTING CRASH THIS FEATURE WOULD HAVE MADE ROUTINE

`runCaseSelectionGate` ends with:

```ts
if (!hasAcceptedPrimary(runId)) throw new Error(`No primary case accepted for run ${runId}: ...`);
```

Unticking the primary could already reach that throw. But "Remove case" and "write my own" make it
an ordinary thing to do — delete the model's primary, write the case you actually wanted, approve,
and the run dies *after* the review rather than during it.

`promotePrimaryIfNeeded` marks the first selected user-written case `fromPrompt` when nothing else
supplies a primary. A case the user typed **is** the direct translation of their own request, so
this states something true. It is not an origin marker: `fromPrompt` already exists, already means
"this case is the user's own ask", and a model-written primary carries it too.

**Known limit:** the promoted case still has to land inside `MAX_ACCUMULATED_CASES` to register.
The lowest selected index is chosen partly for that reason, but a reviewer who fills the pool ahead
of their own case can still reach the original throw.

## 6. NEW ROUTE

### `POST /api/runs/:runId/case-selection/rewrite` — `requireRunRole("tester")`

```
body  { title: string, steps: string[], instruction: string }
200   { steps, before, note, usage }
400   no instruction / over 2000 chars / no steps
404   GATE_CASE_EDIT_AI off
409   no round is pending for this run
429   rate limit (shared with /rewrite)
502   the model returned nothing usable, or more than 50 steps
```

Three properties, and one deliberate difference from its siblings:

1. **It never saves.** The reply fills the editor; the batch is persisted only when a person
   approves the round through `POST /case-selection` (D-27).
2. **It returns step TEXT, never IR.**
3. **It does NOT call `parseIrStep`, and does not constrain the model to `STEP_VOCABULARY`** — and
   this is the difference. `proposeRewrite` edits a *saved* case: there is an IR, the steps are
   grounded, and every proposed line is re-checked by the real parser first. A case at the gate has
   none of those. It is plain English written minutes ago, and forcing the executor's grammar here
   would reject the model's own output. **The vocabulary check has not been skipped — it happens
   later, in the place that owns it.** Whatever survives review is compiled by `toIR` and grounded
   against the live page exactly as an unedited case is. This route cannot widen what the pipeline
   accepts because it sits upstream of every check in it.
4. **Steps come from the request, not the pending batch** — the reviewer may already have edited
   them by hand, and asking about the model's original wording would silently discard that.

## 7. NEW ENV FLAG

**`GATE_CASE_EDIT_AI`** — default **`false`**.

Editing cases by hand needs no flag: it costs nothing and works whenever the gate is on. The flag
gates only "Ask for a change", which spends a Gemini call per press — the same reason
`NL_STEPS_ENABLED` exists. With it off the route 404s *and* the round event reports
`gateRewrite: false`, so the button is never drawn.

`gateRewrite` rides on the existing `case_round_requested` event rather than costing the panel a
second request: the browser cannot know on its own whether this server will answer.

## 8. THE FRONTEND, AND THE ONE LAYOUT FIX

No CSS class was renamed, removed or added. The cards reuse the case-detail editor's own classes
(`cd-lines`, `cd-line`, `cd-line-input`, `cd-line-btn`, `cd-line-del`, `cd-add`, `cd-card`,
`cd-card-inset`, `cd-card-label`, `cd-ask-text`, `cd-ask-btn`, `cd-proposal`, `cd-diff*`) alongside
the gate's own. `diffSteps()` is shared, so an inserted step shifts nothing after it.

**Drafts survive a refresh.** The panel is rebuilt from the run's replayed event stream, and that
event carries the batch the model *originally* produced — so without this, refreshing while the
round is still parked would throw the reviewer's work away. Drafts live in `localStorage` keyed by
run **and attempt**, and are cleared when the gate closes.

**The layout fix.** `.case-selection-list li` is a flex **row**, so the checkbox and every sibling
after it divide the width. Added as direct children, the editor rendered as a ~300px column beside
the summary, leaving about 160px to type a step sentence into. Wrapping the summary, actions and
editor in one `case-narrative` — the existing class for "the stacked content column of a case" —
gives the editor the full row: measured 163px → 924px per step input. It also keeps the inner
`<label>` a flex item, which is what blockifies it and keeps the summary lines on separate rows.

## 9. HOW THIS WAS VERIFIED

- **Gate OFF is structurally unchanged.** `caseSelectionGate.ts` is reached through a *dynamic*
  import inside `if (gateRequested)` in `orchestrator.ts:173`. With the flag off the module is
  never loaded, so `applyGateEdits` cannot run.
- **The tests bite.** Neutering `applyGateEdits` to `return batch` fails 8 of the 9 behavioural
  cases while every back-compat case still passes.
- **Old payloads, live.** Against a real server, `{"action":"done","selectedIndexes":[0]}` and the
  same payload plus `editedCases`/`addedCases` both reach the pending-round check identically.
  `applyGateEdits` returns the **same array reference** when there is nothing to apply, asserted by
  identity rather than deep equality.
- **The flag, both ways.** `GATE_CASE_EDIT_AI=false` → 404 on the rewrite route; `=true` → past it.
- **The UI, driven for real** in Chrome against a synthetic batch (no model spend): cards render,
  a step edit and a reorder land in the payload, removing a case leaves its index behind (cards
  `0` and `2`, no renumbering), a written case lands at `batch.length + 0`, an untouched round
  produces `{}`, and **every edit survived an actual page reload**. Click-to-toggle still fires
  from the summary and not from the editor.

## 9b. A REGRESSION THIS PHASE SHIPPED, AND WHAT IT COST

Worth recording in full, because every check in section 9 passed while it was live.

Building the editor meant replacing a ~200-line region of `public/app.js` wholesale. The
replacement silently dropped **`postCaseSelectionDecision`** — the single function through which
every case-selection decision leaves the browser. Its two call sites survived, pointing at nothing.

**What the user saw:** press "Run test", watch the pipeline reach `2. Generating test cases...`,
and then nothing, forever. It read as "test cases are not generating". Generation was never the
problem. The gate produced 11 cases and parked correctly; clicking "Run selected tests" threw
`ReferenceError: postCaseSelectionDecision is not defined`, so the decision was never sent, the
round waited out its full `CASE_SELECTION_WAIT_MS` (10 minutes), timed out with
`noCasesSelected: true`, and the run finished having executed no tests. Two runs died this way
before it was found, each costing a full plan + discovery + generation cycle.

**Why nothing caught it.** `node --check` validates syntax, not references. `tsc` never looks at
`app.js`. The suite does not execute `app.js`'s click handlers. And the manual browser check drove
the panel by calling `gateEditPayload()` and the render helpers **directly instead of pressing the
button** — so the panel rendered perfectly, every assertion passed, and the only unexercised path
was the one that was broken. That is this project's own recorded failure mode (`DECISIONS.md`
D-19): a check that inspects a thing without ever running it.

**The guard now in place:** `tests/appJsDefined.test.ts`. `app.js` is a classic script with no
module surface and this repo has no JS parser available, so it is a static check of `await NAME(`
call sites — an unambiguous shape that cannot appear in prose, verified to flag nothing across all
70 such sites, and exactly where the bug bit. Two more general approaches were tried and rejected
rather than shipped, both instances of the same trap: regex-stripping literals broke on nested
template literals and reported the word "call" (from the string `"AI call(s)"`) as a missing
function; a hand-rolled tokenizer lost 108KB of a 228KB file to regex literals and apostrophes in
comments, hiding real definitions. The test also pins the gate panel's 23 helpers by name.

**The lesson, stated so it survives this phase:** when a change replaces a region of a file rather
than editing lines within it, diff the set of definitions before and after. `git diff` showed the
deletion plainly; nobody read it that way. And verify a button by *clicking* it.

## 10. WHAT I DID NOT TOUCH

`caseAccumulator.ts`, `caseHistoryLedger.ts`, `pendingCaseSelection.ts`, `ir.ts`, `stepText.ts`,
`parseIrStep`, `public/style.css`, `showView()`, the case detail screen, the saved-case editor,
re-grounding, cost estimates, versions and conflict handling, the library, the home composer,
templates, the coverage selector, the Run button, projects, history, suites, team and settings.

## 11. HOW TO ROLL BACK

Set `ENABLE_CASE_SELECTION_GATE=false` and the whole surface is gone with the gate. To keep the
gate but drop only the model-assisted part, set `GATE_CASE_EDIT_AI=false`. To remove the feature
entirely, revert the commit — nothing it writes has a schema or a migration behind it.

## 12. DEFERRED / FOUND-NOT-FIXED

1. **No validation that an edited step is achievable.** Editing happens before grounding, so
   "Click the Purchase button" on a page with no such button surfaces as a truncation at run time,
   not while typing. Out of scope by specification, and the honest limit of editing this early.
2. **The pool cap can still defeat primary promotion** — see section 5.
3. **The decision route checks for a pending round *before* validating the body**, so a malformed
   payload on a run with no parked round returns 409 rather than 400. Pre-existing ordering, not
   introduced here; the schema itself is pinned by unit test instead.
4. **`tests/caseSelectionGate.test.ts`'s `tc()` helper is a loose `as TestCase` cast** that omits
   the required `intent` and `whyItMatters`. Harmless for the existing cases, but it means the
   stub is not a valid `TestCase`; the new shape assertion compares against a schema-parsed case
   for that reason. Worth tightening whenever that file is next touched.
5. **Drafts are per-browser.** Two people reviewing the same parked round do not see each other's
   edits, and whoever submits first resolves the round. The gate has always been single-decision;
   this makes it more visible.

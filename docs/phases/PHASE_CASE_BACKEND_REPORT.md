# Case editing — the backend: English ↔ IR, re-grounding, and the three prerequisites

The backend half of the case-detail screen. **No UI** — that is the second part, and §10 proposes
how it should consume this.

**Commit:** `90e59a2`. `tsc` clean, **664/664 passing** (was 532; +132).
Working tree clean apart from the untracked `Testbench (1).html`.

The headline: **`parseIrStep(formatIrStep(step), step)` deep-equals `step`, for every step of every
real saved case.** That identity is what makes an unedited line free — it is not re-derived, so its
grounding, its `${env:...}` value and its `nth` survive by construction rather than by the parser
happening to reproduce them.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/stepText.ts` **(new)** | The IR ↔ English mapping, in one place: `formatIrStep`, `parseIrStep`, `parseIrSteps`, `estimateRegrounding`. |
| `src/stages/caseEdit.ts` **(new)** | Re-grounding: walks a prefix in a real browser, then calls the existing `groundingError()`. Cancellable, budgeted, progress-reporting. |
| `src/server/regroundJobs.ts` **(new)** | Re-grounding as an async job — same `StageEvent` contract a run uses, in memory. |
| `src/server/rewrite.ts` **(new)** | "Ask for a change": a model proposes step sentences. Never saves. |
| `src/server/library.ts` | `CaseConflictError` + optional `expectedVersion` on `updateCase`; `duplicateCase`; `listCaseRuns`. |
| `src/server/index.ts` | 8 new routes; `sendAccessError` now renders a 409 with the winning state; the replay path records `run_cases`. |
| `src/db.ts` | `recordRunCases` — fire-and-forget, like every other write there. |
| `tests/stepText.test.ts` **(new)** | 97 cases: the round trip, and a guard that `public/app.js`'s copy cannot drift. |
| `tests/caseEdit.test.ts` **(new)** | 13 cases: the fast path, the walk, cancellation, progress, step-attributed failure. |
| `tests/library.test.ts` | +23: concurrency, duplicate, run history, and the two save paths. |

## 2. NEW FILES

`src/stages/stepText.ts`, `src/stages/caseEdit.ts`, `src/server/regroundJobs.ts`,
`src/server/rewrite.ts`, `tests/stepText.test.ts`, `tests/caseEdit.test.ts`,
`tests/fixtures/stepText/savedCases.json`, this report.

## 3. NEW ENV FLAGS

**One, and it is a timeout rather than a feature switch:**

| Name | Default | What it does |
|---|---|---|
| `REGROUND_TIMEOUT_MS` | `180000` | Whole-save ceiling for the browser walk. A hung site must not hold a job open forever. |

`MAX_LIVE_EXTENSIONS` (existing, default 5) caps the number of browser walks per save. It is
already "browser replays allowed per case" — the same quantity — so it is reused rather than given
a second name. No feature flag: this fixes an editor that could not edit, it does not add a
capability that should default off.

## 4. NEW ROUTES

All new; no existing route's shape changed.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/cases/:id/steps` | viewer | Steps as the sentences the editor shows |
| POST | `/api/cases/:id/steps/estimate` | tester | **What a save would cost. Opens no browser, writes nothing.** |
| POST | `/api/cases/:id/steps` | tester | `200` fast path, or `202 {jobId}` when verification is needed |
| GET | `/api/cases/:id/steps/jobs/:jobId/events` | tester | SSE progress |
| GET | `/api/cases/:id/steps/jobs/:jobId/state` | tester | Poll fallback |
| POST | `/api/cases/:id/steps/jobs/:jobId/cancel` | tester | Stops it; writes nothing |
| POST | `/api/cases/:id/duplicate` | tester | Fresh history at v1 |
| GET | `/api/cases/:id/runs` | viewer | This case's own run history |
| POST | `/api/cases/:id/rewrite` | tester | Model **proposes**; never saves |

**One existing route gained an optional field:** `PATCH /api/cases/:id` accepts `expectedVersion`.
Absent → exactly today's behaviour, which is what keeps it additive.

## 5. SCHEMA CHANGES

Migration `case_run_history_join_table` — `run_cases (run_id, test_case_id, case_index, status,
created_at)`, plus `run_cases_case_recent_idx` on `(test_case_id, created_at desc)`.

**A join table, not `runs.case_id`.** The directive offered both. A suite replay runs several cases
under one run id, so a single column could only ever be correct for single-case replays — and since
most replays *are* suite replays, a case that usually runs in a suite would show an empty history
forever, which is the one thing the "Runs & versions" tab exists to show. Per-case rows answer it
for both shapes and carry the per-case verdict a single column could not.

**No backfill**, as agreed: `run_cases` starts empty (currently 0 rows) and fills from the next
replay onward. The 57 historical runs predate the index and cannot be attributed to library cases —
most of them ran before the library existed.

RLS mirrors the other nine exactly: enabled, `SELECT` to `authenticated` only, scoped through the
case's project to the caller's organisations, and **no policy for `anon`** — that absence is what
makes the publishable key return `[]`.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape.** Eight new routes plus one optional additive field.
- **No second grounder.** `groundingError()` (ir.ts) and `refreshPageModel()` (liveExtend.ts) are
  called, never reimplemented — TD-07 is what that mistake looks like.
- **No `public/style.css` class renamed**, and no frontend file touched at all. This is backend only.
- **Credentials untouched.** `pendingCredentials.ts` and `scrubServedSecrets` unchanged. The round
  trip preserves `${env:TEST_USERNAME}` verbatim and never resolves it — pinned by a test.
- **`AUTH_ENABLED=false` unchanged.** Nothing here runs unless a case is edited.
- **No accounts or organisations created or changed.** Final roster:

  | who | org | role |
  |---|---|---|
  | (synthetic local user) | Default | **owner** |
  | garvit.khandelwal@thinkvibes.com | Default | owner |
  | ls@thinkvibes.com | Default | owner |

---

## 7. HOW TO VERIFY

### A. The round trip — the correctness claim

1. `git log --oneline -1` → `90e59a2`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **664 passed** (42 files).
3. `npx vitest run tests/stepText.test.ts` → **97 passed**. This is the headline: it runs
   `parseIrStep(formatIrStep(step), step)` over **every step of every saved case** copied out of
   your database (`tests/fixtures/stepText/savedCases.json` — 2 distinct IRs, 21 steps) plus 12
   synthetic steps covering shapes no saved case uses yet.

   It also proves the three things the format alone cannot carry survive anyway:
   ```
   ✓ preserves a credential reference verbatim rather than resolving it
   ✓ keeps a wait's millisecond value, which the sentence drops entirely
   ✓ keeps grounded identity (css/testId/nth) that the sentence never shows
   ```
4. The same file evaluates `public/app.js`'s own `formatIrStep` and asserts it renders identically
   for all 33 steps. **Edit one and not the other and this fails** — the browser cannot import the
   server's copy, so drift is caught by a test rather than by an editor that shows one sentence and
   parses another.

### B. The cost model — what is free and what is not

This is the distinction everything else rests on, so check it directly.

5. Start the server (`npm run serve`) and sign in as your owner account.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale saved
   address. Clear with `Ctrl+A` and retype, `Esc` to dismiss.
6. Get a case's steps and an estimate for an untouched edit:
   ```
   TOK=<your token>          # devtools → Application → Local Storage → testbench.session
   CASE=<a case id>          # from the Suite screen, or GET /api/cases

   curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/api/cases/$CASE/steps
   ```
   Feed those exact strings back:
   ```
   curl -s -X POST http://localhost:3000/api/cases/$CASE/steps/estimate \
     -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
     -d '{"steps":["Go to /login", "...paste the rest verbatim..."]}'
   ```
   → `{"instant":true,"stepsToVerify":0,"snapshots":0,"maxLlmCalls":0,...}`
7. Change a fill's **value** only (not which box). → still `"instant":true`, `"changedSteps":1`,
   `"stepsToVerify":0`. **Editing a password costs nothing**, because the element was never in
   question and its `css` survives.
8. Change a **target** (`Click on button "Sign In"` → `Click on button "Log In"`). → `"instant":false`,
   `"stepsToVerify":1`, `"stepIdsToVerify":["s4"]`, `"snapshots":1`, and an `estimatedSeconds`.
9. Confirm estimating is genuinely free: it opened no browser and wrote nothing —
   `current_version` is unchanged and no `test_case_versions` row appeared.

### C. The two save paths

10. **Fast path.** Save the value-only edit from step 7:
    ```
    curl -s -X POST http://localhost:3000/api/cases/$CASE/steps \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
      -d '{"steps":[...value changed...]}'
    ```
    → **`200`** with `"mode":"instant"`. Returns immediately, no browser. Confirm in the database
    that the edited step still carries its original `css`:
    ```sql
    select jsonb_pretty(ir->'steps') from test_cases where id = '<CASE>';
    ```
11. **Job path.** Save the target edit from step 8 → **`202 {"jobId":"...","mode":"verifying",...}`**,
    carrying the same estimate `/estimate` gave, so what the UI promised is what it gets.
12. Watch it:
    ```
    curl -N -H "Authorization: Bearer $TOK" \
      http://localhost:3000/api/cases/$CASE/steps/jobs/<JOB>/events
    ```
    `StageEvent`s arrive with `stage:"ir"` and `data:{phase:"walking",stepId:"s4",done:0,total:1}`,
    ending in `done` (saved) or `error`. `/state` returns the same events for polling.
13. A failure names the row. Point a step at an element that is not on the page and save →
    the job ends `error` with `stepIndex`, `stepId`, and a message the editor can attach to that
    row. **The stored case is untouched** — verify `current_version` did not move.

### D. Cancellation — nothing written, nothing leaked

14. Start a target edit (job path), then cancel it while it is walking:
    ```
    curl -s -X POST http://localhost:3000/api/cases/$CASE/steps/jobs/<JOB>/cancel \
      -H "Authorization: Bearer $TOK"       # 202 {"cancelling":true}
    ```
15. The job ends with `done` carrying `{"cancelled":true,"saved":false}` — cancellation is reported
    as cancellation, not as a failure the user caused. Confirm **nothing was written**:
    ```sql
    select current_version from test_cases where id = '<CASE>';
    select count(*) from test_case_versions where test_case_id = '<CASE>';
    ```
    Both unchanged.
16. **No leaked browser.** Verified at commit time against the real site, with a cache-busted prefix
    so a real Chromium actually launched:
    ```
    baseline chromium processes: 46
      walking to s2 (1/2)
    result: ok=false cancelled=true snapshots=1
    elapsed: 2s
    chromium processes after cancel: 46
    PASS — no leaked browser
    ```
    Cancel is checked **between** snapshots, not mid-Playwright-call, so an in-flight snapshot
    finishes — and `replayAndSnapshot`'s own `finally` closes its browser either way. A cancel can
    therefore take up to one snapshot to land, and no browser is ever left open.

### E. Concurrency — an open editor must not clobber a colleague

17. ```
    curl -s -X PATCH http://localhost:3000/api/cases/$CASE \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
      -d '{"title":"Stale","expectedVersion":1}'
    ```
    → **`409`** when the case is past v1, carrying `currentVersion` and a `current` block with the
    winning steps, so the loser can see what they would have destroyed. Sending **no**
    `expectedVersion` still saves — that is what keeps the field additive.
18. The staleness check runs **before** the browser walk, so a doomed save never spends 90 seconds
    first. It is re-checked inside the write, closing the window during a long walk.

### F. Duplicate, and a case's own runs

19. ```
    curl -s -X POST http://localhost:3000/api/cases/$CASE/duplicate \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{}'
    ```
    → `201`, a new id, `"currentVersion":1`, `"sourceRunId":null`, `"lastRunStatus":null`. The
    original's version history and run outcomes are **not** cloned — a duplicate is new work that
    starts from the same steps, and carrying over "edited by Priya three weeks ago" would attribute
    history to a case that did not exist.
20. Run a **multi-case suite** replay, then:
    ```
    curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/api/cases/$CASE/runs
    ```
    → one row per case, each with `runId`, `caseIndex`, `status` and `resultPath`
    (`cases/case-N`). All the cases in that suite share **one** `runId` and are individually
    addressable — which is exactly why this is a join table.

### G. The RLS invariant — the one that must never regress

21. A table was added, so re-confirm the browser-facing key sees nothing across all ten:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects project_members \
             suites test_cases test_case_versions suite_cases run_cases; do
      printf "%-22s " "$t:"
      curl -s "$URL/rest/v1/$t?select=*&limit=3" -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
      echo
    done
    ```
    **Expected — verified at commit time, all ten:**
    ```
    runs: []   organisations: []   organisation_members: []   projects: []   project_members: []
    suites: []   test_cases: []   test_case_versions: []   suite_cases: []   run_cases: []
    ```
    If any returns rows, run history and saved tests are world-readable — stop everything.
22. Supabase security advisors report only the two **pre-existing** warnings (the orphaned
    `create_organisation_with_owner` from the stopped org work, and leaked-password protection).
    **No new findings from this migration.**

---

## 8. HOW TO ROLLBACK

```
git revert 90e59a2
```

**Manual step — the migration does not revert with the code.** `run_cases` is additive and inert
without the routes, so leaving it is harmless. To drop it:

```sql
drop table if exists run_cases cascade;
```

That destroys only the run-history *index*; the runs themselves and their artifacts are untouched.

Nothing else needs undoing: no case was edited during verification, and the cancelled re-ground
wrote nothing by construction.

---

## 9. DEFERRED

**The round-trip contract is not the one the directive asked for, and it could not be.** The
directive said `parse(format(step))` must deep-equal the original. That is impossible, and the
reason is the format, not the parser: `formatIrStep` renders `role`, `name`/`text` and the value,
and drops `css`, `testId`, `nth`, `label`, `placeholder` and `preAction` entirely. Worse,
`text_contains` and `text_equals` render the **same sentence**, `wait` drops its millisecond value,
`press` drops its target, and `navigate` cannot say whether it read `target.url` or `value`.

So the format is **lossy, and in four places ambiguous** — not merely ambiguous. The contract I
implemented and pinned instead is `parseIrStep(format(step), step)`, parsing *onto* the original.
It is strictly stronger where it matters: an unedited line returns the original **object**, so
nothing can be lost even in principle, and it is what makes an untouched step cost nothing. A
changed line clears the grounded fields, which is precisely what forces the re-check.

**Not built, and you will notice:**

- **No credentials on the re-ground walk.** `regroundEditedIr` accepts `creds` but nothing supplies
  them, so editing a step behind a login will fail to reach it on a site whose session is required.
  The run pipeline prompts for credentials interactively (`pendingCredentials.ts`); wiring that into
  an editing session is its own piece of work, and guessing at it here would have been worse than
  leaving the seam visible.
- **`run_cases` is empty and is not backfilled.** It fills from the next replay onward, as agreed.
  The 57 historical runs mostly predate the library entirely.
- **The rewrite endpoint is untested against a live model.** Its parsing, rate limit and
  never-saves property are exercised; the prompt's actual output quality is not, because that costs
  tokens on every test run. Worth one manual check before the UI ships.
- **Cancellation granularity is one snapshot.** Cancel is polled between walks, so a job cancelled
  during a slow page still finishes that page first. Finer granularity would mean threading an
  `AbortSignal` through `replayAndSnapshot` into Playwright, which is a change to shared grounding
  code for a second or two of latency — not worth it.
- **Job state is in memory.** A server restart mid-edit loses the job, and the edit is simply not
  saved. That is the correct outcome, but the UI should say so rather than spinning forever.

**Noticed, outside this phase, not touched:**

- `ls@thinkvibes.com` is **`owner`**, not `admin` as the directive stated (the previous phase found
  the same). I did not rewrite a real account's role on a stale expectation.
- The orphaned `public.create_organisation_with_owner` function is still there, still the only new
  advisor finding, still from the stopped org work.

---

## 10. UI PLAN

What the case-detail screen should do with this. **The user reviews this before the UI is built.**

### Endpoints, and when

| When | Call |
|---|---|
| Opening the case | `GET /api/cases/:id` (title, versions, suiteIds) + `GET /api/cases/:id/steps` (the sentences) |
| Opening the "Runs & versions" tab | `GET /api/cases/:id/runs` |
| **On every edit, debounced ~400ms** | `POST /steps/estimate` |
| Save | `POST /steps` → branch on `200` vs `202` |
| While a job runs | SSE `/steps/jobs/:jobId/events`, falling back to polling `/state` |
| Cancel | `POST /steps/jobs/:jobId/cancel` |
| "Rewrite steps" | `POST /rewrite` → show a diff → **approve routes back through `POST /steps`** |

Hold `currentVersion` from the moment the case loads and send it as `expectedVersion` on every
write. That is what turns a silent clobber into a visible conflict.

### The estimate, and where cost becomes visible

`/estimate` is cheap and pure, so call it live rather than only on Save. It drives **the Save button's
own label** — the cost is stated on the control that spends it, not in a dialog after the fact:

- `instant: true` → **`Save`**, plus a quiet line: *"No steps need re-checking."*
- `instant: false` → **`Save — re-checks 2 steps (~40s)`**, and the rows in `stepIdsToVerify` get a
  small marker so the count is never abstract: you can see *which* steps you are about to pay for.

`maxLlmCalls` is a ceiling, not an expectation — grounding is DOM-first and usually spends none.
Label it that way ("up to N model calls") or the first save that costs zero will read as a bug.

### Save, and the two paths

- **`200` (fast).** Update in place, clear dirty, show the new version. No spinner — a spinner for
  a 50ms operation reads as slower than none.
- **`202` (job).** Steps go read-only; each row in `stepIdsToVerify` shows *pending*. Progress
  events flip the current row to *verifying…* and completed ones to *ok*. The header shows
  **`Verifying 2 of 3…`** with **`Cancel`** beside it.

Do not block the whole screen. The right column stays live so the run history and latest result are
still readable while a save is verifying.

### Failure, per row

A `422`/`error` event carries `stepIndex` and `stepId`. Attach the message **to that row**, inline,
and leave every other row's edit intact — the user must not lose ten minutes of work because step 7
did not resolve. Keep the editor dirty and Save enabled: the fix is usually one word in that row.

Distinguish the two failure shapes, because the remedies differ:
- *"could not reach step s7"* → an **earlier** step is the real problem; say so, and mark the step
  the walk stopped at rather than the one that was edited.
- a grounding message → **that** step's target is wrong.

### Cancel, and what the user sees after

`Cancel` → button becomes `Cancelling…` (the current snapshot must finish; that is up to a few
seconds and pretending otherwise would be a lie). Then the editor returns to exactly the state it
was in **before Save was pressed** — still dirty, edits intact, an unobtrusive
*"Cancelled — nothing was saved."*

Cancel is **not** an undo: nothing was written, so there is nothing to undo. The message should say
that plainly, or a user will go looking for a version that was never created.

### The conflict

A `409` (from either the pre-check or during a job) opens a small comparison: **your steps** against
**theirs**, using the `current.steps` the response carries. Two ways out — *Discard mine* and
*Keep mine* (which reloads to their version, re-applies your edits on top, and lets you save
against the new `expectedVersion`). Never offer a plain "overwrite": that is the silent clobber
this whole mechanism exists to prevent.

### Ask for a change

The proposal is a **diff, not a save**. Show before/after with the model's `note` above it, and
`Apply` merely fills the editor — the user still presses Save, still sees the estimate, still gets
the re-ground. One way into the library, one set of guarantees, whoever wrote the sentences.

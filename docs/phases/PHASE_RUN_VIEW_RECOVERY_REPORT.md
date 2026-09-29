# Phase — Run-view recovery, HTTP status handling, and sign-out

A run that survived a network blip stayed frozen on screen forever, and the only recovery was a
manual page reload. The poll loop's *retry* was correct the whole time; its *rendering* was not —
it resumed forward from a one-directional cursor, so any event missed during the outage was never
re-derived and the stage cards sat on stale values with nothing left to move them. Alongside that,
the loop never looked at the HTTP status at all, so a `401`, a `403` and a `404` were all retried
once a second indefinitely, and a `403` (a run deleted by retention, or one belonging to another
organisation) was indistinguishable from an expired session.

Additive, per the platform rules — no route shape changed, no CSS class minted, `showView()` not
touched, nothing deployed.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `public/app.js` | `connectToRun`: branch on `res.status` **before** `res.json()`; re-check the generation after every await (TD-15); replay the full stream on recovery; `++fails >= 5`; clear `fails` on completion. New `stopRunPolling(runId, status)` helper. Declared `returnToRunAfterSignIn` and consumed it in the login handler. `signOut()` bumps `pollGeneration`; the sign-out confirm is now conditional. |
| `tests/appJsRunRecovery.test.ts` | **New**, 12 tests, offline — no browser, no server, no network. |
| `docs` | `DECISIONS.md` D-33 (replay, not snapshot) and D-34 (401 vs 403/404, and the sign-out rule). `TECH_DEBT.md` TD-15 marked fixed; TD-96 … TD-99 filed. This report. |

## 2. THE RECOVERY REPLAY

On the first good read after a failure, `connectToRun` calls `resetRunUI()`, sets `seen = 0`, and
re-applies the whole stream.

This is deliberately the **reload path, not a new mechanism**. `applyEvent` is already required to
be re-appliable from the start, because opening `#/run/<id>` after a reload does exactly this. So
the fix introduces no second render function and no new state to keep in sync — it reuses the path
that was already correct. Every accumulator `applyEvent` touches is reset first: `phaseStageStatus`
via `renderPhases`, and the heal counters via `hideSuiteResults`. The latter is load-bearing, not
tidiness: the primary-heal counter is a `+= 1`, so an unreset replay would double-count heals.

Rejected alternatives (D-33): a **snapshot endpoint** returning derived state alongside the log —
strictly better on paper, and it would also have closed the TD-15 window, but it adds a route plus a
second state representation that can drift from the log. And **patching the last-known stage per
phase forward** — cheaper, but it re-implements a partial second derivation that must stay
consistent with `applyEvent` forever, which is the anti-pattern `AGENTS.md` warns about.

**The cost, stated rather than discovered:** a replay re-runs every `applyEvent` side effect, so
credential prompts and case-selection panels visibly replay on recovery. Identical to a manual
reload, still better than frozen forever, but a visible artifact of the fix.

## 3. STATUS HANDLING, AND WHY 403 IS NOT 401

- **401** → stop, say the session expired, clear the session, route to sign-in, and **preserve the
  run id** so signing back in returns to that run instead of the home screen.
- **403 / 404** → stop, say the run is no longer available, **no route to sign-in**.
- **everything else** — network errors, 5xx, non-array payload → transient, keep retrying.

The distinction is the point. `requireRunRole` in `src/server/authz.ts` raises **403** when a run has
no provable ownership record left to prove — exactly what retention pruning leaves behind, and also
what another organisation's run looks like. Re-authenticating cannot fix either, so treating 403 as
"session expired" sends a legitimate user into a sign-in loop with no exit and no error explaining
it. That is the bug this fixes; the wasted retries are the minor half.

**404 is defensive and labelled as such** in both the code and TD-97. `/api/runs/:id/state` returns
`getEvents()` straight from the run store, which yields `[]` for a missing directory, so it does
**not** 404 today — verified against `src/server/index.ts` and `src/runStore.ts`. The branch is kept
so a future route change cannot drop a missing run into the transient path.

## 4. SIGN-OUT

`signOut()` bumps `pollGeneration` **before** clearing any state. Without it an in-flight
`connectToRun` kept polling `/state` with a token about to be revoked, and every response was a
401 — which, before this phase, was swallowed by the same transient catch a dropped connection
uses. Signing out manufactured a 1Hz self-inflicted outage that reads as the server falling over.
This is the same class as TD-25 and uses the mechanism TD-25 established.

The confirm is now conditional on `(currentRunId && !currentRunFinished) || runInFlight`, all
client-side so it costs no round trip. Native `confirm()` retained — the other six destructive asks
in `app.js` are native, and a styled modal would mean minting a CSS class (platform rule 3).

## 5. VERIFICATION

**Mutation testing, because this codebase has shipped green runs that verified nothing.** Each of
the 8 fixes was deleted in turn and the suite re-run; all 8 turned the corresponding test red, and
`public/app.js` was restored byte-identical afterwards.

| Mutation | Result |
|---|---|
| remove the 401/403/404 branch | RED (4) |
| treat 403 as an expired session | RED (2) |
| remove the recovery replay | RED (1) |
| `>= 5` → `=== 5` | RED (1) |
| drop `fails = 0` on done | RED (1) |
| remove the post-fetch generation re-check | RED (1) |
| remove `pollGeneration++` from `signOut` | RED (1) |
| restore the original unconditional confirm | RED (2) |

Two of those eight were green on the first attempt and are worth recording, because both were
*harness* faults that would have produced a false all-clear:

- The `signOut` mutation initially built its replacement from the wrong offset and emitted the
  original function ahead of the mutated one. Duplicate function declarations are legal, so the test
  read the untouched copy and passed. The test was fine; the mutation harness was not.
- The sign-out mutation as first written kept the new confirm's wording, so a test asserting the
  old `confirm("Sign out?")` was *absent* could not fail. The mutation has to reinstate the actual
  code that was replaced, not a variant of it.

A third finding is a real weakness in the test, not the harness: the TD-15 assertion originally
checked only that a re-check exists *somewhere* after the fetch. There are two re-check sites, so
deleting the meaningful one (the one that must precede the status branch) left the test green. The
assertion now pins the **ordering** — the post-fetch check must come before `stopRunPolling` and
before `await res.json()`.

`npx tsc --noEmit`: exit 0, unchanged.
`npx vitest run`: **1468–1469 passed, 106 skipped, 1575 total**; 95–96 files passed, 9–10 failed.
Baseline was 1457 passed / 1563 total / 95 files passed — so exactly **+12 tests, +1 file**.

The failing files are the same pre-existing Playwright/Chromium collection failures, all browser
suites: `assertChoiceBrowser`, `assertGoneBrowser`, `authCrawl`, `dialogFieldResolution`,
`genericClickables`, `safeClickBrowser`, `selectAction`, `selectResolution`, `walkCredentials`. The
changed file was not among them in any run. The *number* of individual failing tests in that set
moved between runs (0, 1, then 2) against an unchanging file list, which is Chromium-launch
contention in this environment rather than a result of this change — the baseline showed the same
9 failing files with **zero** failing tests, i.e. these files fail at collection, not per test.
Stated plainly because a single "1469 passed, 0 failed" line would have been true of one run and
misleading as a general claim.

## 6. DELIBERATELY NOT DONE

- **No live browser verification, and no real run.** Everything here is client-side, so it was
  pinned with offline unit tests that extract and execute the real functions. A real end-to-end
  confirmation would need a deliberately interrupted network against a real run, and it costs
  Gemini/browser budget — not spent without being asked.
- **TD-98's threshold is pinned at the source level, not behaviourally.** The test asserts `>= ` is
  present in the extracted function. Simulating six consecutive failures and asserting the message
  appears would be the better test; recorded in TD-98 so the register does not imply a stronger
  guarantee than was built.
- **No snapshot endpoint, and no `AbortController`.** Both would remove the TD-15 window entirely.
  Both are server- or platform-shaped work; D-33 records the reasoning so it is a deliberate
  revisit rather than an accident.
- **TD-25's untested neighbour is still open.** Deleting a *project* containing the currently-viewed
  run is still unverified as a `pollGeneration` site. Signing out was fixed; project deletion was
  not, and nothing here should be read as covering it.
- **The sign-out confirm trusts a client-side flag.** If a run finished while the tab was
  disconnected, signing out asks about an already-finished run — a false positive costing one extra
  click. Asking the server would make a local action depend on the network being up, which is worse.
- **`LLM_CONTEXT_BRIEFING.md` was not touched**, per the phase constraints — it is regenerated, not
  edited, and would have to catch up with TD-15/TD-96…TD-99 and D-33/D-34 on the next regeneration.
- **The `TECH_DEBT.md` summary table is still missing rows for TD-68 … TD-95.** Rows were added for
  the four new entries as the file's own note requires, but the earlier gap was left as found
  rather than back-filled from someone else's entries — a row written second-hand is how the drift
  started. Noted in the table instead.

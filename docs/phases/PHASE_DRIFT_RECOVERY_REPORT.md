# Drift recovery — when the page changed under the main test: wait, re-discover, ask, rebuild, re-run

Behind `DRIFT_RECOVERY`, default **off**, and inert unless `RUN_QUESTIONS` is also on (it needs
someone to ask). Decision D-52. Open limits: TD-116. Builds on run questions (D-51,
`PHASE_RUN_QUESTIONS_REPORT.md`). No database changes; no existing route, field or class changed.

`tsc --noEmit` clean. Vitest: **1939 → 1956 passing** (14 in `tests/driftRecovery.test.ts`, one
timeout-answer test in `tests/runQuestions.test.ts`, and the flag's generated
`booleanEnvFlags` pair). The one failure before and after is `tests/safeClickBrowser.test.ts`
"still navigates a REAL href", in the cloud container only.

---

## 1. THE FLOW (primary case only)

```
spec fails → diagnose → self-heal (unchanged, if on)
  └─ still failing AND a page-change category past step 0?
       round N (≤ DRIFT_MAX_ROUNDS, default 2):
         wait DRIFT_SETTLE_MS (15 s)
         re-snapshot the page it broke on   (refreshPageModelAt — the walk heal uses)
         ASK the tester                      (run question "drift-instruction")
             Stop → keep the failure | text → steer | empty or timeout → go ahead
         rewrite the TEST CASE              (one model call: old case + fresh page + note)
         compile → reject if truncated, or if it asserts less than the original
         run → pass: accept │ fail on drift again: next round, tell them why │ else: stop
```

## 2. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/driftRecovery.ts` **(new)** | `driftRecoveryEnabled`, `isDrift`, `recoverFromDrift`, `describeStep`, the case rewrite and the assertion-count guard. Writes `runs/<id>/recovered/round-N/` and `recovered/drift-recovery.json`. |
| `src/orchestrator.ts` | Stage `drift`; question kind `drift-instruction`; `QuestionRequest.timeoutAnswer`; the recovery block after heal; `recovered` on the `done` event (optional); `updatedAppModel` becomes the fresh model so the suite is generated against the changed page. |
| `src/stages/suiteRunner.ts` | `PrimaryCaseResult.recoveredCase?`, `CaseRunResult.recovered?`, `SuiteSummary.cases[].recovered?` — the primary card shows the rebuilt case. All optional. |
| `src/server/pendingQuestions.ts` | The waiter remembers its kind; `ANSWER_LIMIT` per kind (code 64, instruction 2000); a timeout resolves with `timeoutAnswer`. |
| `src/server/index.ts` | `DRIFT_RECOVERY` registered; the question route distinguishes Skip (null) from an empty answer (""), and applies the per-kind limit. |
| `public/app.js`, `public/index.html` | `drift` in the results phase and its summary line; a "Rebuilt after page change" badge (existing `case-badge-healed` class); the question modal's wording per kind (ids added, no classes). |

## 3. HOW TO TRY IT

`RUN_QUESTIONS=true DRIFT_RECOVERY=true`, restart the server. Run a test, then change the page
under it (rename a button the test clicks) and run it again. After the failure and any self-heal,
"The page has changed" appears 15 s later: type what changed (or nothing) and press "Rebuild and
re-run", or "Stop — keep the failure".

## 4. DELIBERATELY NOT DONE

- Suite cases are not recovered — one question per run, not one per case (D-52, TD-116).
- No full site re-discovery: only the page that broke is re-snapshotted.
- The rebuilt case does not reach the library by itself; saving it is the usual click.
- Not run end to end against a live site with a real model call here: the loop is pinned with
  module-boundary stubs, and its browser half (`refreshPageModelAt`, `runSpec`) is the code
  self-heal already runs. A first live run should watch `recovered/drift-recovery.json`.
- Rollback: `DRIFT_RECOVERY=false`. Nothing is persisted outside the run's own directory.

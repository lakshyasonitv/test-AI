# Phase 0 — Safety net

Implements Steps 0.1–0.4 of `implentationplan.md`. Approved plan:
`C:\Users\Garvit Khandelwal\.claude\plans\crystalline-scribbling-quiche.md`.

Commits: `0e7dabe` (Steps 0.1, 0.2, 0.4) and `9ac2e33` (Step 0.3 — bundled with Phase 1
Steps 1.1/1.2 because Step 0.3's `src/server/index.ts` export refactor and Step 1.1's route
replacement touch the same file; see PHASE_1_REPORT.md for that commit's full detail).

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `tests/irPostClickReveal.test.ts` | Repointed its two `load(...)` calls from `../runs/2026-08-10T.../04-ir.json` (aged off disk) to committed fixtures; corrected the block comment that claimed these were live `runs/` reads. |
| `.github/workflows/test.yml` | New CI workflow: checkout → Node 22 → `npm ci` → `tsc --noEmit` → `npm test`. No prior CI ran the test suite (TD-20). |
| `package.json` | Added `"engines": {"node": ">=20.12.0"}` (the real floor `--env-file-if-exists`, used in every `npm run` script, requires) and `supertest`/`@types/supertest` devDependencies (for Step 0.3's contract tests). |
| `package-lock.json` | Lockfile update from the above. |
| `CLAUDE.md` | Line 12's architecture summary said "Groq compiles the chosen case into a strict JSON IR" — stale since `DECISIONS.md` D-21 removed Groq entirely. Corrected to Gemini. |
| `playwright.config.ts` | `timeout: 50_000` → `timeout: Number(process.env.PLAYWRIGHT_TIMEOUT) \|\| 50_000`. Resolves TD-24. |
| `TECH_DEBT.md` | Marked TD-24 fixed, and corrected TD-24's own stale claim that `executor.ts` injects `PLAYWRIGHT_TIMEOUT` into the child env (see DEFERRED/notes below — it doesn't, and never did in the current codebase). Updated one cross-reference in TD-02 to match. |

`src/server/index.ts`'s Step 0.3 changes (export `app`, guard `app.listen()`) are in commit
`9ac2e33` together with Phase 1 — see `PHASE_1_REPORT.md`.

## 2. NEW FILES

- `.github/workflows/test.yml`
- `tests/fixtures/irPostClickReveal/1279794e-04-ir.json`
- `tests/fixtures/irPostClickReveal/a5d729b1-case1-04-ir.json`
- `tests/apiContract.test.ts` (committed in `9ac2e33` — see PHASE_1_REPORT.md; it's Step 0.3's
  deliverable, listed here for completeness)

## 3. NEW ENV FLAGS

| Flag | Default | What it does | When flipped |
|---|---|---|---|
| `PLAYWRIGHT_TIMEOUT` | unset → `50_000`ms | Playwright's own per-test timeout (previously hardcoded, now genuinely configurable). | Set it to any number of milliseconds to change Playwright's internal timeout. Nothing in this codebase sets it today, so real behavior is unchanged until you set it yourself. |

Not a capability flag (nothing is gated on/off by it) — a tuning knob that was previously dead.

## 4. NEW ROUTES

None in Phase 0.

## 5. SCHEMA CHANGES

None.

## 6. WHAT I DID NOT TOUCH

- No existing `/api/*` route's request or response shape changed (see Step 0.3's contract
  tests in `9ac2e33`/`PHASE_1_REPORT.md`, which pin every current shape and pass unchanged).
- `public/app.js`, `public/index.html`, `public/style.css` — not touched by this phase at all.
  (Your `git status` will still show these three as modified/untracked, along with
  `PROJECT_OVERVIEW.md` and `Testbench (1).html` — that's pre-existing uncommitted work from
  earlier in this session, unrelated to Phase 0/1, deliberately left as-is and not committed by
  either phase's commits.)
- Credential handling (`pendingCredentials.ts`, `scrubServedSecrets`) — not touched.
- `CONFIG.TIMEOUTS.TEST_RUN` (executor.ts's own parent-kill timer, currently `100_000`ms) —
  not touched. It still fires well after Playwright's own 50s timeout, exactly as before.

## 7. HOW TO VERIFY

1. `git log --oneline -3` — confirm `0e7dabe` and `9ac2e33` are present on top of your prior
   history.
2. `npx tsc --noEmit` → no output (clean).
3. `npx vitest run` → `Test Files 36 passed (36)`, `Tests 396 passed (396)`.
4. `grep -n "Groq compiles" CLAUDE.md` → no match (confirms the doc-drift fix).
5. Open `.github/workflows/test.yml` in GitHub's Actions tab after pushing, or run
   `act -W .github/workflows/test.yml` locally if you have `act` installed — confirm the `test`
   job runs green and `directory-tree.yml` is untouched/unaffected.
6. `cat .env 2>/dev/null | grep PLAYWRIGHT_TIMEOUT` → no match (confirms nothing currently
   overrides the new default, so a real run's Playwright timeout is still 50s).

## 8. HOW TO ROLLBACK

```
git revert 0e7dabe
```

No migrations, no manual steps — this commit only touches tests, CI config, `package.json`/
`package-lock.json`, and two doc files. Reverting drops the CI workflow, the `engines` field, the
two doc corrections, and reintroduces the 2 failing tests (their fixtures and the `test.ts`
repointing revert together).

If you also revert `9ac2e33` (Phase 1's commit), do it in the same pass or afterward — reverting
`9ac2e33` alone would remove `src/server/index.ts`'s `export { app }`, which
`tests/apiContract.test.ts` (this phase's Step 0.3 deliverable, but physically committed in
`9ac2e33`) depends on to import the app. See PHASE_1_REPORT.md's rollback section for the
combined command.

## 9. DEFERRED

- **`tests/liveExtend.test.ts`'s claimed 5000ms timeout failure (plan doc's "3rd failing test")
  did not reproduce.** Ran in isolation 3 times and as part of the full suite: 16/16 green every
  time, no timeout. Not touched — fixing a non-reproducing issue risks weakening a passing test
  for no verifiable benefit. If it starts failing in CI (a slower runner than this dev machine
  could plausibly surface a real margin issue), re-investigate then with real failure output in
  hand rather than the plan doc's secondhand description.
- **TD-24's original text was itself stale/wrong**, independent of this fix: it claimed
  `executor.ts` injects `PLAYWRIGHT_TIMEOUT: String(CONFIG.TIMEOUTS.TEST_RUN)` into the spawned
  Playwright process's env. Grepped the entire `src/` tree — that string appears nowhere outside
  `playwright.config.ts` (this fix). `executePlaywright`'s `spawn(...)` call only ever set
  `...process.env`, `...secretEnv`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, and `PLAYWRIGHT_HEADLESS`.
  Either the injection was removed in a past refactor without updating TD-24, or it described an
  intended-but-never-shipped change. **This matters because a decision made during planning (to
  "delete the stale injection" as part of this fix) was based on that now-disproven premise** —
  there was nothing to delete. The actual fix applied (`playwright.config.ts` reads the env var,
  default unchanged) is unaffected and still correct/safe either way; only the "and also touch
  executor.ts" half of the plan turned out to be a no-op once I looked at the real code. TD-24's
  entry in `TECH_DEBT.md` now documents this correction directly.
- **`TD-02`'s own numbers are stale** (says `CONFIG.TIMEOUTS.TEST_RUN = 60_000`/"60s"; the actual
  value in `executor.ts` is `100_000`/100s). Noticed while investigating the above, but auditing
  TD-02's numbers wasn't in Step 0.4's scope (Groq + TD-24 only) — left alone except for the one
  clause in TD-02 that directly referenced TD-24's now-fixed state, which was updated since
  leaving it would have directly contradicted this phase's own change.
- Stale local `.env` values noticed but not touched (it's gitignored local config, not code):
  `GEMINI_MODEL=gemini-3-flash-preview` (superseded by `gemini-3.6-flash` per `.env.example`),
  and leftover `GROQ_API_KEYS`/`GROQ_MODEL` (dead since D-21).
- Everything under `TD-16` (retention — addressed in Phase 1) and `TD-20` (CI — the *test*-running
  half is addressed here; any other item under TD-20 beyond "no CI runs the tests" is untouched)
  beyond exactly what Steps 0.1–0.4 and 1.1–1.2 cover.

# Phase — Logging hardening (Phases 1 + 2)

Phase 1 was a read-only audit of every `console.*` in `src/` and produced a ranked list of
findings (L1–L7): secrets reaching logs, and log lines that asserted things the code had not
established. Phase 2 fixed them and added opt-in diagnostic output. This is the report for the
work; the audit's findings and the decisions taken on them are `DECISIONS.md` D-37/D-38, the
residual gaps are `TECH_DEBT.md` TD-115/TD-116/TD-117.

**The FIXES are always on; the new OUTPUT is behind one flag, `EXTENDED_LOGGING`, default off.**
Off, the process logs exactly what it logged before, so the nine `docs/phases/` reports that quote
a byte-identical startup log still hold untouched (`DECISIONS.md` D-37). No route's request or
response shape changed except the one explicitly-scoped `length` removal on `/api/health`
(`DECISIONS.md` D-38). No CSS class minted. Nothing committed or deployed.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/executor.ts` | `[PW STDOUT]`/`[PW STDERR]` redacted against `secretCreds(secretEnv)` — a Playwright child can echo a typed credential (STEP 1a). Later: `runIdEnv()` passes `RUN_ID` into the child (STEP 3), and `executorRunTag()` prefixes the parent's OWN `[executor]`/`[PW …]` lines so two concurrent runs' subprocess output is tellable apart (Q3). |
| `src/llm/backoff.ts` | New `ERROR_BODY_LIMIT`/`boundErrorBody`/`retryAfterFromBody`: provider error bodies are bounded before logging; the retry line names the provider and `key N of M`, never key material (STEP 1b). |
| `src/llm/keyPool.ts` | Pool entries carry a `label`; the retry log says which pool and which index, not the key. |
| `src/llm/gemini.ts`, `src/llm/azureOpenAI.ts`, `src/server/orgLlmConfig.ts` | Bounded error bodies on the response paths (STEP 1b/1c). |
| `src/db.ts` | Shadow divergence line says "at least N field(s)" and names the disk side as the caller's *visible* set, the DB side as deliberately unscoped — it no longer claims population equality it never had (STEP 2a). |
| `src/stages/hybridDiscovery.ts` | Auth outcome carries a thrown-detection error instead of reporting a flat "no gate"; the login-failed line no longer asserts the values were *wrong* (only that a session did not take); an authenticated-but-empty model gets an honest `detail`; the crawl line says "no crawlable links from its hrefs" (STEP 2b/2d). |
| `src/stages/liveExtend.ts` | Near-miss line states `findVerbatim`'s real tolerance (`max(16, half the guess)` chars longer), not "presentation only" (STEP 2e). Predicate unchanged — see TD-115. |
| `src/orchestrator.ts` | `playwrightOutcomeLine()`: PASSED/FAILED × report-parsed/no-report stay four distinct verdicts — exit 0 with no report is "UNVERIFIED", not "passed" (STEP 2c). Also `enterWithRunId(runId)` (STEP 3) and the gated `runUsageLine()` per-run token summary (STEP 4b). |
| `src/runContext.ts` | **New.** The run-id `AsyncLocalStorage` rail: `enterWithRunId`, `currentRunId`, `withRunId`. The fourth ALS rail, matching the pattern of `llmBudget`/`llmContext`/`browserLaunch`. |
| `src/llm/client.ts` | `logLlmCall` emits one gated line per completed call (`llmCallLine`): run id, role, `provider:model`, token counts — the facts L4/L7 found were never logged (STEP 4a). |
| `src/logging.ts` | **New.** `extendedLoggingEnabled()` — the single flag read. |
| `src/server/index.ts` | `withRunId` wraps the editor routes (gate rewrite, case rewrite, translate, steps job) so work off a request still knows its run (STEP 3). `/api/health` `check()` returns `{ set }` only (Q3, D-38). Gated widened `[startup]` block (STEP 4c). `EXTENDED_LOGGING` registered in `BOOLEAN_ENV_FLAGS`. |
| `tests/secretInLog.test.ts` | **New**, 9 tests (STEP 1). |
| `tests/misleadingLogs.test.ts` | **New**, 10 tests (STEP 2). |
| `tests/runContext.test.ts` | **New**, 13 tests (STEP 3 + the Q3 leak tests: concurrent runs never mix ids on a line, and no id survives a finished scope). |
| `tests/extendedLogging.test.ts` | **New**, 14 tests (STEP 4 + Q3). |
| `tests/apiContract.test.ts` | Updated: `/api/health` env entries pin `set` only, not `length` (D-38). |
| `.env.example`, `DECISIONS.md`, `TECH_DEBT.md` | Flag documented; D-37/D-38; TD-115/116/117. |

## 2. HOW TO VERIFY

1. `npx tsc --noEmit` → clean.
2. `npx vitest run tests/secretInLog.test.ts tests/misleadingLogs.test.ts tests/runContext.test.ts tests/extendedLogging.test.ts` → all pass.
3. **Default state (the important one).** With `EXTENDED_LOGGING` unset, run `npm run serve`. The
   startup log is byte-identical to before this phase — the widened block is absent, and the
   original six-var `Environment variable check` line (including its `SET (N chars)`) is untouched.
4. `curl -s http://localhost:3000/api/health` → each entry is `{"set":true|false}` with no `length`.
5. Set `EXTENDED_LOGGING=true` and run once. The startup log gains a `Provider variables
   (EXTENDED_LOGGING)` block (presence only + the resolved provider), each LLM call logs one `[llm]`
   line, and the run ends with one `[llm] … TOTAL … | stages: …` line.
6. Negative controls (mutation testing, fix removed → RED, restored → GREEN): 9/9 STEP 1, 7/7
   STEP 2, 6/6 STEP 3, 9/9 STEP 4+Q3, 3/3 leak/tag. Harnesses under
   `…/Temp/opencode/mutate-*.ps1`.
7. **Credential coverage (Q4, verified not assumed):** a credential typed at the UI prompt is
   delivered to the child as `TEST_USERNAME`/`TEST_PASSWORD` (`settle(…, { …, secret: true })` at
   `index.ts:369`/`:1693` → `credentialEnvVars` → `runSpec`'s `secretEnv`), so `secretCreds` in
   `executor.ts` covers it — the runtime path is the SAME env-var channel as the dev env, not a
   gap. The residual (values Playwright could emit that were never in `secretEnv`) is TD-116.

## 3. WHAT THIS DELIBERATELY DID NOT FIX

- **`findVerbatim`'s slack** — the near-miss predicate still tolerates extra words (TD-115). Only
  the log line was corrected; narrowing the predicate is a behaviour change needing its own
  evidence.
- **Redaction is `secretEnv`-only** — a credential the child could emit that was never in the map is
  not covered (TD-116).
- **Error bodies are size-bounded, not redacted** — a provider echoing request content in an error
  would have its first 200 chars logged (TD-117).
- **The flag is off by default**, so the new provider/token lines do not appear on a default install
  — by design (D-37); the fixes are what a default install gets.

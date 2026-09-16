# Phase — LLM cache hardening

A cached **zero-case** LLM answer was served to every later run: run
`2026-09-16T07-10-56-871Z-2a364a79` made zero LLM calls (`llmUsage.calls: 0`) and reported no test
cases. The disk half of the cache never expires (DECISIONS D-10 / TECH_DEBT TD-22), so whichever
earlier run wrote that `[]` pinned a permanent empty answer for that prompt-key. This phase fixes
the class, not the instance: empty results are never cached, a zero-case generation is a typed
stage failure, and a manual version salt can invalidate the entire store.

Additive, per the platform rules — no route shape changed, no existing behaviour was removed.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/kb/llmCache.ts` | `isCacheableResult(content, {json})` — the "no answer is never an answer worth caching" guard used by every write path; `llmCacheVersion()` (returns `process.env.LLM_CACHE_VERSION ?? "1"`); the belt inside `llmCacheSet` (refuses null/undefined, empty/whitespace string, empty array, `{cases:[]}`, `{}`) so even a forgetful future caller cannot persist a negative. |
| `src/stages/{planner,hybridDiscovery,failureAnalysis,ir}.ts` | `llmCacheVersion()` appended to the cache-key construction; `isCacheableResult(...)` guard before each `llmCacheSet`. |
| `src/stages/testCases.ts` | Same key salt + guard; **`NoTestCasesError`** — thrown (no retry, no cache write) when the parsed case list is empty after scope filtering and the compound-login backstop. Carries provider, resolved model/deployment, and the **full** raw response. |
| `src/stages/liveExtend.ts` | Walk/replay cache key salted with `llmCacheVersion()` too (sixth key site); `isCacheableResult` guard on the walk write. |
| `src/orchestrator.ts` | Catches `NoTestCasesError` around the `testcases` step, persists the **full** raw response to `runs/<id>/03-cases-raw.txt` (the step's `failed` event already carries the plain-English message), then rethrows — the run ends blocked/error, never a clean `no_cases_selected`. |
| `src/stages/caseSelectionGate.ts` | Comment-documented contract: `NoTestCasesError` propagates out of the gate (a zero-case round is never presented or waited on); the `batch.length === 0` path remains distinct (`no_cases_selected` is only for a gate round timing out). |
| `src/server/index.ts`, `tests/apiContract.test.ts` | `/api/health` env block and its contract test gain `LLM_CACHE_VERSION` (set/length only, additive). |
| `.env.example` | `LLM_CACHE_VERSION` documented: default `"1"`, bump to invalidate all cached LLM results. |
| docs | `DECISIONS.md` D-31 (cache-version salt, why negatives are never cached), `TECH_DEBT.md` TD-94 (closes the defect with evidence), this report. |

**Cache-write ordering — answered where it stood:** stage results were **already** written to the
cache **after** schema/structural validation at every site. `isCacheableResult` is the guard layer
that was missing — it rejects *validated-but-empty* output (e.g. `[]` passing
`z.array(LLMTestCase).safeParse`), which the schema checks never could. It was not a reordering.

## 2. NEW FILES / EXPORTS

- `tests/llmCacheGuard.test.ts` — `isCacheableResult` (empty/whitespace, `'[]'`, `'{"cases":[]}'`,
  invalid JSON with `json:true`, valid payloads), `llmCacheVersion` default + env, key difference
  under a version bump, and the `llmCacheSet` belt refusing the same negatives while still
  persisting valid data.
- `tests/orchestratorNoTestCases.test.ts` — `NoTestCasesError` from the `testcases` step writes
  `03-cases-raw.txt` with the full raw response, emits exactly one `(testcases, failed)` event with
  the plain-English message, and rethrows (no `done` event, never `no_cases_selected`).
- New export on `src/stages/testCases.ts`: `NoTestCasesError`.

## 3. NEW ENV FLAGS

**`LLM_CACHE_VERSION`** — default `"1"`. Folded into every cache key (all six `makeCacheKey` sites:
plan, discovery, failure-analysis, test-cases, IR, walk/replay). Setting it to anything new — a
number, a date — invalidates all cached results in one move. Not an off-by-default capability flag
by design (see D-31): its default is its value, which is what makes a bump observable.

## 4. SCHEMA CHANGES

None to routes or artifacts. `03-cases-raw.txt` is a new, failure-only diagnostic file under
`runs/<id>/`; artifact-shaped additions are additive by the standing rules.

## 5. TESTS

`npx vitest run` — **1302 passing on the cleanest full run, 14 new tests, 0 new failures**
(net baseline at the start of this phase: 1287). The one remaining failing test is the
pre-existing `tests/failureDetail.test.ts`; the other baseline pre-existing failure
(`tenancy.test.ts`'s `/api/runs` auth test) is the suite's known parallel-run race in which one
worker's fixture-run-dir create/remove (`multiTenancy.test.ts` materialises `runs/2026-02-01…`)
races another worker's directory listing of `/api/runs` and yields a transient 500 — it rotated
out of the final run entirely, and `tests/apiContract.test.ts` (same mechanism) passes in
isolation. The real-browser environmental suites (missing Chromium executable) are unchanged and
skip/fail for setup reasons outside any phase's control. `npx tsc --noEmit` reports only the
three pre-existing `suiteRunner.ts` errors.

Three new suites (11 guard + 1 orchestrator test cases) plus two added cases in `testCases` and
`caseSelectionGate`. The `strategy.test.ts` mock was changed from returning `"[]"` to one valid
case — the tests there capture the generated prompt, and under the new NoTestCasesError contract
an empty mock answer is a stage failure by design; giving the mock a real answer is what a real
run would have. The `liveExtend` fixtures that construct cache keys were updated to seed the
salted key shape — a one-argument-per-seed change, made only so the existing walk-cache seeds
still match the lookups they were already testing.

## 5b. POST-PHASE DELTA — Azure truncation/refusal and the tolerant envelope

Follow-up on the same class: the "model returned nothing" outcome should be readable at its
source (a provider's finish reason) rather than guessed from a truncated raw dump. Additive, per
the platform rules (rule 1-4: beta shape unchanged, flag-ok unchanged, no new route).

Evidence: run `2026-09-16T09-17-37-827Z-ebda5c90` — testcases on Azure main (gpt-5-mini):
`completionTokens` 538, `reasoningTokens` 512, about 26 visible tokens of JSON, parsed to `[]`.
Two hypotheses, indistinguishable from the artifacts: (A) the output cap truncated the answer
mid-object; (B) the model wrapped the expected array in an envelope.

| File | Why |
|---|---|
| `src/llm/azureOpenAI.ts` | Result now carries `finishReason` (`choices[0].finish_reason`) and `refusal` (`message.refusal ?? null`) additively. `finish_reason === "length"` throws `Azure OpenAI truncated: <first 300 chars>`; a non-empty `refusal` throws `Azure OpenAI refusal: <…>` — checked first, since a model can refuse with `finish_reason: "stop"`. Both are plain `Error`s with no `.status`, so `backoff.ts` (429/503 only) throws them through with zero retries, same contract as the content_filter 400. |
| `src/llm/client.ts` | `llm()` returns `LlmResult = GeminiResult & {finishReason?, refusal?}`; `gemini.ts` is untouched — under gemini both fields are simply `undefined`. |
| `src/llm/json.ts` | New `unwrapArray(value, preferredKeys)`: bare array, preferred-key envelope (`cases`/`testCases`/`test_cases`), or a single-key object whose one value is an array; `undefined` otherwise. |
| `src/stages/testCases.ts` | `NoTestCasesError` gains `finishReason` (set under azure, `undefined` under gemini); the strict `Array.isArray(parsed) ? parsed : parsed.testCases ?? []` is replaced by `unwrapArray(parsed, ["cases","testCases","test_cases"]) ?? []`. |
| `public/app.js` | Verified + pinned by `tests/appJsVerdict.test.ts` (extract-and-evaluate, same as `stepText.test.ts`): the "review round timed out before anything was picked" sentence renders only for `status: "no_cases_selected"` (a real gate timeout); a failed testcases stage always renders its failure message. No behavioural change was needed — the pin made the distinction inseparable from future edits. |

**Array-expecting stages — the report the delta asked for:** of the stages parsing json-mode
output, only `testCases.ts` expects a top-level array. The rest expect objects: `discovery.ts` →
`AppModel`, `planner.ts` → `Plan`, `hybridDiscovery.ts` labeling → `{concepts: string[],
labeledElements: [...]}`, `ir.ts` → `IR`, `failureAnalysis.ts` → `Diagnosis`. `unwrapArray` is
therefore applied exactly once (testCases) and deliberately NOT bolted onto the object-expecting
stages, where it would let a wrong-shaped object bypass their schema checks.

New tests (all offline): `tests/llmJson.test.ts` (every `unwrapArray` shape + bare-array identity),
four `azureOpenAI` cases (truncation, refusal, refusal-beats-length, clean-200 passthrough), a
`testCases` azure end-to-end (`LLM_PROVIDER=azure` + mocked `azureOpenAI` module →
`{"testCases":[…]}` produces real cases; `{"cases":[…]}` and a single-key object too; an empty
envelope throws `NoTestCasesError` carrying `finishReason: "length"`), and the verdict-copy pin.

Verification after this delta: **23 new tests** (11 `llmJson` + 5 `appJsVerdict` + 4 `azureOpenAI`
+ 3 `testCases`), net baseline 1302 → **1325 on the cleanest full run**. The full run here showed
1324 passing because `apiContract`'s `/api/runs` listing hit the known multiTenancy parallel race
(the run's own stderr shows the transient ENOENT on a fixture run-dir); it passes 15/15 in
isolation, same as before any of this work. `failureDetail` and the six real-browser suites remain
the unchanged pre-existing failures. `npx tsc --noEmit` still reports only the three pre-existing
`suiteRunner.ts` errors.

## 6. DELIBERATELY NOT DONE

- **No live LLM/browser verification.** Per the phase instructions this pass stopped before any
  real network call; behaviour is pinned by unit tests via the propagated `NoTestCasesError` and
  the seeded walk cache.
- **The cached `[]` entries already on disk were not weeded individually.** The salt makes them
  unreachable on the next bump-or-write; the natural default (`"1"`) means pre-salt entries can
  still be served to key-identical prompts until some future bump. Costing the trade-off (a bump
  also invalidates all *good* cached answers and forces a re-walk of live pages) was considered
  cheaper than a bespoke database sweep.
- **`LLM_CONTEXT_BRIEFING.md` was not touched**, per the phase constraints — it is regenerated,
  not edited, and its duplicate content would have to catch up with TD-94/D-31 on the next
  regeneration.
- **The delta added no live Azure verification either.** The Azure truncation/refusal and
  envelope paths are pinned by mocked-provider unit tests; confirming them against a real Azure
  call is deliberately left out of this pass (no network) and belongs to whichever phase gets the
  go-ahead to spend real budget.
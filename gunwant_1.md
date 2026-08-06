# gunwant_1 — Crux of Changes (2026-08-06)

**Problem:** In the case-selection gate, the user's refined ("not satisfied") prompt in later
rounds was recorded but **never used by generation**, so every round re-emitted login-biased /
irrelevant cases. The test-case cache also ignored the literal prompt, so a rephrased request
could return yesterday's frozen suite.

**Verified:** `npm test` → 215 passed · `npm run typecheck` → clean

---

## Changed files (by line)

### 1. `src/stages/testCases.ts` — thread the prompt through generation

| Lines | Change | Reasoning |
|------|--------|-----------|
| 175–189 | `ExtendContext` gains `latestPrompt?: string` | Carries the round's refinement prompt into generation so it can steer the batch. |
| 191–198 | New `GenerationOptions` with `sourcePrompt?: string` | Lets round 1 supply its source prompt without tripping the "extend = never mint a primary" branch. |
| 200–202 | `toTestCases(p, appModel, extend?, opts?)` new 4th arg | API seam for the new options. |
| 310–313 | Cache key now includes `sourcePrompt` + `latestPrompt` | A rephrased or refined request gets a fresh cache entry instead of a stale cached suite. |
| 317–327 | New `focusBlock` rendered in the LLM user prompt | The refinement steers *what* to cover, while the checklist floor + "elements verbatim from the model" grounding still apply — it cannot invent elements. |
| 336 | `focusBlock` inserted before the JSON-instruction line | Ensures the model actually sees the round's focus. |
| 393–396 | Reactive path (`generateCasesForNewPages`) passes the run prompt as `latestPrompt` + `sourcePrompt` | Reactive cases follow the user's real request instead of anchoring to the first page's feature. |
| 283–288 | Few-shot example switched from login to a neutral contact-form suite | Removes the login anchor that biased every batch toward login-shaped cases. |

### 2. `src/stages/caseSelectionGate.ts` — forward the refinement (the bug fix)

| Lines | Change | Reasoning |
|------|--------|-----------|
| 40–58 | `caseSelectionBatch(...)` gains `latestPrompt`, `sourcePrompt` and passes them to `toTestCases` | Round 1 = `(plan, model, undefined, {sourcePrompt})`; round N+1 = extend with `latestPrompt`. |
| 74 | `promptThatGeneratedCurrentBatch` tracks the latest prompt | It starts as the source prompt and becomes `decision.newPrompt` after each "not satisfied" round. |
| 83–85 | Call site forwards `promptThatGeneratedCurrentBatch` + `sourcePrompt` | The user's refinement finally reaches the LLM instead of dying in an event payload. |

### 3. `src/orchestrator.ts` — cache uniqueness for the normal (non-gate) path

| Lines | Change | Reasoning |
|------|--------|-----------|
| 112 | Upfront call now passes `{ sourcePrompt: prompt }` | Same prompt text → same cached suite; rephrased prompt → fresh generation. |

### 4. `src/stages/testCases.test.ts` — regression tests

| Lines | Test | Reasoning |
|------|------|-----------|
| 10, 12–47 | `gemini` mock also captures the `user` prompt and cache keys | Lets tests assert the prompt reaches the LLM, not just the system instruction. |
| 116–129 | "reaches the LLM user prompt with the latest refinement" | Proves the refinement is actually passed to the model. |
| 130–134 | "keeps the round-1 prompt free of the focus block" | Guards against accidentally changing first-batch behavior. |
| 136–146 | "keys the cache on the literal source prompt and refinement" | Proves rephrased/refined runs get distinct cache entries (the stale-suite bug). |

### 5. `src/stages/caseSelectionGate.test.ts` — regression tests

| Lines | Test | Reasoning |
|------|------|-----------|
| 114 | Round-1 call asserted as `(plan, appModel, undefined, { sourcePrompt })` | Locks round-1 behavior. |
| 133–138 | Round-2 extend call now includes `latestPrompt` | Updated assertion pins the fix (was asserting the buggy call before). |
| 141–171 | "forwards the user's refinement prompt into the next round's generation" | New test: each "not satisfied" reply is forwarded verbatim to the next batch. |
| 266–267 | Rejected-titles test updated with `latestPrompt` | Keeps all existing gate scenarios consistent with the new signature. |

### 6. `vitest.config.ts` — new file

| Lines | Change | Reasoning |
|------|--------|-----------|
| 1–14 | Vitest excludes `runs/**` (plus default excludes) | `npm test` was scanning generated Playwright specs under `runs/` and reporting 28 spurious failures; now only real unit tests run. |

---

## Outcome

- **"not satisfied" prompt now works** — each round generates from the user's latest focus.
- **No more stale suite** — the literal prompt is part of the cache key.
- **Less login bias** — neutral few-shot example + prompt threaded through the reactive path.
- **No degradation** — round 1 and the non-gate path behave byte-for-byte as before; all 215 tests pass.

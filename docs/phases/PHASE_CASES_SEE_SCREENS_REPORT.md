# Gap 1 — the test-case writer sees the stored screens (TD-137)

From the screen-map handoff's "Still can't do" list (added by the owner on 2026-10-15). It builds on
Phase 2's screen map (D-54).

> **Real site:** owed. The owner re-runs the short prompt locally with `SCREEN_MAP_ENABLED=true`.
> Expect the case-review screen to list each form screen's fields under the right screen, and fewer IR
> calls than run `19-34-46` (8).

**Tests:** `tsc` clean. vitest **2224 passed, 7 failed, 23 skipped** (167 files). The failures are a
subset of the `5196487` baseline's.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/screenMap.ts` | `orderedScreens` (reach order, by following the recorded clicks) and `screensForCases` (the block for the case prompt). The block shows each screen's own controls and the click that opens it, and drops controls repeated on every screen of the same URL. |
| `src/stages/testCases.ts` | On a Salesforce run with the flag on, the ANONYMOUS stored map's block is appended to the user prompt and to the cache key (only when non-empty), and passed to the value repair. |
| `src/stages/requestValues.ts` | The repair prompt and its cache key take the screens block. |
| `tests/screensForCases.test.ts`, `tests/fixtures/screenMap/eoi-map.json` | **New.** The fixture is the real map from run `17-50-49`, with the host and the site's contact details replaced. |
| `TECH_DEBT.md` TD-137 | The defect, the fix, and what is still open. |

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.** It uses `SCREEN_MAP_ENABLED` from Phase 2.

## 3. HOW IT WAS VERIFIED

| Mutation | Caught by |
|---|---|
| Block never put in the case prompt | "the case prompt carries the screens block, in reach order" |
| Screens in stored order, not reach order | "orders the real EOI map … following the recorded clicks" (fed reversed) |
| Page controls shared by every screen kept | "each form screen lists its OWN fields …" |
| Map read under a login instead of anonymous | both toTestCases tests |
| Repair not given the screens | "the value repair gets the screens too" |
| Flag ignored | "no block with the flag off …" |

Pro's `toTestCases` pin (`testCasesNoChange`) passes unchanged.

**A test-isolation bug, found by the first real run.** Run `2026-10-16T05-04-07` showed no screens block,
because these tests' `llmCacheClear("screenmap")` had wiped the server's stored map (TD-138). The four
screen-map / value-repair test files now use a unique `LLM_CACHE_VERSION` per test and clear nothing.
Verified by running them twice with the real map's md5 unchanged.

**Second real run (`2026-10-16T05-34-49`) found two more bugs, both fixed:**
1. **Wrong edges in the map.** The case writer was told form 2 is "opened by clicking Self Use", and
   wrote a four-screen form (Self Use + Next / Buying Timeline + Next / …), so the IR truncated after
   "Self Use, Next". Fixed by `edgeForCapture` (one unambiguous click, never a same-screen edge) and
   map format v2 (v1 maps are dropped). See TD-137.
2. **TD-130's fix never fired** (the orchestrator's handoff has no `status`), so a truncated run whose
   steps all passed still showed "failed". Fixed to read `passed:false` + exit 0. See TD-130.

Because v1 maps are dropped, **the first run after this change rebuilds the map** and its case writer
sees no screens. The second run is the real check.

## 4. HOW TO ROLL BACK

Revert the commit. It reads only the existing map, and it writes nothing new except cache entries.

## 5. DELIBERATELY NOT DONE

- **Logged-in orgs** (TD-137, still open). The credentials are not known at case-generation time.
- **The IR prompt's own screens block is unchanged.** Phase 2 already gives it the stored screens.

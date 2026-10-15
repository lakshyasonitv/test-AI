# Gap 5 — the request's values survive into the primary test case (TD-136)

From the screen-map handoff's "Still can't do" list (added by the owner on 2026-10-15). It is not in the
repo handoff itself. Evidence: run `2026-10-15T18-02-40-894Z-e269fbfa`.

> **Real site, MET (local, run `2026-10-15T19-34-46-890Z-06cc4de5`, the owner's SHORT prompt):** one
> `testcases-values` repair call restored Self Use, Later, The Sanctuary, Abu Dhabi and Office into the case.
> The run **passed all 22 steps**, with every value the request gave and a real `assert "Thank You" visible`.
> The final screenshot shows the Thank You page. It took 8 IR calls, because the repaired case put the
> screen-3 fields on screen 2 and the IR recovered by retrying. That is Gap 1 (the case writer cannot see
> which screen holds which field).

**Tests:** `tsc` clean. vitest **2217 passed, 8 failed, 23 skipped** (166 files). The 8 are the
`5196487` baseline's.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/requestValues.ts` | **New.** `requestValues` (what the request commits the case to), `missingValues`, and `restoreDroppedValues` (one checked, cached repair call per affected `fromPrompt` case). |
| `src/stages/testCases.ts` | `withRequestValues` runs TD-127's name restore, then `restoreDroppedValues`, at both exits (cached and fresh). Salesforce runs only; the prompt and cache key are unchanged. |
| `tests/requestValues.test.ts` | **New.** Extraction from the user's real short request, the exact values run 18-02-40's case dropped, repair accepted / rejected, no call when nothing is missing, the cache, and the toTestCases integration on Salesforce versus ordinary runs. |
| `TECH_DEBT.md` TD-136 | The defect and the fix. |

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.** It is gated on the existing Salesforce run flag. There is a new LLM stage label,
`testcases-values`, and a new cache namespace, `requestvalues`.

## 3. HOW IT WAS VERIFIED

| Mutation | Caught by |
|---|---|
| Repair never wired into toTestCases | "Salesforce run: the returned primary case carries every request value" |
| Repair always accepted | "a repair that loses a value the case had is rejected" |
| No sentence split | the extraction and 4 dependent tests |
| Salesforce gate removed | "ordinary run: one call, the model's case returned as written" |
| Opening verbs kept | the extraction and 5 dependent tests |

Pro's `toTestCases` prompt pin (`testCasesNoChange`) and TD-127's `controlNames` tests pass unchanged.

## 4. HOW TO ROLL BACK

- Revert the commit.
- Optionally clear the `requestvalues` cache namespace.

## 5. DELIBERATELY NOT DONE

- **No re-generation of the whole batch.** Only the `fromPrompt` case is repaired. Other cases are the
  model's own coverage and carry no request values by design.
- **Lower-case unquoted names** are not recognised (TD-127's limit).
- **Values the person did not give** are still chosen by the model (Gap 2: dropdown options).
- **No real-site run yet.** The owner re-runs the short prompt locally.

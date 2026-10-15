# Phase 1b — cap the retry prompt's screens block

Handoff `docs/handoff/HANDOFF_SCREEN_MAP_AND_LOCATORS.md`, Phase 1b ("hardening"). Phase 1
(`98c706b`, TD-122) made a Salesforce **retry** prompt list every screen captured so far, with up to
30 control names each. It capped the names per screen but not the number of screens, and the prompt's
`MAX_CHARS` loop knew nothing about the block. Phase 2 will feed the same block from a stored screen
map, so the block can grow. This phase bounds it, and it pins ordinary runs so Phase 2 cannot leak into
them.

**Tests:** `tsc` clean. vitest **2171 passed, 8 failed, 23 skipped** (158 files). The baseline on
`5196487` was 2167 passed with the **same 8 failures**: `booleanEnvFlags`; `discoveryStrategy` ×3 and
`liveDomDiscovery`, which are Windows or local-Chromium only; and the Pro feature's `appJsProIntake` ×2
and `specRoutes`. So the change is +4 tests, all new.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/ir.ts` | `capturedScreensBlock(model, maxScreens = SCREENS_CAP)` keeps at most `SCREENS_CAP = 8` screens, the **newest**, and returns `{ text, screens }`. In `buildUser`, the `MAX_CHARS` loop first drops the block's oldest screen, one at a time, and only then drops pages. A prompt that started with a block logs `[ir] screens block: N screens, M chars`. |
| `tests/screensBlockCap.test.ts` | **New.** A real-Chromium 10-screen wizard on one URL (9 captured screens). One test checks the cap (screens 3..10 kept, the fix grounds). The other uses long control names and checks the over-budget path: the oldest screens are dropped, no page is, and the newest screen survives. |
| `tests/retryPromptOrdinary.test.ts`, `tests/fixtures/salesforceTarget/retry-prompt-ordinary.json` | **New.** An ordinary run's IR prompts (first attempt + retry), captured from the code **before** this change, asserted byte-for-byte. This covers a run outside any run context and a run with no target app. |
| `TECH_DEBT.md` TD-122 | Notes the cap. |

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.**

## 3. HOW IT WAS VERIFIED

- **Ordinary runs are byte-identical.** The fixture was written while `src/` had no changes
  (`git diff --stat src/` was empty), then asserted after the change.
- **Mutation checks.** Each was applied to `ir.ts`, run, then reverted:

| Mutation | Caught by |
|---|---|
| No cap (`SCREENS_CAP = 99`) | both `screensBlockCap` tests |
| Keep the OLDEST screens instead of the newest | both `screensBlockCap` tests |
| Remove the screen-dropping loop (pages go first) | `screensBlockCap` "over MAX_CHARS" |
| Empty the block (the handoff's own check) | both `screensBlockCap` tests, and `selectOnTextbox` "the retry lists the captured screen's controls" (TD-122) |
| Change one character of the ordinary correction text | `retryPromptOrdinary` |

**Correction to the handoff.** It said emptying the block would make the multi-screen wizard's "skips
Select for EOI" test fail. It does not. `tests/multiScreenWizard.test.ts` passes with the block emptied,
because that flow is rescued by the **rejection message itself**, which lists the screen's controls
(`screenControlsHint`, TD-124). The block is guarded by the tests in the table above instead.

## 4. HOW TO ROLL BACK

Revert the Phase 1b commit. Nothing is stored, and no flag or route was added.

## 5. DELIBERATELY NOT DONE

- **The block can be dropped to zero screens under size pressure.** The handoff asks for screens to go
  before pages, and that is implemented literally. In practice `toMicroModel` sends one page, so this
  needs a very large retry prompt.
- **The cap counts screens, not characters.** A single screen is already bounded by 30 names.
- **No real-site run.** This phase only bounds a prompt section, and the gate is tests. Phase 2's
  real-site check runs with this code in place.

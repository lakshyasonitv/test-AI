# Phase 1c — progress-aware retries and an honest status for truncated runs

These are two fixes the owner added to the screen-map handoff (`docs/handoff/HANDOFF_SCREEN_MAP_AND_LOCATORS.md`)
after dissecting two runs on a Salesforce Experience site:
- `2026-10-15T08-19-57-584Z-8c381468` (detailed prompt);
- `2026-10-15T16-39-13-396Z-43d0d427` (minimal prompt).

They are not in the repo handoff itself.

**Tests:** `tsc` clean. vitest **2179 passed, 8 failed, 23 skipped** (160 files). The 8 are the same
pre-existing failures as the `5196487` baseline (`booleanEnvFlags`; `discoveryStrategy` ×3 and
`liveDomDiscovery`, Windows or local Chromium only; and the Pro feature's `appJsProIntake` ×2 and
`specRoutes`). Phase 1b ended at 2171, so this phase adds +8, all new.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/ir.ts` | **Fix A (TD-74 amended).** On a Salesforce run, a target rejected a second time stops the retries only if it was never grounded in any attempt's prefix and this attempt got no further than when it was last rejected. "Further" counts grounded steps other than waits and asserts. Ordinary runs keep the old rule. |
| `src/stages/suiteRunner.ts` | **Fix B (TD-130).** `primaryCaseStatus` handles the reused primary case. The orchestrator's truncated-without-assertion override (`passed: false`) is undone only when Playwright's exit code says the steps passed. The status then becomes `truncated_no_assertion` instead of `failed`. `orchestrator.ts` is untouched. |
| `tests/repeatRejectionProgress.test.ts` | **New.** A real-Chromium two-screen form with scripted attempts. It covers: retry when the target was grounded before; retry when the attempt got further; stop when nothing changed; and the old rule kept on an ordinary run. |
| `tests/primaryCaseStatus.test.ts` | **New.** The status ladder for the reused primary case. |
| `TECH_DEBT.md` | TD-74 amendment, plus TD-130. |

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.**

## 3. HOW IT WAS VERIFIED

| Mutation | Caught by |
|---|---|
| Fix A removed entirely (the Phase 1b `ir.ts`) | "grounded in an earlier attempt", "got further" |
| Only the "grounded before" exemption removed | "grounded in an earlier attempt" |
| Only the "got further" exemption removed | "got further" |
| Waits counted as progress | "still stops when … nothing got further" (run 16-39-13's shape) |
| Exemptions applied to every run (Salesforce gate removed) | "an ordinary run keeps the old rule" |
| Fix B: the override never undone | "an override whose steps all passed is truncated_no_assertion" |
| Fix B: exit code ignored (always pass) | "a real Playwright failure on a truncated IR is still failed" |

The ordinary-run test was checked with **and without** the change: it passes on both, which is what
"unchanged" means.

**A correction to the owner, recorded here.** Fix A would **not** have rescued run 16-39-13. There the
model repeated "Full Name" after the same grounded steps plus one wait, so stopping was correct. Fix A
targets runs like 08-19-57, where a target was rejected, then grounded, then rejected again.

## 4. HOW TO ROLL BACK

Revert the Phase 1c commit. Nothing is stored, and no flag or route was added.

## 5. DELIBERATELY NOT DONE

- **Ordinary runs keep the original TD-74.** The new rule is sound for any site, but the handoff
  requires every change in this stream to be gated on Salesforce runs.
- **The status fix applies to all sites.** It corrects a wrong label, not a capability.
- **The orchestrator's own run verdict is unchanged** (`orchestrator.ts` is off limits). Only the case
  card's status was wrong.
- **No real-site run in this phase's gate.** The owner re-runs the minimal and short prompts locally.

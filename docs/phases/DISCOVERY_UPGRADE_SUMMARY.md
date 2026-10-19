# Discovery upgrade — final summary (Phases 1–5 built and measured, Phase 6 planned)

Date: 2026-10-18 → 2026-10-19. Branch `shadowdom`, on top of `b12013f`. **Committed locally on `shadowdom`, NOT
pushed** (the user asked for the split below after review). A checkpoint of every change is in
`testbench\phase-checkpoints\` (outside the repo).

## Commits (on `shadowdom`, not pushed)

Staged file by file, never `git add -A`. A file that spans phases was committed as an intermediate version in the
earlier commit and completed in the later one. Each commit type-checks on its own (checked in a clean worktree).

1. `adf2097` **fix(security): TD-154 / TD-156.** `runSecrets.ts` (new), `runStore.ts`, `runRegistry.ts`,
   `pendingCredentials.ts`, `credentials.ts`, `kb/llmCache.ts`, `kb/cache.ts` (cache half), `orchestrator.ts`
   (prompt creds + save scrub); tests `eventCredentialScrub`, `literalCredentialFill`, `llmCacheCredentials`.
2. `fe56e44` **feat: Phase 1, network settle + the TD-158 reveal-check follow-up.** `networkSettle.ts` (new),
   `domDiscovery.ts`, `liveExtend.ts`, `hybridDiscovery.ts`, `ir.ts`, `index.ts` (one flag line); tests
   `networkSettle`, `irRevealVisibility`.
3. `766c8a0` **fix: Phase 2, TD-135.** `targetResolver.ts`, `generator.ts`; test `hiddenDialogScope`.
4. `cda6222` **feat: Phase 3, best-match merge.** `screens.ts`, `screenMap.ts`, `index.ts`; test `screenBestMatch`.
5. `339034a` **feat: Phase 4, volatile ids (stable ids as a fallback).** `volatileIds.ts` (new),
   `liveDomDiscovery.ts`, `liveExtend.ts`, `domDiscovery.ts`, `hybridDiscovery.ts`, `kb/cache.ts`, `index.ts`;
   test `volatileIds`.
6. `6a4b23b` **feat: Phase 5, safe explorer (with the Screen Flow / Lightning-app rules).** `buttonExplorer.ts`
   (new), `orchestrator.ts`, `ir.ts`, `index.ts`; test `buttonExplorer`.
7. (this commit) **docs:** README, DECISIONS D-56..D-60, TECH_DEBT TD-154..161, the phase reports,
   `PLAN_RECORD_ONCE.md` (Phase 6, plan only), this summary.

## Flags (all default OFF; flag off = the old behaviour and cache keys)

| Flag | Phase | Turn on |
|---|---|---|
| `NETWORK_SETTLE_ENABLED` | 1 (+ the TD-158 reveal-check follow-up) | `NETWORK_SETTLE_ENABLED=true` in `.env`, restart. **It also changes GROUNDING** (the post-click reveal check in `ir.ts`), not only waiting |
| — (no flag) | 2, TD-135 | always on |
| `SCREEN_BEST_MATCH_ENABLED` | 3 | `=true` |
| `VOLATILE_ID_DETECTION_ENABLED` | 4 | `=true` |
| `BUTTON_EXPLORER_ENABLED` | 5 | `=true`; tune `EXPLORER_MAX_CLICKS` (15) and `EXPLORER_BUDGET_MS` (120000) |

The local `.env` currently has all four boolean flags ON (cumulative, per the plan) plus `DISCOVERY_LIVE_DOM=true`.
**Lines appended to `BOOLEAN_ENV_FLAGS` in `src/server/index.ts` (tell Yashika):** `NETWORK_SETTLE_ENABLED`,
`SCREEN_BEST_MATCH_ENABLED`, `VOLATILE_ID_DETECTION_ENABLED`, `BUTTON_EXPLORER_ENABLED`. Nothing else in that file.
**Garvit's files:** `hybridDiscovery.ts` (tracker at page creation; `#settled` / `#vid` key parts) and `ir.ts`
(the TD-158 reveal-check fix; the `SCREEN_CONTROL_ROLES` export).

## Unit tests

| | tsc | passed / failed / skipped | files |
|---|---|---|---|
| Before (`b12013f`, untouched) | clean | 2279 / 8 / 23 | 169 |
| After the TD-154/156 event fix (Session 77) | clean | 2286 / 8 / 23 | 171 |
| After Phases 1–5 (Session 79) | clean | 2329 / 7 / 23 | 177 |
| **After the review fixes** (TD-156 cache, Phase 4 fallback, Phase 5 flow safety) | clean | **2335 / 8 / 23** | 178 |

Why the numbers moved:
- **2279 vs 2286:** 2279 is the untouched commit, and 2286 is after the first leak fix (+7 tests). Both are
  correct, at different points; the earlier report quoted the second.
- **8 vs 7 failures:** the same 7 fail every time, and `specRoutes` test 15 is the 8th, on some runs only. It is
  a cross-file race: another test file writes `runs/_cache/walks` during its upload window. It passes on its own
  (20/20) and in a clean worktree.

**The 7 that always fail** (each fails identically on a clean `b12013f` worktree):
1. `booleanEnvFlags` › has no reader for any reserved flag yet: `DISCOVERY_LIVE_DOM`, `SALESFORCE_ENABLED` are
   read but still listed as reserved (red on `main`).
2. `discoveryStrategy` › elementStrategy reads DISCOVERY_LIVE_DOM… › is read in exactly ONE place: splits paths on
   `/src/` (Windows-only).
3. `discoveryStrategy` › FLAG OFF: byte-identical… › shadowAndFrame, flag unset: the local Chromium serialises the
   fixture's `srcdoc` differently.
4. `discoveryStrategy` › FLAG OFF: byte-identical… › shadowAndFrame, flag explicitly false: the same.
5. `liveDomDiscovery` › TD-40 › runs under real tsx…: `node_modules/.bin/tsx` cannot be spawned on Windows.
6. `appJsProIntake` › is found (the guard below is not vacuous): Pro feature, off limits.
7. `appJsProIntake` › never toggles .hidden and never calls showView: Pro feature, off limits.

## Baseline vs final (the same request, word for word, cold caches)

There are two "before" samples, because one is not enough: the baseline AND Phase 1's flag-OFF round. That round ran
code equivalent to the baseline and behaved very differently on Salesforce.

| Metric | SF baseline | SF P1-OFF | **SF final (P5)** | Sauce baseline | Sauce P1-OFF | **Sauce final** | Demo baseline | Demo P1-OFF | **Demo final** |
|---|---|---|---|---|---|---|---|---|---|
| Primary | fail (wrong path) | pass* | pass* | pass | pass | pass | pass | pass | pass |
| Cases gen / pass / fail | 4/3/1 | 4/3/1 | **4/4/0** | 4/3/1 | 4/4/0 | 4/3/0 +1t | 4/2/2 | 4/2/2 | 4/3/1 |
| Grounding rejections | 1 | 6 | **0** | 1 | 2 | 1 | 1 | 3 | 1 |
| IR calls | 10 | 20 | **10** | 10 | 14 | 12 | 12 | 20 | 10 |
| LLM calls / tokens | 15 / 85k | 25 / 169k | **14 / 99k** | 16 / 76k | 20 / 98k | 18 / 87k | 19 / 122k | 29 / 172k | 17 / 113k |
| Locators on numbered ids | 0/41 | 0/48 | 6/37 | 0/45 | 0/44 | 0/43 | 0/37 | 0/45 | 0/36 |
| Duration (min) | 6.9 | 13.5 | **6.4** | 6.4 | 4.6 | 5.3 | 7.7 | 10.4 | 8.2 |

\* Both SF "passes" end by asserting a line of form text after Next, NOT a submitted confirmation. The baseline
failed outright: it took "Book a Viewing" and invented an assertion.

### Final vs the BASELINE (the honest headline)

| Site | LLM tokens | LLM calls | Grounding rejections | Primary |
|---|---|---|---|---|
| Salesforce | 85k → 99k (**+16%**) | 15 → 14 (−1) | 1 → 0 | fail → pass (still does not submit) |
| SauceDemo | 76k → 87k (**+14%**) | 16 → 18 (+2) | 1 → 1 | pass → pass |
| Demoblaze | 122k → 113k (−7%) | 19 → 17 (−2) | 1 → 1 | pass → pass |

Against the baseline, the upgrade costs slightly MORE tokens on two of three sites, and has about the same call and
rejection counts. The Salesforce baseline was cheap because it took a wrong, short path and failed. The big SF
savings (0 rejections, 10 IR calls, 99k tokens) are relative to P1-OFF, which ran equivalent code to the baseline
and took the long right path.

### The net result, honestly

- **Pass/fail: no better than P1-OFF on any site.** P1-OFF also passed all three primaries from cold.
- **Salesforce:** the real gain is HOW the primary gets there. The explorer gives discovery the project page, so the
  run goes straight to View Project:
  - versus P1-OFF: 0 rejections vs 6, 10 IR calls vs 20, 99k tokens vs 169k, 6.4 min vs 13.5;
  - versus the baseline the cost is about the same (85k → 99k tokens), because the baseline took a cheap wrong path.
  - The SF primary still never submits.
- **Demoblaze: net zero.** Phase 1's settle CAUSED the hidden-field failure (5 of 5 runs with the settle on). The
  TD-158 reveal-check follow-up repairs that regression; it is not a gain over the baseline.
- **SauceDemo:** no change.
- **Security:** the password stopped appearing in run folders after the TD-154/156 fix (0 hits in every later run).
- One run per site per setting, so a small effect cannot be told apart from model variance.

The per-run ledger is `project-brain/topics/discovery-upgrade-performance.md`; the per-phase reports are
`docs/phases/PHASE_*`.

## Found but not fixed

| Id | What | Severity |
|---|---|---|
| — | The SF primary "passes" without submitting: no check that the final assertion sits on a finished screen (a "Next" and unfilled fields remain). Structural fix wanted, never the "step 2 of 3" text | High |
| — | No check that every case step is represented in the IR (the baseline's skipped EOI steps) | Medium |
| TD-134 | Retained traces may hold credentials; untestable while TD-155 holds | High / unverified |
| TD-155 | Retained `trace.zip` files are truncated (no central directory, no `trace.trace`); seen on every failed case checked | Low |
| ~~TD-156 (rest)~~ | **Fixed in review:** every cache body and key input now gets the run's credentials as `${env:...}` references (`cacheSafe`); a test failed 3/4 before; 0 password hits in all of `testbench/` except `.env` | Fixed |
| TD-157 | A model-written `nth` past the real duplicates ships and times out | Medium |
| TD-158 (rest) | A hidden target in a step that is not the first fill after a click is still accepted | Medium |
| TD-159 | Replays move on right after a click, so a request it started can be aborted (empty cart) | Low |
| TD-160 | `firstUnique`'s `:visible` narrowing is a no-op (latent; a later rung compensates) | Low |
| TD-161 | A truncated best attempt can ship a vacuous assertion, and the generator then errors the whole run | Medium |
| — | Phase 4 trusts a pattern-looking Lightning id after 2 identical sightings; render-order changes could shift it. **Reduced in review:** a stable id is now only a fallback, after role/label locators (live counts above predate this; no live re-run) | Risk (reduced) |
| — | **Before enabling the explorer on a real Lightning ORG:** "Next" is on the allow list, and the network guard blocks only non-GET NAVIGATIONS. Aura writes data through POST XHR, so a Screen Flow that commits records between screens would not be stopped: only the name lists stand in the way, and "Next" passes them. Tested only on Experience Cloud (LS-7 open). **Mitigated in review:** no control inside `lightning-flow` / `flowruntime-*` (through shadow roots) is ever clicked, "Next"/"Finish" are denied on Lightning-app URLs, and the README says the explorer must stay OFF against production orgs (Chromium test: 0 flow clicks counted by the server) | Risk (mitigated) |
| — | With `TEST_USERNAME`/`TEST_PASSWORD` set globally, `store.read` stringifies and parses each run's whole event log on every `/state` poll and every `/api/runs` listing (the TD-154 scrub) | Perf |
| — | Phase 3's effect is not measurable from the logs: log which screen a capture replaced and its overlap | Measurement gap |
| — | Unexplained: Demoblaze settle logs once reported 138 and once 388 long-lived requests ignored | Unknown |

## Operational notes

- **Live runs: 26 started against 24 approved.** The extras are the SauceDemo proof run the user asked for after the
  leak fix, and one re-run of a Demoblaze attempt that died in 6 s because no browser could launch.
- **The local `.env` still has every experimental flag ON**, and the server is stopped. The next local start runs
  with all of them on. To go back to defaults, delete these lines: `NETWORK_SETTLE_ENABLED=true`,
  `SCREEN_BEST_MATCH_ENABLED=true`, `VOLATILE_ID_DETECTION_ENABLED=true`, `BUTTON_EXPLORER_ENABLED=true`, and
  `DISCOVERY_LIVE_DOM=true` if live-DOM discovery should be off too.

- The machine ran low on memory twice (the user's Chrome, IDE and Ollama use most of 16 GB). The system stopped the
  server's shell once, and a stranded server could not launch browsers. One run was lost to that and re-run.
- Cache backups for every round are in `testbench\cache-backups\`; server logs in `testbench\server-logs\`;
  `driver.mjs` and `metrics.mjs` in `testbench\upgrade-tools\`.

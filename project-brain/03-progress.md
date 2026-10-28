# Progress — where we are

*Last updated: 2026-10-28, run insights (D-61) ported to `main`. See `journal/2026-10-28.md`.*

## 2026-10-28 — on `main`'s line

- Branch `vaibhav/intelligent-edison-l6061z` = `main` (`1fb9dcb`) + the D-61 port: `[insight]` lines and
  `runs/<id>/10-insights.json` behind `EXTENDED_LOGGING` (default off). No pull request yet.
- **Gap:** this brain does not record `main`'s own work from 2026-10-18 to 2026-10-28 (discovery
  Phases 1–5, TD-154/156, TD-162, Salesforce OAuth D-63, TD-169). Read `DECISIONS.md`/`TECH_DEBT.md`.
- **Baseline on this branch:** `tsc` clean; `vitest` 2663 passed / 2 failed / 23 skipped, 199 files
  (with the browser symlink workaround below, now `-1148 -> -1243`). Same 2 pre-existing failures.
- `vaibhav/determined-dijkstra-0t2ec9` has diverged from `main`: 9 conflicting files and clashing
  D-/TD- numbers. D-61 is the one record that now means the same thing on both.

*The sections below are from 2026-10-13 and describe `vaibhav/determined-dijkstra-0t2ec9`.*

## Branch and commits

`vaibhav/determined-dijkstra-0t2ec9`, pushed to origin (plus the commit that added this folder). No pull request yet. On top of `097554f`:

| Commit | What |
|---|---|
| `6bd6380` | Stage 0 — fixture pinning `toTestCases`' prompt and cache key (proof of no change) |
| `49652fa` | Stage 1 — `SpecModel` schema, upload validation, mammoth 1.13.0 |
| `d3efa58` | Stage 2 — distillation (one Gemini call) and its cache |
| `96687eb` | Stage 3 — `/api/spec/*` routes, `SPEC_INTAKE_ENABLED`, `options.spec` on runs |
| `2ba5611` | Stage 4 — `proTestCases.ts`, router, gate injection, spec comparison |
| `6a8e455` | Stage 5 — UI (toggle, questions screen, warnings panel), D-53, TD-110 note |

## Shipped (behind a flag, default OFF)

**Pro document intake** — `SPEC_INTAKE_ENABLED`. Design and rationale: `DECISIONS.md` D-53. Files:
`ARCHITECTURE.md` (search "Pro"). With the flag off, the server and UI behave exactly as before;
`tests/testCasesNoChange.test.ts` proves the standard generator's prompt and cache key are unchanged.
`app.yaml` has `SPEC_INTAKE_ENABLED=false`. Not deployed.

## Verification baseline

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **2143 passed, 2 failed, 23 skipped, 153 files** (before this session: 2027
  passed, 142 files).
- The 2 failures pre-date this work: `booleanEnvFlags` ("has no reader for any reserved flag yet" —
  `DISCOVERY_LIVE_DOM` and `SALESFORCE_ENABLED` now have readers but are still in its RESERVED list)
  and `safeClickBrowser` ("still navigates a REAL href").
- **Cloud-container caveat:** Playwright 1.49 expects `chromium_headless_shell-1148`; the container
  has `-1194`. Without a workaround ~21 browser tests fail with "Executable doesn't exist". The
  baseline above was measured with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch directory of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`).
- `tests/tenancy.test.ts` + `tests/multiTenancy.test.ts` run as a pair fail ~1 in 6 (TD-110).

## Not yet done

See `04-tasks.md`.

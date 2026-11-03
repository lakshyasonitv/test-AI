# docs/archive — history, not documentation of the current code

Everything here is kept for its reasoning and evidence. None of it describes how the app works
today, and nothing new should be filed into it: defects go to `TECH_DEBT.md`, reasons to
`DECISIONS.md`, the file map to `ARCHITECTURE.md`.

Moved here on 2026-11-02 (repo clean-up). Older documents (phase reports, journal entries) still
quote the old paths in the left column.

| File here | Used to be | What it is |
|---|---|---|
| `PROJECT_OVERVIEW.md` | `PROJECT_OVERVIEW.md` | An early walkthrough of the project. `README.md` and `ARCHITECTURE.md` replace it. |
| `problems.md` | `problems.md` | A dated audit of run failures. Code comments still cite its section names. |
| `FINDINGS_2026-09-28.md` | `docs/FINDINGS_2026-09-28.md` | Dated findings; cited by comments in `browserLaunch.ts` and `liveExtend.ts`. |
| `RESEARCH_2026-09-25.md` | `docs/RESEARCH_2026-09-25.md` | Dated research notes behind those findings. |
| `PLAN_QA_ITEMS_4-5-7-8.md` | `docs/PLAN_QA_ITEMS_4-5-7-8.md` | A dated plan for four QA items. |
| `Observations.docx` | `Observations.docx` | QA observations the plan above was built from. |
| `LAMBDA_MIGRATION.md` | `docs/LAMBDA_MIGRATION.md` | A plan to run on AWS Lambda. Never carried out; the app runs on Azure Container Apps. |
| `testbench-ui-export.html` | `Testbench (1).html` | A self-contained bundled HTML page (titled "Bundled Page") committed with early work. Nothing in the app uses it. |
| `site-store-view/` | `SITE_STORE_VIEW_SPEC_v2.md`, `scripts/measureView.ts`, `tests/measureView.test.ts` | A spec for work that was **never built** (its gate failed, `TECH_DEBT.md` TD-56), with its offline measurement script and that script's test. The test no longer runs in CI. |
| `scripts/generateRunBackfill.ts` | `scripts/generateRunBackfill.ts` | A one-off database backfill from Phase 3, already applied. |

The two scripts' imports were updated for their new folders, so `npx tsx <path>` still runs them.
`measureView.ts` also needs `gpt-tokenizer`, removed from `package.json` when it was archived: run
`npm i -D gpt-tokenizer` first.

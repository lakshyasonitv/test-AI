-- A saved case must always be able to show its Playwright script.
--
-- Before this, the .spec.ts existed ONLY inside the originating run's artifact folder under
-- runs/<runId>/. Deleting that run (DELETE /api/runs/:runId does rmSync, or retention, or simply
-- cloning the repo on another machine) left every saved case showing "No script yet" while still
-- reporting "Passed v1". See TECH_DEBT.md TD-68.
--
-- Nullable and NOT backfilled on purpose: generateSpec(ir) is pure, deterministic and instant
-- (DECISIONS.md D-06), so a null here is regenerated on read. Backfilling would write a spec
-- derived from today's generator against versions authored by an older one, quietly replacing
-- history with a re-derivation.
alter table public.test_case_versions
  add column if not exists spec text;

comment on column public.test_case_versions.spec is
  'Playwright spec generated from this version''s ir at save time. Nullable: pre-existing rows and any row written while the column was absent fall back to regenerating from ir on read.';

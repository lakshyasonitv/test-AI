-- Which saved cases each run executed.
--
-- A JOIN TABLE, not a `runs.case_id` column. A suite replay runs several cases under one run id,
-- so a single column could only ever be correct for single-case replays -- and since most replays
-- ARE suite replays, a case's own run history would sit empty forever, which is the one thing the
-- "Runs & versions" tab exists to show. Per-case rows answer it for both shapes, and carry the
-- per-case verdict a single column could not.
create table if not exists run_cases (
  run_id       text not null references runs(id) on delete cascade,
  test_case_id uuid not null references test_cases(id) on delete cascade,
  -- Position within that run, so a row maps back to its runs/<id>/cases/case-N/ artifacts.
  case_index   int  not null,
  status       text,
  created_at   timestamptz not null default now(),
  primary key (run_id, test_case_id)
);

-- The access path for the tab: this case's runs, newest first.
create index if not exists run_cases_case_recent_idx
  on run_cases (test_case_id, created_at desc);

alter table run_cases enable row level security;

-- Mirrors the other eight exactly: SELECT to `authenticated` only, scoped through the case's
-- project to the caller's organisations. There is deliberately NO policy for `anon` -- that
-- absence is what makes the browser-facing publishable key return [].
drop policy if exists "members read their run cases" on run_cases;
create policy "members read their run cases" on run_cases
  for select to authenticated
  using (
    test_case_id in (
      select tc.id
        from test_cases tc
        join projects p on p.id = tc.project_id
       where p.organisation_id in (select private.user_org_ids())
    )
  );

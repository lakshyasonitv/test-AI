-- Step 5.2/5.3/5.5: the test-case library.
--
-- Everything hangs off project_id, so the project-visibility axis built in Step 5.1 governs the
-- library too. No second access mechanism is introduced: a case is visible exactly when its
-- project is.

create table if not exists suites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  created_by uuid,
  created_at timestamptz default now()
);
create index if not exists suites_project_idx on suites (project_id);

create table if not exists test_cases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  feature text,
  ir jsonb not null,                       -- validated against src/schema/ir.ts on every write
  current_version int not null default 1,
  source_run_id text,
  assigned_to uuid,
  last_run_status text,
  last_run_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by uuid
);
create index if not exists test_cases_project_idx on test_cases (project_id);

create table if not exists test_case_versions (
  id uuid primary key default gen_random_uuid(),
  test_case_id uuid not null references test_cases(id) on delete cascade,
  version int not null,
  ir jsonb not null,
  change_note text,
  saved_by uuid,
  saved_at timestamptz default now(),
  unique (test_case_id, version)
);
create index if not exists test_case_versions_case_idx on test_case_versions (test_case_id);

-- Deliberately a join table, not a suite_id column on test_cases: one case belongs in several
-- suites (a login case is both "Smoke" and "Auth"), and modelling that as one-to-many is painful
-- to undo once real data exists.
create table if not exists suite_cases (
  suite_id uuid references suites(id) on delete cascade,
  test_case_id uuid references test_cases(id) on delete cascade,
  position int not null default 0,
  primary key (suite_id, test_case_id)
);
create index if not exists suite_cases_case_idx on suite_cases (test_case_id);

-- RLS, mirroring the five existing tables exactly: enabled, with a SELECT grant to `authenticated`
-- only, scoped through the project -> organisation chain. There is no policy for `anon`, which is
-- what makes the browser-facing publishable key return [] — the invariant this project treats as
-- non-negotiable, since run history would otherwise be world-readable.
alter table suites enable row level security;
alter table test_cases enable row level security;
alter table test_case_versions enable row level security;
alter table suite_cases enable row level security;

create policy "members read their suites" on suites for select to authenticated
  using (project_id in (select p.id from projects p
                         where p.organisation_id in (select private.user_org_ids())));

create policy "members read their cases" on test_cases for select to authenticated
  using (project_id in (select p.id from projects p
                         where p.organisation_id in (select private.user_org_ids())));

create policy "members read their case versions" on test_case_versions for select to authenticated
  using (test_case_id in (select c.id from test_cases c
                           join projects p on p.id = c.project_id
                          where p.organisation_id in (select private.user_org_ids())));

create policy "members read their suite membership" on suite_cases for select to authenticated
  using (suite_id in (select s.id from suites s
                       join projects p on p.id = s.project_id
                      where p.organisation_id in (select private.user_org_ids())));

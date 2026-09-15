-- Foreign keys from every user_id column into auth.users (audit finding S-1).
--
-- THE PROBLEM. Seven columns hold a user id and not one of them referenced `auth.users`. Deleting
-- an account left its rows behind — including `organisation_members`, where an orphan row goes on
-- granting a role to an identity nobody can authenticate as.
--
-- DELETE BEHAVIOUR IS NOT UNIFORM, AND SHOULD NOT BE. Two kinds of column are involved:
--
--   * A PERMISSION GRANT — `organisation_members.user_id`, `project_members.user_id`. These exist
--     only to say what an account may do. Once the account is gone the row is meaningless at best
--     and a live grant to a ghost at worst, so: ON DELETE CASCADE.
--
--   * AN ATTRIBUTION — `runs.started_by`, `suites.created_by`, `test_cases.assigned_to` and
--     `.updated_by`, `test_case_versions.saved_by`. These record who did something. The run, the
--     case and the version are the evidence this product exists to produce, and losing a case's
--     entire version history because its author left would be far worse than losing a name, so:
--     ON DELETE SET NULL. Every one of these columns is already nullable, so this needs no
--     schema change beyond the constraint.
--
-- TWO CONSTRAINTS ARE ADDED `NOT VALID`, AND THAT IS THE POINT.
--
-- This database already contains orphan rows, reported before this migration was written:
--
--     organisation_members.user_id   00000000-0000-4000-8000-000000000001      1 row
--     runs.started_by                00000000-0000-4000-8000-000000000001     53 rows
--     runs.started_by                3c779be0-fe43-4eec-a928-19ff3ddd389d      1 row
--
-- The first two are `LOCAL_USER_ID` from src/server/auth.ts — the synthetic identity used when
-- AUTH_ENABLED is off. It is deliberately not an `auth.users` row and never was. The third is a
-- genuinely deleted account.
--
-- A plain `add constraint` would scan those rows and fail, so the only ways to apply it would be to
-- delete or NULL data first. `NOT VALID` is the third way: the constraint is enforced on every
-- INSERT and UPDATE from this moment on, and only the initial full-table check is skipped. New
-- orphans become impossible immediately; the existing three are left exactly as they are, for a
-- human to decide about.
--
-- That decision is written up as a separate, non-migration script — supabase/manual/
-- 0001_resolve_user_id_orphans.sql — precisely so `supabase db push` cannot silently delete or
-- rewrite anybody's data. Run it deliberately or not at all. It ends with the `validate constraint`
-- statements that finish the job.

-- ---------------------------------------------------------------------------
-- Permission grants — cascade
-- ---------------------------------------------------------------------------

-- NOT VALID: one orphan row (the synthetic local owner). See the header.
alter table public.organisation_members
  add constraint organisation_members_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade
  not valid;

-- Clean today, so validated immediately.
alter table public.project_members
  add constraint project_members_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Attribution — set null
-- ---------------------------------------------------------------------------

-- NOT VALID: 54 orphan rows. See the header.
alter table public.runs
  add constraint runs_started_by_fkey
  foreign key (started_by) references auth.users (id) on delete set null
  not valid;

alter table public.suites
  add constraint suites_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table public.test_cases
  add constraint test_cases_assigned_to_fkey
  foreign key (assigned_to) references auth.users (id) on delete set null;

alter table public.test_cases
  add constraint test_cases_updated_by_fkey
  foreign key (updated_by) references auth.users (id) on delete set null;

alter table public.test_case_versions
  add constraint test_case_versions_saved_by_fkey
  foreign key (saved_by) references auth.users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Indexes on the referencing columns.
--
-- Postgres does not index a foreign key's referencing side automatically, and every one of these
-- constraints has a referential action — so deleting one account makes Postgres look for
-- referencing rows in all seven columns. Without these that is seven sequential scans, one of them
-- over the runs table.
-- ---------------------------------------------------------------------------

create index if not exists runs_started_by_idx on public.runs (started_by);
create index if not exists suites_created_by_idx on public.suites (created_by);
create index if not exists test_cases_assigned_to_idx on public.test_cases (assigned_to);
create index if not exists test_cases_updated_by_idx on public.test_cases (updated_by);
create index if not exists test_case_versions_saved_by_idx on public.test_case_versions (saved_by);
-- organisation_members (user_id) and project_members (user_id) are already indexed —
-- the previous migration adds the former, and project_members_user_id_idx already exists.

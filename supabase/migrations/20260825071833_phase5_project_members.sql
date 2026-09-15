-- Project membership: what a user may SEE.
--
-- Deliberately has no per-project role column. The organisation role already answers "what may
-- they do" (viewer/tester/admin/owner); duplicating it here would create two sources of truth for
-- the same question and guarantee they drift. This table answers only "which projects are visible
-- to this person", and admins/owners bypass it entirely by role.
create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz default now(),
  primary key (project_id, user_id)
);

-- Every lookup is "which projects can this user see", so user_id leads.
create index if not exists project_members_user_id_idx on project_members (user_id);

alter table project_members enable row level security;

-- Same shape as the other four tables: a SELECT-only grant to `authenticated`, scoped through
-- private.user_org_ids(). No policy exists for `anon`, which is what keeps the publishable key —
-- the one that ships to every browser — seeing nothing at all.
drop policy if exists "members read their project memberships" on project_members;
create policy "members read their project memberships"
  on project_members for select to authenticated
  using (
    project_id in (
      select p.id from projects p
      where p.organisation_id in (select private.user_org_ids())
    )
  );

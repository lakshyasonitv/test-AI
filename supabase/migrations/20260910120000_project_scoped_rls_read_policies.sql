-- Project-scoped RLS read policies (audit finding R-1).
--
-- THE PROBLEM. Every read policy on this database stopped at `organisation_id IN your orgs`. Not
-- one of them consulted `project_members`. The application, meanwhile, gates every read through
-- `visibleProjectIds()` in src/server/authz.ts — admins and owners see every project in their
-- organisation, everyone else sees only the projects they have been assigned to.
--
-- So the project boundary existed in application code and nowhere else. `GET /api/auth/config`
-- hands the publishable key to any browser by design, so a signed-in viewer assigned to zero
-- projects could take their own JWT and that key straight to PostgREST:
--
--     GET {SUPABASE_URL}/rest/v1/test_cases?select=*
--     GET {SUPABASE_URL}/rest/v1/test_case_versions?select=ir
--
-- and read every case and every stored IR in the organisation — steps, selectors, target URLs and
-- `${env:...}` credential references — including projects they were never added to. The server
-- holds the service-role key and bypasses RLS entirely, so RLS is not a second check on the API
-- path; it is the ONLY check on the direct-PostgREST path, and it was the weaker of the two.
--
-- THE FIX. Two helper functions that answer exactly what `visibleProjectIds()` answers, and seven
-- read policies rewritten in terms of them. The org-scoped policies on `organisations` and
-- `organisation_members` are deliberately left alone: the roster is org-scoped in the application
-- too (`GET /api/organisations/:orgId/members` is `requireOrgRole("viewer")`), so tightening them
-- here would make the database stricter than the product.
--
-- Same properties as the existing `private.user_org_ids()`, for the same reasons: SECURITY DEFINER
-- so the function can read the membership tables the caller cannot; STABLE so the planner may hoist
-- it out of a per-row loop; `search_path = ''` so a caller cannot shadow `public` or `auth` with a
-- temp schema and change what the function resolves to. Every reference inside is schema-qualified
-- because an empty search_path resolves nothing implicitly.
--
-- NO RECURSION. `user_visible_project_ids()` reads `public.projects` and `public.project_members`,
-- both of which have policies that call it. SECURITY DEFINER is what breaks the cycle — the body
-- runs as the function owner, for whom RLS does not apply. This is the same reason
-- `private.user_org_ids()` is defined this way and must not be "simplified" to INVOKER.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/**
 * Organisations where the caller is admin or owner.
 *
 * Those two roles see every project in their organisation without being assigned to any — scoping
 * the people who administer the organisation is friction with no security value, and it is what
 * `roleAtLeast(role, "admin")` already decides in the application.
 */
create or replace function private.user_admin_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select om.organisation_id
  from public.organisation_members om
  where om.user_id = (select auth.uid())
    and om.role in ('admin', 'owner')
$$;

/**
 * Every project the caller may SEE — the second access axis, in the database.
 *
 * Mirrors `visibleProjectIds()` exactly: admin/owner get every project in their organisations, and
 * everyone else gets only their `project_members` rows. A brand-new account is assigned to nothing
 * and so sees nothing, which is the intended floor.
 */
create or replace function private.user_visible_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.organisation_id in (select private.user_admin_org_ids())
  union
  select pm.project_id
  from public.project_members pm
  where pm.user_id = (select auth.uid())
$$;

revoke all on function private.user_admin_org_ids() from public;
revoke all on function private.user_visible_project_ids() from public;
grant execute on function private.user_admin_org_ids() to authenticated;
grant execute on function private.user_visible_project_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Read policies
--
-- Dropped and recreated rather than altered: `alter policy` cannot change a policy's name, and the
-- names are the documentation here. Each `drop` names the exact policy this migration replaces, so
-- a partial application is obvious rather than silent.
-- ---------------------------------------------------------------------------

drop policy if exists "members read their projects" on public.projects;
create policy "members read projects they were added to"
  on public.projects for select to authenticated
  using (id in (select private.user_visible_project_ids()));

/**
 * Runs carry BOTH axes, and a null project is the interesting case.
 *
 * `filterRunsForUser` treats a run with no project as admin-visible only — nobody can be assigned
 * to "no project", so counting it as visible would be a hole that widens as unfiled runs
 * accumulate (there are eight such rows today). The organisation check is kept in front of the
 * project check even though it is implied, so that a run whose project row is somehow missing
 * cannot escape its organisation.
 */
drop policy if exists "members read their runs" on public.runs;
create policy "members read runs in projects they were added to"
  on public.runs for select to authenticated
  using (
    organisation_id in (select private.user_org_ids())
    and (
      project_id in (select private.user_visible_project_ids())
      or (project_id is null and organisation_id in (select private.user_admin_org_ids()))
    )
  );

drop policy if exists "members read their suites" on public.suites;
create policy "members read suites in projects they were added to"
  on public.suites for select to authenticated
  using (project_id in (select private.user_visible_project_ids()));

drop policy if exists "members read their cases" on public.test_cases;
create policy "members read cases in projects they were added to"
  on public.test_cases for select to authenticated
  using (project_id in (select private.user_visible_project_ids()));

-- The IR lives here. This is the row that most needs the project gate, not just the org one.
drop policy if exists "members read their case versions" on public.test_case_versions;
create policy "members read case versions in projects they were added to"
  on public.test_case_versions for select to authenticated
  using (
    test_case_id in (
      select c.id from public.test_cases c
      where c.project_id in (select private.user_visible_project_ids())
    )
  );

drop policy if exists "members read their suite membership" on public.suite_cases;
create policy "members read suite membership in projects they were added to"
  on public.suite_cases for select to authenticated
  using (
    suite_id in (
      select s.id from public.suites s
      where s.project_id in (select private.user_visible_project_ids())
    )
  );

drop policy if exists "members read their run cases" on public.run_cases;
create policy "members read run cases in projects they were added to"
  on public.run_cases for select to authenticated
  using (
    test_case_id in (
      select c.id from public.test_cases c
      where c.project_id in (select private.user_visible_project_ids())
    )
  );

/**
 * project_members itself.
 *
 * Not in the original list of seven, and it should have been: its policy was org-scoped like the
 * rest, so a viewer could read the membership of every project in the organisation — including the
 * projects the other six policies now hide from them. Knowing exactly who is on a team you are not
 * on is a smaller leak than reading their test plans, but it is the same leak, and leaving one
 * table on the old rule is how the rule stops being a rule.
 *
 * A member always sees their own rows here: being in a project is what puts it in their visible
 * set in the first place.
 *
 * No recursion, for the same reason as everything else in this file — `user_visible_project_ids()`
 * reads this table, but SECURITY DEFINER means its body is not subject to this policy.
 */
drop policy if exists "members read their project memberships" on public.project_members;
create policy "members read project memberships they can see the project for"
  on public.project_members for select to authenticated
  using (project_id in (select private.user_visible_project_ids()));

-- Supporting index. `user_visible_project_ids()` filters `organisation_members` by user_id and
-- role on every policy evaluation, and the only index on that table is the (organisation_id,
-- user_id) primary key — which cannot serve a user_id-leading lookup.
create index if not exists organisation_members_user_id_idx
  on public.organisation_members (user_id);

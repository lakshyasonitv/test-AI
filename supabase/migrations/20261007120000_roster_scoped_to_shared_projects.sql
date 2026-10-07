-- The organisation roster, scoped to shared projects (DECISIONS.md D-36).
--
-- THE CHANGE. Below admin, a member may now see only themselves plus the members who share at
-- least one project with them. `GET /api/organisations/:orgId/members` enforces that in the
-- application (`listMembersVisibleTo`, src/server/organisations.ts). This migration makes the
-- database agree, because the publishable key ships to every browser by design: without it a
-- tester could take their own JWT straight to PostgREST —
--
--     GET {SUPABASE_URL}/rest/v1/organisation_members?select=*
--
-- — and read the whole roster the API now refuses them. The server holds the service-role key and
-- bypasses RLS, so this policy changes nothing the APPLICATION reads; it only closes that path.
-- (Verified: no browser code reads either table directly — public/ only calls /auth/v1/*.)
--
-- THIS REVERSES A DELIBERATE CHOICE. 20260910120000_project_scoped_rls_read_policies.sql left the
-- roster org-scoped on purpose, "so the database is not stricter than the product". The product
-- has now changed, so the database follows it — the same rule, applied the other way.
--
-- PER-ORGANISATION, NOT PER-PERSON. A naive "user ids I share a project with" set would leak
-- across organisations: if A and B are both in org X and org Y, and share a project only in X, A
-- would also see B's org-Y membership row. So the helper returns (organisation_id, user_id) PAIRS,
-- each pairing a co-member with the organisation of the project they share, and the policy
-- matches on both columns. This mirrors the API, which computes visibility per organisation via
-- visibleProjectIds(userId, orgId, role).
--
-- Same function properties as every other helper here, for the same reasons: SECURITY DEFINER so
-- it can read the membership tables (and so it does not recurse into this policy), STABLE so the
-- planner can hoist it, `search_path = ''` with every reference schema-qualified.

/**
 * The (organisation, member) pairs a NON-admin caller may see:
 *   - their own membership row, in every organisation they belong to;
 *   - every co-member of a project they are assigned to, in THAT project's organisation only.
 *
 * Admin/owner visibility is not expressed here — the policy grants it separately through
 * private.user_admin_org_ids(), per organisation, exactly as the project policies do.
 *
 * `p.organisation_id in user_org_ids()` guards against a stale assignment: removing someone from
 * an organisation does not currently delete their project_members rows (TECH_DEBT.md TD-109), and
 * such a row must not keep granting visibility in an organisation they have left.
 */
create or replace function private.user_visible_member_keys()
returns table (organisation_id uuid, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select om.organisation_id, om.user_id
  from public.organisation_members om
  where om.user_id = (select auth.uid())
  union
  select p.organisation_id, other.user_id
  from public.project_members mine
  join public.project_members other on other.project_id = mine.project_id
  join public.projects p on p.id = mine.project_id
  where mine.user_id = (select auth.uid())
    and p.organisation_id in (select private.user_org_ids())
$$;

revoke all on function private.user_visible_member_keys() from public, anon;
grant execute on function private.user_visible_member_keys() to authenticated;

drop policy if exists "members read their rosters" on public.organisation_members;
drop policy if exists "members read the roster they are allowed to see" on public.organisation_members;
create policy "members read the roster they are allowed to see"
  on public.organisation_members for select to authenticated
  using (
    -- admin/owner: the whole roster of THAT organisation (and only that one)
    organisation_id in (select private.user_admin_org_ids())
    -- everyone else: themselves, plus project co-members, matched per organisation
    or (organisation_id, user_id) in (
      select k.organisation_id, k.user_id from private.user_visible_member_keys() k
    )
  );

-- ---------------------------------------------------------------------------
-- ROLLBACK — restores the previous, org-scoped roster policy exactly as
-- 20260824151807_phase3_4_move_helper_out_of_api_schema.sql defined it. Run by hand if needed;
-- the application does not depend on either policy (it reads with the service-role key), so
-- rolling back only re-opens the direct-PostgREST path described above.
--
-- drop policy if exists "members read the roster they are allowed to see" on public.organisation_members;
-- create policy "members read their rosters"
--   on public.organisation_members for select
--   to authenticated
--   using (organisation_id in (select private.user_org_ids()));
-- drop function if exists private.user_visible_member_keys();
-- ---------------------------------------------------------------------------

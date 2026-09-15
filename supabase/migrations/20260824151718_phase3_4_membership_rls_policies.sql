-- Step 3.4: replace the deny-all posture with membership-scoped read policies.
--
-- The invariant that must survive this change: the PUBLISHABLE key ships to every browser, and
-- Supabase exposes these tables over PostgREST using it. Anything readable by that key is
-- readable by anyone who views source. So every policy below is granted `to authenticated`
-- only -- the anon role is deliberately left with no policy at all, which keeps it denied.
--
-- Writes stay service-role only (no INSERT/UPDATE/DELETE policies). The server is the sole
-- writer and it holds the service key, which bypasses RLS by design.

-- Membership lookup as a SECURITY DEFINER function.
--
-- This exists to break a recursion: a policy on organisation_members that queries
-- organisation_members would re-enter its own policy and error out. SECURITY DEFINER runs the
-- query as the function owner, bypassing RLS inside the function body only.
--
-- `set search_path = ''` with fully-qualified names: without it a caller could prepend a schema
-- containing their own organisation_members table and have this definer-rights function read it.
create or replace function public.user_org_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select organisation_id
  from public.organisation_members
  where user_id = (select auth.uid())
$$;

revoke all on function public.user_org_ids() from public, anon;
grant execute on function public.user_org_ids() to authenticated;

-- organisations: you can see one only if you are in it.
drop policy if exists "members read their organisations" on public.organisations;
create policy "members read their organisations"
  on public.organisations for select
  to authenticated
  using (id in (select public.user_org_ids()));

-- organisation_members: you can see the roster of organisations you belong to. Not a leak --
-- knowing who your own colleagues are is the point of a members list.
drop policy if exists "members read their rosters" on public.organisation_members;
create policy "members read their rosters"
  on public.organisation_members for select
  to authenticated
  using (organisation_id in (select public.user_org_ids()));

drop policy if exists "members read their projects" on public.projects;
create policy "members read their projects"
  on public.projects for select
  to authenticated
  using (organisation_id in (select public.user_org_ids()));

-- runs: the sensitive one. A run row carries the prompt and target URL, and its id is the key to
-- every screenshot and trace under runs/<id>/.
drop policy if exists "members read their runs" on public.runs;
create policy "members read their runs"
  on public.runs for select
  to authenticated
  using (organisation_id in (select public.user_org_ids()));

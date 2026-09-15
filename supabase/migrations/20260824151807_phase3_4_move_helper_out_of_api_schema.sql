-- The membership helper was reachable at /rest/v1/rpc/user_org_ids simply by living in `public`,
-- which PostgREST exposes. It leaks nothing (it returns only the caller's own organisations, and
-- a signed-in user necessarily already knows those), but a SECURITY DEFINER function needs no
-- HTTP surface at all, so remove it rather than reason about it again later.
--
-- `private` is not in Supabase's exposed schema list, so nothing here gets an endpoint. RLS
-- policies can still call it: policy expressions are evaluated as the querying role, which is why
-- EXECUTE is granted to authenticated below.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.user_org_ids()
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

revoke all on function private.user_org_ids() from public, anon;
grant execute on function private.user_org_ids() to authenticated;

-- Repoint every policy at the relocated helper.
drop policy if exists "members read their organisations" on public.organisations;
create policy "members read their organisations"
  on public.organisations for select
  to authenticated
  using (id in (select private.user_org_ids()));

drop policy if exists "members read their rosters" on public.organisation_members;
create policy "members read their rosters"
  on public.organisation_members for select
  to authenticated
  using (organisation_id in (select private.user_org_ids()));

drop policy if exists "members read their projects" on public.projects;
create policy "members read their projects"
  on public.projects for select
  to authenticated
  using (organisation_id in (select private.user_org_ids()));

drop policy if exists "members read their runs" on public.runs;
create policy "members read their runs"
  on public.runs for select
  to authenticated
  using (organisation_id in (select private.user_org_ids()));

drop function if exists public.user_org_ids();

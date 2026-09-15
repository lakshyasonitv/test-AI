-- Explicit deny-by-default write policies (audit finding R-2).
--
-- THE PROBLEM. Supabase's default grants are in place: `anon` and `authenticated` hold
-- SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on all ten tables. Writes were
-- refused only because no INSERT/UPDATE/DELETE policy existed anywhere. That is correct behaviour
-- resting on an absence — nothing in the schema says "clients must not write here", so the day
-- someone adds a permissive `for all` policy to any table, that table's write side opens to every
-- signed-in user of every organisation at once and nothing fails loudly.
--
-- WHY RESTRICTIVE, AND WHY THIS IS NOT DECORATIVE. Postgres combines permissive policies with OR.
-- A permissive `with check (false)` policy would therefore be worthless here: it would OR with a
-- future permissive policy and the future one would win. RESTRICTIVE policies are combined with
-- AND, and the two sets are ANDed together — so `(anything permissive) AND false` is false no
-- matter what is added later. That is the actual guarantee being bought.
--
-- SELECT IS DELIBERATELY UNTOUCHED. These are three per-command policies rather than one
-- `for all`, because `for all` covers SELECT too and a restrictive `using (false)` there would
-- silently return zero rows for every read — undoing the previous migration rather than
-- complementing it.
--
-- THE SERVER IS UNAFFECTED. It connects with the service-role key, and `service_role` has
-- `rolbypassrls = true` (verified on this project before writing this). RLS is not consulted for
-- that role at all, so every write the application makes continues to work. If that ever stops
-- being true, this migration is where to look first.

do $$
declare
  t text;
  tables text[] := array[
    'organisations',
    'organisation_members',
    'projects',
    'project_members',
    'runs',
    'run_cases',
    'suites',
    'suite_cases',
    'test_cases',
    'test_case_versions'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', 'clients may not insert', t);
    execute format('drop policy if exists %I on public.%I', 'clients may not update', t);
    execute format('drop policy if exists %I on public.%I', 'clients may not delete', t);

    execute format(
      'create policy %I on public.%I as restrictive for insert to anon, authenticated with check (false)',
      'clients may not insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to anon, authenticated using (false) with check (false)',
      'clients may not update', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to anon, authenticated using (false)',
      'clients may not delete', t);
  end loop;
end $$;

comment on schema public is
  'Client writes are denied by RESTRICTIVE policy on every table; all writes go through the server''s service-role key. See 20260910120100_deny_client_writes_by_default.sql before adding any permissive policy.';

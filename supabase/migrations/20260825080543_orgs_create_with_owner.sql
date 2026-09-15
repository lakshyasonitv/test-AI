-- Creating an organisation and its first owner must be one write.
--
-- An organisation with no owner is unreachable forever: every management route requires an
-- owner/admin membership to act, so nobody could ever add one. Doing this as two client-side
-- inserts leaves exactly that state behind if the process dies between them, so it is a single
-- function and therefore a single transaction.
--
-- SECURITY INVOKER (the default) on purpose: this is only ever called by the server holding the
-- service-role key, which already bypasses RLS. A SECURITY DEFINER function would add an
-- escalation surface for no benefit.
create or replace function public.create_organisation_with_owner(
  p_name    text,
  p_user_id uuid
)
returns table (id uuid, name text)
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'organisation name is required';
  end if;

  insert into organisations (name)
  values (btrim(p_name))
  returning organisations.id into v_id;

  insert into organisation_members (organisation_id, user_id, role)
  values (v_id, p_user_id, 'owner');

  return query select v_id, btrim(p_name);
end;
$$;

-- No HTTP surface. The publishable key ships to every browser; a callable org-minting endpoint
-- there would let anyone create organisations without going through the server's checks.
revoke all on function public.create_organisation_with_owner(text, uuid) from public;
revoke all on function public.create_organisation_with_owner(text, uuid) from anon;
revoke all on function public.create_organisation_with_owner(text, uuid) from authenticated;
grant execute on function public.create_organisation_with_owner(text, uuid) to service_role;

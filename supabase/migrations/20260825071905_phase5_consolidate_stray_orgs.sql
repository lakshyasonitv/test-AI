-- Earlier phases' end-to-end tests left three organisations behind: the bootstrap "Default" plus
-- two solo orgs auto-created by the old sign-up path (each new account used to become owner of its
-- own organisation). That behaviour is being replaced in this phase — every sign-up now joins
-- Default as a viewer — so the leftovers are consolidated rather than left as orphan tenants.
--
-- Real accounts are preserved and moved, never deleted: `ls@thinkvibes.com` is a genuine account
-- and lands in Default as `viewer`, which is exactly where the new sign-up flow would have put it.

-- 1. Any run sitting in a non-Default organisation is a real run on disk. Move it, don't drop it.
update runs
   set organisation_id = '00000000-0000-4000-8000-000000000010'
 where organisation_id <> '00000000-0000-4000-8000-000000000010';

-- 2. Every human account that isn't already in Default joins it as `viewer` — the new default.
--    The synthetic local user and anyone already present keep the role they have.
insert into organisation_members (organisation_id, user_id, role)
select '00000000-0000-4000-8000-000000000010', m.user_id, 'viewer'
  from (select distinct user_id from organisation_members) m
 where not exists (
   select 1 from organisation_members d
    where d.organisation_id = '00000000-0000-4000-8000-000000000010'
      and d.user_id = m.user_id
 )
on conflict (organisation_id, user_id) do nothing;

-- 3. Drop the memberships that pointed at the solo orgs, then the now-empty orgs themselves.
delete from organisation_members
 where organisation_id <> '00000000-0000-4000-8000-000000000010';

delete from organisations
 where id <> '00000000-0000-4000-8000-000000000010';

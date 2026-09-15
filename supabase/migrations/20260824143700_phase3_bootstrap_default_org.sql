-- Bootstrap: one organisation, one owner (implentationplan.md Step 3.1, Rule 4).
--
-- Both ids are FIXED rather than generated. The server has to be able to name the organisation
-- it writes runs into without a lookup, and the owner id must match src/server/auth.ts's
-- LOCAL_USER_ID exactly -- if those two ever drift, every backfilled run is owned by nobody.
-- Keep these three constants in sync:
--   auth.ts LOCAL_USER_ID  = 00000000-0000-4000-8000-000000000001
--   db.ts   DEFAULT_ORG_ID = 00000000-0000-4000-8000-000000000010

insert into organisations (id, name)
values ('00000000-0000-4000-8000-000000000010', 'Default')
on conflict (id) do nothing;

insert into organisation_members (organisation_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (organisation_id, user_id) do nothing;

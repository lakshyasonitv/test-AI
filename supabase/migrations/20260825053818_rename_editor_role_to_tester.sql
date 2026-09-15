-- Rename the `editor` role to `tester`.
--
-- The role's meaning is unchanged -- it is the person who drives a run: talks to the AI, answers
-- the credential prompt, and picks cases at the selection gate. `editor` described the permission
-- ("may write") rather than the job ("tests things"), and the job is what an admin is actually
-- assigning. The ladder keeps four levels in the same order:
--     viewer < tester < admin < owner
--
-- Order matters: existing rows are migrated BEFORE the constraint is swapped, so no row is ever
-- left violating the constraint it is checked against.

update public.organisation_members
   set role = 'tester'
 where role = 'editor';

alter table public.organisation_members
  drop constraint if exists organisation_members_role_check;

alter table public.organisation_members
  add constraint organisation_members_role_check
  check (role = any (array['owner'::text, 'admin'::text, 'tester'::text, 'viewer'::text]));

-- One project per name per organisation (audit finding S-2).
--
-- THE PROBLEM. `resolveProjectForUrl` in src/server/projects.ts does a lookup, then an insert, with
-- nothing between them. Two runs started concurrently against a URL that has no project yet both
-- miss the lookup and both insert, producing two projects with the same key — and that site's run
-- history then splits across both, with the sidebar showing near-duplicate rows and no way to merge
-- them (there is no route for that).
--
-- The window is small and nothing has fallen into it yet: checked before writing this migration,
-- all 17 projects are distinct under `lower(btrim(name))`, in a single organisation. This closes it
-- before that stops being true rather than after.
--
-- WHY A GENERATED COLUMN RATHER THAN AN INDEX ON AN EXPRESSION. Both would enforce the constraint.
-- A stored column additionally makes the normalisation VISIBLE — `select name, normalised_name`
-- shows why two rows collided, which an expression index cannot. It is also the value a future
-- merge tool would group by.
--
-- WHAT `name` ACTUALLY HOLDS, AND WHY THIS IS SAFE ANYWAY. Two different kinds of value share this
-- column: `resolveProjectForUrl` writes a normalised URL key ("alpha.example.com/login"), while
-- `createProject` writes whatever a human typed. Uniqueness across both is still the right rule —
-- two projects called "Checkout" in one organisation are a bug in either dialect — and the URL-key
-- case is the one with a real race behind it.
--
-- CONSEQUENCE FOR THE APPLICATION, WORTH KNOWING BEFORE THIS IS APPLIED. With this index in place,
-- the losing side of that race now gets a unique-violation from its insert instead of creating a
-- duplicate. `resolveProjectForUrl` logs the error and returns null, which means the run is filed
-- under NO project — and an unfiled run is visible to admins only. So this constraint converts a
-- rare "duplicate project" bug into a rare "run its author cannot see" bug unless the insert is
-- given an on-conflict retry that re-reads the winner's row. That change belongs in projects.ts,
-- not here; it is called out in the summary that accompanied this migration.

alter table public.projects
  add column if not exists normalised_name text
  generated always as (lower(btrim(name))) stored;

comment on column public.projects.normalised_name is
  'Generated from name. Exists to carry the uniqueness constraint below and to make a collision legible. Never written directly.';

create unique index if not exists projects_organisation_id_normalised_name_key
  on public.projects (organisation_id, normalised_name);

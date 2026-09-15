# Database migrations

Schema changes for the Supabase Postgres this server talks to. Owned by `ARCHITECTURE.md` for
*what the tables are*; this file owns *how a change to them gets made*.

## Read this first: the history was never in the repo

The remote database has a migration history — twelve migrations, from `20260824143642
phase3_identity_and_runs` through `20260906113330 add_spec_to_test_case_versions`, recorded in
`supabase_migrations.schema_migrations`. They were applied through the Supabase dashboard and MCP
tools and **never committed here**, so until now the live database was the only authority on the
schema and there was no way to review a schema change, roll one back, or stand up a second
environment.

That is the gap this directory closes. The four migrations below are the first ones written as
files. **The twelve that came before them are still missing locally**, and the first job is to
recover them — see the next section. Do not skip it: `supabase db push` compares your local
`migrations/` against the remote history table, and pushing with the older ones absent will not go
well.

## One-time setup: recover the twelve existing migrations

```bash
npm i -g supabase                      # or: npx supabase@latest <command>
supabase login
supabase init                          # creates supabase/config.toml; leaves migrations/ alone
supabase link --project-ref tvujslcqkykxwenloimg
supabase migration fetch               # downloads the 12 remote migrations into migrations/
supabase migration list                # LOCAL and REMOTE columns should now line up
```

`migration fetch` writes each remote migration's recorded SQL into `supabase/migrations/`. Commit
what it produces — that is the project's real history, and it should be reviewed like any other
code even though it is being committed after the fact.

After that, `migration list` should show all sixteen: the twelve fetched, plus the four here.

## What is in here now

| File | Finding | What it does |
|---|---|---|
| `20260910120000_project_scoped_rls_read_policies.sql` | R-1 | Adds `private.user_admin_org_ids()` and `private.user_visible_project_ids()`, and rewrites the read policies on `projects`, `runs`, `run_cases`, `suites`, `suite_cases`, `test_cases` and `test_case_versions` to consult project membership. Admin and owner stay exempt. |
| `20260910120100_deny_client_writes_by_default.sql` | R-2 | A RESTRICTIVE deny policy per write command on all ten tables, so write isolation stops depending on the absence of a policy. |
| `20260910120200_user_id_foreign_keys.sql` | S-1 | Foreign keys from all seven user id columns into `auth.users` — cascade for permission grants, set null for attribution. Two are `NOT VALID` because of pre-existing orphans. |
| `20260910120300_projects_unique_normalised_name.sql` | S-2 | A generated `normalised_name` column and a unique index on `(organisation_id, normalised_name)`. |

`manual/0001_resolve_user_id_orphans.sql` is **not** a migration and is not in `migrations/` on
purpose — it deletes or rewrites rows, and `db push` must never be able to do that unattended. It
documents the three orphan rows that exist today, offers two ways to resolve them, and ends with
the `validate constraint` statements that finish S-1.

## Applying

```bash
supabase migration list                # confirm local and remote agree before doing anything
supabase db push --dry-run             # prints what would run
supabase db push
```

Prefer testing on a branch first — `supabase branches create <name>` gives a full copy with the
migrations applied, which is also the right place to point the RLS test at.

## Writing a new one

```bash
supabase migration new what_it_does
```

Then edit the generated `supabase/migrations/<timestamp>_what_it_does.sql`. Three rules, all learned
from what this directory had to be created to fix:

1. **Never change the remote database by hand again** — not through the dashboard SQL editor, not
   through an MCP tool. Both bypass the history table, and `db push` starts failing with sync errors
   that are far more work to unpick than writing the file was.
2. **A migration that changes an RLS policy must come with a test.** See below — the reason R-1
   survived for months is that nothing in the suite could see a policy.
3. **A migration must not delete or rewrite user data as a side effect.** Put that in `manual/`
   with the measurement query that justifies it, as `0001` does.

## Testing RLS

`npm test` mocks `@supabase/supabase-js` in every file that touches it, which means **no policy in
this system is covered by the ordinary suite** — a fake `createClient` never asks Postgres anything,
and RLS is enforced only by Postgres. That is exactly how the R-1 gap survived a green suite.

`tests/rlsPolicies.integration.test.ts` is the counterpart: no mocking, a real viewer JWT, real
HTTP to PostgREST — the precise path RLS is the only defence on, since the server itself holds the
service-role key and bypasses RLS entirely.

It skips unless pointed at a database. Put the credentials in `.env.rls` (gitignored):

```
RLS_TEST_SUPABASE_URL=https://<branch-ref>.supabase.co
RLS_TEST_SERVICE_ROLE_KEY=<service_role key>
RLS_TEST_PUBLISHABLE_KEY=<publishable key>
```

```bash
npm run test:rls
```

**Point it at a branch or a scratch project, never production.** It creates two organisations, three
accounts and their data, and cleans up afterwards — but a failed run can leave fixtures behind.
Everything it creates is prefixed `rlstest-`.

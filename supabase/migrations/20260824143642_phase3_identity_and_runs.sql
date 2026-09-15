-- implentationplan.md Phase 3, Step 3.1.
--
-- organisations + organisation_members exist from this very first migration on purpose: it is
-- the retrofit that cannot be done later (Rule 4). Single-user mode is then just multi-user
-- mode with exactly one member, rather than a separate code path.

create table organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- user_id deliberately has NO foreign key to auth.users. The AUTH_ENABLED=off synthetic
-- LOCAL_USER is not a real Supabase account, and it must still be able to own the bootstrap
-- organisation so historical runs have a valid owner before anyone signs up.
create table organisation_members (
  organisation_id uuid references organisations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz default now(),
  primary key (organisation_id, user_id)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  base_url text not null,
  credentials_ref text,   -- env var NAME, never a value
  created_at timestamptz default now()
);
create index on projects (organisation_id);

create table runs (
  id text primary key,    -- existing runId format, unchanged
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  started_by uuid,
  prompt text,
  url text,
  status text,
  started_at timestamptz,
  artifact_path text
);
create index on runs (organisation_id, started_at desc);

-- RLS on, with NO policies, on every table.
--
-- This is load-bearing, not boilerplate. The publishable/anon key ships to every browser that
-- loads the app, and Supabase exposes these tables over PostgREST using it. Without RLS, anyone
-- who views source could read every organisation's runs directly from the REST API, bypassing
-- this server entirely.
--
-- Deny-all is the correct posture for this phase: the only thing that touches these tables is
-- the Node server via the service-role key, which bypasses RLS by design. Tenancy-scoped
-- policies (membership joins) arrive with Step 3.4, when there is a real user to scope them to.
alter table organisations        enable row level security;
alter table organisation_members enable row level security;
alter table projects             enable row level security;
alter table runs                 enable row level security;

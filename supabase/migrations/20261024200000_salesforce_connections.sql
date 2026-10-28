-- Salesforce org connections that survive a server restart (Session 102, TD-166).
--
-- A connection used to live in process memory only, so every restart (and every second replica)
-- forgot it and the person had to click Connect org again. The row holds what is needed to mint a
-- new access token: the org's login host, its instance URL, and the REFRESH TOKEN — encrypted the
-- same way org_llm_config encrypts an API key (AES-256-GCM, key held outside this database, see
-- src/server/secretStore.ts). No access token is stored: it is short-lived and re-minted on load.
--
-- `id` is the connection id the browser holds (sessionStorage), so a page that outlives a server
-- restart keeps working. One row per connection; a run may only use a row of its own organisation.

create table if not exists public.salesforce_connections (
  id text primary key,
  organisation_id uuid references organisations(id) on delete cascade,
  user_id uuid,

  login_origin text not null,
  instance_url text not null,
  kind text not null,

  -- Sealed refresh token. All four are required together; none is secret on its own.
  refresh_ct text not null,
  refresh_iv text not null,
  refresh_tag text not null,
  refresh_custody text not null,

  created_at timestamptz default now()
);

comment on table public.salesforce_connections is
  'Salesforce org connections (OAuth refresh tokens, encrypted with a key held outside this database) so a server restart keeps them. Never returned to any client.';

-- Service role only, like the rest of the library; RLS on so a publishable key cannot reach it.
alter table public.salesforce_connections enable row level security;

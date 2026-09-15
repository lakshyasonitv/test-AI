-- Per-organisation LLM configuration: an organisation's own Gemini API key and model choice.
--
-- The key is stored ENCRYPTED and is never returned to any client. The column holds ciphertext,
-- IV and GCM auth tag; the key that opens them deliberately does NOT live in this database (see
-- src/server/secretStore.ts). A dump of this table is therefore not enough to read anyone's key.
--
-- `key_fingerprint` is a truncated SHA-256 of the plaintext. It exists so two things are possible
-- without ever decrypting: telling whether a key changed, and — the important one — mixing a
-- per-tenant dimension into the LLM disk cache key. That cache never expires, so without this
-- dimension two organisations asking the same question would share one answer forever, which is
-- TECH_DEBT.md TD-22 / DECISIONS.md D-10 happening across a tenant boundary.
--
-- `key_hint` is the last four characters only, so the UI can say WHICH key is set without a
-- reveal action existing at all.
--
-- One row per organisation; absence means "use the server's env configuration", which is the
-- documented fallback and the state of every organisation until an admin sets one.

create table if not exists public.org_llm_config (
  organisation_id uuid primary key references organisations(id) on delete cascade,

  -- Ciphertext parts. All three are required together; none is secret on its own.
  key_ct text,
  key_iv text,
  key_tag text,
  -- Which custody sealed it, so a failure to open can say why rather than just failing.
  key_custody text,

  key_fingerprint text,
  key_hint text,

  -- Validated against the allowlist in src/llm/gemini.ts AND against the provider's own
  -- ListModels for this key before being stored. Null means "use the server's model".
  model text,
  model_lite text,

  -- Per-organisation ceiling, replacing the shared MAX_LLM_CALLS_PER_RUN for this org's runs.
  max_calls_per_run int,

  updated_at timestamptz default now(),
  updated_by uuid
);

comment on table public.org_llm_config is
  'Per-organisation Gemini credentials and model choice. The API key is encrypted with a key held outside this database; it is write-only through the API and is never returned decrypted to any client.';

comment on column public.org_llm_config.key_fingerprint is
  'Truncated SHA-256 of the plaintext key. Used to detect change and as a per-tenant LLM cache dimension. Not reversible, not a credential.';

comment on column public.org_llm_config.key_hint is
  'Last four characters of the key, for a set/not-set UI. There is deliberately no reveal action.';

-- Client writes are denied by default across this schema; the service role reads and writes this
-- table on the server's behalf, exactly as it does for the rest of the library. RLS is enabled so
-- the table is never reachable directly with a publishable key.
alter table public.org_llm_config enable row level security;

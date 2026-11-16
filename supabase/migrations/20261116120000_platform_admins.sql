-- Platform admins (D-84): the people who run Testbench itself, above every organisation.
--
-- Kept apart from organisation_members on purpose: that table answers "which company are you in, and
-- with what role", and a platform admin is in none of them — they create organisations, create users in
-- any of them, and can open any of them. Read only by the server (service role); with RLS on and no
-- policy, no browser client can read or write it.
--
-- Additive: nothing reads this table until PLATFORM_ADMIN_ENABLED=true on the server.

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;

-- The first admin. The account must already exist in Supabase Authentication; if it does not, this
-- inserts nothing and can simply be run again once it does.
insert into platform_admins (user_id, email)
select id, email from auth.users where lower(email) = 'admin@gmail.com'
on conflict (user_id) do nothing;

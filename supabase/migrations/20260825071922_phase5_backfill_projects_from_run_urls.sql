-- Turn the sidebar's client-side URL grouping into real project rows.
--
-- Until now `public/app.js` grouped runs by normalised URL purely for display; `projects` was an
-- empty table nothing wrote to. Scoping run visibility by project without this would make all 52
-- historical runs invisible to everyone but admins, so the grouping the user already sees is
-- promoted into real rows and every run is pointed at one.
--
-- The key matches groupRunsByUrl()/normalizeUrlKey() in public/app.js exactly — protocol stripped,
-- trailing slashes stripped, lowercased, PATH RETAINED — so nothing regroups under the user.
with keyed as (
  select
    r.id,
    r.url,
    lower(regexp_replace(regexp_replace(btrim(coalesce(r.url, '')), '^https?://', '', 'i'), '/+$', '')) as norm_key
  from runs r
),
distinct_keys as (
  -- A run with no usable URL gets a real home rather than being silently skipped: "Unsorted".
  select
    case when norm_key = '' then 'Unsorted' else norm_key end as name,
    min(case when norm_key = '' then '' else url end) as base_url
  from keyed
  group by 1
),
created as (
  insert into projects (organisation_id, name, base_url)
  select '00000000-0000-4000-8000-000000000010', d.name, coalesce(d.base_url, '')
  from distinct_keys d
  returning id, name
)
update runs r
   set project_id = c.id
  from created c, keyed k
 where k.id = r.id
   and c.name = (case when k.norm_key = '' then 'Unsorted' else k.norm_key end);

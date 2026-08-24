# Phase 3 (partial) — Database, Steps 3.1 and 3.2 only

Implements Steps 3.1–3.2 of `implentationplan.md`. Commit: `bac6d1f`.

**Steps 3.3 and 3.4 are deliberately NOT included.** Step 3.2 ends at a gate the plan sets
itself: the shadow read must run for a few days of real use with zero divergence logged before
authority is flipped to the database. See "The soak gate" below for what to watch.

Everything is behind `DB_ENABLED`, default **off**. With it off, nothing contacts the database.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/db.ts` | **New.** Service-role client, `fetchRunsFromDb()`, the pure `diffRuns()` comparison, and the fire-and-forget `shadowCompareRuns()`. |
| `src/runStore.ts` | Split `listRuns()` into `allRunIds()` + `summariseRun()` (behaviour-preserving) so the backfill can walk every run without the 20-row display cap, using identical logic. `listRuns()` now also kicks off the shadow comparison — **not awaited**, so its signature, synchronicity and return value are unchanged. |
| `scripts/generateRunBackfill.ts` | **New.** Emits the backfill SQL to stdout. |
| `tests/shadowRead.test.ts` | **New.** 9 tests over `diffRuns()` and the flag default. |

## 2. NEW FILES

- `src/db.ts`
- `scripts/generateRunBackfill.ts`
- `tests/shadowRead.test.ts`

Three decisions worth stating:

**The shadow read is fire-and-forget.** `listRuns()` does not `await` it. That keeps `listRuns()`
synchronous (no route signature change) and means a slow or unreachable database cannot delay or
break `/api/runs`. Shadow mode that can take down the endpoint it's shadowing would defeat its own
purpose.

**`diffRuns()` is pure and directly unit-tested.** It is the entire substance of this step — it's
what decides whether 3.3 is safe — so it is tested against fixtures rather than only through a
live database, which would make the test depend on a service-role secret and network access.

**The backfill script prints SQL rather than connecting.** It needs no secret, and you can read
exactly what is about to be written before applying it. Every insert is
`on conflict (id) do nothing`, so re-running it later (as new runs accumulate) is safe.

## 3. NEW ENV FLAGS

| Flag | Default | What it does | When flipped |
|---|---|---|---|
| `DB_ENABLED` | unset → off | Off: the database is never contacted. No client is constructed, no query is issued, no log line appears. | `true`: after each `/api/runs`, at most once per 60s, the same newest-20 window is read from Postgres and compared against the disk result. Divergences are logged. **The disk result is still what's returned** — the database is never authoritative at this step. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | **Secret.** Required for `DB_ENABLED` to do anything. Bypasses row-level security, which is why it must never reach a browser. | With `DB_ENABLED=true` but this unset, the server logs one actionable error and continues on disk only. Nothing breaks. |

**⚠️ You must supply the service-role key yourself.** It is not obtainable through the Supabase
MCP tooling (which exposes publishable keys only), so it could not be filled in for you. Copy it
from **Supabase Dashboard → Project Settings → API → `service_role`** into `.env`:

```
SUPABASE_SERVICE_ROLE_KEY=<paste it here>
```

`.env` is gitignored, so it will not be committed. Until this is set, `DB_ENABLED=true` is inert
apart from one warning line.

## 4. NEW ROUTES

None. This phase adds no HTTP surface and changes no existing route's shape.

## 5. SCHEMA CHANGES

Two migrations applied to Supabase project **`ai-test-platform`** (ref `tvujslcqkykxwenloimg`,
`ap-south-1`). Your other project, "project tracker", was not touched.

**`phase3_identity_and_runs`** — creates `organisations`, `organisation_members`, `projects`,
`runs`, with the plan's exact columns, plus indexes on `projects(organisation_id)` and
`runs(organisation_id, started_at desc)`.

- `organisations` and `organisation_members` exist in the *first* migration on purpose. Per Rule 4
  this is the retrofit that cannot be added later.
- `organisation_members.user_id` deliberately has **no foreign key** to `auth.users`. The
  `AUTH_ENABLED=off` synthetic user is not a real Supabase account and still has to own the
  bootstrap organisation so historical runs have a valid owner before anyone signs up.
- **RLS is enabled with no policies on all four tables.** This is load-bearing, not boilerplate:
  the publishable key ships to every browser and Supabase exposes these tables over PostgREST
  using it, so without RLS anyone viewing source could read every run directly, bypassing this
  server entirely. Deny-all is the correct posture while the server is the only client (it uses
  service-role, which bypasses RLS by design). Membership-scoped policies arrive with Step 3.4.
  **Verified:** querying PostgREST with the publishable key returns `[]` for both `runs` and
  `organisations`.

**`phase3_bootstrap_default_org`** — seeds one organisation `"Default"`
(`00000000-0000-4000-8000-000000000010`) and one `owner` membership for
`00000000-0000-4000-8000-000000000001`, which is `LOCAL_USER_ID` from `src/server/auth.ts`. Both
ids are fixed rather than generated so the server can name them without a lookup; if they drift
from the constants in code, backfilled runs become orphaned.

**Backfill result: 51 rows inserted from 51 run directories, 0 skipped.** The plan's stated
verification is "row count matches directory count minus a logged, inspected skip list" — the skip
list is empty. Confirmed by query: 51 rows, all in the Default org, all attributed to the local
user, none with a null `started_at`.

The only Supabase security advisories are four INFO-level `rls_enabled_no_policy` notices — one
per table. That is the intended deny-all state described above, not a defect. No ERROR- or
WARN-level advisories.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request/response shape changed.** `listRuns()` returns exactly what it did
  (same fields, same order, same 20-row cap, still synchronous). Phase 0's contract tests pass
  unchanged.
- **No frontend file was touched at all** in this phase — `public/app.js`, `public/index.html`,
  `public/style.css` are untouched, so no `style.css` class contract could have been affected.
- **Credential handling is untouched.** `pendingCredentials.ts` and `scrubServedSecrets` were not
  modified; run credentials still never reach disk or the database. The service-role key lives
  only in gitignored `.env` and is never sent to a browser.
- **Your "project tracker" Supabase project was not touched** — no query, no migration. A separate
  project was created for this platform specifically because its existing `projects` table would
  have collided with this schema.
- **The real `runs/` directory was only ever read**, never modified. The backfill copies data out;
  it deletes and rewrites nothing.

## 7. HOW TO VERIFY

1. `git log --oneline -1` → `bac6d1f`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **410 passed** (37 files), including the 9 new
   `tests/shadowRead.test.ts` cases.
3. **Default state.** With `DB_ENABLED` unset, `npm run serve`. The startup log must show no
   `[shadow]` lines, and `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/runs`
   → `200`. Hit `/api/runs` repeatedly — no database line ever appears, because nothing is
   contacted.
4. **Flag on, key missing (do this before pasting the key).** Stop the server, then:
   ```
   DB_ENABLED=true npm run serve
   ```
   Hit `http://localhost:3000/api/runs`. It must still return `200` with all 20 rows, and the log
   must show exactly one line:
   ```
   [shadow] DB_ENABLED=true but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ...
   ```
   The point of this step is confirming a missing key degrades cleanly instead of breaking the
   endpoint.
5. **Paste the service-role key** into `.env` (Supabase Dashboard → Project Settings → API →
   `service_role`), then restart with `DB_ENABLED=true npm run serve`.
6. Hit `/api/runs`, then wait ~60s (the comparison is throttled to once per minute) and hit it
   again. **Expected: no `[shadow]` output at all.** Silence is the pass condition — see the soak
   gate below.
7. Confirm the data landed, from the Supabase SQL editor or dashboard:
   ```sql
   select count(*) from runs;                    -- 51
   select count(*) from organisations;           -- 1
   select count(*) from organisation_members;    -- 1
   ```
8. Confirm RLS actually blocks the browser-facing key (paste your publishable key):
   ```
   curl -s "https://tvujslcqkykxwenloimg.supabase.co/rest/v1/runs?select=id&limit=3" \
     -H "apikey: <publishable key>" -H "Authorization: Bearer <publishable key>"
   ```
   → `[]`. If this ever returns rows, RLS has been weakened and run history is world-readable.
9. **Deliberately create a divergence to prove the detector works** (optional but recommended
   before trusting silence). In the Supabase SQL editor:
   ```sql
   update runs set status = 'passed'
   where id = (select id from runs order by started_at desc limit 1);
   ```
   Restart the server with `DB_ENABLED=true`, hit `/api/runs`, and you should see a
   `[shadow] status differs for <runId>: disk=... db=passed` line. Then undo it:
   ```sql
   -- set it back to whatever the UI shows for that run
   update runs set status = '<original>' where id = '<runId>';
   ```
10. Re-run `npx tsx scripts/generateRunBackfill.ts --summary` any time to see the current
    directory/row/skip counts.

### The soak gate — what you are now watching for

Step 3.3 (flipping authority to the database) is **gated on this running for a few days of real
use with zero divergence.** Concretely:

- **Zero divergence looks like silence.** When disk and database agree, `shadowCompareRuns()`
  logs *nothing at all*. No news is good news.
- **A divergence looks like** a block beginning
  `[shadow] N divergence(s) between disk and database (disk=20 rows, db=20 rows). Disk remains
  authoritative:` followed by one indented `[shadow]` line per problem, each naming a run id and
  the specific field — `missing from database: <runId>`, `status differs for <runId>: disk=failed
  db=passed`, `url differs for ...`, `prompt differs for ...`, or `present in database but not on
  disk: <runId>`.
- **Expect `missing from database` for every new run you start.** Nothing writes new runs to the
  database yet — the backfill was a one-off snapshot, and dual *writes* are not part of Step 3.2.
  This is expected, not a bug, but it does mean you should re-run the backfill script before
  judging the soak, or judge only against runs that existed at backfill time.
- **Do not proceed to 3.3 while any unexplained divergence is being logged.** That is the entire
  reason this step exists.

## 8. HOW TO ROLLBACK

**Code:**
```
git revert bac6d1f
```
That removes `src/db.ts`, the shadow call in `listRuns()`, the backfill script and its tests, and
restores `listRuns()` to its pre-split form. No behavioural change results, since the shadow read
was inert by default anyway.

**Database (manual — `git revert` cannot undo a migration).** Only needed if you want the tables
gone. From the Supabase SQL editor:
```sql
drop table if exists runs cascade;
drop table if exists projects cascade;
drop table if exists organisation_members cascade;
drop table if exists organisations cascade;
```
This destroys the backfilled rows. That is safe: the database is shadow-only at this step and
`runs/` on disk remains the authoritative source for everything — nothing in the product reads
these tables yet. You can rebuild them by re-applying both migrations and re-running
`npx tsx scripts/generateRunBackfill.ts`.

**Env:** remove `DB_ENABLED` and `SUPABASE_SERVICE_ROLE_KEY` from `.env` if you want the key off
your disk.

Reverting Phase 3 alone is safe and leaves Phases 0–2 intact. To revert Phase 2 as well:
`git revert bac6d1f 8c20130` (newest first) — in that order, because this phase's bootstrap
depends on `LOCAL_USER_ID` from Phase 2.

## 9. DEFERRED

- **Nothing writes new runs to the database.** Dual *writes* were not part of Step 3.2, which
  specifies a dual-path *read* only. Consequence: any run created after the backfill will be
  reported as `missing from database` by the shadow comparison. Either re-run the backfill script
  periodically during the soak, or add a dual write — the plan folds this into 3.3's work, and
  doing it early would mean writing to a store nothing reads.
- **Step 3.3 (flip authority) and 3.4 (tenancy enforcement) are not implemented**, by agreement.
  3.4 in particular matters before a second real account exists: today any authenticated user can
  read any run.
- **The 20-run cap and the missing pagination are unchanged.** The plan retires the cap and adds
  `?limit=&cursor=` as part of 3.3.
- **Run prompts can contain secrets the user typed** (several backfilled prompts contain phrases
  like `password = ...`). This is **not** a new leak — that text was already on disk in
  `00-input.json` and already returned by `GET /api/runs` — but it is now in a second store, one
  that will eventually be multi-tenant. Worth a scrub or a warning before other people's prompts
  live in the same table. Flagged rather than fixed: it is outside this phase and changing what
  gets persisted deserves its own decision.
- **`projects` table is created but unused.** `runs.project_id` is `NULL` for all 51 backfilled
  rows. The sidebar's "projects" are still derived client-side by grouping runs by URL. Wiring the
  two together is library work (Phase 5), not this phase.
- **Free-tier projects pause after ~7 days of inactivity** (noted in the plan's Part 8). If the
  soak period includes a quiet stretch, the project may need a manual resume, and the shadow read
  will log connection errors until it does.
- Two pre-existing high-severity Playwright npm advisories remain untouched — see
  `PHASE_2_REPORT.md`'s DEFERRED for detail.

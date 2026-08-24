# Step 3.4 — Tenancy and roles (plus the sign-up screen)

Implements `implentationplan.md` **Step 3.4**, the role-enforcement half of **Step 5.4**, and the
run dual-write both depend on. Commit: `39420da`.

Everything stays behind the existing flags. With `AUTH_ENABLED` off — the default — the system
behaves identically to before, and that is proven rather than asserted: Phase 0's contract tests
pass unchanged, and the running UI was checked in a real browser (no restriction classes applied,
no console errors, Projects tree and history intact).

**Step 3.3 (flipping read authority to the database) is still NOT done**, and is still gated on
Step 3.2's soak period. Disk remains authoritative for what a run *is*; the database is consulted
only for *who owns it*.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/authz.ts` | **New.** The role ladder, `assertOrgAccess`, the three middleware, and `filterRunsForUser`. Everything authorization-related lives here. |
| `src/server/organisations.ts` | **New.** Member CRUD and the first-owner bootstrap, holding the two invariants (nobody grants above themselves; an org always keeps one owner). |
| `src/db.ts` | Exports `getServiceClient()` so authz can reuse the one cached client; adds `recordRunStarted()` / `recordRunStatus()` / `fetchRunOrgIds()`. Also **removed the organisation filter from `fetchRunsFromDb()`** — see SCHEMA CHANGES for why that was wrong the moment a second org existed. |
| `src/server/index.ts` | Mounts the role middleware on every route, scopes `GET /api/runs`, upgrades `canAccessRun` from authentication to authorization, dual-writes new runs, and adds the five new identity/membership routes. |
| `public/index.html` | Adds the `#view-signup` section, the switch links on both auth screens, and the topbar session/role badge. |
| `public/app.js` | Sign-up handling (including the email-confirmation branch), `refreshIdentity()`, `applyRoleRestrictions()`, and `"signup"` registered in `VIEWS`. |
| `public/style.css` | Appends `.auth-notice`, `.auth-switch*`, `.session-*`, and the two role-restriction rules. **New class names only.** |
| `tests/tenancy.test.ts` | **New.** 31 tests: the plan's two-org isolation matrix, the role ladder, and the flag-off path. |
| `.env.example` | Documents that roles need `DB_ENABLED` as well as `AUTH_ENABLED`, and what happens when only one is set. |

**A real bug was found and fixed during verification.** The sign-up form's client-side validation
never ran: `type="email"` + `required` + `minlength` meant the browser's native validation bubble
fired *before* submit and cancelled it, so the JS checks were unreachable dead code that looked
like coverage. The form is now `novalidate`, which makes the JS the single validation path and
keeps bad-input errors in the same `.auth-error` style as server errors. Caught in a browser, not
by the suite.

## 2. NEW FILES

- `src/server/authz.ts`
- `src/server/organisations.ts`
- `tests/tenancy.test.ts`

Four decisions worth stating plainly:

**Authorization is satisfied with the flag off, not skipped.** `AUTH_ENABLED=false` makes the
synthetic `LOCAL_USER` a genuine `owner` of the bootstrap organisation, so `assertOrgAccess` runs
its normal path and returns normally. There is no `if (authDisabled) return true` anywhere. That
is Rule 4: single-user mode is multi-user mode with one member, and the branch that would later
leak never gets written. It also means the flag-off path needs no database — the answer comes
from a constant.

**Three middleware, not one clever one.** `requireRole` (acts within your own org),
`requireRunRole` (the org that owns *this run*), `requireOrgRole` (the org named in the path). The
subject of the check genuinely differs per route, and making that explicit at each mount point is
what stops a newly-added route silently inheriting the weakest interpretation.

**Every unknown fails closed.** A run with no ownership row, an unreadable membership table, an
unreachable database — each returns "denied" or an empty list, never "probably fine". The one
place this is visible in normal use is a run created while `DB_ENABLED` was off: it has no owner
row, so with tenancy on nobody can open it. That is the correct trade, and it is why the dual-write
exists.

**Membership is cached for 5 seconds.** `GET /api/runs` is polled every couple of seconds and an
uncached lookup would mean a database round-trip per poll to re-derive an answer that almost never
changes. The staleness window is closed for the case that matters: the member-management routes
call `invalidateMemberships()` directly, so an admin demoting someone takes effect immediately.

## 3. NEW ENV FLAGS

**None.** This step adds no flag of its own — it changes what the two existing ones mean:

| Flag | Default | What it now also does |
|---|---|---|
| `AUTH_ENABLED` | unset → off | Off: the synthetic user is an owner and every check passes. On: real users, real roles, real isolation. |
| `DB_ENABLED` | unset → off | Now also gates the run dual-write and every membership/role lookup. |

**The combination that matters:** `AUTH_ENABLED=true` with `DB_ENABLED` unset **cannot enforce
roles** — membership lives in the database and there is nowhere else to read it from. Rather than
invent an answer, the server falls back to Phase 2's behaviour (any signed-in user may do
anything) and logs once, loudly:

```
[authz] AUTH_ENABLED=true but DB_ENABLED is not set. Membership lives in the database, so roles
and organisation isolation CANNOT be enforced — every signed-in user can see and do everything.
Set DB_ENABLED=true (and SUPABASE_SERVICE_ROLE_KEY) before a second account exists.
```

That combination is a misconfiguration, not a supported mode.

## 4. NEW ROUTES

All new. **No existing route's request or response shape changed anywhere in this step.**

| Method | Path | Min role | Request | Response |
|---|---|---|---|---|
| `GET` | `/api/auth/me` | authenticated | — | `{userId, email, synthetic, organisationId, role, tenancyEnforced}` |
| `POST` | `/api/auth/bootstrap` | authenticated | — | `{organisationId, organisationName, role, created}` |
| `GET` | `/api/organisations/:orgId/members` | `viewer` | — | `{members: [{userId, email, role, createdAt}]}` |
| `POST` | `/api/organisations/:orgId/members` | `admin` | `{email, role}` | `201` + the member row |
| `PATCH` | `/api/organisations/:orgId/members/:userId` | `admin` | `{role}` | the updated member row |
| `DELETE` | `/api/organisations/:orgId/members/:userId` | `admin` | — | `204` |

`GET /api/auth/me` exists so the UI can label the session and hide controls the role forbids.
**It is not a control.** Every action it reports on is independently enforced server-side; lying
to this endpoint changes what the UI draws and nothing else.

### Role gates applied to existing routes

| Route | Min role | Why |
|---|---|---|
| `GET /api/runs`, `/state`, `/events`, `/accepted-cases`, `/case-selection-status`, `GET /runs/*` | `viewer` | Reading. |
| `POST /api/runs`, `/credentials`, `/case-selection` | `editor` | Starting a run spends real money and drives a browser against someone's site. |
| `DELETE /api/runs/:runId` | `admin` | Destroying screenshots, traces and the generated spec is irreversible. |

`GET /api/runs` is scoped by **filtering rows only** — every field, its type and its order are
exactly as before, which is what keeps `public/app.js` and Phase 0's contract tests working
untouched (Rule 1).

## 5. SCHEMA CHANGES

Two migrations on `ai-test-platform` (`tvujslcqkykxwenloimg`). No table was created, altered or
dropped — this is policy only.

**`phase3_4_membership_rls_policies`** — replaces the deny-all posture with membership-scoped
`SELECT` policies on all four tables, granted **`to authenticated` only**. The `anon` role is
deliberately left with no policy at all, which is what preserves the invariant that matters: the
publishable key ships to every browser, and anything it can read is readable by anyone who views
source. No `INSERT`/`UPDATE`/`DELETE` policies exist — the server is the sole writer and holds the
service key, which bypasses RLS by design.

**`phase3_4_move_helper_out_of_api_schema`** — the membership helper needs `SECURITY DEFINER` to
break a recursion (a policy on `organisation_members` that queries `organisation_members` re-enters
its own policy). Supabase's linter correctly flagged that living in `public` gave it an RPC
endpoint at `/rest/v1/rpc/user_org_ids`. It leaked nothing — it only ever returns the caller's own
organisations — but a definer-rights function needs no HTTP surface, so it moved to a `private`
schema that PostgREST does not expose. Verified: that endpoint now `404`s.

Both use `set search_path = ''` with fully-qualified names, so a caller cannot prepend a schema
containing their own `organisation_members` table and have a definer-rights function read it.

**Supabase security advisors: zero.** (The four INFO `rls_enabled_no_policy` notices from Phase 3
are gone — the tables now have policies.)

**One behaviour fix in `fetchRunsFromDb()`:** it filtered on the Default organisation. That was
harmless with one org and wrong with two — it would have reported every second-org run as "missing
from database" and every other org's rows as absent from disk, drowning the soak signal in false
divergences. The comparison now asks the question it is actually meant to ask ("does the database
hold the same runs the disk does"), which has nothing to do with organisations.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request/response shape changed.** `GET /api/runs` filters rows; it does
  not add, rename, remove or reorder a single field. Phase 0's contract tests pass unchanged, and
  the tenancy suite re-asserts the `RunSummary` shape on the rows that do come back.
- **No `public/style.css` class was renamed or repurposed.** Only new classes were appended
  (`.auth-notice`, `.auth-switch`, `.auth-switch-btn`, `.session-badge`, `.session-email`,
  `.session-role`, and the `body.role-no-*` restriction rules). Every documented contract
  (`.hidden`, `li.completed`, `.phase-badge.running`, `.case-card.open`, `.tree-*`,
  `.view-active`) is untouched.
- **Views are only ever switched through `showView()`.** `"signup"` was registered in `VIEWS`
  alongside `"login"`. Nothing toggles `.hidden` to change screens.
- **Credential handling is untouched.** `pendingCredentials.ts` and `scrubServedSecrets` were not
  modified. Run credentials still live only in process memory and generated specs still use
  `${env:...}` references. Nothing in this step writes a credential anywhere.
- **No table was created, altered or dropped**, and no run data was modified. The `runs/`
  directory was only ever read.
- **Your "project tracker" Supabase project was not touched** — no query, no migration.
- `.env` is gitignored and confirmed absent from the commit.

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -1` → `39420da`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **441 passed** (38 files), including the 31 new
   `tests/tenancy.test.ts` cases.
3. With **no** `AUTH_ENABLED` and **no** `DB_ENABLED`, run `npm run serve`. The startup log must be
   byte-identical to before — no `[authz]` line, no `[db]` line:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
4. `curl -s http://localhost:3000/api/auth/config` → exactly `{"authEnabled":false}`.
5. `curl -s http://localhost:3000/api/auth/me` → the synthetic user, and note it is a real
   **owner**, not a bypass:
   ```json
   {"userId":"00000000-...-000000000001","email":null,"synthetic":true,
    "organisationId":"00000000-...-000000000010","role":"owner","tenancyEnforced":false}
   ```
6. Open `http://localhost:3000`. Everything must look and behave exactly as before: Home, sidebar
   with the Projects tree grouping runs by URL, History, **no login or sign-up screen**, no
   "Sign out" button, no role badge, no console errors. The "Run test" button and the History
   delete buttons must all still be visible.

### B. Turn it on

7. Paste the service-role key into `.env` (**Supabase Dashboard → `ai-test-platform` → Project
   Settings → API → `service_role`**):
   ```
   SUPABASE_SERVICE_ROLE_KEY=<paste it here>
   ```
   `.env` is gitignored, so it will not be committed.
8. Restart with both flags on:
   ```
   AUTH_ENABLED=true DB_ENABLED=true npm run serve
   ```
9. Confirm the gates, with no credential:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/runs        # 401
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health      # 200 (must stay public)
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/runs/2026-01-01T00-00-00-000Z-aaaaaaaa/x.json   # 403
   ```

### C. Create your account

10. Open `http://localhost:3000` → the **Sign in** screen, with sidebar and topbar hidden. Click
    **"Sign up"** → the sign-up screen. Try a malformed email and a 5-character password: each
    should show an inline error in the same style as a server error.
11. Sign up with your real email and a password of 8+ characters.

    **Email confirmation is currently ON for this project** (verified against the live endpoint —
    sign-up returns the created user with `confirmation_sent_at` and no session). So you will land
    back on the sign-in screen with:
    ```
    Account created. Check <your email> to confirm your address, then sign in.
    ```
    Confirm via the email, then sign in.

    **To skip confirmation for local development instead:** Supabase Dashboard → Authentication →
    Providers → Email → turn **"Confirm email"** off. Sign-up then returns a session and you land
    straight on Home, already signed in — the code handles both, no change needed.
12. Once signed in you should see the sidebar return, plus your email and an **OWNER** badge in the
    topbar. You are owner of a brand-new organisation of your own — which is empty.

### D. Claim the Default organisation (your 51 historical runs)

13. Those 51 backfilled runs belong to the bootstrap "Default" organisation, owned by the synthetic
    local user. To see them as your real account, make yourself an owner of it. In the **Supabase
    SQL editor**, replacing the email:

    ```sql
    -- vvv PUT YOUR SIGN-UP EMAIL HERE vvv
    insert into organisation_members (organisation_id, user_id, role)
    select '00000000-0000-4000-8000-000000000010', id, 'owner'
      from auth.users
     where email = 'YOUR_EMAIL@EXAMPLE.COM'
    on conflict (organisation_id, user_id) do update set role = 'owner';
    ```
    Idempotent — safe to re-run. Then reload the app (or wait 5s for the membership cache) and the
    history should fill in.

### E. Prove each role's boundary by hand

14. Add a second account (sign it up in another browser, then from your owner session):
    ```
    curl -X POST http://localhost:3000/api/organisations/<ORG_ID>/members \
      -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
      -d '{"email":"second@example.com","role":"viewer"}'
    ```
    Your token is in the browser: devtools → Application → Local Storage → `testbench.session`.
    Your `<ORG_ID>` comes from `GET /api/auth/me`.
15. Signed in as that **viewer**, confirm in the browser that the composer and "Run test" button
    are gone and History shows no delete buttons. Then confirm the server refuses regardless of
    the UI — this is the part that matters:
    ```
    curl -X POST http://localhost:3000/api/runs -H "Authorization: Bearer <VIEWER_TOKEN>" \
      -H "Content-Type: application/json" -d '{"prompt":"x","url":"https://example.com"}'   # 403
    ```
16. Promote them to **editor** (`PATCH .../members/<userId>` with `{"role":"editor"}`) and repeat —
    the same call now gets past the role gate. Then confirm they still cannot delete:
    ```
    curl -X DELETE http://localhost:3000/api/runs/<runId> -H "Authorization: Bearer <EDITOR_TOKEN>"  # 403
    ```
17. Promote to **admin**: the delete now succeeds, but they still cannot mint an owner:
    ```
    curl -X POST http://localhost:3000/api/organisations/<ORG_ID>/members \
      -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
      -d '{"email":"third@example.com","role":"owner"}'   # 403 "above your own"
    ```
18. Confirm the last owner is protected — try to demote yourself while you are the only owner:
    ```
    curl -X PATCH http://localhost:3000/api/organisations/<ORG_ID>/members/<YOUR_USER_ID> \
      -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
      -d '{"role":"viewer"}'   # 409 "this is the last owner"
    ```

### F. The RLS invariant — the one that must never regress

19. The publishable key ships to every browser. It must see **nothing**:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects; do
      printf "%-22s " "$t:"
      curl -s "$URL/rest/v1/$t?select=*&limit=3" -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
      echo
    done
    ```
    **Expected — verified at commit time:**
    ```
    runs:                  []
    organisations:         []
    organisation_members:  []
    projects:              []
    ```
    If any of these ever returns rows, run history is world-readable and that is a stop-everything
    bug. Also confirm the helper has no endpoint:
    ```
    curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/rest/v1/rpc/user_org_ids" \
      -H "apikey: $PUB" -H "Authorization: Bearer $PUB"    # 404
    ```

## 8. HOW TO ROLLBACK

**Code:**
```
git revert 39420da
```
Safe on its own and leaves Phases 0–3 intact. It removes the role middleware, the dual-write and
the sign-up screen, returning to Phase 2's "authenticated = permitted".

**Database (manual — `git revert` cannot undo a migration).** Only needed if you also want the RLS
policies gone. Reverting the code without this is fine and arguably safer: the policies deny more
than the old deny-all did in exactly zero cases, and the server uses the service key either way.
To restore Phase 3's deny-all posture:
```sql
drop policy if exists "members read their organisations" on public.organisations;
drop policy if exists "members read their rosters"       on public.organisation_members;
drop policy if exists "members read their projects"      on public.projects;
drop policy if exists "members read their runs"          on public.runs;
drop function if exists private.user_org_ids();
drop schema if exists private;
```
Row-level security stays *enabled* on all four tables, so this returns them to deny-all rather
than opening them up. **Do not disable RLS** — that is what makes the publishable key able to read
everything.

**Rows written by the dual-write** are harmless to leave (nothing reads them once the code is
gone). To remove them: `delete from runs where started_at > '<when you deployed this>';`

**Env:** no new variables to remove.

## 9. DEFERRED

- **You must still paste the service-role key.** Until then `AUTH_ENABLED=true` works but roles do
  not, and the server says so on startup. This is the one thing that could not be done for you —
  Supabase's MCP tooling exposes publishable keys only.
- **Runs created while `DB_ENABLED` was off have no owner row**, so with tenancy on nobody can open
  them (fail-closed, by design). Re-run `npx tsx scripts/generateRunBackfill.ts` to give them one —
  it assigns them to the Default organisation and is idempotent.
- **No members-management UI.** Roles are enforced and visible (the topbar badge), but adding and
  promoting people is `curl` against the new routes. The plan puts the invite flow in Step 5.4;
  this is the enforcement half only.
- **No email invites.** `POST .../members` requires the person to have signed up already. The plan
  puts Resend-backed invites in Step 5.4.
- **The 5-second membership cache** means a role change made directly in SQL (rather than through
  the routes, which invalidate) takes up to 5 seconds to take effect.
- **`GET /api/runs` still reads disk and is still capped at 20**, now filtered. A user whose runs
  are all older than the newest 20 on disk sees an empty history. This resolves itself at Step 3.3
  when the query moves to the database with real pagination.
- **Token expiry and `localStorage` storage are unchanged** from Phase 2's DEFERRED list — still no
  refresh loop, still not an `httpOnly` cookie.
- **Run prompts can contain secrets the user typed**, unchanged from Phase 3's DEFERRED list, and
  now more relevant: those prompts sit in a table that is genuinely multi-tenant. Still flagged
  rather than fixed — changing what gets persisted deserves its own decision.
- **Step 3.3 remains gated** on Step 3.2's soak. Nothing here changes that: the database now
  answers "who owns this run", but disk still answers "what runs are there".
- Two pre-existing high-severity Playwright npm advisories remain untouched — see
  `PHASE_2_REPORT.md`'s DEFERRED.

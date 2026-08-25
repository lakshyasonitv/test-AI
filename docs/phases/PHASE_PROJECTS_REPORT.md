# Phase 5.1 — Real projects, and visibility as a second access axis

**Commits:** `a4a08d5` (code), plus this report.
**Baseline:** `7fd814a`. `tsc` clean, **495/495** passing (was 470).

The request this implements, verbatim: *"create by default a user as viewer, and then admin or the
owner can add them to a particular project. The team-editing option should be visible to these 2
only, and the owner can decide the admins but not vice versa."*

The last two clauses already worked (Team screen is admin-gated; an admin gets 403 granting
`owner`) and were re-verified rather than rebuilt. The first two needed projects to be real.

---

## The model

Two independent axes. Keeping them apart is the whole design:

| | Lives in | Answers |
|---|---|---|
| **Organisation role** | `organisation_members.role` | What you may **DO** — `viewer` < `tester` < `admin` < `owner` |
| **Project membership** | `project_members` (new) | What you may **SEE** |

`project_members` deliberately has **no role column**. The org role already answers "may this
person delete a run"; duplicating the ladder per project would put the same question in two places
and guarantee they drift.

**Visibility:** admins and owners see every project in their organisation *by role* — scoping
someone who manages the org is friction with no security value. Testers and viewers see only what
they were added to. A new account is added to nothing, which is exactly the requested state.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/projects.ts` | **New.** Project CRUD, project membership, and URL→project inference for new runs. |
| `src/server/authz.ts` | Owns `visibleProjectIds()` (an authorization question, and `filterRunsForUser` needs it — putting it in projects.ts would make the two modules import each other). `filterRunsForUser` now applies both gates. New `canViewRun()`. `requireRunRole` now checks project visibility too. |
| `src/server/index.ts` | Seven new project routes; the artifact guard delegates to `canViewRun`; `POST /api/runs` files the run under a project. |
| `src/server/organisations.ts` | `bootstrapUser` joins the existing workspace as `viewer` instead of creating a private org owned by the new account. `roleOfMember` exported so project routes can require org membership first. |
| `src/db.ts` | `fetchRunScopes()` (org **and** project in one lookup), `recordRunProject()`. |
| `public/app.js` | Sidebar reads real projects from the API, with the old URL grouping kept as the no-database fallback. Team screen shows and edits project assignments. |
| `public/style.css` | Additive classes for the assignment chips. No existing class renamed or repurposed. |
| `tests/tenancy.test.ts` | Project fixtures and 25 new cases. |

## 2. NEW FILES

- `src/server/projects.ts`
- `docs/phases/PHASE_PROJECTS_REPORT.md`

No new frontend files — the sidebar and Team screen already existed.

## 3. NEW ENV FLAGS

**None.** Project scoping rides on the existing `AUTH_ENABLED` / `DB_ENABLED` pair: with either
off, `canEnforceTenancy()` is false and the synthetic user is `owner`, so nothing is scoped.

## 4. NEW ROUTES

All new; no existing route's request or response shape changed.

| Method | Path | Role | Request | Response |
|---|---|---|---|---|
| GET | `/api/projects` | viewer | — | `{projects:[{id,name,baseUrl,runCount}]}` |
| POST | `/api/projects` | admin | `{name, baseUrl?}` | `201 {id,name,baseUrl,runCount}` |
| PATCH | `/api/projects/:id` | admin | `{name?, baseUrl?}` | `{id,name,baseUrl}` |
| DELETE | `/api/projects/:id` | admin | — | `204`, or `409` if it still holds runs |
| GET | `/api/projects/:id/members` | admin | — | `{members:[{userId,email}]}` |
| POST | `/api/projects/:id/members` | admin | `{userId}` or `{email}` | `201 {ok,userId}` |
| DELETE | `/api/projects/:id/members/:userId` | admin | — | `204` |
| GET | `/api/organisations/:orgId/assignments` | admin | — | `{assignments:{userId:[projectId]}}` |

**`POST /api/runs` gains an optional `projectId`.** Additive only — absent behaves exactly as
before. It is never trusted as authority: the organisation still comes from the session, so a
project id outside it simply doesn't resolve. With no id, the project is inferred from the URL.

## 5. SCHEMA CHANGES

Three migrations:

1. **`phase5_project_members`** — the `project_members` table (`project_id`, `user_id`,
   `created_at`; PK on both ids), an index on `user_id`, RLS enabled, and a SELECT-only policy for
   `authenticated` scoped through `private.user_org_ids()`. No policy for `anon` — that is what
   keeps the publishable key seeing nothing.
2. **`phase5_consolidate_stray_orgs`** — earlier phases' end-to-end tests left three organisations
   behind. Runs were moved into the bootstrap workspace, human accounts joined it as `viewer`, and
   the empty solo orgs were dropped. **Accounts were moved, never deleted.**
3. **`phase5_backfill_projects_from_run_urls`** — promoted the sidebar's client-side grouping into
   real rows.

**Migration result:** 53 runs → **11 projects, 0 unfiled**.

| Project | Runs | | Project | Runs |
|---|---|---|---|---|
| learnvibes.vercel.app | 26 | | www.saucedemo.com | 2 |
| allen.in | 8 | | adfgadf.app | 1 |
| thinkvibes.com | 4 | | assettrack-web.onrender.com | 1 |
| www.amazon.in | 4 | | assettrack-web.onrender.com/login | 1 |
| the-internet.herokuapp.com | 3 | | the-internet.herokuapp.com/login | 1 |
| example.com | 2 | | | |

The key matches `normalizeUrlKey()` in `public/app.js` exactly — protocol stripped, trailing
slashes stripped, lowercased, **path retained** — so nothing regrouped under you. That fidelity is
also why two near-duplicate pairs exist (`…/login` split from its host); an admin can rename or
merge them with `PATCH /api/projects/:id`. Runs with no usable URL would have gone to an
"Unsorted" project; none needed it.

## 6. WHAT I DID NOT TOUCH

- **No existing route contract changed.** Every addition is a new route or an optional additive
  field. `GET /api/runs` filters rows only — every field, type and order is untouched, which is
  what keeps `public/app.js` and the Phase 0 contract tests working unchanged.
- **No `style.css` class renamed or repurposed.** Only additive classes (`.team-projects`,
  `.team-chip`, `.team-chip-x`, `.team-assign`, `.team-projects-all/-none`).
- **View switching still goes through `showView()`.** No new view was needed; nothing toggles
  `.hidden` directly.
- **Credential handling untouched.** `pendingCredentials.ts` and `scrubServedSecrets` unchanged;
  credentials still live in process memory only and specs still use `${env:...}`.
- **The other Supabase project (`project tracker`) was never touched.**

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -1` → `a4a08d5`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **495 passed** (39 files). Was 470; the 25 new
   cases are the two `projects —` blocks in `tests/tenancy.test.ts`.
3. With **no** `AUTH_ENABLED` and **no** `DB_ENABLED`, run `npm run serve`. The startup log must be
   byte-identical — no `[authz]`, `[db]`, `[shadow]` or `[projects]` lines:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
4. `curl -s http://localhost:3000/api/auth/config` → exactly `{"authEnabled":false}`.
5. Open `http://localhost:3000`. Everything as before: Home, sidebar projects, History, the
   "Run test" button — no login screen, no Team button, no badge, no console errors.

### B. The no-database case still has a sidebar

This is the default mode and the one most easily broken by this change, since project rows live in
Postgres.

6. Start the server **without** loading `.env` at all, so Supabase is genuinely unconfigured:
   ```
   node --import tsx src/server/index.ts
   ```
7. `curl -s http://localhost:3000/api/projects`
   → `503 {"error":"the database is not configured — set DB_ENABLED=true and SUPABASE_SERVICE_ROLE_KEY"}`
8. Open `http://localhost:3000`. **The sidebar must still list projects** — the frontend falls back
   to grouping runs by URL, exactly as it did before projects were real. Verified at commit time:
   ```json
   {"activeView":"home","projectRows":["https://learnvibes.vercel.app","https://allen.in",
    "https://www.amazon.in","https://assettrack-web.onrender.com/login","https://adfgadf.app"],
    "teamBtnDisplay":"none","badgeHidden":true,"bodyClasses":"","runBtn":true}
   ```

### C. The owner sees everything

9. Restart with both flags on:
   ```
   AUTH_ENABLED=true DB_ENABLED=true npm run serve
   ```
10. Sign in as `garvit.khandelwal@thinkvibes.com` / `111111`.

    **Chrome autofill will fight you on this form** — it overwrites the email field with a stale
    saved address, which is what made an earlier "invalid credentials" look like an app bug. Clear
    with `Ctrl+A` and retype, `Esc` to dismiss. To fix permanently: `chrome://settings/passwords`
    → find `localhost` → delete the wrong entry.
11. The sidebar lists **11 projects** with their full counts (learnvibes 26, allen.in 8, …), not
    the newest-20 subset. Verified: `projects: 11 | runs across them: 53`, history rows 20 (the
    disk cap is unchanged).

### D. A new account is a viewer with nothing — the point of the request

12. Sign up a fresh address (Sign in → **Sign up**, 8+ character password). You land on Home,
    signed in, badge reads **VIEWER**.
13. The sidebar reads **"You're not in any project yet. Ask an admin to add you to one."** — not a
    bare "No projects yet", which reads as a bug to someone who was just told to sign up.
    Verified at commit time:
    ```json
    {"sidebarText":"You're not in any project yet. Ask an admin to add you to one.",
     "role":"viewer","teamBtnHidden":true,"bodyClasses":"role-no-edit role-no-admin",
     "runBtnVisible":false}
    ```
14. Confirm they belong to the **shared** workspace, not a private one:
    ```
    curl -s -H "Authorization: Bearer <THEIR_TOKEN>" http://localhost:3000/api/auth/me
    ```
    → `"organisationId":"00000000-0000-4000-8000-000000000010"`, `"role":"viewer"`.
15. **The server refuses regardless of what the UI drew.** Verified at commit time returning
    `403, 403, 403, 403`:
    ```
    curl -s -o /dev/null -w "start a run       %{http_code}\n" -X POST http://localhost:3000/api/runs \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"prompt":"x","url":"https://example.com"}'
    curl -s -o /dev/null -w "read assignments  %{http_code}\n" -H "Authorization: Bearer $TOK" \
      "http://localhost:3000/api/organisations/00000000-0000-4000-8000-000000000010/assignments"
    curl -s -o /dev/null -w "create a project  %{http_code}\n" -X POST http://localhost:3000/api/projects \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"name":"sneaky"}'
    curl -s -o /dev/null -w "add self to proj  %{http_code}\n" -X POST "http://localhost:3000/api/projects/<PROJ>/members" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"userId":"<THEIR_ID>"}'
    ```

### E. An admin adds them to one project, and only that project appears

16. As the owner, open **Team**. Their row shows *"No projects yet — they can't see anything."*
    with an **+ Add to project…** picker. Owner and admin rows instead read *"Sees every project
    (by role)"* — listing projects for them would be a lie the moment a new one is created.
17. Add them to `allen.in` (8 runs). Wait ~6s for the visibility cache, then as that account:
    ```
    curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/api/projects
    curl -s -H "Authorization: Bearer $TOK" http://localhost:3000/api/runs
    ```
    **Expected — verified at commit time:** `projects: allen.in (8)`, `runs visible: 8`, and every
    URL in that list is an `allen.in` one. The other 45 runs are gone, not merely hidden.
18. **The artifact guard applies the same rule.** Screenshots and videos are fetched by
    `<img>`/`<video>`, which bypass every frontend check, so a weaker guard here would leak the
    pictures of a run whose row was already hidden. Verified at commit time:
    ```
    viewer -> own project's artifact   : 200
    viewer -> other project's artifact : 403
    viewer -> other project's state    : 403
    owner  -> other project's artifact : 200
    ```

### F. The RLS invariant — the one that must never regress

19. `project_members` is a new table, so re-confirm the browser-facing key sees nothing across all
    five:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects project_members; do
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
    project_members:       []
    ```
    If any returns rows, run history is world-readable — stop everything.
20. Supabase security advisors report only the pre-existing
    `auth_leaked_password_protection` warning. No new RLS findings.

## 8. HOW TO ROLLBACK

```
git revert a4a08d5
```

**Manual steps** — the code revert alone leaves the database ahead of it, which is harmless
(unused columns and tables) but not clean. To fully reverse, in the Supabase SQL editor:

```sql
-- Un-file every run (the column stays; it predates this phase)
update runs set project_id = null;

-- Drop this phase's table and the rows it created
drop table if exists project_members;
delete from projects where organisation_id = '00000000-0000-4000-8000-000000000010';
```

**Not reversible:** the org consolidation (migration 2). Three organisations were merged into the
bootstrap workspace and the empty ones dropped. No account or run was deleted — accounts moved to
`Default` and every run was preserved — but the original org boundaries are gone. They were
end-to-end test debris, not real tenants.

Reverting the code without the SQL is safe: nothing reads `project_members` once
`src/server/projects.ts` is gone.

## 9. DEFERRED

- **Single-company assumption.** Every sign-up joins the one bootstrap organisation as `viewer`.
  Correct for one company running this locally, and exactly what was asked for. **Wrong the moment
  two unrelated customers share an instance** — sign-up would need an invite token or a
  domain-matching rule, and `bootstrapUser` is the one function to change.
- **`GET /api/organisations/:orgId/addable-users` still returns every registered address to any
  admin** (flagged in the sign-up phase and unchanged here). Fine for one company; a privacy leak
  across customers.
- **Two near-duplicate project pairs** (`assettrack-web.onrender.com` vs `…/login`, and the same
  for `the-internet.herokuapp.com`). A faithful consequence of keying on the URL *path* so nothing
  regrouped under you. `PATCH /api/projects/:id` can rename them; merging runs between projects has
  no route yet.
- **No "move a run to another project" route.** `DELETE /api/projects/:id` therefore refuses while
  a project still holds runs, rather than orphaning them — deliberate, since run history is the
  evidence this product exists to produce, but it means an unwanted project with runs in it cannot
  currently be removed.
- **`ls@thinkvibes.com` was preserved, not deleted.** It is a real account (not generated test
  debris) that existed before this phase, and it now sits in `Default` as `viewer` — which is where
  the new sign-up flow would have put it. Deleting someone's real account was not a call to make
  silently. The generated `proj-e2e-*` and `signup-e2e-*` accounts were deleted.
- **Project membership has no audit trail.** `project_members.created_at` records when, not who by.
- **A `tester` cannot start a run against a project they can't see**, but nothing stops them
  starting one against an arbitrary URL, which creates a new project they then can't see either.
  Worth a rule once projects are managed deliberately rather than inferred.

---

## Final database state

```
orgs 1 · members 3 · projects 11 · project_assignments 0 · runs 53 · unfiled_runs 0 · accounts 2
```

Roster:

| Who | Org | Role |
|---|---|---|
| (synthetic local user) | Default | **owner** |
| garvit.khandelwal@thinkvibes.com | Default | **owner** |
| ls@thinkvibes.com | Default | viewer |

The synthetic local user being `owner` is load-bearing: it is the identity `AUTH_ENABLED=false`
uses, and if it is demoted the flag-off app silently starts hiding controls.

# Team management UI, and `editor` → `tester`

Two things, both asked for directly: *"admin should be able to give the roles, and the roles
should be of testers who can communicate with the AI and then generate the test cases."*

The capability already existed — Step 3.4 gave `editor` the right to start runs, answer the
credential prompt and drive the case-selection gate, which **is** "talk to the AI and generate
test cases". What was missing was a way for an admin to assign it without `curl`, and a name that
said what the role actually does. So: a Team screen, and a rename.

**No new permission was invented.** Every control on the Team screen maps to a route that already
existed and was already enforced (`/api/organisations/:orgId/members`, Step 3.4). This is UI over
an existing contract.

Commit: `889b0c7`. The report itself lands in the commit after it.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/authz.ts` | `ROLES` and `ROLE_RANK`: `editor` → `tester`. Same four levels, same order, same meaning. |
| `src/server/index.ts` | The three `requireRole`/`requireRunRole` mounts and the two 400-message strings now say `tester`. |
| `public/index.html` | Adds the `#teamBtn` topbar entry point (hidden by default) and the `#view-team` section. |
| `public/app.js` | The Team screen: `renderTeamView()`, `teamCall()`, `teamFeedback()`, `ROLES_ASC`/`teamRoleOptions()`. Registers `"team"` in `VIEWS` and routes `#/team`. Mirrors the rename in `ROLE_RANK`. Stores `auth.userId` so a row can be marked as yours. |
| `public/style.css` | Appends the `.team-*` classes. **New class names only.** |
| `tests/tenancy.test.ts` | Renamed `EDITOR_A` → `TESTER_A` and its fixture role; adds 8 cases for the Team screen's server side. The Supabase mock gained `insert`/`update`/`delete`. |
| `docs/phases/PHASE_3_4_REPORT.md` | Three pointers to the rename, and its "no members-management UI" deferral marked done. |

### Two things worth stating

**A real bug was found in a browser, not by the suite.** `teamCall()` wrote its success message
into `#teamFeedback` and *then* called `renderTeamView()`, which rebuilds the whole view body —
including `#teamFeedback`. Every successful add or role change silently ate its own confirmation.
The error path was unaffected (it throws past the re-render), which is exactly why it stayed
invisible: the messages you'd go looking for — the 403s and 409s — were the ones that worked.
Fixed by re-rendering first, then writing the message.

**The mock had no write methods.** Every pre-existing role test asserts a *refusal* (403/409/400),
and all of those short-circuit before the database is touched. The first test to assert a
*successful* mutation hit a 500, because `makeBuilder` implemented only `select`/`eq`/`in`.
`insert`/`update`/`delete` were added as chainable no-ops that report success without mutating the
fixture — deliberately, so assertions can't depend on the order tests happen to run in.

## 2. NEW FILES

None. Every change is to a file that already existed.

## 3. NEW ENV FLAGS

**None.** The Team screen appears when `AUTH_ENABLED=true` and the signed-in account is `admin` or
`owner`. With `AUTH_ENABLED` off — the default — the synthetic user is the only member, so there
is no team to manage and the entry point stays hidden. Behaviour is byte-identical to before.

## 4. NEW ROUTES

**None.** The Team screen calls the four member routes shipped in Step 3.4, unchanged:

| Method | Path | Min role |
|---|---|---|
| `GET` | `/api/organisations/:orgId/members` | `viewer` — **scoped below admin since D-36**: yourself plus members sharing a project with you. See `PHASE_TEAM_SCOPED_ROSTER_REPORT.md` |
| `POST` | `/api/organisations/:orgId/members` | `admin` |
| `PATCH` | `/api/organisations/:orgId/members/:userId` | `admin` |
| `DELETE` | `/api/organisations/:orgId/members/:userId` | `admin` |

**No existing route's request or response shape changed.** The only difference on the wire is that
two 400 messages now list `tester` instead of `editor` in their enumeration of valid roles, and
the `role` field accepts/returns `tester`.

### The ladder

`viewer` < `tester` < `admin` < `owner`

| Role | Can |
|---|---|
| `viewer` | Read runs, results and artifacts. Nothing else. |
| `tester` | Everything a viewer can, **plus start runs, answer the login prompt, and pick cases at the selection gate** — this is the "talks to the AI and generates test cases" role. Cannot delete. |
| `admin` | Everything a tester can, plus manage members and delete runs. |
| `owner` | Everything. |

## 5. SCHEMA CHANGES

One migration on `ai-test-platform` (`tvujslcqkykxwenloimg`):

**`rename_editor_role_to_tester`** — migrates existing rows, *then* swaps the CHECK constraint:

```sql
update public.organisation_members set role = 'tester' where role = 'editor';

alter table public.organisation_members drop constraint if exists organisation_members_role_check;
alter table public.organisation_members add constraint organisation_members_role_check
  check (role = any (array['owner'::text, 'admin'::text, 'tester'::text, 'viewer'::text]));
```

Order is deliberate — swapping the constraint first would leave any `editor` row violating the
constraint it is checked against.

**Rows migrated: 0.** Checked before running: the table held exactly two rows, both `owner` (the
synthetic local user and `garvit.khandelwal@thinkvibes.com`). The `update` was a no-op in practice
but is kept so the migration is correct on any database that *does* hold `editor` rows.

Constraint verified after: `CHECK ((role = ANY (ARRAY['owner', 'admin', 'tester', 'viewer'])))`.

**No table was created, altered or dropped. No RLS policy was touched.**

## 6. WHAT I DID NOT TOUCH

- **No existing route's request/response shape changed.** Phase 0's contract tests pass unchanged.
- **No `public/style.css` class was renamed or repurposed.** Only new `.team-*` classes were
  appended, plus one new rule (`body.role-no-admin #teamBtn`). Every documented contract
  (`.hidden`, `li.completed`, `.phase-badge.running`, `.case-card.open`, `.tree-*`,
  `.view-active`, `.role-no-edit`, `.role-no-admin`) is untouched. The screen reuses `.panel`,
  `.field`, `.dl-btn-inline`, `.tree-empty`, `.eyebrow`, `.page-head-title` and `.tagline` rather
  than inventing parallel names.
- **Views are only ever switched through `showView()`.** `"team"` was registered in `VIEWS` and
  `#/team` routes through `applyRoute()`. Nothing toggles `.hidden` to change screens — the only
  `.hidden` toggle added is on the topbar *button*, which is not a view.
- **Credential handling is untouched.** `pendingCredentials.ts` and `scrubServedSecrets` were not
  modified.
- **No RLS policy was changed**, and the invariant was re-verified (section F below).
- **Your "project tracker" Supabase project was not touched.**
- **The WordPress CSS in `tests/fixtures/irGroqToGeminiReplay/*.json` was left alone.** Those files
  contain `--wp-editor-canvas-background` and `#end-resizable-editor-section` in captured page
  data. A blind find-and-replace would have corrupted two replay fixtures.
- **Historical statements in the earlier phase reports were left true.** `PHASE_3_4_REPORT.md`
  still says it shipped `editor`, because it did; three pointers to this document were added
  rather than rewriting history into something that never happened.
- `.env` is gitignored and confirmed absent from the commit.

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -2` → the report commit, then `889b0c7`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **449 passed** (38 files). Was 441; the 8 new
   cases are the `team management` block in `tests/tenancy.test.ts`.
3. With **no** `AUTH_ENABLED` and **no** `DB_ENABLED`, run `npm run serve`. The startup log must be
   byte-identical to before — no `[authz]`, `[db]` or `[shadow]` lines:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
4. `curl -s http://localhost:3000/api/auth/config` → exactly `{"authEnabled":false}`.
5. Open `http://localhost:3000`. Everything must look exactly as before: Home, the sidebar with the
   Projects tree, History, the "Run test" button — and **no Team button**, no session badge, no
   Sign out, no console errors. Verified at commit time via devtools:
   ```json
   {"teamBtnDisplay":"none","badgeHidden":true,"signOutHidden":true,
    "bodyClasses":"","runBtn":true,"projects":5}
   ```

### B. Turn it on and open the Team screen

6. Restart with both flags on (the service-role key must already be in `.env`):
   ```
   AUTH_ENABLED=true DB_ENABLED=true npm run serve
   ```
7. Sign in at `http://localhost:3000` as your owner account. A **Team** button now appears in the
   topbar between History and Settings.
8. Click it. You should see "Who can use this workspace", an add-member form (email + role picker
   defaulting to **tester**), and one row per member. Your own row is tagged **YOU**.

   One row will read **"(unknown address)"** — that is the synthetic local user
   (`00000000-…-000000000001`) that owns the bootstrap organisation. It has no `auth.users`
   record, so there is no email to show. Expected, not a bug.

### C. Add someone and give them a role

9. You need a second account to add. Sign-up through the UI works but this project has email
   confirmation on, so the quickest route for testing is the Admin API:
   ```
   SRK=$(grep "^SUPABASE_SERVICE_ROLE_KEY=" .env | cut -d= -f2-)
   curl -s -X POST "https://tvujslcqkykxwenloimg.supabase.co/auth/v1/admin/users" \
     -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
     -d '{"email":"someone@example.com","password":"testpass12345","email_confirm":true}'
   ```
10. On the Team screen, type that email, leave the role as **tester**, click **Add to team**. The
    row appears with the description *"Runs tests — talks to the AI, answers login prompts, picks
    cases. Cannot delete."* and a green **"someone@example.com added as tester."** confirmation.
11. Change their role with the dropdown on their row. The confirmation reads **"Role changed to
    admin."** — verified at commit time returning `{"feedbackHTML":"Role changed to admin.",
    "feedbackClass":"team-ok"}`.

### D. Prove each role's boundary — the part that matters

The Team screen hides controls a role can't use. That is a courtesy. These steps confirm the
server refuses regardless of what was drawn.

12. Get a token for the second account and set `ORG` from `GET /api/auth/me`:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    ORG="00000000-0000-4000-8000-000000000010"
    TOK=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $PUB" \
      -H "Content-Type: application/json" \
      -d '{"email":"someone@example.com","password":"testpass12345"}' \
      | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).access_token))")
    ```
13. **As an `admin`, they still cannot mint an owner** — the guard rail returns its own sentence,
    and the Team screen renders it inline rather than swallowing it:
    ```
    curl -s -X POST "http://localhost:3000/api/organisations/$ORG/members" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
      -d '{"email":"nobody@example.com","role":"owner"}'
    ```
    → `403 {"error":"you cannot grant the owner role — it is above your own"}`
14. Demote them to **tester** (from your owner session, via the UI or `PATCH`), wait ~6s for the
    membership cache, then confirm every management action is refused:
    ```
    curl -s -o /dev/null -w "add    %{http_code}\n" -X POST "http://localhost:3000/api/organisations/$ORG/members" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"email":"x@example.com","role":"viewer"}'
    curl -s -o /dev/null -w "change %{http_code}\n" -X PATCH "http://localhost:3000/api/organisations/$ORG/members/<THEIR_USER_ID>" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"role":"admin"}'
    curl -s -o /dev/null -w "remove %{http_code}\n" -X DELETE "http://localhost:3000/api/organisations/$ORG/members/<THEIR_USER_ID>" \
      -H "Authorization: Bearer $TOK"
    ```
    **Expected — verified at commit time: `403`, `403`, `403`.**
15. **But a tester can still do the job the role is named for:**
    ```
    curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/runs \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"prompt":"x"}'
    ```
    → **`400`**, not `403`. A 400 means it got *past* the role gate and was rejected by the
    handler's own validation (no URL). Deliberately invalid so no Gemini spend is triggered.
16. Sign in as that tester in the browser. The **Team button is gone**, the badge reads **TESTER**,
    and the **"Run test" button is still there**. Verified at commit time:
    ```json
    {"role":"tester","teamBtnHidden":true,"teamBtnDisplay":"none","bodyClasses":"role-no-admin"}
    ```

### E. The last-owner guard

17. While you are the only owner, try to demote yourself:
    ```
    curl -s -X PATCH "http://localhost:3000/api/organisations/$ORG/members/<YOUR_USER_ID>" \
      -H "Authorization: Bearer <YOUR_TOKEN>" -H "Content-Type: application/json" \
      -d '{"role":"viewer"}'
    ```
    → `409 {"error":"this is the last owner — promote someone else to owner first"}`

    On the Team screen the same rule shows up as an *absence*: the last owner's row renders their
    role as static text with no dropdown and no Remove button, because every option would be
    refused. Hover it for the reason.

### F. The RLS invariant — the one that must never regress

18. A constraint was swapped, so re-confirm the publishable key still sees nothing:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects; do
      printf "%-22s " "$t:"
      curl -s "$URL/rest/v1/$t?select=*&limit=3" -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
      echo
    done
    curl -s -o /dev/null -w "rpc: %{http_code}\n" -X POST "$URL/rest/v1/rpc/user_org_ids" \
      -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
    ```
    **Expected — verified at commit time:**
    ```
    runs:                  []
    organisations:         []
    organisation_members:  []
    projects:              []
    rpc: 404
    ```
    If any of these ever returns rows, run history is world-readable — stop everything.

### G. Clean up

19. Delete the test account when done, so it isn't left with standing access:
    ```
    curl -s -X DELETE "$URL/auth/v1/admin/users/<THEIR_USER_ID>" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
    ```
    then remove their membership row in the Supabase SQL editor:
    ```sql
    delete from organisation_members where user_id = '<THEIR_USER_ID>';
    ```
    (Both were done for the account used to verify this report — the roster is back to its
    original two owners.)

## 8. HOW TO ROLLBACK

**Code:**
```
git revert 889b0c7
```
Safe on its own. It removes the Team screen and restores `editor` throughout the code.

**Database (manual — `git revert` cannot undo a migration).** The code revert alone would leave
the constraint accepting `tester` while the code writes `editor`, so if you revert the code you
**must** also run this:
```sql
update organisation_members set role = 'editor' where role = 'tester';

alter table organisation_members drop constraint if exists organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role = any (array['owner'::text, 'admin'::text, 'editor'::text, 'viewer'::text]));
```
Same ordering rule as the forward migration: migrate rows first, swap the constraint second.

**Env:** no new variables to remove.

## 9. DEFERRED

- **No email invites.** `POST .../members` still requires the person to have signed up already —
  the Team screen surfaces the server's *"no account with that email — they must sign up first"*
  when they haven't. The plan puts Resend-backed invites in Step 5.4.
- **The synthetic local user shows as "(unknown address)"** on the roster. It genuinely has no
  `auth.users` row. Harmless, but a real deployment would want it labelled or hidden once auth is
  permanently on.
- **Leaked-password protection is off** (Supabase security advisor, WARN). Not caused by anything
  here — it is the project default — but worth turning on given the app now has real accounts:
  Dashboard → Authentication → Policies. Supabase also enforces no minimum password strength
  beyond 6 characters by default, which is why an account with a trivial password can exist.
- **Two INFO performance advisors on `public.projects`** (unindexed FK `runs_project_id_fkey`, and
  the unused `projects_organisation_id_idx`). Both pre-date this change and both concern the
  `projects` table, which is empty and unwired until Phase 5. Not worth an index on a table with
  no rows and no queries.
- **The 5-second membership cache** still applies: a role changed directly in SQL takes up to 5
  seconds to take effect. Changes made *through* the Team screen are immediate — those routes call
  `invalidateMemberships()`.
- **`ROLE_RANK` is mirrored by hand** between `src/server/authz.ts` and `public/app.js`. A test now
  asserts the server's ladder shape, so a rename can't silently half-land, but the mirror itself is
  still manual. The failure mode is benign — a control offered that the server then refuses.
- **Everything in `PHASE_3_4_REPORT.md`'s DEFERRED list still stands**, including that Step 3.3 is
  gated on Step 3.2's soak, and that runs created while `DB_ENABLED` was off have no owner row.
  The `[shadow] missing from database: 2026-08-24T14-52-21-559Z-1b7068a6` line seen during
  verification is exactly that, and is expected.

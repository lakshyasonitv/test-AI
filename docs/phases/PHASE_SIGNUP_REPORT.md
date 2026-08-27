# Server-side sign-up, and addable-account suggestions

Two things, both from direct reports: *"after I create the account it should go to the home page
but it is not going on that page"*, and *"merko suggestion bhi aane chaiye na jiska account create
hua hai uska"*.

The first turned out to be worse than described. Sign-up was not failing to redirect — it was
failing entirely.

Commit: `3ba42d0`. The report lands in the commit after it.

## The bug, stated precisely

`POST https://tvujslcqkykxwenloimg.supabase.co/auth/v1/signup` with the publishable key returns
**HTTP 504 `upstream request timeout` after ~35 seconds.** Reproduced from curl, twice, before
changing anything.

Cause: this project has email confirmation **on**, so Supabase attempts to send the confirmation
mail through its built-in free-tier sender, and that hangs. No account is ever created. The
sign-up screen sat on "Creating account…" until the request died, then showed an error.

**This was not fixed by turning "Confirm email" off in the Supabase dashboard**, deliberately. That
is a console toggle nothing in this repo can assert on, in a Supabase account the person running
this app is not necessarily signed into (their browser is signed into a different org than the one
owning this project). A route we own is testable and cannot silently regress. As a side benefit the
fix works regardless of how that setting is left.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/signup.ts` | **New.** The Admin-API account creation, the validation, and the per-IP rate limiter. |
| `src/server/index.ts` | Adds `POST /api/auth/signup` (public) and `GET /api/organisations/:orgId/addable-users` (admin). Adds `/auth/signup` to `PUBLIC_API_PATHS`. |
| `src/server/organisations.ts` | Adds `listAddableUsers()` — registered accounts minus this organisation's current members. |
| `public/app.js` | The sign-up form now posts to `/api/auth/signup` instead of Supabase, and always lands on Home. Removes the dead "check your email" branch and its `signupNotice` references. Adds the datalist fetch on the Team screen. |
| `public/index.html` | Removes the `#signupNotice` element (its only writer is gone). |
| `public/style.css` | Removes the `.auth-notice` rule, replaced by a comment saying why. **No existing class renamed or repurposed.** |
| `tests/signup.test.ts` | **New.** 15 cases: happy path, `email_confirm:true`, validation, refusals, rate limiting. |
| `tests/tenancy.test.ts` | Adds 6 cases for the suggestions route's admin gate, plus a `DIRECTORY` fixture so `listUsers` returns something to filter. |
| `.env.example` | Documents `SIGNUP_ENABLED`, with the exposure warning. |

### The dead branch was removed, not left in place

Phase 2's sign-up handled two outcomes: a session (confirmation off) and "check your email"
(confirmation on). With sign-up going through the Admin API the account is *always* pre-confirmed,
so the second outcome can no longer occur. Leaving it would have been copy describing a flow that
no longer exists, so `#signupNotice` and `.auth-notice` are gone. `style.css` keeps a comment where
the rule was, explaining why.

## 2. NEW FILES

- `src/server/signup.ts`
- `tests/signup.test.ts`

The rate limiter is in-process and per-IP, in the same spirit as `Semaphore` in `concurrency.ts`:
no dependency, no shared store, obvious to read. It is a speed bump against someone scripting
account creation against a tunnelled port, **not** access control — a second server instance would
have its own counter. Sufficient for the single local process this runs on, and `SIGNUP_ENABLED` is
the real control.

It counts *attempts*, not successes, on purpose: otherwise the duplicate-email 409 becomes an
unlimited oracle for "is this address registered?".

## 3. NEW ENV FLAGS

| Flag | Default | What it does | When flipped |
|---|---|---|---|
| `SIGNUP_ENABLED` | unset → **on** | Whether `POST /api/auth/signup` will create accounts. | `false`: the route 403s. The sign-up screen still renders but cannot complete; add people from the Team screen instead. |

### Why this one defaults ON when every other flag defaults off

It looks like an exception and isn't. The entire sign-up path only exists when `AUTH_ENABLED=true`,
which itself defaults off — with the shipped defaults there is no login screen, no sign-up screen,
and the route returns 404. So the **system** default is unchanged. This flag only decides what
happens once someone has already opted into auth, where a sign-up screen that cannot create
accounts would be pointless.

### ⚠️ SET `SIGNUP_ENABLED=false` BEFORE EXPOSING THIS SERVER BEYOND LOCALHOST

`POST /api/auth/signup` is unauthenticated by necessity — an account that does not exist yet cannot
present a token — and it creates real accounts using the service-role key. The rate limit slows
abuse; it does not prevent it. Anyone who can reach the port can otherwise sign themselves up, and
each new account gets its own workspace and can start runs that spend your Gemini budget.

This matters the first time you put this behind a tunnel for someone else to try.

## 4. NEW ROUTES

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/auth/signup` | `{ email: string, password: string }` | `201 { accessToken, refreshToken, user: { id, email } }`. `400` invalid email / password under 8 chars / missing fields. `403` `SIGNUP_ENABLED=false`. `404` `AUTH_ENABLED` off. `409` address already registered. `429` rate limited. `502` upstream failure. `503` Supabase not configured. **Public** — listed in `PUBLIC_API_PATHS` alongside `/health` and `/auth/config`. |
| `GET` | `/api/organisations/:orgId/addable-users` | — | `200 { emails: string[] }` — registered accounts *not* already in this organisation, sorted. `admin`+ via the existing `requireOrgRole`. |

**No existing route's request or response shape changed.** Phase 0's contract tests pass unchanged.

Guard ordering in the sign-up route is deliberate: flag → rate limit → validation → Supabase. A
disabled or flooded endpoint costs nothing and never reaches the network.

## 5. SCHEMA CHANGES

**None.** No migration, no table, no column, no RLS policy touched. The RLS invariant was
re-verified anyway (section E below) because new rows now arrive via a new path.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request/response shape changed.** Both additions are new routes.
- **No `public/style.css` class was renamed or repurposed.** One rule (`.auth-notice`) was
  *removed* because its only element is gone; every documented contract (`.hidden`,
  `li.completed`, `.phase-badge.running`, `.case-card.open`, `.tree-*`, `.view-active`,
  `.role-no-edit`, `.role-no-admin`, `.team-*`, `.auth-card`, `.auth-error`) is untouched.
- **No new view was added**, so nothing needed registering in `VIEWS`. Sign-up already routed
  through `showView()` and still does — the success path calls `navigate("#/")` then `applyRoute()`.
  Nothing toggles `.hidden` to change screens.
- **Credential handling is untouched.** `pendingCredentials.ts` and `scrubServedSecrets` were not
  modified. The sign-up password follows the same rule run credentials do: passed through, never
  logged, never stored, never returned.
- **No new permission concept.** The suggestions route goes through the same
  `requireOrgRole`/`assertOrgAccess` path as every other member route.
- **`AUTH_ENABLED=false` is byte-identical.** Re-verified in a browser: Home renders, sidebar shows
  the 5 projects, no Team button, no session badge, no Sign out, no console errors, and
  `/api/auth/signup` returns 404.
- **Your "project tracker" Supabase project was not touched.**
- `.env` is gitignored and confirmed absent from the commit.

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -2` → the report commit, then `3ba42d0`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **470 passed** (39 files). Was 449; the 21 new
   cases are `tests/signup.test.ts` (15) and the suggestions block in `tests/tenancy.test.ts` (6).
3. With **no** `AUTH_ENABLED` and **no** `DB_ENABLED`, run `npm run serve`. The startup log must be
   byte-identical to before — no `[authz]`, `[db]`, `[shadow]` or `[signup]` lines:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
4. `curl -s http://localhost:3000/api/auth/config` → exactly `{"authEnabled":false}`.
5. Sign-up must refuse outright when there is no login to pair it with:
   ```
   curl -s -X POST http://localhost:3000/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"x@example.com","password":"longenough1"}'
   ```
   → `404 {"error":"sign-up is not available — this server has AUTH_ENABLED off"}`
6. Open `http://localhost:3000`. Everything exactly as before: Home, the sidebar with 5 projects,
   History, the Run test button — no login screen, no Team button, no badge, no Sign out, no
   console errors. Verified at commit time via devtools:
   ```json
   {"activeView":"home","teamBtnDisplay":"none","signOutHidden":true,"badgeHidden":true,
    "bodyClasses":"","runBtnVisible":true,"projects":5,"signupNoticeGone":true}
   ```

### B. Sign up, and land on Home — the thing that was broken

7. Restart with both flags on (the service-role key must be in `.env`):
   ```
   AUTH_ENABLED=true DB_ENABLED=true npm run serve
   ```
8. Open `http://localhost:3000` → **Sign in** screen. Click **Sign up**.

   **Chrome autofill will fight you on these forms** — it overwrites the email field with a stale
   saved address, which is what made the earlier "invalid credentials" look like an app bug. If it
   does, clear the field with `Ctrl+A` and retype, and press `Esc` to dismiss the dropdown. To fix
   it permanently: `chrome://settings/passwords` → find `localhost` → delete the wrong entry.
9. Enter a brand-new address and a password of 8+ characters, then **Create account**.

   **Expected: you land directly on Home, already signed in** — no "check your email", no bounce
   back to the sign-in screen. The topbar shows your address and an **OWNER** badge. Verified at
   commit time (~9s, most of it Supabase round-trips):
   ```json
   {"hash":"#/","activeView":"home","signedIn":true,"errorShown":false}
   ```
10. Confirm the new account is genuinely isolated — it owns a fresh, empty workspace and can see
    none of the Default organisation's 51 runs:
    ```
    sidebar "Projects"   → "No projects yet. Runs you save will appear here."
    sidebar "Recent runs"→ "No runs yet."
    ```
    Verified at commit time:
    ```json
    {"runsVisible":0,"role":"owner","organisationId":"dd9ecb61-… (its own, not Default)"}
    ```

### C. Validation and refusals

11. Server-side validation does not trust the form. With the server running:
    ```
    curl -s -X POST http://localhost:3000/api/auth/signup -H "Content-Type: application/json" \
      -d '{"email":"not-an-email","password":"longenough1"}'      # 400
    curl -s -X POST http://localhost:3000/api/auth/signup -H "Content-Type: application/json" \
      -d '{"email":"someone@example.com","password":"short"}'      # 400
    ```
12. A duplicate address is refused without echoing Supabase's internals:
    ```
    curl -s -X POST http://localhost:3000/api/auth/signup -H "Content-Type: application/json" \
      -d '{"email":"garvit.khandelwal@thinkvibes.com","password":"longenough1"}'
    ```
    → `409 {"error":"An account with that email already exists. Sign in instead."}`
13. **The rate limit.** Six attempts in a row from one IP:
    ```
    for i in 1 2 3 4 5 6; do
      curl -s -o /dev/null -w "attempt $i: %{http_code}\n" \
        -X POST http://localhost:3000/api/auth/signup -H "Content-Type: application/json" \
        -d "{\"email\":\"rl-$i-$(date +%s)@example.com\",\"password\":\"longenough1\"}"
    done
    ```
    **Expected: the first few succeed (`201`), then `429` for the rest.** Verified at commit time
    returning `201, 201, 201, 429, 429, 429` — the allowance is 5 per 15 minutes per IP and the
    earlier curl in step 12 had already spent some of it.

    **Delete any accounts these steps create** — see section F.
14. Closing sign-up works:
    ```
    SIGNUP_ENABLED=false AUTH_ENABLED=true DB_ENABLED=true npm run serve
    curl -s -X POST http://localhost:3000/api/auth/signup -H "Content-Type: application/json" \
      -d '{"email":"x@example.com","password":"longenough1"}'
    ```
    → `403 {"error":"sign-up is closed on this server"}`

### D. Suggestions on the Team screen

15. Signed in as your owner account (`garvit.khandelwal@thinkvibes.com`), open **Team**. Click into
    **Email of an existing account** — a dropdown appears listing registered accounts that are
    **not already members**. Your own address must not be in it.
16. Pick one, leave the role as **tester**, click **Add to team**. Verified at commit time:
    ```json
    {"feedback":"signup-e2e-…@example.com added as tester.","feedbackClass":"team-ok",
     "rosterCount":3, "suggestionsNow":[]}
    ```
    The roster grows and the suggestion disappears — it is now a member, and suggesting it again
    would only produce a guaranteed 409.
17. The list is admin-gated. As a `tester` or `viewer`:
    ```
    curl -s -o /dev/null -w "%{http_code}\n" \
      -H "Authorization: Bearer <THEIR_TOKEN>" \
      "http://localhost:3000/api/organisations/<ORG_ID>/addable-users"
    ```
    → **`403`**. You cannot enumerate a directory you cannot add to.

### E. The RLS invariant — the one that must never regress

18. No migration ran, but new rows arrive by a new path, so re-confirm the browser-facing key still
    sees nothing:
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
    If any of these ever returns rows, run history is world-readable — stop everything.

### F. Clean up any accounts these steps created

19. Every sign-up above creates a real account **and** its own organisation. Remove them:
    ```
    SRK=$(grep "^SUPABASE_SERVICE_ROLE_KEY=" .env | cut -d= -f2-)
    URL="https://tvujslcqkykxwenloimg.supabase.co"

    # list what exists
    curl -s "$URL/auth/v1/admin/users?per_page=200" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK"

    # delete one
    curl -s -X DELETE "$URL/auth/v1/admin/users/<THEIR_USER_ID>" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
    ```
    Then sweep the rows they left behind, in the Supabase SQL editor:
    ```sql
    delete from organisation_members m
     where m.user_id <> '00000000-0000-4000-8000-000000000001'
       and not exists (select 1 from auth.users u where u.id = m.user_id);

    delete from organisations o
     where not exists (select 1 from organisation_members m where m.organisation_id = o.id);
    ```
20. Confirm the roster is back to exactly two rows, both `owner` of "Default":
    ```sql
    select coalesce(u.email, '(synthetic local user)') as who, o.name as org, m.role
      from organisation_members m
      join organisations o on o.id = m.organisation_id
      left join auth.users u on u.id = m.user_id
     order by u.email nulls first;
    ```
    **This check matters.** An earlier agent left the synthetic local user demoted to `tester`,
    which silently breaks `AUTH_ENABLED=false` — that user must be `owner` or the flag-off app
    starts hiding controls. Verified at commit time:
    ```
    (synthetic local user) | Default | owner
    garvit.khandelwal@…    | Default | owner
    orgs 1 · members 2 · runs 51 · accounts 1
    ```

## 8. HOW TO ROLLBACK

```
git revert 3ba42d0
```

Safe on its own and needs nothing manual — no migration ran, no schema changed, no env variable
must be removed (`SIGNUP_ENABLED` simply stops being read).

Reverting restores the previous sign-up screen, which means **sign-up goes back to being broken**
(504 on this project) unless you also turn "Confirm email" off in Supabase Dashboard →
Authentication → Providers → Email.

Accounts created while this was live are unaffected by the revert — they are real Supabase accounts
and keep working. Delete them with the Admin API if you want them gone (section F).

## 9. DEFERRED

- **The suggestions route exposes every registered address to any organisation admin.** Correct for
  one company running this locally; a **privacy leak the moment two unrelated customers share an
  instance** — org A's admin would see org B's users' addresses. Before this is ever multi-customer
  it must be scoped (to a shared domain, or to pending invitations) or removed. Flagged here rather
  than solved because the right scoping depends on a product decision that hasn't been made.
- **Open sign-up means anyone reaching the port gets a workspace.** `SIGNUP_ENABLED=false` is the
  lever; there is no invitation flow yet. The plan puts Resend-backed invites in Step 5.4, which
  would be the better answer than a global on/off.
- **No password strength requirement beyond 8 characters**, and Supabase's own floor is 6. The
  existing owner account has a 6-character password created through the dashboard, which this route
  would now reject. Leaked-password protection is still off (Supabase advisor, WARN) — Dashboard →
  Authentication → Policies. Worth turning on now that accounts can be self-created.
- **No email verification at all.** `email_confirm: true` marks addresses confirmed without ever
  checking them, so someone can sign up as any address they like. That is the deliberate trade for
  sign-up working locally; a real deployment wants a working SMTP provider and the normal
  confirmation flow, not this route.
- **The rate limiter is per-process and in-memory.** A restart clears it and a second instance
  would have its own. Fine for one local process, not a defence for a public deployment.
- **No token refresh still** (Phase 2's deferral). The `refreshToken` returned by sign-up is passed
  through and unused, so a long session eventually 401s and needs a fresh sign-in.
- **Everything in `PHASE_TEAM_REPORT.md` and `PHASE_3_4_REPORT.md`'s DEFERRED lists still stands**,
  including Step 3.3 being gated on Step 3.2's soak, the synthetic user showing as
  "(unknown address)" on the roster, and the 5-second membership cache.

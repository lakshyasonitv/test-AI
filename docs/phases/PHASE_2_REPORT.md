# Phase 2 — Identity

Implements Steps 2.1–2.2 of `implentationplan.md`. Commit: `8c20130`.

Everything in this phase is behind `AUTH_ENABLED`, which defaults to **off**. With it off the
system behaves identically to before — proven by Phase 0's contract tests passing unchanged, and
by a rendered-DOM check of the running UI (see HOW TO VERIFY).

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/auth.ts` | **New.** `requireAuth` middleware, `resolveUser`, and the `LOCAL_USER_ID` constant. With the flag off it injects a fixed synthetic user rather than skipping — see NEW FILES for why that distinction is the entire point of the step. |
| `src/server/index.ts` | Mounts `requireAuth` on `/api/*` with `/api/health` and `/api/auth/config` exempted; fills in Step 1.1's `canAccessRun` stub with a real authentication check; adds `authEnabled` to `/api/health` (additive); adds the new `GET /api/auth/config` route. |
| `public/index.html` | Adds the `#view-login` section (a `.view` like every other screen) and a `#signOutBtn` in the topbar, hidden by default. |
| `public/app.js` | Adds the session layer: token storage, the `fetch` wrapper, login/sign-out handlers, `initAuth()`. Registers `"login"` in `VIEWS` and gates routing inside `applyRoute()`. Also fixes a real crash found while verifying the flag-on path (see below). |
| `public/style.css` | Appends `.auth-card` / `.auth-error` and a rule hiding sidebar+topbar while the login view is active. **New class names only** — nothing existing renamed or repurposed. |
| `tests/apiContract.test.ts` | Adds an additive `authEnabled` assertion plus 4 auth-gate tests. The pre-existing assertions are untouched. |
| `package.json`, `package-lock.json` | Adds `@supabase/supabase-js`. |
| `.env.example` | Documents `AUTH_ENABLED`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DB_ENABLED`, and — carry-over — `RUN_RETENTION_DAYS`, which Phase 1 introduced but never documented. |

**A real bug was found and fixed while verifying the flag-on path.** `loadHistory()` and
`renderHistoryView()` both assumed `GET /api/runs` always returns an array. A 401 *resolves
successfully* with an `{error}` object, so with auth on every cold load threw
`runs.slice is not a function` before sign-in. Both now check `Array.isArray` and bail. This was
caught by a headless browser check, not by the test suite — worth knowing, because the suite
would not have caught it.

## 2. NEW FILES

- `src/server/auth.ts`

Two design decisions in it are worth stating plainly:

**It injects a user instead of skipping.** With `AUTH_ENABLED` off, `requireAuth` does not
`next()` past itself — it sets `req.user = LOCAL_USER`. That is Rule 4: every downstream path can
assume `req.user` exists from day one, so the codebase never grows `if (!user)` branches, which is
where tenancy leaks come from once a second account exists. Single-user mode becomes multi-user
mode with exactly one member, not a separate mode.

**`LOCAL_USER_ID` is a single exported constant** (`00000000-0000-4000-8000-000000000001`).
Phase 3's bootstrap inserts that same id as the "Default" organisation's owner. If the two ever
drift, every backfilled historical run is owned by nobody.

## 3. NEW ENV FLAGS

| Flag | Default | What it does | When flipped |
|---|---|---|---|
| `AUTH_ENABLED` | unset → off | Off: every request is attributed to the synthetic `LOCAL_USER`; no network call, no Supabase client built, no login UI. | `true`: every `/api/*` route except `/api/health` and `/api/auth/config` requires a valid Supabase session JWT and 401s without one; artifact requests 403; the UI shows a login screen and a Sign out button. |
| `SUPABASE_URL` | unset | Supabase project API URL. | Required once `AUTH_ENABLED=true` (or `DB_ENABLED=true`). Pre-filled in `.env` for the `ai-test-platform` project. |
| `SUPABASE_PUBLISHABLE_KEY` | unset | Browser-safe publishable key, used to verify JWTs and by the login form. Not a secret — it grants only what RLS allows. | Same as above. Pre-filled in `.env`. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | **Secret.** Not used by this phase at all; documented here because it's introduced in the same `.env` block. Phase 3 needs it. | See PHASE_3_REPORT.md. |

If `AUTH_ENABLED=true` but the URL/key are missing, the server logs one clear error and rejects
requests rather than silently 401ing forever with no explanation.

## 4. NEW ROUTES

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/api/auth/config` | — | Auth off: `{"authEnabled": false}`. Auth on: `{"authEnabled": true, "url": string\|null, "publishableKey": string\|null}`. Public by necessity — the UI must be able to ask "is auth on, and where do I authenticate?" before it can hold a token. Returns no secret: the publishable key is designed to ship in client code, and the service-role key is never read here. |

**Changed shape on an existing route:** `GET /api/health` gains a top-level `authEnabled: boolean`.
This is **additive** — appended, nothing renamed, removed, or reordered — which Rule 1 permits and
which the plan explicitly calls for ("extend that response with `authEnabled` and branch on it").
Its contract test now asserts additively, so a future added field can't false-alarm.

## 5. SCHEMA CHANGES

None in this phase. Phase 3 owns the database.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request/response shape was changed**, except `/api/health`'s sanctioned
  additive `authEnabled` field described above. Phase 0's contract tests pass unchanged.
- **No `public/style.css` class was renamed or repurposed.** Only new classes were appended
  (`.auth-card`, `.auth-error`) plus one rule keyed on the existing `.view-active`. The documented
  contracts (`.hidden`, `li.completed`, `.phase-badge.running`, `.case-card.open`, `.tree-*`,
  `.view-active`) are untouched.
- **The login view is shown only through `showView()`**, and `"login"` was registered in `VIEWS`.
  Nothing toggles `.hidden` to switch views — that's the bug `showView()`'s own comment documents.
- **Credential handling is untouched.** `pendingCredentials.ts` and `scrubServedSecrets` were not
  modified. Run credentials still live only in process memory and generated specs still use
  `${env:...}` references. The Supabase session token is a different thing entirely and never
  touches a run directory.
- `.env` is gitignored and confirmed absent from every commit — the keys in it never entered git.

## 7. HOW TO VERIFY

1. `git log --oneline -1` → `8c20130`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **410 passed**.
3. **Default state (this is the important one).** With `AUTH_ENABLED` unset, run `npm run serve`.
   The startup log must be byte-identical to before — no new lines:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
4. `curl -s http://localhost:3000/api/auth/config` → exactly `{"authEnabled":false}` (no URL, no
   key — with auth off there's nothing for a client to do with them).
5. `curl -s http://localhost:3000/api/runs -o /dev/null -w "%{http_code}\n"` → `200`, no
   credential needed.
6. Open `http://localhost:3000` in a browser. Everything must look and behave exactly as before:
   Home view, sidebar visible with the Projects tree grouping your runs by URL, no login screen,
   **no "Sign out" button**, no console errors. Click through to History and back.
7. **Flag-on state.** Stop the server and restart with auth on:
   ```
   AUTH_ENABLED=true npm run serve
   ```
   Then:
   - `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/runs` → **401**
   - `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health` → **200**
     (must stay public, or login is unreachable)
   - `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/runs/<any-real-runId>/00-input.json"`
     → **403**
   - `curl -s http://localhost:3000/api/auth/config` → `authEnabled:true` plus the URL and
     publishable key.
8. With auth still on, open `http://localhost:3000` in a browser. You should get the **Sign in**
   screen with the sidebar and topbar hidden. Enter a wrong password → an inline
   "Invalid login credentials" error appears and the button re-enables.
9. To actually sign in you need a user, and none exists yet in the new project. Create one in
   Supabase Dashboard → Authentication → Users → Add user (set a password and mark it confirmed),
   then sign in. You should land on Home with the sidebar back and a **Sign out** button visible.
   Reload — you should stay signed in. Click Sign out — you should return to the login screen.
10. Turn auth back off (drop the env var) and confirm step 6 still holds.

## 8. HOW TO ROLLBACK

```
git revert 8c20130
```

No migrations, no manual steps. Nothing in this phase writes to a database or to disk; the only
persisted state is a token in the browser's `localStorage` under `testbench.session` and an
`sb-access-token` cookie, both of which simply stop being read once the code is gone (clear site
data if you want them physically removed).

Reverting this alone is safe and leaves Phase 0/1 intact. **If you also want to revert Phase 3**,
do it first or in the same pass — `git revert bac6d1f 8c20130` — because Phase 3's bootstrap
migration references `LOCAL_USER_ID`, which this commit introduces.

## 9. DEFERRED

- **The session token is stored in `localStorage` and a non-`httpOnly` cookie**, so it is readable
  by any script on the page. This matches what `supabase-js` does by default and is not a
  regression, but the stronger pattern is an `httpOnly` cookie set by the server after login.
  That requires a server-side session-exchange endpoint; worth doing before this is exposed to
  the public internet, not needed for local single-user use.
- **No token refresh.** Supabase access tokens expire (1h by default) and there is no refresh
  loop, so a long session will eventually start 401ing and the user must sign in again. The
  refresh token is returned by the login call and simply not used yet — a deliberate scope cut,
  not an oversight.
- **No sign-up, password reset, or email verification UI.** Users must be created in the Supabase
  dashboard. The plan puts invites in Step 5.4.
- **`canAccessRun` authenticates but does not authorise.** With auth on, any signed-in user can
  read any run's artifacts. That is correct for this phase — tenancy is Step 3.4 and there is
  exactly one organisation today — but it must not ship to a second real account before 3.4 lands.
- **Two pre-existing high-severity npm advisories** (`playwright` / `@playwright/test` 1.49.0,
  "downloads browsers without verifying SSL certificate authenticity"). Confirmed present before
  this phase and unrelated to `@supabase/supabase-js`. Not touched: bumping the pinned Playwright
  version is a real behavioural risk this repo's own conventions warn about, and it deserves its
  own change.
- Stale local `.env` values still present (`GEMINI_MODEL=gemini-3-flash-preview`, dead
  `GROQ_API_KEYS`/`GROQ_MODEL`) — carried over from Phase 0's DEFERRED list, still not touched.

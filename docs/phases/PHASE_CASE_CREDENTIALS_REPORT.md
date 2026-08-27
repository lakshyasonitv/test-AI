# Phase — credentials on the re-ground walk

Closing the gap `PHASE_CASE_BACKEND_REPORT.md` §9 left open: `regroundEditedIr` accepted
credentials but nothing supplied them, so editing any step behind a login failed to reach it.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/credentials.ts` | `credentialsFromEnv()` — reads back the same `TEST_USERNAME`/`TEST_PASSWORD` pair `credentialEnvVars` writes. `credentialKindsNeeded()` — which credentials a step list needs, read off its `${env:...}` values rather than guessed from field names. |
| `src/stages/stepText.ts` | `RegroundEstimate.needsCredentials` — the estimate now says whether the walk must sign in, computed over the prefix actually replayed (capped, so it cannot promise a sign-in the walk never reaches). |
| `src/stages/caseEdit.ts` | Both outgoing failure messages run through `redactCredentials`. The walk types real credentials into a real browser, and a Playwright fill failure quotes what it was filling. |
| `src/server/index.ts` | `resolveWalkCredentials()` — env first, prompt second. Wired into the job path before the walk starts. Cancel now also settles a parked prompt. |
| `public/app.js` | The existing credential modal is now reusable: `showCredentialPrompt(runId, data, postUrl)`. The case editor's poll loop shows it on a `credentials` event and posts the answer to the job. Save's hint warns about the sign-in before the click. |
| `tests/caseEdit.test.ts` | 5 cases: credentials reach the walk, absence is unchanged, and neither password nor identifier survives in a failure message. |
| `tests/credentials.test.ts` | 9 cases for `credentialsFromEnv` and `credentialKindsNeeded`, including a round-trip against `credentialEnvVars` so the two names cannot drift. |
| `tests/stepText.test.ts` | 5 cases for `needsCredentials`, including the capped-walk case. |

**682 passing** (was 664, +18). `tsc --noEmit` clean.

## 2. NEW FILES

None. Every change extends a module that already owned the concept.

## 3. NEW ENV FLAGS

None. Two existing variables gain a second reader:

- **`TEST_USERNAME` / `TEST_PASSWORD`** — already the pair the generated spec references and
  `executor.ts` injects. Now also the silent source for a re-ground walk. Unset by default, which
  is the prompt path.
- **`CREDENTIAL_WAIT_MS`** — the existing prompt timeout, now also bounding an editing session.

## 4. NEW ROUTES

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/cases/:caseId/steps/jobs/:jobId/credentials` | `{username, password}` or `{skip:true}` | `204`, or `409` when nothing is waiting |

Deliberately the same shape as `/api/runs/:runId/credentials` — same body, same `secret: true`,
same `settle()`. It **is** the same mechanism, keyed on a job id instead of a run id.

`POST /api/cases/:caseId/steps/estimate` gains `needsCredentials` — an additive field on an
existing response.

## 5. SCHEMA CHANGES

None.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape changed.** One new route; one additive field.
- **No `public/style.css` class renamed or repurposed.** The credential modal reuses its existing
  markup and classes; only its POST target became a parameter.
- **`showView()` untouched** — this phase adds no view.
- **Credential handling is stricter, not weaker.** `scrubServedSecrets` untouched. The values live
  in the waiting promise and the walk, and are redacted out of every message leaving
  `regroundEditedIr`.
- `liveExtend.ts` and `groundingError()` untouched — grounding is still called, never reimplemented.

## 7. HOW TO VERIFY

### A. The estimate tells the truth, before anything is spent

Against a real case whose steps 1-4 are a login (`Admin creates a new user via management
interface`, under `Smoke`):

1. `npx tsc --noEmit` → clean. `npx vitest run` → **682 passed** (42 files).
2. Start the server (`npm run serve`) and sign in as your owner account.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale
   saved address. Clear with `Ctrl+A` and retype, `Esc` to dismiss. Permanent fix:
   `chrome://settings/passwords` → find `localhost` → delete the wrong entry.
3. Open the case, edit a step **behind** the login (e.g. `Click on button "Admin"`). After ~400ms
   the Save button reads:
   ```
   Save — re-checks 1 step (~16s)
   Opens the site to re-check the marked step · up to 1 model call.
   The step is behind a login, so this will sign in first.
   ```
   **Verified at commit time**, along with the two contrasting shapes:

   | Edit | `stepsToVerify` | `stepsToReplay` | `needsCredentials` |
   |---|---|---|---|
   | a step **behind** the login (`s6`) | 1 | 5 | **true** |
   | a step **before** it (`s1`) | 1 | 0 | false |
   | a fill's **value** only | 0 | 0 | false |

   The third row is the fast path: retyping a value opens no browser and asks for nothing.

### B. The prompt, and that skipping fails honestly

4. With `TEST_USERNAME`/`TEST_PASSWORD` **unset**, save that edit. It returns `202`, and the job
   parks — verified at commit time:
   ```
   ir / started           {"stepsToVerify":1,"stepIdsToVerify":["s6"],"stepsToReplay":5,…}
   credentials / started  {"url":"https://learnvibes.vercel.app","fields":["username","password"],"caseEdit":true}
   ```
   The modal carries editing-specific wording rather than the run's:
   > Checking this edit means signing in to *host* first — the step you changed is behind the
   > login. Add credentials to verify it, or skip and the check will stop at the login.
5. **No browser is open while it waits.** Chromium process count was unchanged from baseline at
   this point — the prompt is resolved *before* the walk starts, so an ignored prompt costs
   nothing.
6. Press **Skip**. The walk proceeds without credentials, types the `${env:…}` sentinel into the
   login box exactly as it did before this phase, and fails:
   ```
   stage: error   saved: false
   Step s6 targets role="button" name="Admin Panel", which is not present under any
   compatible role on page "https://learnvibes.vercel.app"…
   ```
   **`saved: false` is the point** — a skip produces a failure, never a false success. Confirm the
   case is untouched: `currentVersion` and the version count both unchanged.

### C. The env path asks nothing

7. Restart with the pair set:
   ```
   TEST_USERNAME=... TEST_PASSWORD=... npm run serve
   ```
   Save the same edit. **Verified: `credentials events: 0`** — no prompt, no interruption.

### D. Credentials actually get the walk past a login — the headline

The user's own login-walled case cannot complete this leg here: its credentials were supplied
interactively during the original run and, correctly, never persisted, so I do not have them. The
mechanism is therefore proven against a login wall I control — a site whose `/dashboard` 302s to
`/login` unless signed in, holding the button an edited step targets.

8. The same walk, same steps, cache cleared between runs, differing only in whether credentials
   were passed. **Verified at commit time:**
   ```
   WITHOUT creds -> reached: http://localhost:3210/login        ← the old behaviour
   WITH    creds -> reached: http://localhost:3210/dashboard    ← the step behind the login is now reachable
   ```
   That is the whole substance of this phase in two lines.

9. Through the UI: the modal posts to the **job**, not to a run, and clears itself afterwards.
   **Verified:**
   ```json
   {"postedTo": ["/api/cases/…/steps/jobs/…/credentials"],
    "modalClosedAfterSubmit": true,
    "passwordClearedFromDom": true, "userClearedFromDom": true}
   ```

   > A synthetic `new Event("submit")` makes the form read empty fields and send `{skip:true}`.
   > Use `requestSubmit()` when scripting this, or you will chase a bug that is not there — it
   > cost me one confusing round.

### E. Cancel while the prompt is open

10. Start a save that needs credentials, then press **Cancel** without answering. With
    `CREDENTIAL_WAIT_MS=20000`, **verified at commit time**:
    ```
    cancel -> HTTP 202
    released after: 1s          ← not 20s, so the cancel settled the parked prompt
    stage: done | cancelled: true | saved: false
    chromium: 50 before, 50 after
    version: 3 before, 3 after | versions: 3, 3
    ```
    Without this, a cancelled job would sit for the full timeout — `shouldCancel` is polled inside
    the walk, and a parked job is not in the walk yet.

### F. The prompt times out, and writes nothing

11. Start the same save and **do not answer**. **Verified**:
    ```
    terminal after 20s
    credentials / started    {"url":…,"fields":["username","password"],"caseEdit":true}
    credentials / completed  {"supplied":false}
    final: error | saved: false
    [credentials] no answer for <jobId> - continuing without credentials
    chromium: 50 before, 49 after
    version unchanged | versions unchanged
    ```

### G. No credential leaks

12. A job was run with a deliberately distinctive password (`ZZ-leak-canary-9f3a1`) and identifier
    (`canary-user@example.invalid`), then everything it could have reached was searched.

    **What was grepped, and the result — zero occurrences of either value in all five:**

    | Searched | Password | Identifier |
    |---|---|---|
    | the job's event stream (`GET …/steps/jobs/:jobId/state`) — what the UI renders | 0 | 0 |
    | the server's stdout log | 0 | 0 |
    | the entire `runs/` tree — publicly served at `/runs/*` | 0 | 0 |
    | the whole working tree (excluding `node_modules`, `.git`) | 0 | — |
    | the stored case and its versions (`GET /api/cases/:id`) | 0 | 0 |

13. Unit-level, the realistic leak shape is pinned: a Playwright fill failure quoting the value it
    was typing. `tests/caseEdit.test.ts` asserts the password does not survive into the message,
    `[redacted]` does, and the diagnosis still names the step and the failing call.

### H. The RLS invariant

14. No migration ran, but re-confirm the browser-facing key sees nothing:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects project_members \
             suites test_cases test_case_versions suite_cases run_cases; do
      printf "%-22s " "$t:"
      curl -s "$URL/rest/v1/$t?select=*&limit=3" -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
      echo
    done
    ```
    **Verified — all ten returned `[]`.**

## 8. HOW TO ROLLBACK

```
git revert <this commit>
```

Nothing manual. No migration, no new table, no schema change. `TEST_USERNAME`/`TEST_PASSWORD`
revert to being read only by `executor.ts`, and a re-ground reverts to failing at a login wall.

One thing a revert will not restore: **the LLM replay cache under `runs/_cache/llm` was cleared
during verification** (1023 entries), because the cache key omits credentials and was serving a
failed-login snapshot to a later run. It rebuilds itself; the cost is re-work on the next few
walks, not lost data.

## 9. DEFERRED

### The replay cache is keyed without credentials — found the hard way

`replayAndSnapshot` caches on `makeCacheKey(model.baseUrl, JSON.stringify(prefix), policy)`.
Credentials are **not** in that key, so a walk that failed to log in and a later walk with correct
credentials share a cache entry. This cost me a confusing round: my "with credentials" run silently
reused the "wrong credentials" snapshot and looked like the fix had not worked.

The user-facing shape: fix your credentials, retry the save, and get the same failure until the
cache ages out. Not fixed here — the key is shared grounding code and `policy` is already folded in
specifically because *"relying on that difference to always change the prefix's own JSON is the
exact caching-bug shape that has already bitten this codebase twice"*. Adding a credential
fingerprint to the key is the right fix and belongs with that code, not with this change.

### A walk with no source AppModel cannot ground its own login steps

`baseModel()` seeds from `runs/<sourceRunId>/02-appmodel.json`. A **duplicated** case has
`sourceRunId: null`, so its model starts empty; `refreshPageModel` then adds only the page the walk
*reached*. Editing a step behind a login therefore leaves the login page absent from the model, and
`groundingError` fails on the login steps themselves — verified: the real case's source run holds
`02-appmodel.json` with `/login` in it, my duplicate holds nothing.

Consequence: **you can edit a step behind a login on a case saved from a run, but not on a duplicate
of one**, until the walk seeds the pages it passes through rather than only the one it lands on.
Pre-existing and unrelated to credentials, but this phase is what makes it reachable.

### Unlabelled login fields still get no credential

`credentialFieldMap` is built from the *starting* model. With an empty one it contributes nothing,
and the fallback matches the accessible name — so a field whose only name is its placeholder
(`you@example.com`, `*********`, the exact shape `credentials.ts` documents from a real run) is not
recognised and receives the sentinel instead of the credential. Verified directly: the same walk
failed with placeholder-named fields and succeeded once they carried `aria-label`.

The existing DOM-derived `inputType` path solves this — it just needs a model to read, which brings
it back to the item above.

### Per-project credentials

Out of scope by directive. `projects.credentials_ref` exists from Step 3.1 and stores an env var
**name**, never a value — the natural next step once different projects need different logins. The
env pair is global today, so two projects with different accounts cannot both be silent.

### Noticed, not touched

- The `credentials/completed` event reports `{supplied:boolean}` and nothing else. Deliberate — it
  is the one event that must never carry a value.
- Job state remains in memory, so a server restart mid-prompt loses the edit. Correct outcome,
  already recorded in the backend report.

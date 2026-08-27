# Phase report — create and edit a project from the UI

Closes the two remaining unreachable library routes identified by
`PHASE_STEP_EDITOR_REPORT.md` §9, and fixes one stale empty-state message.

Commit: `43f6cc1`. Baseline `25d4c1c`. `tsc` clean, **532/532 passing** (unchanged — see §9 for
why this adds no tests).

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `public/app.js` | Wired the dead `#addProjectBtn`; added the inline create/edit project form, its state, and `bindProjectForm()`; added a per-row **Edit** affordance; made the empty-suite message name both ways in and be role-aware. |
| `public/style.css` | `.tree-project-form` / `.project-form-input` / `.project-form-actions` for the inline form, `.tree-project-edit` for the hover-revealed Edit button, and `body.role-no-admin #addProjectBtn`. All new names; nothing renamed or repurposed. |

**No server file changed. No new routes. No migration.** The backend was never the missing half —
`POST /api/projects` and `PATCH /api/projects/:projectId` have existed since Step 5.1.

---

## 2. NEW FILES

None, other than this report.

---

## 3. NEW ENV FLAGS

None.

---

## 4. NEW ROUTES

None. This phase is a caller for routes that already existed.

For the record, the two now reachable:

| Route | Verb | Body | Response |
|---|---|---|---|
| `/api/projects` | POST | `{ name, baseUrl? }` | `201 { id, name, baseUrl, runCount }` |
| `/api/projects/:projectId` | PATCH | `{ name?, baseUrl? }` | `200 { id, name, baseUrl }` |

**`baseUrl` was already optional server-side** — the route passes `""` when the field is absent or
not a string, and `createProject()` stores `baseUrl.trim()`. I checked before assuming, and
**changed nothing on the server**: the directive allowed relaxing validation if it turned out to be
required, and it did not.

---

## 5. SCHEMA CHANGES

None.

---

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape changed.** No server file was edited at all.
- **No `style.css` class renamed or repurposed.** The form reuses `.tree-row` and `.dl-btn-inline`;
  its error reuses `.suite-new-err`. Five new class names were added.
- **Credential handling untouched** — `pendingCredentials.ts`, `scrubServedSecrets`, and the
  `${env:...}` references in generated specs are all unchanged.
- **`showView()` is still the only thing that switches views.** This phase adds no view; the form
  renders inside the existing sidebar tree.
- **No delete affordance was built**, per the user's explicit decision. `DELETE /api/projects/:id`
  is untouched and still unreachable from the UI.
- **`ls@thinkvibes.com` untouched.** The directive described it as `admin`; it is in fact `owner`,
  as `PHASE_STEP_EDITOR_REPORT.md` also found. It is a real account, so rewriting its role on a
  stale expectation would be wrong. Left exactly as it was.

---

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -1` → `43f6cc1`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **532 passed** (40 files).
3. `.env` sets `AUTH_ENABLED=true DB_ENABLED=true`, so override to see the flag-off path:
   ```
   AUTH_ENABLED=false DB_ENABLED=false npm run serve
   ```
   The startup log must be byte-identical — no `[authz]`, `[db]`, `[shadow]` or `[library]` lines.
   ```
   curl -s http://localhost:3000/api/auth/config     # {"authEnabled":false}
   ```
4. Open `http://localhost:3000` — Home, sidebar, History, Run test; no login screen, no Team
   button, no console errors.

> **Hard-reload whenever you switch modes.** A `#/` change is a same-document navigation: the old
> JavaScript stays live and will show you stale UI. This cost the previous phase a false negative,
> and it cost me one here too — my first click on `+` did nothing because the coordinates were off
> by a few pixels, which looks identical to "the handler isn't wired".

### B. The no-database case must not offer a button that cannot work

This is the mode most easily broken by this change: project rows live in Postgres, and with none
configured the sidebar is showing URL groupings, not projects. A create button there would be a lie.

5. Start with no `.env` loaded at all, on a spare port:
   ```
   PORT=3100 node --import tsx src/server/index.ts
   ```
6. ```
   curl -s http://localhost:3100/api/projects     # 503 "the database is not configured — …"
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/api/runs   # 200
   ```
7. Open `http://localhost:3100`. The sidebar must still list projects — it falls back to grouping
   runs by URL — and the **`+` must be gone**. Verified at commit time:
   ```json
   {"addProjectBtnHidden":true,"addProjectDisplay":"none","editButtons":0,
    "projectRows":4,"sample":["https://learnvibes.vercel.app","https://example.com",
    "https://thinkvibes.com","https://allen.in"],
    "teamBtnDisplay":"none","bodyClasses":"","runBtn":true}
   ```
   Note this holds even though auth is *off* there — `canManageProjects()` fails on
   `projectsUnavailable`, not on the role.

### C. Create a project with no URL at all

8. Restart normally (`npm run serve`) and sign in as your owner account.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale
   saved address, which is what made an earlier "invalid credentials" look like an app bug. Clear
   with `Ctrl+A` and retype, `Esc` to dismiss. Permanent fix: `chrome://settings/passwords` → find
   `localhost` → delete the wrong entry.
9. Click the **`+`** beside the sidebar's **PROJECTS** heading. An inline form opens with two
   fields. The second reads **"Base URL (optional)"** — the optionality is visible before you
   commit to anything, not discovered by a failed submit.
10. Type a name, **leave the URL empty**, click **Create**.

    The project appears in the sidebar **already expanded**, with **+ New suite** directly beneath
    it — there is no project screen to navigate to, so "landing in it" means the next step is on
    screen. Verified at commit time:
    ```json
    {"stored":{"name":"Mobile App QA","baseUrl":"","runCount":0},
     "baseUrlIsEmpty":true,"nextRowAfterIt":"+ New suite"}
    ```
    `baseUrl` is stored as `""` — not a placeholder, not a guess at a URL.
11. Create a second one **with** a URL, and submit with **Enter** rather than the button. Verified:
    `{"created":{"name":"Checkout Regression","baseUrl":"https://shop.example.com"}}`.

### D. Edit — rename and set a URL

12. Hover a project row. An **Edit** button appears at its right. (It is `opacity: 0` until hover
    or keyboard focus, so the tree stays quiet — the label and run count are what you read.)
13. Click it. The row is **replaced in place** by the form, pre-filled, with the button now reading
    **Save** rather than Create. Clicking Edit does not expand or collapse the project —
    `stopPropagation` keeps the row's own toggle out of it.
14. Change the name, add a URL, **Save**. Then **reload the page** and confirm both persisted
    against the same project id. Verified at commit time:
    ```json
    {"renamed":{"id":"1643799f-…","name":"Mobile App QA (renamed)","baseUrl":"https://m.example.com"},
     "oldNameGone":true}
    ```
    Sending a blank URL clears it — `updateProject()` distinguishes `""` (set it empty) from
    `undefined` (leave it alone), so the form always sends `baseUrl`.
15. Submit with an empty name → **"Give the project a name."** inline, and nothing is written. The
    server enforces this too (`400 "name is required"`); the client check only avoids a round-trip
    for the obvious case. `Escape` closes the form and discards.

### E. The whole chain on a project born in the UI

The point of this step is that a project created through the form behaves exactly like one the
Step 5.1 migration made.

16. Expand the new project → **+ New suite** → name it → you land in the empty suite.
17. Its empty state now names **both** ways to fill it:
    > No cases in this suite yet. Use **+ Add cases** above to file saved ones here, or **Save
    > case** on a finished run's result to make a new one.

    (Before this, it named only *Save case* — it predated `+ Add cases` existing.)
18. Open a finished run from History, expand a case, click **Save case**. The project picker now
    lists your new projects, and the suite picker offers the new suite. The suite list filters to
    the chosen project — verified the other suites are `hidden:true`, since the server refuses a
    cross-project pair and offering one would be offering a mistake.
19. Save into the new project + suite, open the suite, click **▸ Run all**. When it finishes:
    ```
    cat runs/<runId>/08-llm-usage.json
    ```
    **Expected, and verified at commit time for a suite in a UI-created project:**
    ```json
    {
      "calls": 0,
      "promptTokens": 0,
      "completionTokens": 0,
      "totalTokens": 0,
      "exhausted": false,
      "byStage": {}
    }
    ```
    All four phase cards read **DONE** — verified `["completed:DONE","completed:DONE",
    "completed:DONE","completed:DONE"]`.

### F. Roles — the part that matters

The sidebar hides both controls below admin. That is a courtesy. These confirm the server refuses
regardless of what was drawn.

20. As a **viewer** and as a **tester** (this is `admin`+, not `tester`+ — composing a suite is
    authoring, but creating a project is administration):
    ```
    curl -s -o /dev/null -w "create %{http_code}\n" -X POST http://localhost:3000/api/projects \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"name":"sneaky"}'
    curl -s -o /dev/null -w "edit   %{http_code}\n" -X PATCH "http://localhost:3000/api/projects/<P>" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"name":"hijacked"}'
    ```
    **Verified at commit time — `403` for all four**, while `GET /api/projects` stays **200**:
    reading the tree is not the same as rewriting it.
21. Signed in as a tester in the browser, verified:
    ```json
    {"role":"tester","addProjectBtnHidden":true,"addProjectDisplay":"none",
     "editButtons":0,"bodyClasses":"role-no-admin"}
    ```
    Hidden two ways on purpose: the CSS rule covers the role even if a future change forgets the
    JS toggle, and the JS toggle covers the no-database case the CSS knows nothing about.

### G. The RLS invariant

22. No migration ran and no table was added, but rows now arrive by a new path, so re-confirm the
    browser-facing key still sees nothing:
    ```
    PUB="sb_publishable_vYARUVBTlq58X1Z_XinInQ_eX9u2iVa"
    URL="https://tvujslcqkykxwenloimg.supabase.co"
    for t in runs organisations organisation_members projects project_members \
             suites test_cases test_case_versions suite_cases; do
      printf "%-22s " "$t:"
      curl -s "$URL/rest/v1/$t?select=*&limit=3" -H "apikey: $PUB" -H "Authorization: Bearer $PUB"
      echo
    done
    ```
    Every one must return `[]`. If any returns rows, run history and saved tests are
    world-readable — stop everything.

---

## 8. HOW TO ROLLBACK

```
git revert 43f6cc1
```

Two frontend files, no server change, no migration, no new table — the revert is complete and
there is nothing to undo by hand.

**One thing revert will not undo:** any project you created or renamed through the form is a real
row and stays. Since there is no delete UI by design, removing one means SQL:

```sql
delete from projects where id = '<project id>';
```

Check what it holds first — `runs`, `suites` and `test_cases` all reference it.

---

## 9. DEFERRED

### The route audit, updated

`PHASE_STEP_EDITOR_REPORT.md` §9 introduced this table. Only the project rows changed.

| Route | Verb | Reachable from | |
|---|---|---|---|
| `/api/projects` | GET | sidebar tree | ✅ |
| `/api/projects` | POST | **sidebar "+" beside PROJECTS** | ✅ *(added here)* |
| `/api/projects/:id` | PATCH | **project row → Edit** | ✅ *(added here)* |
| `/api/projects/:id` | DELETE | — | ⛔ **deliberately unreachable** |
| `/api/projects/:id/members` | GET / POST / DELETE | Team screen | ✅ |
| `/api/suites` | GET / POST | sidebar, Suite screen | ✅ |
| `/api/suites/:id` | PATCH / DELETE | Suite screen | ✅ |
| `/api/suites/:id/cases` | GET / POST | Suite screen, Case screen | ✅ |
| `/api/suites/:id/cases/:caseId` | DELETE | Suite screen → Remove | ✅ |
| `/api/suites/:id/order` | PATCH | Suite screen → ↑ ↓ | ✅ |
| `/api/cases?projectId=` | GET | "+ Add cases" candidate list | ✅ |
| `/api/cases/:id` | GET / PATCH / DELETE | Case screen, step editor | ✅ |
| `/api/cases/:id/versions/:v` | GET | Compare screen | ✅ |
| `/api/replay` | POST | Suite + Case screens | ✅ |
| `/api/runs/:runId/cases/:caseId/save` | POST | Save-case panel on a run | ✅ |

**Every library route is now reachable except project delete, which is intentional.** The user
weighed it and chose not to have one, so a project — and the runs, suites and cases hanging off it
— cannot be destroyed by a misclick. The backend guard still exists and still refuses while the
project holds runs; it simply has no caller. If a delete affordance is ever added, that 409 and its
run count are what it should surface.

### No tests were added

`public/app.js` is a classic script with no import surface — nothing in `tests/` loads it, and
doing so under vitest would mean stubbing `document` at load. This phase is entirely DOM wiring
over two routes that already have server-side tests, so there is no unit to test that would have
caught anything. I would rather say that than pad the count. The behaviour was verified in a real
browser against real data; §7 records what was observed at commit time.

### Findings worth knowing

- **The "+ Add cases" empty message is wrong for an empty project.** It reads *"Every saved case in
  this project is already in this suite"* even when the project has no saved cases at all. Two very
  different situations, one sentence. Pre-existing, in `openAddPanel()`, and outside this
  directive — but it is the same class of stale-copy bug this phase fixed on the suite empty state,
  and it will read as a bug to the first person who creates a project and immediately tries to add
  cases to a suite in it.
- **Duplicate project names are permitted**, exactly as duplicate suite names are (noted last
  phase). The sidebar will show two identical rows. I did not add a client-side check — that would
  be a second validator to drift out of step with the server. The fix is a unique constraint on
  `(organisation_id, name)`, which is a migration.
- **A project is an organisational label, not a constraint on what a case targets.** A case saved
  into "Checkout Regression" still runs against whatever URLs its IR carries — during verification
  a case pointing at `learnvibes.vercel.app` ran happily under a project whose base URL was
  `shop.example.com`. That is by design (the IR is grounded against a real page and the base URL is
  metadata), but it is not obvious from the UI, and nothing warns about the mismatch.
- **Still not built, carried over:** no Script tab, no Duplicate/Restore, no `tags` axis, no
  optimistic concurrency on case edits, and no diagnosis or self-heal on a replay.

### Verification debris, cleaned

Two projects, one suite, one saved case, one replay run directory and two accounts were created
while verifying, and all were removed. Confirmed afterwards: 11 projects, 2 suites
(`regression`, `Smoke`), 5 test cases, 57 runs, 0 orphaned cases/suites/runs, 0 unfiled runs, and a
roster of exactly three rows in "Default" — the synthetic local user (**`owner`**, which
`AUTH_ENABLED=false` depends on), `garvit.khandelwal@thinkvibes.com` (`owner`), and
`ls@thinkvibes.com` (`owner`, untouched).

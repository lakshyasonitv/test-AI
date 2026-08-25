# Phase — the inline step editor, and the library's missing UI

The deferred item from `PHASE_LIBRARY_REPORT.md` §9 ("No step editor on the Case screen"), plus
three further gaps of the same kind found by auditing every library route against the UI.

**Commit:** `9263edd`. `tsc` clean, **532/532 passing** (was 531).
Working tree clean apart from the untracked `Testbench (1).html`.

**The headline finding:** the deferred step editor was not the only thing missing. The backend was
complete and the UI was not, and last phase's worked-example data (`Smoke` with three cases) hid it
because that data was created through the API rather than through the screens. Section 9 has the
full route-by-route audit.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `public/app.js` | The inline step editor on the Case screen; the unsaved-changes route guard; "+ New suite" in the sidebar; "+ Add cases" on the Suite screen; suite membership and an add-to-suite picker on the Case screen. |
| `public/style.css` | New `.step-edit-*`, `.step-f*`, `.tree-suite-add` / `.tree-suite-new`, `.case-suite*` and `.suite-add-*` rules, appended. Nothing above them renamed or repurposed. |
| `tests/library.test.ts` | One test pinning the invariant the editor depends on — a PATCH round-trip preserves `css` / `testId` / `nth`. |

**One commit, not two.** The editor and the suite-composition work interleave in the same two
files; splitting them would have meant an artificial staging exercise rather than two coherent
changes. Nothing was dropped — the audit table in §9 lists every route and its status.

## 2. NEW FILES

- `docs/phases/PHASE_STEP_EDITOR_REPORT.md`

No new source files. Everything here is frontend against routes that already existed.

## 3. NEW ENV FLAGS

**None.**

## 4. NEW ROUTES

**None.** Every addition calls a route that already shipped and was already tested. That was the
point of the audit: the backend was never the missing half.

## 5. SCHEMA CHANGES

**None.** No migration was applied.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape.** No route was added, changed or widened.
- **No `style.css` class renamed or repurposed.** The new rules reuse `.lib-pos`,
  `.dl-btn-inline`, `.case-badge`, `.team-error`, `.hrow-label`, `.hrow-meta`, `.lib-check`,
  `.case-save-panel` and `.tree-row` rather than restating them.
- **View switching is `showView()` only.** The editor is a panel inside the existing `case` view;
  no `.hidden` is toggled anywhere.
- **Credentials untouched.** Verified directly: a step whose value is `${env:TEST_PASSWORD}` still
  reads back as `${env:TEST_PASSWORD}` after an edit and save. The editor stores values untrimmed
  precisely so a credential reference is handed back exactly as found.
- **No second copy of the IR schema.** `src/schema/ir.ts` via `library.ts`'s `parseIr` stays the
  only authority on validity. What the editor holds is which *inputs to draw* per action, not what
  is valid — see §9 for the one deliberate exception, which warns and never blocks.
- **Accounts and organisations.** The throwaway viewer used for the role checks was deleted and its
  memberships swept. Final roster:

  | who | org | role |
  |---|---|---|
  | (synthetic local user) | Default | **owner** |
  | garvit.khandelwal@thinkvibes.com | Default | owner |
  | ls@thinkvibes.com | Default | owner |

  **Note:** my directive said `ls@thinkvibes.com` should be `admin`. It is `owner`, and I did not
  change it — it was already `owner` when I checked, presumably promoted through the Team screen
  since the last report. Flagging rather than "correcting" it, because silently rewriting a real
  account's role on a stale expectation is exactly the wrong move.

---

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -1` → `9263edd`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **532 passed** (40 files).
3. `.env` sets `AUTH_ENABLED=true DB_ENABLED=true`, so override to see the flag-off path:
   ```
   AUTH_ENABLED=false DB_ENABLED=false npm run serve
   ```
   Startup log byte-identical — no `[authz]`, `[db]`, `[shadow]` or `[library]` lines.
   ```
   curl -s http://localhost:3000/api/auth/config     # {"authEnabled":false}
   ```
4. Open `http://localhost:3000` — Home, sidebar, History, Run test; no login screen, no Team
   button, no console errors.

> **Hard-reload when you switch modes.** A `#/` change is a same-document navigation: the old
> JavaScript and its caches stay live and will show you stale UI. This cost me a false negative
> mid-verification — the "+ New suite" row appeared to be missing when it was simply not in the
> page's loaded script yet.

### B. Edit a step, and confirm it mints a version

5. Restart normally (`npm run serve`) and sign in as your owner account.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale
   saved address, which is what made an earlier "invalid credentials" look like an app bug. Clear
   with `Ctrl+A` and retype, `Esc` to dismiss. Permanent fix: `chrome://settings/passwords` → find
   `localhost` → delete the wrong entry.
6. Open a case (sidebar → expand a project → a suite → **Open** on a row). On the **Steps** tab
   click **Edit steps**.
7. Each row draws only the fields its action uses — verified at commit time:
   ```
   navigate  →  ACTION, URL
   fill      →  ACTION, ROLE, NAME, VALUE
   click     →  ACTION, ROLE, NAME
   assert (url contains) →  ACTION, ASSERTION, VALUE     ← page-level, so no target
   ```
8. Change something. An **UNSAVED** badge appears. Click **Save changes** → you land on the
   **Versions** tab with the new version at the top. Verified: v1 → v2.
9. Click **Compare versions**. It shows exactly your change and nothing else. Verified at commit
   time: *"1 step added, 1 removed between v1 and v2"*, with `Go to /login` struck through and
   `Go to /login?edited=1` marked added.

### C. Add, reorder, delete — and the id rule

10. Back on **Steps** → **Edit steps**. Use `+` on a row to insert below it, `↑`/`↓` to reorder,
    `×` to delete. Save.
11. Reload and confirm the order persisted. Verified at commit time: inserted at position 2, moved
    down one, deleted the last, saved 15 steps at v3, and the new step took id `s16` —
    **not a reused id**. Step ids are what failing-step reporting names, so reusing one would
    misattribute a failure to the wrong step.

### D. A rejected edit must not half-apply

12. Enter the editor and delete **every** step, then Save. The IR schema requires at least one:
    ```
    the edited test plan is not a valid test plan: steps Array must contain at least 1 element(s)
    ```
    That message renders **inline in the editor**, and the stored case is untouched — verified at
    commit time still 15 steps at v3. When the server names a specific step (`steps.3.action …`)
    the message is shown against that row instead.
13. There is also a **warning** the schema cannot give. Set a step to `assert` → `text contains`
    and leave the value empty:
    > "text contains" needs a comparison value — the run cannot generate this step without one.

    This is not a blocked save. Zod accepts such a step; `generator.ts`'s `emitAssert` refuses to
    emit it ("refusing to emit a vacuous assertion"), so without the warning the failure would
    only surface at replay. It warns rather than blocks deliberately — see §9.

### E. Unsaved work is not lost silently

14. Edit a step but do **not** save, then click something else in the sidebar. You are asked
    first; declining keeps you on the case with your edits intact. Verified at commit time
    (`confirm` stubbed so no dialog blocked the run): declining left `hash` on the case and the
    view on `case`; accepting moved to `#/history`. Reload and close are covered by the browser's
    own prompt.

### F. The full loop, entirely through the UI — no curl

This is the check that would have caught everything in §9.

15. In the sidebar, expand a project. Below its suites there is now **+ New suite**. Click it, type
    a name, press Enter. You land in the new, empty suite. Verified: `landedOnSuite: true`,
    heading `E2E Regression`, empty state shown.
16. Click **+ Add cases**. It lists this project's saved cases **not already in this suite** —
    re-adding one is a guaranteed error, so offering it would be offering a mistake. Tick two; the
    button reads **Add 2 cases**. Click it.
17. Reorder with `↑`/`↓`. **Reload the page.** The order persisted — verified at commit time,
    identical id order before and after.
18. Re-open **+ Add cases**: it now offers only the one case you did not add. Verified:
    `offeredNow: 1`.
19. Tick both rows → **▸ Run 2 selected**.
20. When it finishes:
    ```
    cat runs/<runId>/08-llm-usage.json
    ```
    **Expected, and verified at commit time for a suite built entirely through the UI:**
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
    All four phase cards read **DONE** — verified `["completed:DONE","completed:DONE","completed:DONE","completed:DONE"]`,
    with two per-case results rendered.

### G. Many-to-many, made reachable

21. Open a case that is in a suite. Under the title a **Suites** row lists its suites as chips
    (click one to open it), plus an **Add to suite…** picker offering the ones it is *not* in.
22. Add it to a second suite, then open both — it appears in each. Verified at commit time: one
    case showing chips `["E2E Regression","Smoke"]` and **no picker** (no suites left to add), and
    a second showing `["Smoke"]` with `E2E Regression` offered.

    This is what makes `suite_cases` real to a user. Before this, a case could only be filed at
    save time, into exactly one suite — the join table was a schema detail nobody could reach.

### H. Roles — the part that matters

The screens hide what a role cannot use. That is a courtesy. These confirm the server refuses
regardless of what was drawn.

23. As a **viewer**, verified at commit time returning **403, 403, 403, 403**:
    ```
    curl -s -o /dev/null -w "create suite      %{http_code}\n" -X POST http://localhost:3000/api/suites \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"projectId":"<P>","name":"sneaky"}'
    curl -s -o /dev/null -w "add case to suite %{http_code}\n" -X POST "http://localhost:3000/api/suites/<S>/cases" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"caseId":"<C>"}'
    curl -s -o /dev/null -w "edit case steps   %{http_code}\n" -X PATCH "http://localhost:3000/api/cases/<C>" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"ir":{...}}'
    curl -s -o /dev/null -w "reorder suite     %{http_code}\n" -X PATCH "http://localhost:3000/api/suites/<S>/order" \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"caseIds":[]}'
    ```
    Reading still works — `GET /api/cases?projectId=<P>` → **200**.
24. Signed in as that viewer in the browser, verified at commit time:
    ```json
    {"role":"viewer","newSuiteRowVisible":false,"addCasesBtnVisible":false,
     "runAllVisible":false,"editStepsBtnVisible":false,"suitePickerVisible":false,
     "suiteChipsStillShown":["Smoke"]}
    ```
    No authoring control anywhere, and they can still *see* which suites a case belongs to.

### I. The grounding invariant

25. The editor draws six fields. A grounded target also carries `css`, `testId` and `nth` — `css`
    being "what makes icon-only controls addressable at all" (`src/schema/ir.ts`). Edits mutate the
    existing target rather than rebuilding it, so those cannot be dropped by construction.
    Confirmed on real data: after editing step 1 of a 15-step case, step 15's untouched
    `target.text` was byte-identical, and `${env:TEST_USERNAME}` / `${env:TEST_PASSWORD}` came back
    intact. `tests/library.test.ts` pins the server half of the round-trip.

---

## 8. HOW TO ROLLBACK

```
git revert 9263edd
```

No migration, no manual step. The routes this calls all predate the commit and are unaffected;
reverting returns the Case screen to read-only steps and removes the three suite-composition
affordances, leaving the API exactly as it was.

**One thing revert will not undo** — during verification I edited a real case
(`621fc78e…`, "Admin creates a new user via management interface") and then restored it. It is now
**v4, whose content is identical to v1**; v2 and v3 are my test edits. The case runs as it always
did. To tidy the history, delete versions 2–4 in the SQL editor, or leave it — the version log
being honest about what happened is arguably worth more than a clean number.

---

## 9. DEFERRED

### The route audit — every library route against the UI

The coordinator asked for this as a table after the second gap turned up, and it is the most
useful thing in this report. **Reachable** means a user can trigger it from a screen without curl.

| Route | Verb | Reachable from | |
|---|---|---|---|
| `/api/projects` | GET | sidebar tree | ✅ |
| `/api/projects` | POST | — | ❌ **no create-project UI** |
| `/api/projects/:id` | PATCH | — | ❌ **no rename/edit-project UI** |
| `/api/projects/:id` | DELETE | — | ❌ **no delete-project UI** |
| `/api/projects/:id/members` | GET / POST / DELETE | Team screen | ✅ |
| `/api/suites` | GET | sidebar, Suite screen | ✅ |
| `/api/suites` | POST | **sidebar "+ New suite"** | ✅ *(added here)* |
| `/api/suites/:id` | PATCH | Suite screen → Rename suite | ✅ |
| `/api/suites/:id` | DELETE | Suite screen → Delete suite | ✅ |
| `/api/suites/:id/cases` | GET | Suite screen | ✅ |
| `/api/suites/:id/cases` | POST | **Suite "+ Add cases", Case "Add to suite…"** | ✅ *(added here)* |
| `/api/suites/:id/cases/:caseId` | DELETE | Suite screen → Remove | ✅ |
| `/api/suites/:id/order` | PATCH | Suite screen → ↑ ↓ | ✅ |
| `/api/cases?projectId=` | GET | **"+ Add cases" candidate list** | ✅ *(added here)* |
| `/api/cases/:id` | GET | Case screen | ✅ |
| `/api/cases/:id/versions/:v` | GET | Compare screen | ✅ |
| `/api/cases/:id` | PATCH | Rename, **and the step editor** | ✅ *(editor added here)* |
| `/api/cases/:id` | DELETE | Case screen → Delete case | ✅ |
| `/api/replay` | POST | Suite + Case screens | ✅ |
| `/api/runs/:runId/cases/:caseId/save` | POST | Save-case panel on a run | ✅ |

**Still unreachable, deliberately: the three project-write routes.** Projects are currently created
by the Step 5.1 migration and by nothing else, so there is no way to add, rename or delete one from
the UI. That is a real gap of the same shape as the ones fixed here, and it is the obvious next
piece — but it is project management, not the test library, and the user's blocker was suites. It
needs a decision this phase should not make on its own: deleting a project has to say what happens
to its runs and cases.

### Findings worth knowing

- **Duplicate suite names are permitted.** Creating a second suite called "Smoke" succeeds — I hit
  this while testing the failure path and had to delete the stray. The sidebar then shows two
  identical rows. I did **not** add a client-side uniqueness check: that would be a second
  validator to drift out of step with the server, which is the exact hazard the standing rule
  names. The right fix is a unique constraint on `(project_id, name)`, which is a migration and
  outside this directive.
- **The value-assertion warning is the one place the editor knows something the schema does not.**
  `generator.ts` throws for `url_contains` / `text_*` / `title_*` with no comparison value; Zod
  accepts them. It **warns and never blocks**, so the server stays the only thing that can refuse a
  save. If it ever starts blocking, it becomes a second validator and inherits the drift problem.
- **No unit tests for the editor itself.** `public/app.js` is a classic script, not a module —
  nothing in `tests/` imports it, and loading it under vitest would mean stubbing `document` at
  load. So there is no import surface to test against, and I did not pad the count with tests that
  would not have caught anything. The riskiest logic — preserving target fields the editor does not
  draw — is handled *by construction* (mutate the existing object, never rebuild it) rather than by
  a test, and the server half of that round-trip is pinned by the one test added here. The editor's
  behaviour was verified in a real browser against real data; §7 records what was observed.
- **Still not built, carried over from `PHASE_LIBRARY_REPORT.md` §9:** no Script tab, no
  Duplicate/Restore, no `tags` axis, no optimistic concurrency on case edits (two people editing
  one case still clobber each other silently — `current_version` exists, so the 409 guard the plan
  describes remains cheap), and no diagnosis or self-heal on a replay.
- **The reference design's "edit in plain English" was not followed, deliberately.**
  `Testbench (1).html`'s CASE section shows one free-text input per step and an "Ask for a change /
  Rewrite steps" panel. Both need a model to turn prose back into an IR — which would put LLM cost
  back into the one path that exists to avoid it. The structured editor built here is what the
  directive asked for; the "ask for a change" panel is genuinely a model feature and belongs with a
  decision about whether editing may spend tokens.
- **Pre-existing, untouched:** the orphaned `public.create_organisation_with_owner` function from
  the stopped org work (still the only security-advisor finding), and leaked-password protection
  still off.

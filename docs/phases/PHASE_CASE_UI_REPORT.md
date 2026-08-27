# The case-detail screen — editing a test in plain English

Part two of case editing. The backend (`90e59a2`) owns the English ↔ IR mapping, re-grounding and
the job protocol; this is the screen that consumes it. **No backend file was touched and no route
was added** — the backend was never the missing half.

`tsc` clean, **664/664 passing** (unchanged — this phase adds no testable unit; see §9).
Working tree clean apart from the untracked `Testbench (1).html`.

The headline: **the cost of a save is written on the button that spends it.** A value edit reads
`Save`; a target edit reads `Save — re-checks 1 step (~14s)` and marks the row it will pay for.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `public/app.js` | The case screen, rewritten: sentence editor, live estimate, two save paths, job progress, cancel, conflict, rewrite proposal, three tabs. Router learns `#/projects/:projectId/cases/:caseId` and keeps `#/case/:id` working. |
| `public/style.css` | The `cd-*` block — two-column layout, sentence rows and their per-row states, job banner, conflict panel, proposal diff, script pane. |

**Removed:** the previous field-based step editor (`stepFields`, `setStepField`, `stepEditorRow`,
`paintStepEditor`, `STEP_ACTIONS`, `STEP_ASSERTIONS`, `PAGE_ASSERTIONS`, `VALUE_ASSERTIONS`,
`nextStepId`, `errorStepIndex`). It edited role/name fields and PATCHed the whole IR; steps are now
edited as sentences and go through `POST /steps`. Leaving it would have left a second editor
reading a `caseEditor` shape that no longer exists — dead code that breaks the moment it is reached.
`formatIrStep` and `stepText` are untouched: the first is pinned by `tests/stepText.test.ts`, the
second still renders the read-only Compare screen.

## 2. NEW FILES

None besides this report.

## 3. NEW ENV FLAGS

None.

## 4. NEW ROUTES

**None.** Every endpoint this screen calls already existed:
`GET /api/cases/:id`, `GET /api/cases/:id/steps`, `POST /api/cases/:id/steps/estimate`,
`POST /api/cases/:id/steps`, `GET …/steps/jobs/:jobId/state`, `POST …/steps/jobs/:jobId/cancel`,
`POST /api/cases/:id/duplicate`, `GET /api/cases/:id/runs`, `POST /api/cases/:id/rewrite`,
`PATCH /api/cases/:id`, plus the suite membership routes the header reuses.

## 5. SCHEMA CHANGES

None.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape.** No backend file changed at all.
- **No `public/style.css` class renamed or repurposed.** Every new rule is `cd-*`; the screen reuses
  `.case-badge` / `.badge-*`, `.dl-btn-inline`, `.run-btn`, `.hrow*`, `.panel`, `.seg` / `.seg-btn`,
  `.tree-empty`, `.team-ok` / `.team-error`, `.case-suites*` and `.lib-run-all`.
- **`showView()` only.** The case view was already registered in `VIEWS`; the new route resolves to
  the same view rather than adding a parallel one. Nothing toggles `.hidden`.
- **Credentials.** `pendingCredentials.ts` and `scrubServedSecrets` untouched. `${env:TEST_USERNAME}`
  round-trips through the editor verbatim — confirmed on real data (§7 B).
- **`AUTH_ENABLED=false` and the no-database path.** Both verified in a browser (§7 A/B).
- **The user's data.** Every destructive test ran on a **duplicate**, which was then deleted. The
  source case is byte-identical: still `v1`, one version, `step10 value "test lakshay"`,
  `step4 {role:"button", name:"Sign In"}`. Final roster is exactly three `owner` rows in "Default"
  (synthetic local user, `garvit.khandelwal@…`, `ls@thinkvibes.com`), 11 projects,
  `regression`(2) and `Smoke`(3) intact.

---

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -1` → `<this phase's commit>`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **664 passed** (42 files).
3. `.env` sets `AUTH_ENABLED=true DB_ENABLED=true`, so override to see the flag-off path:
   ```
   AUTH_ENABLED=false DB_ENABLED=false npm run serve
   ```
   Open `http://localhost:3000` — Home, sidebar, History, Run test; no login screen, no Team button,
   no console errors.

> **Hard-reload when you change anything in `public/`.** A `#/` change is a same-document
> navigation and keeps the old JavaScript live. This cost me two false negatives during
> verification — a fix looked missing when the browser was simply still running the previous
> `app.js`. If a reload is not enough, run `await fetch('/app.js',{cache:'reload'})` in the console
> first, then reload.

### B. The no-database case must degrade honestly, not throw

The case screen reads library rows, so with no database there is nothing useful to show — but it
must say so rather than blanking.

4. Start with no `.env` loaded at all, on a spare port:
   ```
   PORT=3100 node --import tsx src/server/index.ts
   ```
5. ```
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/api/cases/abc   # 503
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/api/runs        # 200
   ```
6. Open `http://localhost:3100/#/case/anything`. **Verified at commit time:**
   ```json
   {"view":"case","msg":"the database is not configured — set DB_ENABLED=true and SUPABASE_SERVICE_ROLE_KEY",
    "threw":false,"sidebarProjects":3}
   ```
   No console errors, and the sidebar still lists projects via the URL-grouping fallback.

### C. Open a case — and an old link still works

7. Restart normally (`npm run serve`) and sign in as your owner account.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale
   saved address. Clear with `Ctrl+A` and retype, `Esc` to dismiss. Permanent fix:
   `chrome://settings/passwords` → find `localhost` → delete the wrong entry.
8. Navigate to an **old-style** link: `http://localhost:3000/#/case/<caseId>`. It resolves, and the
   URL rewrites itself in place to the canonical shape. Verified:
   ```
   #/case/ab708e2b-…  ->  #/projects/78d6a70d-…/cases/ab708e2b-…
   ```
   `history.replaceState` fires no `hashchange`, so this cannot cause a second render.
9. The header shows the breadcrumb `PROJECT / SUITE` in uppercase mono, a status badge,
   `v<N> · <N> versions`, the title as a large serif field, the why-it-matters line, and
   **Save · Duplicate · Compare versions · Run case** with Run case filled terracotta and a play
   glyph. Save is **disabled** until something changes. "Compare versions" only appears once there
   is more than one version.

### D. The cost model — what is free and what is not

This is the distinction the whole screen rests on.

10. Edit a fill's **value** (not which box). After ~400ms:
    ```json
    {"label":"Save","disabled":false,"hint":"No steps need re-checking.","marked":[],"unsaved":true}
    ```
11. Edit a **target** (`Click on button "Sign In"` → `"Log In"`):
    ```json
    {"label":"Save — re-checks 1 step (~14s)",
     "hint":"Opens the site to re-check the marked step · up to 1 model call.",
     "marked":["s4"],"unsaved":true}
    ```
    The marked row is tinted, so "re-checks 1 step" is never an abstract number — you can see which.
    `maxLlmCalls` is labelled **"up to"** deliberately: grounding is DOM-first and usually spends
    none, so a flat promise of N calls would make the common zero-cost save read as a bug.

### E. The two save paths

12. **Fast path.** Save the value-only edit → returns in well under a second, **no spinner**, and:
    ```json
    {"version":"v3 · 3 versions","notice":"Saved as v3.","unsaved":false,"saveDisabled":true}
    ```
    Confirmed at the API level that the edited step keeps its grounding and the credential
    reference survives: `${env:TEST_USERNAME}` came back verbatim, `css` unchanged.
13. **Job path.** Save a target edit → `202`, steps go read-only, and the banner appears. Verified
    at commit time by sampling every 250ms:
    ```json
    {"sawBanner":true,"bannerText":"Verifying 1 of 1…","sawCancel":true,
     "sawDisabled":true,"sawStates":["verifying…"],"rightColLive":true}
    ```
    `rightColLive` is the point of "do not block the whole screen": the Ask card and Latest result
    stay readable while a save verifies.

### F. Failure lands on the row that caused it

14. Point a step at something that is not there (`Click on button "Log In"`) and save. The message
    attaches to **that row**, every other edit survives, and the editor stays dirty with Save
    enabled — the fix is usually one word. Verified: `errorAt: 3` with the message rendered in
    `.cd-line-err` under row 4.
15. **The two failure shapes read differently, because the remedies differ.** Editing a step behind
    the login wall produces:
    ```
    could not reach step s7 to check it: locator.click: Timeout 30000ms exceeded.
    waiting for getByRole('button', { name: 'Admin' })
    ```
    That is **§9's credentials gap, live** — the walk cannot sign in, so it never arrives. The row
    message appends *"an earlier step is the real problem; this is where the walk stopped"* rather
    than blaming the step you edited.

### G. Cancel — and what it does not claim

16. Start a target edit, save, then **Cancel**. The button becomes
    *"Cancelling… the page being checked has to finish first."* — honest, because cancel is read
    between snapshots and an in-flight one completes.
17. When it lands, the editor returns to exactly its pre-Save state. Verified against a job the
    server really did cancel (`done` + `cancelled:true` + `saved:false` at 4.0s):
    ```json
    {"notice":"Cancelled — nothing was saved. Your edits are still here.",
     "vBefore":"v3 · 3 versions","vAfter":"v3 · 3 versions","jobCleared":true}
    ```
    **Cancel is not an undo.** Nothing was written, so there is nothing to undo — saying "reverted"
    would send someone looking for a version that never existed.

### H. The conflict — no path silently overwrites

18. Open the case in two tabs, save from one, then save from the other. Verified:
    ```json
    {"conflictShown":true,
     "head":"this case has changed since you opened it — you have v1, it is now v3. …",
     "cols":["Your steps","Theirs — v3"],"mineCount":15,"theirsCount":15,
     "actions":["Discard mine, use theirs","Keep mine on top of theirs"],
     "noOverwriteOption":true}
    ```
19. **Keep mine** re-bases your edits onto their version and lets you save against the version that
    actually won:
    ```json
    {"notice":"Your edits are on top of their version — press Save to write them.",
     "heldVersion":3,"myEditStillThere":"Type \"conflict test\" into textbox \"Full Name\"",
     "afterSave":{"version":"v4 · 4 versions","notice":"Saved as v4."}}
    ```
    `expectedVersion` is held from the moment the case loads and sent on every write. That is what
    turns a silent clobber into a visible conflict.

### I. Ask for a change — a proposal, never a save

20. Type an instruction and press **Rewrite steps**. Verified against the live model:
    ```json
    {"proposalShown":true,
     "note":"Added a final step to check that the text \"Users\" is displayed as requested.",
     "diff":{"add":1,"del":0,"same":15},
     "buttons":["Apply to editor","Discard"],
     "versionNow":"v4 · 4 versions"}
    ```
    The version did **not** move — proposing costs a model call but writes nothing.
21. **Apply** only fills the editor:
    ```json
    {"linesBefore":15,"linesAfter":16,
     "lastLine":"Check that the text \"Users\" is displayed",
     "versionStillUnsaved":"v4 · 4 versions","unsavedBadge":true,
     "notice":"Proposal applied to the editor — nothing is saved until you press Save."}
    ```
    You still press Save, still see the estimate, still get the re-ground. One way into the library,
    whoever wrote the sentences.

### J. The other two tabs

22. **Script** shows the spec the last run actually emitted, with a Download link. On a case that
    has never run it says so honestly:
    > No script yet — the spec is written when this case runs. Press **Run case** to generate one.

    There is no endpoint that generates a spec from a stored IR (the generator runs as part of a
    run), so showing the real artifact is truthful where a re-derivation could differ from what
    executed.
23. **Runs & versions** lists this case's own runs beside its version history. Verified:
    `versionRows: 3` with badges `["v3","v2","v1"]`. A case with no indexed runs explains why
    rather than showing an empty box.

### K. Run case, and the zero-LLM guarantee

24. Press **Run case** — it hands off to the existing Run view. Then:
    ```
    cat runs/<runId>/08-llm-usage.json
    ```
    **Verified at commit time:**
    ```json
    {"calls":0,"promptTokens":0,"completionTokens":0,"totalTokens":0,"exhausted":false,"byStage":{}}
    ```
    All six stages are emitted (`plan, discovery, testcases, ir, generate, execute, done`), so all
    four phase cards read DONE rather than hanging at PENDING.

### L. Roles — the part that matters

The screen hides what a viewer cannot use. That is a courtesy. These confirm the server refuses
regardless of what was drawn.

25. As a **viewer**, verified returning **403 on all five writes** while reads stay open:
    ```
    save steps    403      read case   200
    estimate      403      read runs   200
    duplicate     403      read steps  200 (15 steps)
    rewrite       403
    patch title   403
    ```
26. Signed in as that viewer in the browser, verified:
    ```json
    {"role":"viewer","bodyClasses":"role-no-edit role-no-admin",
     "saveBtn":false,"duplicateBtn":false,"runBtn":false,"deleteBtn":false,
     "askCard":false,"rewriteBtn":false,"addStepBtn":false,
     "lineInputsDisabled":true,"rowButtons":0,"titleReadonly":true,
     "linesVisible":15,"suitePicker":false}
    ```
    A viewer can still *read* the steps — which is the whole point of the role.

### M. The RLS invariant

27. No table was added and no backend file changed, but re-confirm anyway:
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
    **Verified — all ten returned `[]`.** If any ever returns rows, run history and saved tests are
    world-readable; stop everything.

---

## 8. HOW TO ROLLBACK

```
git revert <this phase's commit>
```

Frontend only — no migration, no schema, no route. Reverting restores the previous field-based step
editor and the `#/case/:id` route; the backend's endpoints simply go uncalled again.

Nothing needs undoing in the database: every destructive test ran on a duplicate that was deleted,
and the test account, its memberships and the test run were removed (§6).

---

## 9. DEFERRED

**A real bug this screen surfaced, and I fixed it.** The UNSAVED badge never appeared while typing.
Typing deliberately does *not* repaint — a repaint mid-keystroke steals the caret — so the badge,
which was rendered by the repaint, only showed up after a structural change. It is now toggled by
`refreshCaseSaveAffordance()` alongside the Save label. Worth recording because the same trap
applies to anything else added to that header later.

**Expected outcome is read-only, and it has to be.** The reference design draws it as a field, but
`GET /steps` exposes `expected` as `ir.meta.title` — the case title, which the header already shows
and which `PATCH {title}` already edits. `POST /steps` deliberately preserves `found.ir.meta` and
takes only steps, so an editable field here would have nowhere to send its value. Rendering a field
that silently discards edits is worse than rendering a value, so it is a labelled read-only line.
Making it genuinely editable means either a distinct `expected` field in the IR schema or `POST
/steps` accepting meta — both backend changes, both out of scope for a UI phase.

**Not built:**

- **Credentials on the re-ground walk** — §9 of the backend report, and I confirmed it is live
  (§7 F). Editing any step behind a login fails with *"could not reach step s7"* after a 30s
  timeout. The screen reports it accurately, but the underlying capability is missing: wiring
  `pendingCredentials.ts` into an editing session is its own piece of work. **This is the single
  biggest limitation of the screen** — on an authenticated site, only steps before the login wall
  can be re-targeted.
- **Restore a version.** The reference design has it beside Compare; the Runs & versions tab offers
  Compare only. Restoring is `POST /steps` with an old version's sentences, so it is small — but it
  needs a decision about whether restoring mints a new version (it should) and that was not asked
  for here.
- **Copy button on the Script tab.** Download is wired; Copy would need clipboard permission
  handling that nothing else in this app does yet.
- **No unit tests added.** `public/app.js` is a classic script with no import surface, so there is
  nothing to import and assert against; the logic here is DOM wiring over routes that already carry
  server-side tests. Saying so rather than padding the count.

**Noticed, outside this phase, not touched:**

- **A same-document navigation serves stale `public/` assets.** `#/` changes keep the old
  JavaScript live, and even `location.reload()` can serve `app.js` from memory cache. It cost me
  two false negatives. A build-time version query on the script tag would end the whole class of
  problem, and would also help the user, who has hit this before.
- `ls@thinkvibes.com` is **`owner`**, not `admin` as successive directives have said. Third phase
  in a row to observe it; still not rewriting a real account's role on a stale expectation.
- The orphaned `public.create_organisation_with_owner` function from the stopped org work is still
  the only new advisor finding.

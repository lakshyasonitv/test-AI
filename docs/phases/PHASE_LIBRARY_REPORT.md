# Phase 5 — the test-case library: save, replay, and the Suite / Case / Compare screens

Steps 5.2, 5.3 and 5.5 of `implentationplan.md`.

**Commits:** `a413adf` (schema, backend, replay engine, tests) and `ddaa925` (the three screens,
the Save-case control, the sidebar's suite list).
`tsc` clean, **531/531 passing** (was 495; +36 — 35 in the new `tests/library.test.ts`, 1 row added
to the permanent isolation table).

The headline: **a saved case re-runs for zero LLM calls.** A 3-case suite replay against
`learnvibes.vercel.app` completed in ~60s and wrote `"calls": 0`. Section 7 has the file verbatim.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/library.ts` **(new)** | Suites, cases, versions, suite membership and ordering. Everything scoped by project; the IR schema is imported from `src/schema/ir.ts` and parsed on every write. |
| `src/stages/replay.ts` **(new)** | The second pipeline entry point: stored IR → `generateSpec` → `runSpec`. No model is called anywhere in it. |
| `src/server/index.ts` | 16 new routes for the library and replay. No existing route's shape changed. |
| `public/app.js` | The Suite, Case and Compare screens; the inline Save-case panel; suites in the sidebar; one additive line in `summarize()`. |
| `public/style.css` | New `.lib-*` / `.cmp-*` / `.case-save-*` rules, appended. Nothing above them renamed or repurposed. |
| `tests/library.test.ts` **(new)** | 35 cases over the library, the replay contract and the role gates. |
| `tests/tenancy.test.ts` | The new run-scoped route added to the permanent isolation table; its normaliser now maps `:caseId` as well as `:runId`. |

## 2. NEW FILES

- `src/server/library.ts`
- `src/stages/replay.ts`
- `tests/library.test.ts`
- `docs/phases/PHASE_LIBRARY_REPORT.md`

## 3. NEW ENV FLAGS

**None.** The library is reachable whenever the database is — it introduces no switch of its own.

## 4. NEW ROUTES

All new. `viewer` can read, `tester` can author and run, `admin` can destroy — and a viewer still
only ever sees projects they were added to.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/suites?projectId=` | viewer | With case counts |
| POST | `/api/suites` | tester | `{projectId, name}` |
| PATCH | `/api/suites/:suiteId` | tester | Rename |
| DELETE | `/api/suites/:suiteId` | **admin** | Cases survive — a suite is a grouping |
| GET | `/api/suites/:suiteId/cases` | viewer | In execution order |
| POST | `/api/suites/:suiteId/cases` | tester | `{caseId}`; appends |
| DELETE | `/api/suites/:suiteId/cases/:caseId` | tester | |
| PATCH | `/api/suites/:suiteId/order` | tester | `{caseIds}` — full ordered list |
| GET | `/api/cases?projectId=` | viewer | |
| GET | `/api/cases/:caseId` | viewer | With IR, versions, suite ids |
| GET | `/api/cases/:caseId/versions/:version` | viewer | One version's IR |
| PATCH | `/api/cases/:caseId` | tester | Editing the IR mints a version |
| DELETE | `/api/cases/:caseId` | **admin** | |
| POST | `/api/runs/:runId/cases/:caseId/save` | tester | `{projectId, title?, suiteId?}` |
| POST | `/api/replay` | tester | `{suiteId?, caseIds?, label?}` → `202 {runId, caseCount}` |

`POST /api/replay` is one route for all three selections deliberately, so the access check and the
ordering rule exist once: a suite, a subset of a suite (which runs in the **suite's** order, not the
order the ids arrived in), or loose cases.

## 5. SCHEMA CHANGES

Migration `phase5_library_suites_and_cases` — `suites`, `test_cases`, `test_case_versions`,
`suite_cases`, matching the plan's Part 7.

`suite_cases` is a **join table, not a column on `test_cases`**. A login case genuinely belongs in
both "Smoke" and "Auth", and discovering that after data exists is an expensive migration.
`position` is honoured, so execution follows the curated order.

RLS on all four mirrors the existing five exactly: enabled, `SELECT` to `authenticated` only, scoped
through project → organisation. There is no policy for `anon`, which is what makes the
browser-facing publishable key return `[]`.

## 6. WHAT I DID NOT TOUCH

- **No existing route's request or response shape.** Every addition is a new route.
- **No `style.css` class renamed or repurposed.** The screens reuse `.hrow*`, `.case-badge`,
  `.badge-*`, `.seg`, `.dl-btn-inline`, `.tree-*`, `.panel`, `.field`.
- **View switching is `showView()` only.** No `.hidden` toggled directly.
- **Credentials untouched** — `pendingCredentials.ts` and `scrubServedSecrets` unchanged. A replay
  passes credentials through the same `credentialEnvVars()` path a normal run uses.
- **`AUTH_ENABLED=false` is byte-identical.** Verified: startup log unchanged, no login screen, no
  Team button, sidebar and Run test present.
- **No accounts or organisations created or changed.** Final roster, verified after the work:

  | who | org | role |
  |---|---|---|
  | (synthetic local user) | Default | **owner** |
  | garvit.khandelwal@thinkvibes.com | Default | owner |
  | ls@thinkvibes.com | Default | admin |

---

## 7. HOW TO VERIFY

### A. The flag-off path is unchanged (do this first)

1. `git log --oneline -2` → `ddaa925`, `c3e8adf`.
2. `npx tsc --noEmit` → clean. `npx vitest run` → **531 passed** (40 files).
3. `.env` now sets `AUTH_ENABLED=true DB_ENABLED=true`, so override to see the flag-off path:
   ```
   AUTH_ENABLED=false DB_ENABLED=false npm run serve
   ```
   The startup log must be byte-identical — no `[authz]`, `[db]`, `[shadow]` or `[library]` lines.
   ```
   curl -s http://localhost:3000/api/auth/config     # {"authEnabled":false}
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/runs    # 200
   ```
4. Open `http://localhost:3000` — Home, sidebar, History, Run test; no login screen, no Team
   button, no console errors.

### B. The no-database case still has a sidebar

The default deployment mode, and the one most easily broken by a change that adds DB-backed rows to
the sidebar.

5. Start with no `.env` loaded at all:
   ```
   node --import tsx src/server/index.ts
   ```
6. Both library endpoints degrade with the same actionable message, and runs still work:
   ```
   curl -s http://localhost:3000/api/suites     # 503 "the database is not configured — …"
   curl -s http://localhost:3000/api/projects   # 503, same
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/runs   # 200
   ```
7. Open `http://localhost:3000` and **hard-reload** (a `#/` change alone is a same-document
   navigation and keeps the old in-memory caches, which will mislead you here). The sidebar must
   still list projects — it falls back to grouping runs by URL — and simply show no suites.
   Verified at commit time:
   ```json
   {"activeView":"home","projectRows":5,"suiteRows":0,
    "teamBtnDisplay":"none","badgeHidden":true,"bodyClasses":"","runBtn":true}
   ```

### C. Save a case out of a finished run

8. Restart normally (`npm run serve`) and sign in.

   **Chrome autofill will fight you on the login form** — it overwrites the email with a stale
   saved address. Clear with `Ctrl+A` and retype, `Esc` to dismiss. Permanent fix:
   `chrome://settings/passwords` → find `localhost` → delete the wrong entry.
9. Open any finished run from History, expand a case, and click **Save case**. An inline panel
   opens with a project picker and an optional suite picker.

   The suite list filters to the chosen project — the server refuses a cross-project pair, so
   offering one would be offering a guaranteed error. Verified at commit time:
   `{"panelOpen":true,"projects":11,"suites":["— none —","Smoke"]}`
10. Save it. The confirmation links straight to the new case.

### D. Club cases into a suite, and run them at your choice

A worked example already exists: suite **Smoke** under `learnvibes.vercel.app`, three cases saved
from run `2026-08-11T07-22-49-571Z-984e8063`. Section 9 says how to remove it.

11. Expand a project in the sidebar — its suites are listed **above** its runs. Click one.
12. The Suite screen shows each case with a checkbox, its position, its last status, and
    `↑ ↓ Open ▸ Run Remove`. Confirm all three execution paths:
    - **Run all** — the whole suite, in order.
    - Tick two boxes → the button becomes **▸ Run 2 selected** → click it.
    - **▸ Run** on one row — that case alone.
13. Reorder with `↑`/`↓`. The new order persists (reload to confirm) and is the order execution
    follows.
14. Confirm a case can live in two suites at once — create a second suite, add the same case, and
    check it still appears in the first. Removing it from one leaves it in the other, and the case
    itself survives.

### E. The zero-LLM proof — do this for a MULTI-CASE run

15. Run a suite of 3 from the Suite screen and note the `runId`, then:
    ```
    cat runs/<runId>/08-llm-usage.json
    ```
    **Expected, and verified at commit time for a 3-case suite replay:**
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
    If `calls` is ever non-zero, something routes through a model and the economics are broken.
16. Open that run in the UI. **All four phase cards must read DONE — none stuck at PENDING.**
    Cards 1 and 2 carry their reason:
    ```
    1 · Understanding your request   DONE   Skipped — replaying saved cases, so there is nothing to plan.
    2 · Analyzing the website        DONE   Skipped — the saved steps already say what to click.
    3 · Building & running tests     DONE
    4 · Checking the results         DONE   Pipeline finished — nothing left to evaluate
    ```
    This is the trap the plan names by hand: `computePhaseStatus` only reports a phase complete when
    **every** stage it tracks has completed, so a replay emitting only `generate`/`execute` would
    hang cards 1–3 forever. Verified at commit time:
    `{"phaseCards":["completed:DONE","completed:DONE","completed:DONE","completed:DONE"]}`
17. Per-case results render in the existing suite-results section unchanged — the replay emits the
    same `suite` stage events a normal run does.

### F. Versions and Compare

18. On a Case screen, the **Versions** tab lists the history. v1 is written when the case is saved,
    so history starts at the beginning rather than at the second edit.
19. Edit a case's steps (`PATCH /api/cases/:id` with an `ir`) to mint v2, then click
    **Compare versions**. Two columns, aligned by longest-common-subsequence so an inserted step
    shifts nothing after it, with a count above. Verified at commit time: *"1 step added, 1 removed
    between v1 and v2"*, five shared steps rendered plain, the removed step struck through.
20. A malformed IR is refused rather than stored, and the case is left untouched:
    ```
    curl -s -X PATCH http://localhost:3000/api/cases/<id> -H "Authorization: Bearer <TOKEN>" \
      -H "Content-Type: application/json" -d '{"ir":{"meta":{"title":"x"},"steps":[]}}'
    ```
    → `400 "… is not a valid test plan: …"`

### G. Roles — the part that matters

The screens hide what a role cannot use. That is a courtesy. These confirm the server refuses
regardless of what was drawn.

21. As a **viewer** (token from an account with the viewer role):
    ```
    curl -s -o /dev/null -w "create suite  %{http_code}\n" -X POST http://localhost:3000/api/suites \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"projectId":"<P>","name":"x"}'
    curl -s -o /dev/null -w "replay        %{http_code}\n" -X POST http://localhost:3000/api/replay \
      -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"caseIds":["<C>"]}'
    ```
    → **403, 403**. A tester gets 201 and 202 for the same two.
22. A **tester** still cannot destroy:
    ```
    curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3000/api/suites/<S> \
      -H "Authorization: Bearer $TESTER_TOK"      # 403
    ```
23. Selecting by id is not a way into a project you were not added to — every case in a replay
    selection is checked, not just the first:
    ```
    curl -s -X POST http://localhost:3000/api/replay -H "Authorization: Bearer $TESTER_TOK" \
      -H "Content-Type: application/json" -d '{"caseIds":["<yours>","<someone-elses>"]}'
    ```
    → `403 "you have not been added to this project"`

### H. The RLS invariant — the one that must never regress

24. Four tables were added, so re-confirm the browser-facing key sees nothing across all nine:
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
    **Expected — verified at commit time:**
    ```
    runs:                  []
    organisations:         []
    organisation_members:  []
    projects:              []
    project_members:       []
    suites:                []
    test_cases:            []
    test_case_versions:    []
    suite_cases:           []
    ```
    If any returns rows, run history and saved tests are world-readable — stop everything.

---

## 8. HOW TO ROLLBACK

```
git revert ddaa925          # the three screens only — the API stays, nothing breaks
git revert ddaa925 a413adf  # all of it
```

**Manual step — the migration does not revert with the code.** The four tables are additive and
inert without the routes, so leaving them is harmless. To drop them:

```sql
drop table if exists suite_cases, test_case_versions, test_cases, suites cascade;
```

That **destroys every saved case and its version history**, which is authored work with no other
copy — the source runs hold the original IR, but not the edits. Export first if you might want it.

---

## 9. DEFERRED

**Left in your workspace on purpose.** The suite **Smoke** under `learnvibes.vercel.app`, its three
saved cases and the replay run are real data I created while verifying, kept so section D has
something concrete to click. Remove with **Delete suite** on the Suite screen (cases survive) plus
**Delete case** on each, or:
```sql
delete from test_cases where source_run_id = '2026-08-11T07-22-49-571Z-984e8063';
delete from suites where name = 'Smoke';
```

**Not built, and you will notice these:**

- **No step editor on the Case screen.** Steps render read-only. The API supports editing
  (`PATCH /api/cases/:id` with an `ir`, which mints a version and drives Compare), but the
  reference design's inline step editor — add/remove/reorder/"ask for a change" — is not there. A
  case is currently edited through the API or re-saved from a fresh run.
- **No Script tab.** The reference design shows the generated `spec.ts` on the Case screen. The
  spec is regenerated from the IR at replay time and is downloadable per-run from a run's results,
  but the Case screen does not show it.
- **No Duplicate or Restore.** Both appear in the reference design for suites, cases and versions.
- **`tags` / `test_case_tags` not created.** The plan's third segregation axis. Projects (hard
  ownership) and suites (ordered collections) are in; a case cannot yet be labelled
  smoke/regression/sprint-14. The plan is explicit that a single `category` column is the wrong
  answer, so this stays a join table when it is built.
- **No optimistic concurrency on case edits** (plan Step 5.4). Two people editing one case will
  silently clobber each other. `current_version` already exists for version history, so the guard
  the plan describes — `PATCH` requiring the client's `current_version`, 409 on mismatch — is
  cheap to add and worth doing before a second person edits cases.
- **No diagnosis or self-heal on a replay.** Both call a model, and a replay that quietly spent
  tokens to recover would defeat the property this path exists for. A failing replay reports the
  failure and the evidence. If you want a diagnosis, re-run the case through the normal pipeline.

**Noticed, outside this phase, not touched:**

- **An orphaned database function.** Migration `20260825080543 orgs_create_with_owner` applied
  `public.create_organisation_with_owner`, and the security advisor flags it
  (`function_search_path_mutable`). The org-creation work that added it was stopped and its code
  reverted from git, but **the migration persisted in the database** — so the function has no
  caller. Either finish that feature or drop the function; I left it alone because resuming that
  work is your call. It is the only new advisor finding, and it is not from this phase's migration.
- **Leaked-password protection is still off** (Dashboard → Authentication → Policies). Pre-existing,
  and now that real accounts can be self-created it is worth turning on.

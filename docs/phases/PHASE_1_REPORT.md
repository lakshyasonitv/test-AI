# Phase 1 — Artifact storage

Implements Steps 1.1–1.2 of `implentationplan.md`, plus Step 0.3 (bundled into the same commit —
see below). Approved plan: `C:\Users\Garvit Khandelwal\.claude\plans\crystalline-scribbling-quiche.md`.

Commit: `9ac2e33`.

**Why Step 0.3 is in this commit, not Phase 0's:** Step 0.3's prerequisite refactor
(`src/server/index.ts` exports `app`, guards `app.listen()`) and Step 1.1's route replacement
both edit `src/server/index.ts`, and 1.1 directly builds on 0.3's change in the same file. Rather
than reconstruct an artificial intermediate file state to split them, both are committed together.
`docs/phases/PHASE_0_REPORT.md` covers Steps 0.1/0.2/0.4, which are genuinely independent and
committed separately (`0e7dabe`).

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/index.ts` | (a) Exports `app`; guards `app.listen()`, the startup env-var log, and the new retention job behind `isMain` (`fileURLToPath(import.meta.url) === process.argv[1]`) so importing the module for tests never binds a port or starts a timer — verified `npm run serve` still logs and listens identically. (b) Replaces `app.use("/runs", express.static("runs"))` with an explicit `GET /runs/:runId/*` route: path-traversal guard, a no-op `canAccessRun(req, runId)` stub for Phase 2 to fill in, and `res.sendFile` (same Range-request and Content-Type handling `express.static` used internally, so nothing about video scrubbing or download links changes). (c) Wires in `startRetentionJob()` inside the `isMain` block. |

## 2. NEW FILES

- `src/server/retention.ts` — Step 1.2's retention job.
- `tests/apiContract.test.ts` — Step 0.3's contract tests, extended with 3 cases for the new
  artifact route (path traversal, encoded traversal, 404 on a missing file).

## 3. NEW ENV FLAGS

| Flag | Default | What it does | When flipped |
|---|---|---|---|
| `RUN_RETENTION_DAYS` | unset/`0` (disabled) | Deletes `runs/<id>/` directories once they're in a terminal state (`done`/`error`) **and** older than this many days, hard-floored at never touching anything under 24h old. Checked once immediately on startup, then every 6h. | Set to a positive number (can be fractional, e.g. `7` for a week) to enable pruning. `0`, unset, or any non-positive/non-finite value keeps the job fully inert — no timer starts, no log line appears, nothing is ever read from or deleted under `runs/`. |

## 4. NEW ROUTES

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/runs/:runId/*` | — (path only) | Streams the file at `runs/<runId>/<rest-of-path>` with its natural `Content-Type` and Range-request support, `404` if it doesn't exist (or is a directory — unchanged from before), `403` if the resolved path would escape `runs/` or (Phase 2, currently always-allow) `canAccessRun` denies it. **Not new functionality** — replaces the identical-surface `express.static("runs")` mount; every path shape `public/app.js` already constructs (run-root and per-case spec/IR/result JSON, arbitrarily-nested Playwright artifact directories, screenshots, video, trace.zip) was verified to still resolve and serve correctly. |

No `/api/*` route changed shape.

## 5. SCHEMA CHANGES

None — no database exists yet (that's Phase 3).

## 6. WHAT I DID NOT TOUCH

- No existing `/api/*` route's request/response shape — `tests/apiContract.test.ts` pins all of
  them and passes unchanged.
- `public/app.js` / `public/style.css` — not touched. The frontend's existing `/runs/...` URL
  constructions (case cards, `loadCaseDetails`, the run-root trace link, etc.) needed zero changes
  because the new route serves the exact same path space.
- Credential handling — untouched.
- `RUNS_DIR`'s resolution (`path.resolve("runs")`) — same directory the static mount served from;
  nothing moved.
- The real `runs/` directory — Step 1.2's guard logic was verified against a throwaway scratch
  copy (`.retention-scratch/`, created and deleted during verification, never committed), never
  against real run data. `RUN_RETENTION_DAYS` was never set while the real server pointed at the
  real `runs/` directory.

## 7. HOW TO VERIFY

1. `npx tsc --noEmit` → clean. `npx vitest run` → `396 passed (396)`, including the 3 new
   artifact-route tests in `tests/apiContract.test.ts`.
2. `npm run serve`, then in the same terminal confirm the startup log still reads exactly:
   ```
   [startup] Environment variable check:
     GEMINI_API_KEYS: ...
   AI Test Platform UI: http://localhost:3000
   ```
   (no new "retention" lines — confirms the default-off flag).
3. In a browser, open a completed run that has a `cases/` subtree (any run directory under
   `runs/` with a `cases/case-N/` folder works — e.g. one you already have locally). Confirm every
   screenshot renders, a failing case's video plays **and its scrub bar works** (drag it — this
   confirms Range-request support survived the switch off `express.static`), and both
   "Download test script"/"Download full result" buttons work.
4. Path-traversal guard — with the server running and `<runId>` replaced by any real run id you
   have:
   ```
   curl -i "http://localhost:3000/runs/<runId>/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"
   ```
   → `403`.
5. Missing file: `curl -i "http://localhost:3000/runs/<runId>/nope.json"` → `404`.
6. Retention, default-off: leave `RUN_RETENTION_DAYS` unset, start the server, confirm no
   `[retention]`-prefixed log line ever appears and nothing under `runs/` is touched, no matter
   how long the server runs.
7. Retention, logic-only (do **not** point this at your real `runs/` data): create a scratch
   directory with a fake `runs/<id>/events.ndjson` ending in a `"done"`/`"error"` stage event,
   `cd` into it, set `RUN_RETENTION_DAYS` to a very small number, and run
   `npx tsx <path-to>/src/server/retention.ts`-style import of `startRetentionJob()` — confirm a
   run younger than 24h is never deleted regardless of how aggressive the setting is (this is what
   was done for this report; see Step 1.2's description above for the exact guard order).

## 8. HOW TO ROLLBACK

```
git revert 9ac2e33
```

This alone restores `express.static("runs")`, removes `src/server/index.ts`'s `export { app }`/
`isMain` guard, deletes `src/server/retention.ts`, and removes `tests/apiContract.test.ts`. No
migrations, no manual steps — `RUN_RETENTION_DAYS` was never set against real data, so there's
nothing to undo on disk.

**If Phase 0's commit (`0e7dabe`) is still present after this revert:** everything in it remains
valid and independent — it doesn't reference anything from `9ac2e33`. Reverting only `9ac2e33` is
safe on its own.

**If you want to revert both phases:** `git revert 9ac2e33 0e7dabe` (in that order — newest
first) in one pass, or as two separate revert commits; either way is safe since neither commit's
revert depends on ordering relative to the other except that `9ac2e33` was committed after
`0e7dabe`.

## 9. DEFERRED

- **Directory listing for a bare `.../artifacts` link** (the "Open" link in a case's result
  panel) behaves identically before and after this change — `sendFile` can't serve a directory,
  and `express.static` didn't render a listing for one either (no `index.html` inside those
  directories). Not a regression, just noting it stays a dead link either way; making it list
  contents (or removing the link if nothing uses it) would be new UI work, out of scope here.
- **`canAccessRun` is a stub that always returns `true`** — by design, per the plan
  (`implentationplan.md` Step 1.1: "the guard isn't built yet"). Phase 2 (Identity) is where this
  gets real logic.
- Retention's 6-hour interval and terminal-state check reuse `src/runStore.ts`'s existing
  `store.read()` rather than a new status helper, per the plan's explicit instruction — worth
  knowing if Phase 3's database migration changes what "terminal" means, since this job will need
  updating in lockstep with `listRuns()`'s own status derivation, not independently.

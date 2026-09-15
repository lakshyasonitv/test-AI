# Lambda migration — what it would take to run this on AWS Lambda

**What this doc owns:** the *plan* for moving this app to AWS Lambda — the blockers, the target
architecture, and the ordered work. It is a plan, not a topic owner. `ARCHITECTURE.md` owns the
file-by-file map and the schema, `DECISIONS.md` owns why any individual choice was made,
`TECH_DEBT.md` owns what is broken, and `docs/phases/` owns what each shipped phase changed. Where
this doc and those disagree, they win. Nothing should be filed *into* this doc — a defect found
while executing it belongs in `TECH_DEBT.md`, a rationale in `DECISIONS.md`.

**Status: not started.** Written 2026-09-14 against the tree at that date. Every line/file reference
below was verified then; re-check before acting on one (`DECISIONS.md` D-01 — doc drift is a
recorded, recurring failure mode here).

---

## Context

The goal is to run this app on AWS Lambda so the organisation's testers can use it without an EC2
instance to patch or an SSH session to keep alive.

The app cannot run on Lambda in its current shape. Four architectural facts block it, each verified
in code: work continues after the HTTP response (`index.ts:303-307` fires the pipeline without
awaiting, then returns `202`); runs park up to 10 minutes on in-memory promise resolvers
(`pendingCaseSelection.ts:8-11`, which states outright that they "cannot be persisted"); every
artifact path is hardcoded relative to cwd with no env var to relocate it; and the concurrency
semaphore is per-process. This was raised and the Lambda target was reaffirmed, so this plan covers
the migration rather than an alternative.

**The resulting architecture is Lambda for the API tier and Fargate for the worker.** That is not a
hedge — a full run includes a 10-minute human gate plus discovery plus real Playwright execution,
which cannot fit Lambda's non-negotiable 15-minute cap. Lambda serves the UI and the read/poll
routes; the run itself executes on a container.

One finding materially simplifies this, and one materially complicates it. Both are in the design
below: run state is **already durable on disk**, so no DynamoDB is needed for run state. But the
credential gate **cannot** use Step Functions task tokens without violating a standing security
rule.

---

## Target architecture

```
Browser
  |
  v
Function URL / ALB
  |
API Lambda (container image + Lambda Web Adapter)
  |  - serves public/, all GET routes, auth, library, projects
  |  - POST /api/runs  -> enqueue to SQS, return { runId } (202, unchanged)
  |  - GET  /api/runs/:id/state -> reads events.ndjson from EFS
  |
  +--> SQS (run queue)
  |      |
  |      v
  |    Fargate worker (same image, worker mode)
  |      - consumes the queue, executes runPipeline
  |      - launches Chromium, writes artifacts
  |
  +--> Step Functions (case-selection gate only, waitForTaskToken)
  |
  +--> direct in-memory proxy to the worker (credential gate - see below)
  |
EFS mounted at /mnt/runs on BOTH tiers  <- RUNS_DIR
```

---

## The credential gate cannot use Step Functions — design constraint

`CLAUDE.md` rule 5 is absolute: *real credentials never touch disk or the database.* They live in
process memory for one walk, and stored steps keep `${env:...}` references.

Step Functions' `SendTaskSuccess` payload is recorded in **execution history and retained for 90
days**. Routing a credential answer through a task token would write real user passwords into an AWS
control-plane log. That is a direct violation, and it is the kind of leak the project has already
been bitten by twice (`CLAUDE.md` "Don't" list).

**Therefore the two gates are handled differently:**

| Gate | Payload | Mechanism |
|---|---|---|
| Case selection (`pendingCaseSelection.ts`) | test case titles/indexes — no secrets | Step Functions `waitForTaskToken`, token in DynamoDB |
| Credentials (`pendingCredentials.ts`) | real username/password | **Never** through Step Functions or DynamoDB. The worker registers its task IP in DynamoDB; the API Lambda proxies `POST /api/runs/:runId/credentials` straight to that worker over the VPC, in memory only. |

The credential path keeps today's guarantee: the value exists only in the worker's memory, is never
written to disk, never logged, never persisted. `resolveCredentials.ts`'s existing waiter table is
reused unchanged inside the worker — only the *transport* to it changes.

Do **not** take the shortcut of setting `TEST_USERNAME`/`TEST_PASSWORD` in the worker's task
environment. `resolveCredentials.ts:33` is env-first, so those would override every UI prompt and
all testers would silently share one account.

---

## Work items

### 1. `RUNS_DIR` env var — make the artifact root configurable

Currently hardcoded relative in ~10 places. Add a single exported helper (e.g. `src/runsDir.ts`)
returning `process.env.RUNS_DIR ?? "runs"`, and thread it through every site. **Default `"runs"`
means local behaviour is byte-for-byte unchanged**, satisfying `CLAUDE.md` rule 2.

Sites: `orchestrator.ts:78`, `runStore.ts:23,179,189,240`, `kb/llmCache.ts:18`, `kb/cache.ts:6`,
`caseAccumulator.ts:12`, `caseHistoryLedger.ts:7`, `replay.ts:154`, `suiteRunner.ts:207`,
`heal.ts:128`, `server/index.ts:167,427,516`, `server/library.ts:549`, `stages/caseEdit.ts:117`,
`server/retention.ts:11`.

Two traps:

- `index.ts:167` (`path.resolve("runs")`) is the **path-traversal guard's base**. Changing it wrong
  is a security regression, not a cosmetic one. It needs its own test.
- `playwright.config.ts:4` has `testDir: "./runs"`, resolved relative to the config file. It must
  agree with `RUNS_DIR`, or the spawned CLI looks in the wrong place.

Also note `executor.ts:170` finds the Playwright CLI via `process.cwd()/node_modules/...` — cwd must
still be the app root even though artifacts move to EFS. Keep `WORKDIR /app`; only `RUNS_DIR` moves.

### 2. Split dispatch: inline vs queued

New flag `RUN_DISPATCH=inline|queue`, **defaulting to `inline`** (today's behaviour). It is not a
boolean, so it needs its own explicit validation — the boot guard in `index.ts` validates only the
seven flags in `BOOLEAN_ENV_FLAGS`, and a malformed value here must not slip past it.

- `inline` — `runLimit.run(...)` exactly as now.
- `queue` — `POST /api/runs` sends to SQS and returns.

**`POST /api/runs` must still return `{ runId }` with status `202`.** `CLAUDE.md` rule 1 forbids
changing an existing route's response shape, and `public/app.js` reads it. The queue is invisible to
the browser.

### 3. Worker entrypoint

New `src/worker/index.ts`: long-poll SQS, call `runPipeline` with the same arguments `index.ts:305`
passes today, register the task's IP in DynamoDB for the credential proxy, delete the message on
terminal status. Reuses the orchestrator untouched.

Runs as a Fargate service (not Lambda). Set task concurrency to the value `MAX_CONCURRENT_RUNS`
means today — one Chromium per concurrent run, ~1 GB each.

### 4. Case-selection gate via Step Functions

Replace the in-memory `Map` in `pendingCaseSelection.ts` with a task-token store, keeping the
existing `awaitCaseSelection`/`resolveCaseSelection` signatures so callers do not change. Keep the
10-minute timeout as the state's own timeout.

### 5. Container images

One image, two entrypoints (API vs worker), built on `mcr.microsoft.com/playwright:v1.49.0-jammy` —
matching the exactly-pinned Playwright `1.49.0`.

- `WORKDIR /app`, `node_modules` directly beneath it (constraint from `executor.ts:170`).
- **No `--omit=dev`** — `tsx`, `playwright` and `@playwright/test` are all devDependencies required
  at runtime, and there is no build step (`tsconfig.json` has `noEmit: true`).
- `USER pwuser` — all four `chromium.launch()` sites take no options object (`domDiscovery.ts:537`,
  `hybridDiscovery.ts:278,893`, `liveExtend.ts:124`), so there is no seam to pass `--no-sandbox`,
  and Chromium will not run as root.
- `ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — browsers are already in the base image, and
  `README.md:43-46` records the postinstall hanging indefinitely.
- API tier adds the Lambda Web Adapter so Express runs unmodified.
- `.dockerignore` must exclude `.env` and `.env.rls` — `npm start` uses `--env-file-if-exists=.env`,
  so a baked-in `.env` is silently loaded.

### 6. EFS

Mount at `/mnt/runs` on both tiers; set `RUNS_DIR=/mnt/runs`. Required because
`playwright.config.ts` and the executor's `--output=` both need a real filesystem path — S3 would
mean rewriting `fs` calls.

Keep `RUN_RETENTION_DAYS` set on the worker only (`retention.ts`), or EFS grows forever. Note
`runs/_cache/` holds paid-for LLM answers that never expire; it must survive any cleanup.

### 7. Concurrency

`Semaphore` becomes meaningless across tasks. Cap via Fargate service desired-count and SQS
concurrency instead. `/api/health`'s `concurrency: {inFlight, queued, max}` will report only the
local process — leave the field (rule 1 freezes the shape) but stop treating it as the global
signal.

---

## Verification

Local first — the whole point of defaulting `RUNS_DIR` and `RUN_DISPATCH` is that nothing changes
until they are set:

```bash
npx tsc --noEmit          # must stay clean
npx vitest run            # note the count against the last known baseline
```

Then, in order:

1. **`RUNS_DIR` defaults correctly** — with it unset, a full local run produces
   `runs/<id>/results.json` exactly as before. New tests for the traversal guard at `index.ts:167`
   under a non-default `RUNS_DIR`.
2. **`RUN_DISPATCH=inline` is unchanged** — a local run behaves identically; `POST /api/runs` still
   answers `202 {runId}`.
3. **Worker consumes the queue** — enqueue one run, confirm the Fargate task picks it up and
   `events.ndjson` appears on EFS.
4. **Polling works cross-tier** — `GET /api/runs/:id/state` served by Lambda must show progress for
   a run executing on the worker. This proves the EFS/durability assumption.
5. **Case-selection gate resolves** across tiers via task token.
6. **Credential gate resolves, and leaks nothing.** After a successful login run, grep the entire
   run directory, the Step Functions execution history and DynamoDB for the password — it must
   appear in none of them. This is the rule-5 regression test and it is non-negotiable.
7. **Chromium launches as `pwuser`** — one real run producing screenshots, per `DECISIONS.md` D-19
   (a generated Playwright expression is not verified until executed once).

---

## Risks

- **Scope.** Items 1-4 rewrite the run lifecycle and touch the credential path — the area
  `CLAUDE.md` flags as most dangerous. This is substantially larger than a deployment change.
- **The credential proxy is the weakest link.** It requires the API tier to reach a specific worker
  task over the VPC. If that fails, login cases fail — the exact class of bug TD-66 just fixed.
- **Two moving tiers instead of one process** conflicts with TD-19's recorded single-process
  assumption; anything else reading in-memory state will need the same treatment.
- **Cost.** A Fargate worker that must stay warm to hold gates is not cheaper than one small EC2
  instance running the same container.

---

## Verified references

`index.ts:303-307` (fire-and-forget) · `pendingCaseSelection.ts:8-11,20,24` (in-memory gate, 10-min
wait) · `runRegistry.ts:5-8` (SSE only; durability is the RunStore, so run state **is** on disk) ·
`executor.ts:170` (CLI located by cwd) · `resolveCredentials.ts:33` (env-first) ·
`playwright.config.ts:4` (`testDir: "./runs"`) · `package.json:25,30,32` (runtime devDependencies) ·
`TECH_DEBT.md` TD-19 (single-process assumption) · `CLAUDE.md` rules 1, 2, 5

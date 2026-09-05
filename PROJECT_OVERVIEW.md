# Project Overview

**What this file is:** a guided walkthrough of the whole system — pipeline, server, and
frontend — for someone who has never opened this repo before. It's meant to be read start to
finish in one sitting and build a mental model, not to be the authoritative reference for any
one piece.

**What this file is not:** a replacement for the repo's existing docs, which each own one topic
and go much deeper than this file does on purpose (see `CLAUDE.md`'s `DECISIONS.md` D-01 for why
that separation exists — this doc set used to duplicate itself and drifted out of sync). Where
this file says "for the full picture, see X," that's not a formality — X actually has the
detail. This file exists to add the one thing none of the others cover: a walkthrough of the
`public/` frontend, which until now had no documentation anywhere.

---

## The elevator pitch

You type a plain-English testing request and a URL. The system reads the request, crawls the
real site to understand what's actually on the page (forms, buttons, links — as accessibility
roles and names, not screenshots), asks an LLM to turn your request into a small suite of test
cases, compiles the one that matches your request into a strict, machine-checked test plan,
writes it out as a real Playwright spec, and runs that spec in an actual Chromium browser. You
get back a pass/fail verdict, a screenshot, and — if it failed — a plain-English explanation of
what went wrong, not a raw stack trace. The rest of the suite runs the same way, each case in its
own browser session, and you can watch all of it happen live in the web UI.

The reason this is more than "point an LLM at a browser": almost every step that could be wrong
has a deterministic check behind it, not just a prompt asking the model to be careful. A test
step that references a page the crawler never found is rejected in code, not trusted. A locator
the model invented is checked against what discovery actually saw on the real page. See
`CLAUDE.md`'s "central design rule" for the philosophy — it's the single idea that shapes most of
`src/stages/`.

---

## The end-to-end pipeline

Everything below lives in `src/stages/`, and the whole sequence is wired together in one place:
`src/orchestrator.ts`'s `runPipeline()`. That function is genuinely worth opening directly — it
reads almost like documentation, with a comment on every non-obvious decision. What follows is
the narrative version.

**1. Plan** (`planner.ts`) — Gemini turns your prompt into a structured plan: what kind of
testing scope you're asking for (smoke / functional / regression / security), at what coverage
level (`minimal` / `standard` / `full`).

**2. Discovery** (`domDiscovery.ts`, `domExtract.ts`, `hybridDiscovery.ts`) — this is the "look
at the real page" step, and it's DOM-first by design: `domDiscovery.ts` drives a real headless
Chromium page, and `domExtract.ts` reads its HTML with cheerio to pull out every interactive
element as an accessibility role + name (button "Add to cart", link "Checkout", etc.) — no LLM
tokens spent on this, it's the primary path for every page. `hybridDiscovery.ts`'s
`discoverSiteHybrid` doesn't stop at the one URL you gave it: it follows the entry page's own
same-origin links (bounded by `MAX_DISCOVERY_PAGES`) and merges everything into one `AppModel`
(the schema in `src/schema/appModel.ts`). If the entry page shows a live login form, discovery
signs in *before* crawling, so the rest of the site isn't modelled as a login wall. Gemini Vision
only gets involved as a fallback, for pages where the DOM genuinely has nothing useful (a canvas
app, an icon-only control with no accessible name). Full mechanics, including the auth-aware
flow: `ARCHITECTURE.md`'s Auth-Aware Discovery section.

**3. Test case generation** (`testCases.ts`) — Gemini takes the plan + the AppModel and proposes
a coverage suite: valid path, invalid input, boundary, security — filtered to whatever scope the
plan asked for, capped at `MAX_CASES_PER_RUN`. If `ENABLE_CASE_SELECTION_GATE` is on (or the
per-run Settings toggle is), this is also where the pipeline can *pause* — see "Pause points"
below — via `caseSelectionGate.ts`, handing a batch to the UI for you to accept, reject, or ask
for a refined regeneration before anything runs.

**4. Primary case + IR compilation** (`ir.ts`) — one case is picked as "primary" (the one tagged
as the direct translation of your prompt, or the highest-priority one otherwise), and it gets
compiled into an **IR** — a strict JSON test plan (`src/schema/ir.ts`) that is the actual
contract everything downstream trusts. This is where most of the "deterministic check behind
every LLM claim" work happens: a `navigate` step's target URL is checked against pages discovery
actually found; a locator is grounded against a real discovered element; a final text assertion
is replayed against the live page and corrected if the model guessed the wording wrong. If
discovery had to sign in, that login is replayed here as real steps at the start of the IR, so
the generated test authenticates itself in its own fresh browser rather than depending on
discovery's session.

**5. Spec generation** (`generator.ts`) — pure code, deliberately no LLM call (`DECISIONS.md`
D-06) — turns the IR into an actual `*.spec.ts` file, one `test.step()` block per IR step, each
with its own screenshot.

**6. Execution** (`executor.ts`) — also pure code — actually runs that spec with Playwright, for
real, in Chromium.

**7. Failure analysis** (`failureAnalysis.ts`, `classify.ts`) — only runs if the test failed.
A deterministic classifier tries first, pattern-matching common Playwright error shapes for free;
Gemini is the fallback for anything ambiguous, producing a plain-English diagnosis instead of a
raw stack trace.

**8. Self-heal** (`heal.ts`) — for a narrow class of failures (selector drift), the pipeline gets
exactly one automatic retry: re-snapshot the page, regenerate the affected part of the IR, run
again. Bounded to one attempt, no loop.

**9. The rest of the suite** (`suiteRunner.ts`) — once the primary case has a result, every other
selected case goes through steps 4–8 independently, each in its own Playwright `test()` /
browser context, writing its own artifacts under `cases/<caseId>/`.

`README.md`'s "How It Works" diagram is the fastest single reference for this whole sequence —
worth having open alongside this section. For every file's actual signature and every schema
field, `ARCHITECTURE.md` is the real reference.

---

## The server layer

`src/server/index.ts` is an Express app in two halves.

The **original half** is almost entirely "kick off `runPipeline()` and let clients watch it
happen" — no database, no auth, no session store. That half still works exactly as it always did,
and with every platform flag off it is the *only* half that exists:

| Route | Purpose |
|---|---|
| `POST /api/runs` | Start a run. Validates the URL(s) and coverage level, generates a `runId`, returns it immediately (202) while the pipeline runs in the background against a concurrency limit (`MAX_CONCURRENT_RUNS`). |
| `GET /api/runs` | List runs — newest 20, from disk (`runStore.ts`'s `listRuns()`). No paging past that cap. |
| `GET /api/runs/:runId/events` | SSE stream of that run's progress events, live. |
| `GET /api/runs/:runId/state` | The same run's full event log as one JSON snapshot — a polling fallback (see below). |
| `POST /api/runs/:runId/credentials` | Answer a paused run's login prompt (or explicitly skip). |
| `POST /api/runs/:runId/case-selection` | Submit a decision for a paused case-selection gate round. |
| `GET /api/runs/:runId/accepted-cases` | Current accumulated pool for a gate round, so the UI can render what's been accepted so far. |
| `GET /api/runs/:runId/case-selection-status` | Snapshot of the currently-pending gate round, for polling it. |
| `POST /api/runs/:runId/case-selection/rewrite` | "Ask for a change" on a case at the gate, before it has an IR. Behind `GATE_CASE_EDIT_AI`; proposes only. |
| `GET /api/runs/:runId/page-elements` | The discovered controls of each page, role + name only, so the gate editor can show what actually exists. |
| `DELETE /api/runs/:runId` | Delete a run's directory permanently. |
| `GET /api/health` | Diagnostic: which env vars are set (name/length only, never values), and the server's current defaults for the gate/self-heal toggles. |

**Why both SSE and polling exist for the same data:** a Cloudflare Quick Tunnel (the repo's
suggested way to share a local instance) buffers `text/event-stream` responses and only flushes
on connection close — which an open SSE stream never does. So the frontend polls `/state`
**unconditionally**: there is no SSE branch and no runtime fallback, and `EventSource` appears
nowhere in `public/` as code. `/events` is still implemented and tested server-side, but no client
has ever consumed it — on localhost or behind a tunnel.

**Pause points — how a run "waits" for you:** two moments in the pipeline can park a run on a
promise until the browser answers. (The third bullet below is not a pause point — it is what the
gate does with your answer once it arrives; `applyGateEdits` runs *after* the decision resolves and
parks nothing.)

- **Credentials** (`pendingCredentials.ts`) — the moment discovery finds a live login gate, or
  case generation decides a case needs a login it doesn't have. The promise resolver lives only
  in server memory (never on disk — the values are real passwords, and `runs/` is served
  publicly), with a timeout (`CREDENTIAL_WAIT_MS`) after which the run just continues without
  credentials, same as a `Skip` would produce. This is what backs the UI's credential modal.
- **Editing at the gate** (`gateCaseEdits.ts`) — a proposed case is not read-only: its title,
  steps and expected outcome can be changed, it can be removed, or a case can be written from
  scratch, all before anything is compiled. The decision route gained two optional fields for it,
  so a client that sends neither behaves exactly as before. Only the CURRENT round's batch is
  editable — cases accepted in an earlier round show as a count, not as cards.
- **Case-selection gate** (`pendingCaseSelection.ts`, `caseAccumulator.ts`,
  `caseHistoryLedger.ts`) — when the gate is enabled, `POST /api/runs/:runId/case-selection`
  resolves a parked promise with your accept/reject/refine decision. `caseAccumulator.ts` tracks
  which cases have been accepted so far *this run* (persisted to `runs/<runId>/accepted-cases.json`
  so a page reload doesn't lose the pool), and `caseHistoryLedger.ts` keeps a durable log of every
  round so a title that was already accepted or explicitly rejected is excluded from every later
  regeneration batch.

Run history itself is intentionally simple: `runStore.ts` just reads `runs/<runId>/` directories
off disk (see "What gets persisted" below) — there's no separate database to keep in sync with
the filesystem, which is also why `GET /api/runs` has a hard cap instead of real pagination.

### The platform half

The **second half** turns the tool into something a team can share: accounts, projects, a library
of saved tests, and an editor for them. It was built in the phases logged under `docs/phases/`,
and every part of it is behind an env flag that defaults to **off**.

| Area | Routes | What it is |
|---|---|---|
| Identity | `/api/auth/config`, `/api/auth/signup`, `/api/auth/me`, `/api/auth/bootstrap` | Supabase Auth. `AUTH_ENABLED=false` substitutes a synthetic local **owner** — the permission checks still run and still pass, rather than being skipped |
| Org + team | `/api/organisations/:orgId/{members[/:userId],assignments,addable-users}`, `/api/projects/:projectId/members[/:userId]` | Four roles: `viewer` < `tester` < `admin` < `owner`. Member management is nested under the org or project — there is no top-level `/api/members` |
| Projects | `/api/projects`, `/api/projects/:projectId` (GET/POST/PATCH/DELETE) | Full CRUD; delete is admin-only and refuses with 409 while the project still holds runs. A project may have no URL |
| Library | `/api/cases*`, `/api/suites*` | Saved test cases, their version history, and suites you can run a chosen subset of |
| Step editing | `/api/cases/:id/steps*` | Read steps as English, estimate what a save costs, save it as a cancellable job |
| Model help | `/api/cases/:id/rewrite`, `/api/cases/:id/steps/translate` | A model **proposes** a step list; it never writes |

**Two access axes, deliberately separate.** Your org **role** is what you may *do* (a `viewer` can
look, a `tester` can author, an `admin` can assign). Your **project membership** is what you may
*see*. A brand-new account is a `viewer` who is a member of nothing, so it sees an empty app until
an owner or admin adds it to a project. Neither axis alone is enough: a `tester` who is not a
member of a project cannot touch its cases, and an `admin` still only sees the projects they are
in.

**Editing a saved test is the interesting part.** Steps are shown as sentences —
`Click on button "Sign In"` — and edited as text. When you save, the server parses each sentence
back onto the step it came from, which produces a distinction the whole cost model rests on:

- Changing a step's **value** (retyping a password, fixing a typo in a name) leaves the *element*
  it points at alone. The stored grounding survives, so the save is **instant and free** — no
  browser opens at all.
- Changing **which element** a step points at strips that grounding by construction. Now the new
  target has to be verified against the live site, which means replaying the earlier steps to
  arrive at the right page first — you cannot check step 7 without executing steps 1 through 6.

So the editor tells you which it is **before** you press Save: how many steps will be re-checked,
roughly how long, and whether the walk will need to sign in. The save then runs as a job with live
per-step progress and a Cancel button, and nothing is written unless it finishes.

**And when the sentence is wrong,** the parser says so within about 400ms of you stopping typing —
and offers **"Write it for me"**. A model translates the loose line (`press the admin button at the
top`) into the vocabulary the parser accepts (`Click on button "Admin"`) and shows it as a diff.
Approving it only fills the editor; you still press Save, and it still goes through the same parse,
the same re-ground, the same version history. That rule — **a model proposes, a person approves,
and there is only ever one way into the library** — is `DECISIONS.md` D-27, and it applies equally
to the "Ask for a change" card next to it.

---

## The frontend

**Which frontend:** the working one is `public/` — a plain HTML/CSS/vanilla-JS app served
directly by Express (`app.use(express.static("public"))` in `src/server/index.ts`). There was
briefly also a `web/` directory containing a partial Next.js rewrite; it was never functional —
most of its source (config, components, a lib layer) was missing from disk and it didn't build —
so it has since been deleted. Everything below is `public/`.

The three files: `public/index.html` (348 lines — structure, one
`<section class="view" data-view="...">` per screen), `public/app.js` (**5,611 lines** — all
behavior, all state, all rendering, including every platform screen: login and sign-up, the projects
tree, the Team screen, suites, and the case detail screen with its step editor, live estimate, job
progress and proposal diffs), and `public/style.css` (1,915 lines — the visual system: a
deliberately single light theme built from **two colours, white and ThinkVibes blue `#0b63ce`**,
with black for text and every other surface being that blue at low opacity. Every component class is
documented as a *contract*: `app.js` drives the UI purely by toggling class names like `.hidden`,
`.view-active`, `li.completed`, `.phase-badge.running`, `.case-card.open`, `.role-no-edit`, so
renaming one silently breaks a feature). `icons.js` is a small inline-SVG icon set; `preview.js` is
a dev-only helper (inert unless the page is loaded with `?preview=states`) for eyeballing every UI
state without running a real pipeline.

**The shell.** `app.js` runs a tiny hash router: `location.hash` drives `applyRoute()`, which
calls `showView(name)` — the *only* function allowed to toggle which `.view` section is visible,
specifically so hiding one screen's leftover panels can't be forgotten in multiple places (the
comment on `showView` explains a real bug this fixed). **Nine views exist and all nine are built:**
`home`, `run`, `suite`, `case`, `compare`, `history`, `team`, `login`, `signup`. The library screens
have real renderers — `renderSuiteView`, `renderCaseView` (which carries the entire step editor) and
`renderCompareView` — backed by the persisted project/suite/case library in Postgres.

Topbar actions (History, Team, Settings) live behind a **header hamburger menu** built in `app.js`
as `#hdrMenuBtn`; role restrictions are applied as negative `role-no-edit` / `role-no-admin` classes
on `<body>`, so the default state is exactly the pre-auth behaviour.

**Home** (`#/`) — the composer: a prompt textarea, a URL field, and a row of one-click prompt
templates. Submitting calls `POST /api/runs` and navigates to `#/run/<runId>`. The
Minimal/Standard/Full coverage segmented control **was removed from this form**; `coverage` is
pinned to `"standard"` in `app.js` and still travels in the POST body, so the route's request shape
is unchanged and `budgetFor()` sizes the run exactly as it did for anyone who never touched the
control.

**Run** (`#/run/:id`) — the live view. `connectToRun()` **polls `GET /api/runs/:id/state` once a
second** — it is a plain loop with a generation counter, not an `EventSource`; the SSE route exists
on the server but no browser code consumes it, because a Cloudflare tunnel buffers
`text/event-stream` until the connection closes. It renders, in order: four phase cards
(understand → analyze → build & run → check results, driven by `PHASES`/`STAGE_TO_PHASE` in
`app.js`, mapped from the orchestrator's real stage names), the case-selection gate panel if the
run pauses for review, a live suite-progress list as cases finish, a verdict banner, and — once
everything's done — per-case result cards with their screenshot, video (only present on a failed
Playwright run, `retain-on-failure`), and plain-English diagnosis. The credential modal
(`#credentialPrompt`) and the full-size screenshot modal (`#screenshotModal`) both overlay this
view when their respective server-side pause point fires.

**History** (`#/history`, `renderHistoryView()`) — every run `GET /api/runs` returns (so the same
20-run cap as the API), each row showing status, prompt, suite pass count, and when it ran, with
per-row View / Re-run / Delete actions.

**Sidebar.** Two lists, from **two different endpoints**:

- **Projects tree** (`GET /api/projects`) — real project rows, scoped server-side: admins and
  owners see every project in the org, everyone else only the ones they were added to. Run rows
  still come from `GET /api/runs` and are matched to their project by normalised URL. The tree
  header carries `+ Suite` (`#addSuiteBtn`) and `+` (`#addProjectBtn`) controls, hidden by role,
  and each project row has a Delete action.
- **Recent runs** (`GET /api/runs`, via `loadHistory()`) — the newest few, flat,
  most-recent-first.

  > An earlier version of this section said there was "no server-side project entity" and that the
  > tree was computed client-side by `groupRunsByUrl()`. That stopped being true when projects
  > became real rows. `groupRunsByUrl()` survives only as the **database-off fallback**, synthesising
  > pseudo-projects when `/api/projects` is unavailable.

**Settings popover** — two toggles (review cases before running / self-heal broken selectors).
These are **per-run request options**, not persisted server settings: an untouched toggle leaves
the server on its own env-configured default (`ENABLE_CASE_SELECTION_GATE`) rather than the
client silently overriding it with a guess. The popover reads `GET /api/health`'s `defaults` on
load so it opens already reflecting whatever the server is actually configured to do.

**The test-case library now exists.** An earlier version of this document said it did not — that the
`suite`/`case`/`compare` views were deliberate empty stubs because the server had only run-lifecycle
routes. That has not been true since the library phases shipped. `src/server/index.ts` now carries
**57 routes**, including full CRUD for projects, suites and cases, per-case version history,
`POST /api/replay` for re-running saved cases from stored IR with zero LLM calls, and
`POST /api/runs/:runId/cases/:caseId/save` to promote a run artifact into the library. Persistence
is Supabase Postgres (`src/db.ts`, `src/server/library.ts`); see `docs/phases/PHASE_LIBRARY_REPORT.md`
and `PHASE_CASE_UI_REPORT.md`.

---

## What gets persisted, and where

Every run gets its own directory, `runs/<runId>/` (gitignored, but very real — it's the primary
evidence trail this project's own debugging has always relied on, per `CLAUDE.md`). A typical run
directory contains:

```
00-input.json          the (secret-redacted) prompt/url/coverage that started the run
01-plan.json            planner.ts's output
02-appmodel.json        discovery's output — every page/element it found
03-cases.json           the generated (and selected) test case suite
04-ir.json              the primary case's compiled IR — CAREFUL: at the run root this file is a
                          WRAPPER, { ir, updatedAppModel }. Only cases/case-N/04-ir.json is a bare
                          IR. Same filename, two shapes; library.ts handles both with
                          `parsed?.ir ?? parsed`
05-result.json          the primary case's Playwright result — the REAL Playwright error lives here,
                          at raw.suites[0].specs[0].tests[0].results[0].errors[0].message
06-diagnosis.json       failure diagnosis, if it failed
07-suite-summary.json   pass/fail counts across the whole suite
08-llm-usage.json       real LLM spend for this run, every stage
events.ndjson           the durable, replayable event log (what the UI's 1s poll reads from)
generated.spec.ts       the actual Playwright spec that ran
artifacts/, cases/      per-step screenshots, trace, video, and per-case subdirectories
```

`src/server/index.ts` serves this directory tree publicly at `/runs/*` (screenshots and videos
need to be viewable in the browser without another API round-trip) — which is exactly why real
credentials are never allowed to land in any of these files. They become `${env:...}` references
in the generated spec instead of literal values; see `scrubServedSecrets` in `executor.ts` if you
ever add a new place a secret could leak into an artifact.

---

## Running it locally

```bash
npm install                  # installs deps + playwright install chromium (postinstall)
cp .env.example .env         # fill in GEMINI_API_KEYS
npm run serve                # http://localhost:3000
```

That's the short version — `README.md`'s Quick Start has the CLI mode and the full environment
variable table if you need either.

---

## Where to go deeper

This file is a map, not the territory. For anything below, the linked doc is the one actual
source of truth — don't take this file's word over theirs:

| You want... | Read |
|---|---|
| Every file, every schema field, full internals | [ARCHITECTURE.md](ARCHITECTURE.md) |
| What's currently broken, ranked, with remediation | [TECH_DEBT.md](TECH_DEBT.md) |
| Why a specific design choice was made (and what was rejected) | [DECISIONS.md](DECISIONS.md) |
| Working rules for an agent editing this repo | [CLAUDE.md](CLAUDE.md) |
| What this is / how to run it / current capabilities | [README.md](README.md) |
| What each shipped phase changed, and how to roll it back | [docs/phases/](docs/phases/) |
| How a person edits a compiled test, end to end | [docs/EDITABLE_IR.md](docs/EDITABLE_IR.md) |
| Briefing an LLM that cannot read this repo | [docs/LLM_CONTEXT_BRIEFING.md](docs/LLM_CONTEXT_BRIEFING.md) |

# Architecture Reference

This is the technical reference for the AI test automation platform: every source file with its
role, the data contracts between stages, and the LLM integration surface.

**This file answers "how does it work."** For **why** it works this way — decisions made and
rejected alternatives — see [DECISIONS.md](DECISIONS.md). For **what's broken**, see
[TECH_DEBT.md](TECH_DEBT.md). Full map in the [README](README.md#documentation-map).

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Discovery Fallback Chain](#discovery-fallback-chain)
3. [Case Selection Gate](#case-selection-gate)
4. [Source Files by Module](#source-files)
5. [Schema Contracts](#schema-contracts)
6. [LLM Integration](#llm-integration)
7. [Frontend & Server](#frontend--server)

---

## Pipeline Overview

```
prompt + url
  -> Planner (Gemini)                 -> structured test plan
  -> Discovery                        -> app model: elements as accessibility role + name
       |_ DOM extraction (primary)     -> cheerio over page.content(), no LLM needed
       |_ generic clickables           -> div/span/li/p that behave as controls (cursor:pointer,
                                          onclick, tabindex) but carry no semantic tag or role
       |_ visibility recheck           -> real computed style for selector-bearing elements,
                                          replacing the static parser's assumed visible:true
       |_ site crawl (same-origin)     -> follows the entry page's own internal links, bounded
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Test Cases (Gemini)              -> full coverage suite (valid/invalid/boundary/security)
       \_ case-selection gate (opt.)   -> pauses for human review/regeneration, feature-flagged
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (Gemini) + grounding -> strict JSON test model (the contract)
       \_ groundingError(ir, model)    -> the deterministic authority over EVERY target kind:
                                          role+name (with a narrow clickable-role fallback),
                                          css selector, navigate URL, and hidden-vs-visible.
                                          Rejections feed correction text into the next attempt
       \_ credentialPolicyFor(case)    -> full / identifier-only / none, from case wording,
                                          computed before any credential ever gets substituted
       \_ extractCredentialsFromPrompt -> real values the user typed into the prompt, kept as
                                          ${env:...} references so they never reach disk
       \_ live-extend (on demand)      -> reaches + models pages beyond the entry page,
                                          policy-aware during replay, from the SAME session
                                          (not a fresh, session-less browser)
       \_ text-assertion grounding     -> replays the terminal step, corrects a wrong-worded
                                          guess against the real page
       \_ truncation (fallback)        -> a real, partial test instead of a hard failure
  -> Playwright Generator (no AI)     -> *.spec.ts with per-step test.step() blocks
  -> Suite Runner (no AI)             -> every case in its own Playwright test()/browser context
  -> Failure Analysis (LLM, vision)   -> diagnosis (only on failure)
       \_ Deterministic classifier    -> pattern-matches Playwright errors first (free)
       \_ Gemini fallback             -> only for ambiguous cases
       \_ Bounded self-heal (<=1x)    -> re-snapshot (policy-aware) + regenerate + re-run once
```

Design rationale for the choices in this diagram — why grounding is centralized, why the spec is
standalone, why the gate is feature-flagged — lives in [DECISIONS.md](DECISIONS.md), not here.

---

## Discovery Fallback Chain

The hybrid discovery orchestrator (`hybridDiscovery.ts`) tries these in order:

```
1. AppModel cache hit?  -> Return immediately (zero cost). Site-crawl results live under their
     |                     OWN cache key ("site:<url>"), distinct from the single-page result's
     |                     bare-URL key — the two shapes can't silently overwrite each other.
     |
2. DOM extraction path  -> domDiscovery.ts drives Playwright to fetch page.content(),
     |                      domExtract.ts (cheerio) parses it into structured elements
     |                      + Gemini concept labeling (text-only, no screenshot)
     |                      = Fast, deterministic structure, ~1 Gemini call, no service to run
     |
3. Entry page has        -> collectCrawlTargets filters its internal links to same-origin,
   crawlable links?         http(s), non-asset, not-already-visited, and the crawl repeats
     |                      step 2 for each (bounded by MAX_DISCOVERY_PAGES, default 5) —
     |                      merging every reachable page into ONE AppModel. A site with no
     |                      crawlable entry-page links (auth wall, SPA) is unaffected: same
     |                      one-page result as before this existed.
     |
4. If DOM returns null   -> Gemini Vision fallback
   (no usable elements)    = Playwright ARIA snapshot + JPEG screenshot
                           + Gemini with image input
                           = Slow, token-heavy, but works for everything (canvas, captcha,
                             icon-only controls with no accessible name or text)
```

`domExtract.ts` is a Node port of an earlier Python/Crawl4AI implementation — same extraction
logic, same output shape, no external service, no Python. The `needsVision` signal is set when the
extracted page has canvas/embed/image-heavy content or CAPTCHA text; in that case the DOM result
still supplies structure but vision is also consulted, and `discoveryMethod` becomes `"hybrid"`.
(A CAPTCHA-*text* signal is not the same as detecting a bot-check interstitial *page* — see
`TECH_DEBT.md` TD-04.)

`domExtract.ts` is a static HTML parser (cheerio) — it never executes CSS, so on its own it cannot
detect visibility controlled by a media query, and records `visible: true` for everything.
`recheckVisibility` (`domDiscovery.ts`) closes this where it matters: in one batched
`page.evaluate()` it re-checks real computed visibility (geometry + `getComputedStyle`,
deliberately *not* `offsetParent`, which reports null for `position:fixed` and would wrongly
condemn fixed headers) for every element carrying a stable selector. It runs inside
`extractDomModelFromPage`, the one function every discovery path shares. What remains uncovered —
an element with no `id`/`data-test`/`css` at all — is tracked in `TECH_DEBT.md` TD-13.

`extractDomModelFromPage(page, url)` is the piece that makes replay-time discovery trustworthy: it
snapshots a Playwright `Page` object that's ALREADY open and navigated — no new browser launch.
Both `liveExtend.ts`'s replay and `hybridDiscovery.ts`'s site crawl use it, in preference to
launching a fresh session-less browser (`DECISIONS.md` D-07).

---

## Case Selection Gate

Optional (`ENABLE_CASE_SELECTION_GATE=true`; off leaves the pipeline byte-for-byte identical to
before this existed — `DECISIONS.md` D-11). Pauses upfront case generation for a human review loop
instead of running straight through with the model's first batch.

```
runCaseSelectionGate (caseSelectionGate.ts)
  round 1: toTestCases(plan, appModel) — the plain upfront call, mints its own primary case
     |
     v
  store.append("case_round_requested") -> UI shows the batch, parks on your decision
     |
     v
  awaitCaseSelection (pendingCaseSelection.ts) -- parks a Promise in memory (never on disk)
     |
     v
  decision: "done"                     decision: "not_satisfied" + refinement prompt
     |                                       |
     v                                       v
  appendAcceptedCases            appendAcceptedCases (whatever WAS checked)
  (caseAccumulator.ts)           appendRoundToHistory (caseHistoryLedger.ts) — every title
     |                           in this batch recorded as selected / selected_but_capped /
     |                           rejected, keyed by normalized title
     |                                       |
     v                                       v
  finalize, return pool          round 2: toTestCases(plan, appModel, {
                                    existingTitles, rejectedTitles, mintPrimary, latestPrompt
                                  }) -- filterNovelCases() then HARD-drops anything overlapping
                                  an already-seen title, regardless of what the model/cache
                                  returned -- loop back to "store.append(...)"
```

The pool is capped at `MAX_ACCUMULATED_CASES` (default 5); a pick that doesn't fit becomes
`selected_but_capped` in the history ledger — treated the same as rejected for repetition
purposes, but distinguished in the UI-facing prompt block so the model understands it WAS wanted,
just didn't fit. Regeneration is bounded by `MAX_CASE_REGEN_ATTEMPTS` (default 3); the wait for a
decision on a parked round is bounded by `CASE_SELECTION_WAIT_MS` (default 10 min) — a paused
round times out as `"done"` with nothing new accepted, same shape as the credential prompt's
timeout.

---

## Source Files

### `src/stages/` — Pipeline Stages (18 files)

| File | LLM? | Purpose |
|------|:-----:|---------|
| `authSettle.ts` | No | Post-auth SPA redirect handling |
| `planner.ts` | Gemini | NL request -> structured Plan |
| `promptSelectors.ts` | No | Honors selectors the user wrote directly into their prompt |
| `classify.ts` | No | Deterministic failure classifier |
| `targetResolver.ts` | No | IR Target -> Playwright Locator with fallbacks (role/css/testId, plus a dedicated field-locator path for `fill`/`select`/`check`) |
| `failureAnalysis.ts` | Gemini + Vision | Failure diagnosis (fallback only) |
| `caseSelectionGate.ts` | Gemini (via testCases) | Optional human-review loop over generated case batches, incl. reactive-case rounds |
| `suiteRunner.ts` | No | Runs every case in its own browser context, per-case artifacts |
| `executor.ts` | No | Runs spec, captures artifacts, redacts secrets from served output |
| `discovery.ts` | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel (fallback path) |
| `liveExtend.ts` | No | Policy-aware browser replay: new-page discovery + terminal-assertion grounding |
| `testCases.ts` | Gemini | Coverage suite generation, `finalizeCaseSelection`, scope-filtered checklist |
| `generator.ts` | No | IR -> Playwright spec (pure code) |
| `hybridDiscovery.ts` | Gemini (text) | Discovery orchestrator: DOM first, same-origin site crawl, vision fallback; also owns `isAllowedEntryUrl`/`isPrivateOrLoopbackHost`, the entry-URL scheme + private-host allow-list |
| `credentials.ts` | No | Per-case/per-leg substitution policy + prompt credential extraction — no demo-site registry |
| `domDiscovery.ts` | No | Drives Playwright for page HTML; `extractDomModelFromPage` snapshots an open page, detects generic clickables, re-checks real visibility |
| `domExtract.ts` | No | Cheerio DOM extraction — Node port of the deleted Python parser |
| `ir.ts` | Gemini | TestCase -> IR: grounding (role/selector/navigate-URL/visibility), credential policy, live-extend, truncation, action-coverage check (`missingActions`) |

### `src/schema/` — Data Contracts (3 files)

| File | Purpose |
|------|---------|
| `caseSelection.ts` | Case-selection decision schema + on-disk accepted-cases/history file shapes |
| `ir.ts` | Target, Step (action/assertion enums), IR with truncation tracking |
| `appModel.ts` | Element, PageModel, AppModel + DOM-structured types + `toLiteModel` |

### `src/` Core

| File | Purpose |
|------|---------|
| `text.ts` | `cutAtBoundary` — cuts text at the last line/word boundary at or before a length cap, never mid-word |
| `cli.ts` | CLI entry point: parses `--prompt`/`--url`/`--urls`/`--coverage`, calls `runPipeline` |
| `runStore.ts` | File-backed per-run NDJSON event log with SSE replay + fallback reconstruction + orphaned-run detection |
| `orchestrator.ts` | Pipeline wiring: plan -> discovery -> test cases (-> optional gate) -> IR -> generate -> execute -> heal -> suite |

### `src/llm/` — LLM Layer (5 files)

| File | Purpose |
|------|---------|
| `gemini.ts` | Google Gemini client (REST API, key-pool rotation, backoff); returns `{content, usage}` and records ambient per-stage spend via `llmBudget.ts` |
| `keyPool.ts` | Round-robin API key pool with cooldown tracking; `poolFromEnv` accepts a singular `_KEY` var as a fallback when the plural `_KEYS` var isn't set |
| `llmBudget.ts` | Per-run hard cap on LLM calls across every stage (plan, discovery, testcases, ir, failure-analysis, heal), not just IR; usage recorded to `08-llm-usage.json`, broken down per stage. See `DECISIONS.md` D-21 |
| `backoff.ts` | Exponential backoff, per-attempt timeout, rate-limit detection + key rotation |
| `json.ts` | Strip markdown fences and parse JSON from LLM output |

### `src/kb/` — Knowledge Base (3 files)

| File | Purpose |
|------|---------|
| `cache.ts` | SHA1-keyed file-based AppModel cache |
| `llmCache.ts` | Two-tier LLM response cache (in-memory, 30-min TTL + disk, no expiry); every stage's cache key also hashes its system prompt + model name (`DECISIONS.md` D-10) |
| `testStrategy.ts` | Static QA knowledge: coverage taxonomy, scope classification, filtering |

### `src/server/` — Web Server (7 files)

| File | Purpose |
|------|---------|
| `concurrency.ts` | In-process semaphore: caps concurrent runs, queues overflow |
| `runRegistry.ts` | SSE fan-out: broadcasts events, replays history on connect |
| `pendingCredentials.ts` | Parks a paused run's credential prompt in memory; resolved by the UI's answer or `CREDENTIAL_WAIT_MS` timeout |
| `pendingCaseSelection.ts` | Parks a paused run's case-review round in memory; resolved by the UI's decision or `CASE_SELECTION_WAIT_MS` timeout |
| `caseAccumulator.ts` | File-backed pool of accepted cases across gate rounds, capped at `MAX_ACCUMULATED_CASES` |
| `caseHistoryLedger.ts` | File-backed record of every case title ever shown and its outcome, so rejections never resurface |
| `index.ts` | Express: `/api/runs` CRUD, credential-prompt + case-selection endpoints, SSE stream, polling, static files, `/api/health` diagnostic endpoint, entry-URL validation |

### `public/` — Frontend (5 files)

| File | Purpose |
|------|---------|
| `icons.js` | Inline SVG icon set |
| `preview.js` | Static preview/demo states for UI development |
| `index.html` | Single-page HTML shell, case-selection panel, theme toggle |
| `style.css` | Dark theme (default) + `[data-theme="light"]` override, responsive design |
| `app.js` | Single-page app: run form, phase UI, suite cards, history, case-selection panel, theme toggle, renders executed IR steps (not raw case prose) in the results panel |

---

## Schema Contracts

Three Zod schemas: `src/schema/appModel.ts`, `src/schema/ir.ts`, `src/schema/caseSelection.ts`.

### AppModel (the discovery output)

```
AppModel
  pages: PageModel[]
    url, title, discoveryMethod: "dom" | "vision" | "hybrid"
    elements: Element[]
      role, name (accessibility role + name — the primary identity)
      concept?           e.g. "login-email", "search-box" — used for taxonomy matching
      css?                deterministic selector, NEVER invented by an LLM — set by
                          discovery for elements with an empty/synthetic accessible name
      visible?, enabled?, containerRole?, containerName?, pageSection?, path?, order?
    forms?: DomForm[]      structured <form> extraction: fields (inputType, placeholder,
                          label, required, ...) — this is what credentialFieldMap reads to
                          tell a password field from a username field on an unlabelled form
    domLinks?, navigation?, internalUrls?: DomLink[] / NavigationItem[] / string[]  —
                          raw link/nav structure; internalUrls feeds the site crawl's queue
```

This is the shared language between discovery, planning, test-case generation, IR grounding, and
target resolution. Every stage reads or writes AppModels. A multi-page site crawl merges every
reachable page's elements into one AppModel with no page-scoping in the merged element list — see
`TECH_DEBT.md` TD-05 for the consequence.

### IR (the execution contract)

```
IR
  meta: { feature, title, priority, sourcePrompt, baseUrl,
          truncated?, truncationNote?, hasTerminalAssertion? }
  steps: Step[]
    id: string
    action: "navigate" | "click" | "fill" | "select" | "check" | "press" | "wait" | "assert"
    target?: { url?, role?, name?, nth?, label?, text?, placeholder?, testId?, css? }
              -- css is written in code during grounding (copied from a verified AppModel
                 element), never produced by the LLM directly
    value?: string
    assertion?: "visible" | "hidden" | "text_equals" | "text_contains" |
                "url_contains" | "title_contains" | "title_equals" |
                "enabled" | "disabled"
    preAction?: { action: "hover" | "click", target: Target }
```

The Generator reads this contract and emits Playwright code (one `test.step()` per Step). The
Executor runs it. Failure analysis inspects it step-by-step. `truncated`/`hasTerminalAssertion`
are what let a partially-grounded IR ship as a real, honest partial test instead of a hard failure.

**Page-level vs. element-level assertions.** `url_contains`, `title_contains` and `title_equals`
check the *page* and take **no target** — `normalizeIR` strips one if the model attaches it, and
`PAGE_LEVEL_ASSERTIONS` (`ir.ts`) is the set. Everything else is locator-bound. The title pair
exists specifically so "verify the page title is X" has a correct compilation target
(`expect(page).toHaveTitle(...)`) instead of degrading into a body-text search for a string that
only lives in `<title>` — see `TECH_DEBT.md` TD-06.

### Case Selection (the gate's contract)

```
CaseSelectionDecision (discriminated on "action")
  { action: "done", selectedIndexes: number[] }
  { action: "not_satisfied", selectedIndexes: number[], newPrompt: string }

AcceptedCasesFile (runs/<id>/accepted-cases.json)
  runId, hasAcceptedPrimary: boolean
  rounds: { attempt, prompt, acceptedCases: TestCase[], overflowIndexes: number[] }[]

CaseHistoryFile (runs/<id>/case-history.json)
  runId
  rounds: { attempt, prompt,
            entries: { normalizedTitle, originalTitle,
                       status: "selected" | "selected_but_capped" | "rejected" }[] }[]
```

---

## LLM Integration

| Stage | Model | Input | Output | When Used |
|-------|-------|-------|--------|-----------|
| Planner | Gemini (`GEMINI_MODEL_LITE`) | Prompt + URL | Plan (steps, scope, coverage) | Every run, 1 call |
| Concept labeling | Gemini (`GEMINI_MODEL_LITE`) | DOM element list | Labeled AppModel | DOM discovery path, 1 call per page (incl. each crawled page) |
| Vision discovery | Gemini (`GEMINI_MODEL_LITE`) | ARIA snapshot + JPEG screenshot | AppModel | Fallback only, 1 call per page |
| Test cases | Gemini (`GEMINI_MODEL`) | Plan + AppModel + strategy (scope-filtered) | TestCase[] | Every run, 1 call per round |
| IR generation | Gemini (`GEMINI_MODEL`) | TestCase + AppModel + sourcePrompt | IR (JSON) | Every run, up to `MAX_IR_ATTEMPTS` (default 4) calls per case, plus up to 3 free rate-limit retries that don't cost an attempt; hard-capped run-wide by `MAX_LLM_CALLS_PER_RUN` (default 60), shared across every stage |
| Failure analysis | Gemini (`GEMINI_MODEL_LITE`) | Error + ARIA + screenshots | Diagnosis | Only on failure, and only when the deterministic classifier can't resolve it |

Model ids and their real rate limits are worth re-verifying directly against the deployed `.env`
rather than trusted from this table — `GEMINI_MODEL` in particular has drifted from this table's
default before (a preview id deprecated after this project's own use of it; see `DECISIONS.md`
D-21). Probe with a real request before assuming a name or a limit is current.

**Key rotation:** The Gemini client uses `keyPool.ts` for round-robin key selection with cooldown.
`backoff.ts` handles rate-limit detection, exponential delay, key penalization, and a per-attempt
abort (`LLM_TIMEOUT_MS`, default 45s). Single-provider since `DECISIONS.md` D-21 — Groq was
removed entirely (`TECH_DEBT.md` TD-03's history).

**Caching:** `llmCache.ts` — see D-10, D-22 in `DECISIONS.md`/`TECH_DEBT.md`.

---

## Frontend & Server

### Server Architecture

```
Express (port 3000, PORT env)
  POST   /api/runs                              -> starts pipeline (via concurrency semaphore).
                                                     url/urls validated by isAllowedEntryUrl —
                                                     http(s) only, loopback/link-local/RFC1918
                                                     hosts rejected before discovery ever runs
  POST   /api/runs/:runId/credentials            -> answers a paused run's credential prompt
                                                     (never logged, never written to disk)
  POST   /api/runs/:runId/case-selection         -> answers a paused run's case-review round
  GET    /api/runs/:runId/accepted-cases         -> current accepted-pool state (count, cap)
  GET    /api/runs/:runId/case-selection-status  -> snapshot of the currently-pending round
  GET    /api/runs/:runId/state                  -> polling endpoint (for Cloudflare tunnels)
  GET    /api/runs/:runId/events                 -> SSE event stream (for localhost)
  GET    /api/runs                               -> list all runs (newest first)
  DELETE /api/runs/:runId                        -> remove a run
  GET    /api/health                             -> which critical env vars are set (name +
                                                     length only, never the value) — a deploy
                                                     diagnostic, not a load-balancer healthcheck
  /                                              -> static files (public/)
  /runs                                          -> static files (runs/) — no auth (TECH_DEBT.md TD-14)
```

Every route taking a `:runId` validates it against `RUN_ID` (`^[\dT-]+Z-[0-9a-f]{8}$`,
`makeRunId()`'s own shape) via a single `app.param("runId", ...)` middleware, so a crafted id can't
escape `runs/`.

### Frontend Architecture

Single-page HTML/JS/CSS app (`public/`):
- **Run form:** prompt, URL, coverage dropdown
- **Credential prompt:** appears when a run pauses waiting for login details; submitted values go
  straight into the paused pipeline's memory, never through `runStore`/disk
- **Case-selection panel:** appears when the gate pauses a run; checkbox review list, select
  all/none, a "not satisfied" refinement flow, scrolls itself into view when it renders
- **Phase pipeline:** 4 phases (Plan & Discover, Generate & Execute, Analyze, Report) with live aggregate status
- **Suite progress:** per-case status, lazy-loaded details, screenshots, download buttons
- **History panel:** newest 20 runs, each deletable
- **Theme toggle:** light/dark, persisted in `localStorage`, applied before first paint via an
  inline script (no flash of the wrong theme)
- **Polling:** uses `GET /api/runs/:id/state` (works through Cloudflare tunnels; SSE is localhost-only)

### Concurrency

`concurrency.ts` implements an in-process semaphore that caps concurrent pipeline runs (default:
3, configurable via `MAX_CONCURRENT_RUNS`). Each run launches a Chromium instance. Overflow
requests queue and wait.

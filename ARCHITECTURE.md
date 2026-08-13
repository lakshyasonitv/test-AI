# Architecture Reference

This is the technical reference for the AI test automation platform. It covers every source file
with its role, data contracts, LLM integration, and key design decisions.

**This file answers "how does it work".** For **what's broken and what's next**, see
[PROBLEM_ANALYSIS.md](PROBLEM_ANALYSIS.md) — the single owner of that list. For a quick-read project
statement and architecture diagram, see [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md); for what changed
and when, [SESSION_SUMMARY.md](SESSION_SUMMARY.md). Full map in the
[README](README.md#documentation-map).

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Discovery Fallback Chain](#discovery-fallback-chain)
3. [Case Selection Gate](#case-selection-gate)
4. [Source Files by Module](#source-files)
5. [Schema Contracts](#schema-contracts)
6. [LLM Integration](#llm-integration)
7. [Frontend & Server](#frontend--server)
8. [Key Design Decisions](#key-design-decisions)
9. [Current Gaps](#current-gaps)

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
  -> IR generation (Groq) + grounding -> strict JSON test model (the contract)
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

`domExtract.ts` is a 1:1 Node port of an earlier Python/Crawl4AI implementation (`discovery-service/`,
now deleted) — same extraction logic, same output shape, no external service, no Python. The
`needsVision` signal is set when the extracted page has canvas/embed/image-heavy content or CAPTCHA
text; in that case the DOM result still supplies structure but vision is also consulted, and
`discoveryMethod` becomes `"hybrid"`.

**A structural limitation, now mostly closed:** `domExtract.ts` is a static HTML parser (cheerio)
— it never executes CSS, so on its own it cannot detect visibility controlled by a media query,
and it records `visible: true` for everything. An element hidden only at a certain viewport width
(a mobile hamburger toggle is the canonical case) therefore looked visible, and got grounded as a
`visible` assertion target that could only ever time out.

`recheckVisibility` (`domDiscovery.ts`) closes this where it matters: in one batched
`page.evaluate()` it re-checks real computed visibility (geometry + `getComputedStyle`,
deliberately *not* `offsetParent`, which reports null for `position:fixed` and would wrongly
condemn fixed headers) for every element carrying a stable selector — precisely the set eligible
for grounding's selector auto-attach, and so precisely the set that can reach a generated spec as
a raw locator. It runs inside `extractDomModelFromPage`, the one function every discovery path
already shares, so all of them get it. `groundingError` then refuses a `visible` assertion against
anything recorded hidden. What remains uncovered: an element with no `id`/`data-test`/`css` at all,
which still keeps the parser's assumed `visible: true`.

`extractDomModelFromPage(page, url)` (`domDiscovery.ts`) is the piece that makes replay-time
discovery trustworthy: it snapshots a Playwright `Page` object that's ALREADY open and navigated
— no new browser launch. Both `liveExtend.ts`'s replay and `hybridDiscovery.ts`'s site crawl use
it. The alternative, `discoverUsingCrawler(url)`, launches a fresh, session-less browser; for an
authenticated URL that hits the login redirect and models the wrong page — and would cache that
wrong snapshot under the real URL's key permanently. `extractDomModelFromPage` has no such trap:
it can only ever see whatever the calling code's own browser session sees.

---

## Case Selection Gate

Optional (`ENABLE_CASE_SELECTION_GATE=true`; off leaves the pipeline byte-for-byte identical to
before this existed — the gate module isn't even imported). Pauses upfront case generation for a
human review loop instead of running straight through with the model's first batch.

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

Two things make the regeneration actually reliable rather than just prompt-requested:

- **`filterNovelCases`** (`testCases.ts`) is an enforced floor, not an instruction: it drops any
  generated case whose title overlaps (Jaccard-style token match, same threshold `selectCases`
  already used) an accepted OR rejected title, even if the LLM or the LLM cache handed one back
  anyway.
- **The extend-context additions** (`rejectedTitles`, `mintPrimary`, `latestPrompt`, all folded
  into the cache key) are what let a "not satisfied, focus on X" reply actually steer the next
  batch instead of being recorded and having no effect — without `latestPrompt` reaching the
  prompt as an additive focus block, round 2 was just round 1 again.

The pool is capped at `MAX_ACCUMULATED_CASES` (default 5); a pick that doesn't fit becomes
`selected_but_capped` in the history ledger — treated the same as rejected for repetition
purposes (eligible to be regenerated later), but distinguished in the UI-facing prompt block so
the model understands it WAS wanted, just didn't fit. Regeneration is bounded by
`MAX_CASE_REGEN_ATTEMPTS` (default 3); the wait for a decision on a parked round is bounded by
`CASE_SELECTION_WAIT_MS` (default 10 min) — a paused round times out as `"done"` with nothing
new accepted, same shape as the credential prompt's timeout.

---

## Source Files

### `src/stages/` — Pipeline Stages (18 files, ~6,642 lines)

| File | Lines | LLM? | Purpose |
|------|------:|:-----:|---------|
| `authSettle.ts` | 42 | No | Post-auth SPA redirect handling |
| `planner.ts` | 71 | Gemini | NL request -> structured Plan |
| `promptSelectors.ts` | 98 | No | Honors selectors the user wrote directly into their prompt |
| `classify.ts` | 158 | No | Deterministic failure classifier |
| `targetResolver.ts` | 160 | No | IR Target -> Playwright Locator with fallbacks (role/css/testId, plus a dedicated field-locator path for `fill`/`select`/`check`) |
| `failureAnalysis.ts` | 185 | Gemini + Vision | Failure diagnosis (fallback only) |
| `caseSelectionGate.ts` | 254 | Gemini (via testCases) | Optional human-review loop over generated case batches, incl. reactive-case rounds |
| `suiteRunner.ts` | 300 | No | Runs every case in its own browser context, per-case artifacts |
| `executor.ts` | 313 | No | Runs spec, captures artifacts, redacts secrets from served output |
| `discovery.ts` | 351 | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel (fallback path) |
| `liveExtend.ts` | 365 | No | Policy-aware browser replay: new-page discovery + terminal-assertion grounding |
| `testCases.ts` | 438 | Gemini | Coverage suite generation, `finalizeCaseSelection`, scope-filtered checklist |
| `generator.ts` | 463 | No | IR -> Playwright spec (pure code) |
| `hybridDiscovery.ts` | 471 | Gemini (text) | Discovery orchestrator: DOM first, same-origin site crawl, vision fallback; also owns `isAllowedEntryUrl`/`isPrivateOrLoopbackHost`, the entry-URL scheme + private-host allow-list |
| `credentials.ts` | 480 | No | Per-case/per-leg substitution policy + prompt credential extraction — no demo-site registry |
| `domDiscovery.ts` | 534 | No | Drives Playwright for page HTML; `extractDomModelFromPage` snapshots an open page, detects generic clickables, re-checks real visibility |
| `domExtract.ts` | 676 | No | Cheerio DOM extraction — Node port of the deleted Python parser |
| `ir.ts` | 1283 | Groq | TestCase -> IR: grounding (role/selector/navigate-URL/visibility), credential policy, live-extend, truncation, action-coverage check (`missingActions`) |

### `src/schema/` — Data Contracts (3 files, ~328 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `caseSelection.ts` | 39 | Case-selection decision schema + on-disk accepted-cases/history file shapes |
| `ir.ts` | 61 | Target, Step (action/assertion enums), IR with truncation tracking |
| `appModel.ts` | 228 | Element, PageModel, AppModel + DOM-structured types + `toLiteModel` |

### `src/` Core (4 files, ~654 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `text.ts` | 16 | `cutAtBoundary` — cuts text at the last line/word boundary at or before a length cap, never mid-word |
| `cli.ts` | 42 | CLI entry point: parses `--prompt`/`--url`/`--urls`/`--coverage`, calls `runPipeline` |
| `runStore.ts` | 216 | File-backed per-run NDJSON event log with SSE replay + fallback reconstruction + orphaned-run detection |
| `orchestrator.ts` | 380 | Pipeline wiring: plan -> discovery -> test cases (-> optional gate) -> IR -> generate -> execute -> heal -> suite |

Timeouts, retries, and other constants that used to live in a single `config.ts` are now inline
per-stage (mostly env-overridable — see `README.md`'s Configuration section and `.env.example`).

### `src/llm/` — LLM Layer (6 files, ~361 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `gemini.ts` | 59 | Google Gemini client (REST API, key-pool rotation, backoff) |
| `groq.ts` | 65 | Groq client (OpenAI-compatible REST API, key-pool rotation, backoff) |
| `keyPool.ts` | 40 | Round-robin API key pool with cooldown tracking; `poolFromEnv` accepts a singular `_KEY` var as a fallback when the plural `_KEYS` var isn't set |
| `groqBudget.ts` | 55 | Per-run hard cap on Groq calls; usage recorded to `08-groq-usage.json` |
| `backoff.ts` | 133 | Exponential backoff, per-attempt timeout, rate-limit detection + key rotation |
| `json.ts` | 9 | Strip markdown fences and parse JSON from LLM output |

### `src/kb/` — Knowledge Base (3 files, ~278 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `cache.ts` | 38 | SHA1-keyed file-based AppModel cache |
| `llmCache.ts` | 42 | Two-tier LLM response cache (in-memory, 30-min TTL + disk, no expiry); every stage's cache key now also hashes its system prompt + model name |
| `testStrategy.ts` | 198 | Static QA knowledge: coverage taxonomy, scope classification, filtering |

### `src/server/` — Web Server (7 files, ~580 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `concurrency.ts` | 36 | In-process semaphore: caps concurrent runs, queues overflow |
| `runRegistry.ts` | 37 | SSE fan-out: broadcasts events, replays history on connect |
| `pendingCredentials.ts` | 55 | Parks a paused run's credential prompt in memory; resolved by the UI's answer or `CREDENTIAL_WAIT_MS` timeout |
| `pendingCaseSelection.ts` | 62 | Parks a paused run's case-review round in memory; resolved by the UI's decision or `CASE_SELECTION_WAIT_MS` timeout |
| `caseAccumulator.ts` | 86 | File-backed pool of accepted cases across gate rounds, capped at `MAX_ACCUMULATED_CASES` |
| `caseHistoryLedger.ts` | 99 | File-backed record of every case title ever shown and its outcome, so rejections never resurface |
| `index.ts` | 205 | Express: `/api/runs` CRUD, credential-prompt + case-selection endpoints, SSE stream, polling, static files, `/api/health` diagnostic endpoint, entry-URL validation |

### `public/` — Frontend (5 files, ~2,598 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `icons.js` | 93 | Inline SVG icon set |
| `preview.js` | 123 | Static preview/demo states for UI development |
| `index.html` | 191 | Single-page HTML shell, case-selection panel, theme toggle |
| `style.css` | 893 | Dark theme (default) + `[data-theme="light"]` override, responsive design |
| `app.js` | 1298 | Single-page app: run form, phase UI, suite cards, history, case-selection panel, theme toggle, renders executed IR steps (not raw case prose) in the results panel |

---

## Schema Contracts

Three Zod schemas: `src/schema/appModel.ts`, `src/schema/ir.ts`, `src/schema/caseSelection.ts`
(334 lines combined).

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
target resolution. Every stage reads or writes AppModels.

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
                "url_contains" | "enabled" | "disabled"
    preAction?: { action: "hover" | "click", target: Target }
```

The Generator reads this contract and emits Playwright code (one `test.step()` per Step). The
Executor runs it. Failure analysis inspects it step-by-step. `truncated`/`hasTerminalAssertion`
are what let a partially-grounded IR ship as a real, honest partial test instead of a hard failure.

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
| Planner | Gemini (`gemini-3.1-flash-lite`, `GEMINI_MODEL_LITE`) | Prompt + URL | Plan (steps, scope, coverage) | Every run, 1 call |
| Concept labeling | Gemini (`gemini-3.1-flash-lite`, `GEMINI_MODEL_LITE`) | DOM element list | Labeled AppModel | DOM discovery path, 1 call per page (including each crawled page) |
| Vision discovery | Gemini (`gemini-3.1-flash-lite`, `GEMINI_MODEL_LITE`) | ARIA snapshot + JPEG screenshot | AppModel | Fallback only, 1 call per page |
| Test cases | Gemini (`gemini-3-flash-preview`, `GEMINI_MODEL`) | Plan + AppModel + strategy (scope-filtered) | TestCase[] | Every run, 1 call per round (1 round unless the gate is on and you ask for more) |
| IR generation | Groq (`openai/gpt-oss-120b`) | TestCase + AppModel + sourcePrompt | IR (JSON) | Every run, up to `MAX_IR_ATTEMPTS` (default 4) calls per case, hard-capped run-wide by `MAX_GROQ_CALLS_PER_RUN` (default 60) |
| Failure analysis | Gemini (`gemini-3.1-flash-lite`, `GEMINI_MODEL_LITE`) | Error + ARIA + screenshots | Diagnosis | Only on failure, and only when the deterministic classifier can't resolve it |

Model ids are overridable per-deploy and worth re-verifying directly against the API rather than
trusted from memory — a model-list endpoint can report a name as available when it 404s on an
actual `generateContent` call, and the reverse (an undocumented-looking id that works fine). Probe
with a real request before assuming a name is wrong.

**Key rotation:** Both Gemini and Groq clients use `keyPool.ts` for round-robin key selection with cooldown. `backoff.ts` handles rate-limit detection, exponential delay, key penalization, and a per-attempt abort (`LLM_TIMEOUT_MS`, default 45s) so a hung fetch can't stall a run indefinitely.

**Caching:** `llmCache.ts` provides a two-tier cache — in-memory (30-min TTL) + disk (no expiry) — keyed by a hash of concatenated inputs. Avoids duplicate LLM calls for identical inputs across runs. The disk half's lack of expiry has bitten this project more than once: a cache key that omits a real input dimension (e.g. credential policy, or — fixed this session — the case-selection gate's rejected titles and refinement prompt) can silently serve stale results forever.

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
  /runs                                          -> static files (runs/) — no auth; see Current Gaps
```

Every route taking a `:runId` validates it against `RUN_ID` (`^[\dT-]+Z-[0-9a-f]{8}$`, `makeRunId()`'s
own shape) via a single `app.param("runId", ...)` middleware, so a crafted id can't escape `runs/`.

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

`concurrency.ts` implements an in-process semaphore that caps concurrent pipeline runs (default: 3, configurable via `MAX_CONCURRENT_RUNS`). Each run launches a Chromium instance. Overflow requests queue and wait.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **DOM-first discovery, now site-wide by default** | `domExtract.ts` extracts structured elements without LLM tokens. The site crawl (`discoverSiteHybrid`) follows the entry page's own links so more of an app is groundable without a separate discovery pass per page; vision stays reserved for pages DOM extraction finds nothing usable on. |
| **The case-selection gate is additive, not a fork** | Feature-flagged behind `ENABLE_CASE_SELECTION_GATE`; while off, `caseSelectionGate.ts` is never even imported, so the default path is provably unchanged from before the gate existed. |
| **A rejected/accepted case title is a hard filter, not a prompt hint** | `filterNovelCases` drops overlapping titles in code, after generation — a model that ignores the "don't repeat this" instruction, or a stale cache hit, can't reintroduce something the user already dismissed. |
| **`extractDomModelFromPage` over `discoverUsingCrawler` for replay-time snapshots** | A fresh, session-less browser hits the login redirect on an authenticated URL and models the wrong page; snapshotting the page the calling code already has open can't make that mistake. |
| **`groundingError` is the single deterministic authority over every target kind** | Each kind of target the model can emit is a different way for it to invent something, and each one needed its own check: a **role+name** must match a real discovered element (with a narrow `link`/`button`/`menuitem`/`tab` fallback, since SPA nav is routinely built from the "wrong" tag, and the real role is written back onto the target); a **css selector** must be one discovery actually captured; a **navigate URL** must be a discovered page or a discovered link's href, never a route guessed from a feature's name; and an element discovery recorded as hidden can't be the target of a `visible` assertion. Every rejection returns the same `{index, message}` shape and rides the existing correction-feedback retry loop, so adding a check never adds new control flow. |
| **Prompt nudges are never the only guard** | Three separate bugs recurred after being "fixed" with a system-prompt instruction alone (menu-toggle assertions, guessed routes, role mismatches). The prompt rules are kept as cheap first-line steering, but every one of them now has a deterministic check behind it — an LLM instruction is a preference, not a constraint. |
| **Live-extension is skipped for errors it can't possibly fix** | A grounding rejection carries an optional `kind`. A guessed navigate URL is an authoring mistake, not a discovery gap — replaying the prefix can never make an invented route real — so `toIR` breaks out instead of spending hops that the steps genuinely needing discovery depend on. |
| **Deterministic failure classifier** | Pattern-matching on Playwright error text is free and instant. Gemini vision diagnosis is used only for ambiguous cases. Distinguishes "0 elements resolved" (genuinely missing) from "N elements resolved, condition never true" (found but wrong state) — collapsing the two made the missing-element self-heal path unreachable. |
| **Bounded self-heal** | `MAX_LIVE_EXTENSIONS` (default 5) page hops, 1 heal attempt per test case, policy-aware re-snapshot. Prevents infinite loops and runaway LLM usage. |
| **Truncation as fallback** | A partial real test is better than a hard failure. IR truncation + `hasTerminalAssertion` guard ensures execution always happens on real, grounded steps. |
| **Credential policy is decided per case, from the case's own wording, before any substitution** | A boolean ("substitute or not") can't express a good negative-password test, which needs the identifier real but the password wrong. `credentialPolicyFor` returns `full` / `identifier-only` / `none`; getting the check order right matters (identifier-at-fault must be vetoed before the broader password-at-fault check, or a malformed-email case gets its email silently "fixed"). Currently case-scoped, not leg-scoped — a case with TWO login attempts in one browser session is a known open edge. |
| **No built-in demo-credential registry** | An earlier version silently auto-filled known demo sites (saucedemo, the-internet.herokuapp.com); removed so the pipeline never special-cases a specific host. Credentials now come from exactly two general sources: extracted from the prompt when the user typed them there (`extractCredentialsFromPrompt`), otherwise the `askCredentials` UI prompt. |
| **A prompt-derived case always gets real credentials substituted** | `credentialPolicyFor` used to return `none` for a `fromPrompt` case when the prompt carried credentials, assuming the model had copied the user's literal value into the case text. It routinely hadn't — it invented a placeholder instead. Always substituting the verified value is strictly safer: a no-op when the model was faithful, the only fix when it wasn't. |
| **Secrets never reach disk** | User-supplied (non-demo) credentials become `${env:...}` references in the IR/generated spec; the real value is injected only into the Playwright child process's environment at execution time. Extended this session to also scrub `results.json`, `final-page.txt`, and error-context attachments — a logged-in page routinely echoes the identifier back into visible text. `runs/` is served as static files, so this is a hard requirement, not a nicety. |
| **LLM caching, two-tier** | Same input -> same response. In-memory (30-min TTL) + disk (no expiry) deduplicates across runs and stages — the cache key must include every real input dimension, or a result gets served stale forever (this has been a recurring bug source; the case-selection gate's cache key was fixed this session for exactly this reason). |
| **Key rotation with cooldown** | Multiple API keys with round-robin selection and rate-limit cooldown prevents single-key exhaustion. |
| **SSE + polling dual mode** | SSE for localhost (real-time), polling for Cloudflare tunnels (which buffer SSE). |
| **Isolated per-case execution** | Every case in a suite gets its own Playwright `test()` — a fresh browser context, so one case's login session can't leak into the next case's assumptions. |
| **A case's representative screenshot is its LAST step, not its first** | `findScreenshot` used to return the first `.png` a directory walk found, which was always the pre-action frame — every case in a run showed the same generic screenshot regardless of what it tested. Fixed by sorting `step-N.png` numerically and taking the last one. |
| **Presence checks aren't coverage checks** | `missingActions` used to ask only "does *any* `fill` exist, does *any* `click` exist" — an IR covering 5 of a case's 9 named steps passed it, and a run that stopped after login could still report the whole case "passed". Now counts action-bearing lines in the case's own text against the IR's actual action-step count and rejects when the gap is more than one short (tolerating a single legitimate consolidation, e.g. "fill the login form" becoming two IR fills). |
| **Leftmost keyword occurrence, not "first pattern to match anywhere"** | `extractCredentialsFromPrompt`'s value-extraction regex used to try a quoted-value pattern before a bare-value one — so when a prompt named the login email unquoted early and an unrelated email quoted later, the quoted pattern skipped the real credential and matched the decoy instead. Merged into one regex with a quoted/bare alternation so a single `.match()` finds the true leftmost occurrence regardless of which mention happens to be quoted. |
| **Entry-URL allow-listing, not just malformed-string rejection** | `discoverSiteHybrid` used to validate the URL only by catching a `new URL()` parse exception — `new URL("file:///...")` doesn't throw, so a `file:` URL or an internal-network address reached `page.goto()` and the result landed in a publicly-served run directory. `isAllowedEntryUrl` requires `http:`/`https:` and rejects loopback/link-local/RFC1918 hosts, enforced at both the API boundary and inside discovery. |

---

## Current Gaps

**The authoritative, ranked list of open issues lives in
[PROBLEM_ANALYSIS.md](PROBLEM_ANALYSIS.md)** — with evidence, severity, and the fix plan for each.
It is deliberately not duplicated here: this list previously existed in six documents at once and
every copy drifted out of date.

What belongs in *this* file is the architectural context behind those gaps:

| Deliberate design choice, sometimes mistaken for a gap | Why it's this way |
|---|---|
| The Playwright generator uses no LLM | Spec generation is pure code, by design — the IR is the contract, and a deterministic generator is what makes the output reviewable and reproducible |
| The generated spec restates locator logic instead of importing it | The spec must be standalone and runnable outside this repo. The cost is that `generator.ts`'s helpers can drift from `targetResolver.ts` — and they already have (`PROBLEM_ANALYSIS.md` W3) |
| The UI polls instead of streaming | Cloudflare Quick Tunnels buffer SSE. Both routes exist; SSE works on localhost |
| `domExtract.ts` assumes `visible: true` | It's a static cheerio parser with no CSS engine. `recheckVisibility` corrects this live for every element carrying a stable selector; selector-less elements keep the assumption |
| A deterministic rejection costs an LLM attempt | Every grounding rejection re-generates with correction feedback, bounded by `MAX_IR_ATTEMPTS`. The navigate-URL rejection is marked `kind: "navigate-url"` so it at least doesn't also drain the live-extend budget |
| Single-process, no multi-user isolation | Shared run history, no per-user quotas — the current deployment model is a single trusted operator |

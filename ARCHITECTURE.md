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
3. [Auth-Aware Discovery](#auth-aware-discovery)
4. [Case Selection Gate](#case-selection-gate)
5. [Source Files by Module](#source-files)
6. [Schema Contracts](#schema-contracts)
7. [LLM Integration](#llm-integration)
8. [Frontend & Server](#frontend--server)

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
       |_ auth-aware login             -> detects a live password field, signs in, verifies the
                                          session, records the steps taken (see below)
       |_ site crawl (same-origin)     -> follows the entry page's own internal links, bounded;
                                          also probes JS-only nav (buttons/anchors with no href)
                                          once the href pass returns nothing
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Test Cases (Gemini)              -> full coverage suite (valid/invalid/boundary/security)
       \_ case-selection gate (opt.)   -> pauses for human review/regeneration, feature-flagged
       \_ login-case cap              -> at most one case targets the login page itself, so a
                                          gated app's suite isn't all login tests
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (Gemini) + grounding -> strict JSON test model (the contract)
       \_ login prefix (on auth)      -> discovery's recorded login is replayed as ordinary
                                          Steps, prepended before grounding, so the spec starts
                                          authenticated in its own fresh browser
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
       \_ Auth-bounce check          -> deterministic: an authenticated run that ended back on
                                          the login page is reported as that, before the generic
                                          classifier can misreport it as a renamed/missing element
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
2b. Entry page shows      -> Auth-Aware Discovery (below) — sign in, verify the session, keep
    a login gate?            crawling authenticated. A gate with no usable credentials, or a
     |                       login attempt that fails, falls through to the crawl unauthenticated
     |                       rather than stopping — same one-page result as before this existed.
     |
3. Entry page has        -> collectCrawlTargets filters its internal links to same-origin,
   crawlable links?         http(s), non-asset, not-already-visited, and the crawl repeats
     |                      step 2 for each (bounded by MAX_DISCOVERY_PAGES, default 5) —
     |                      merging every reachable page into ONE AppModel. A page whose links
     |                      are all JS-only (no href, or href="#") is probed by clicking instead,
     |                      once the href pass returns nothing (see Auth-Aware Discovery).
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

## Auth-Aware Discovery

Runs inside `discoverSiteHybrid` (`hybridDiscovery.ts`), between the entry-page snapshot and the
site crawl. Applies to a plain email/password login only — no multi-step, SSO, or MFA flow
(`DECISIONS.md` D-22–D-26 record the full design reasoning; this section is the mechanics).

```
entry page snapshotted
  |
  v
hasLoginGate(page)?  -- a live, visible, enabled input[type="password"] on the page
  |                      (never the extracted PageModel — see D-22 for why that's lossy)
  no  -> auth: { status: "no-gate" }, crawl proceeds unauthenticated as before
  |
  yes, one hop allowed if the gate isn't on the entry page itself (a marketing home
       linking to /login), then:
  |
  v
credentials available?  -- prompt-supplied first, else askCredentials() fires HERE,
  |                         mid-discovery (not after case generation) -- the credentials
  |                         event pair (started/completed) is what makes the UI render
  |                         the form at all; see TD-46
  no  -> auth: { status: "no-credentials" }, crawl proceeds unauthenticated
  |
  yes
  v
loginOnPage(page, creds)  -- fills identifier + password by a live-DOM selector ladder,
  |                          submits, returns the exact steps taken (AuthStep[])
  v
verifySession(page, gateUrl)  -- true iff the login form is actually gone from the page
  |                              now loaded (re-navigating in the SAME tab if the app moved
  |                              somewhere else -- never a fresh tab, which would lose
  |                              sessionStorage; see D-23)
  no  -> auth: { status: "login-failed", url, detail }, crawl proceeds unauthenticated,
  |      result NOT cached (a transient failure shouldn't pin the run for 30 min)
  |
  yes
  v
auth: { status: "authenticated", url, loginUrl, loginSteps }
crawl re-roots from the authenticated page; the login page is KEPT in the model
alongside it (needed so the IR's login prefix has something to ground against)
  |
  v
site crawl proceeds on ONE shared Page for the whole crawl (not one per hop) --
sessionStorage-based auth doesn't survive a new page, only a new navigation on the
same one; a Next.js/React nav with no <a href> (button-driven routing, or an anchor
with no href / href="#") is discovered by discoverUrlsByClicking() once the ordinary
href pass returns nothing, scoped to nav-landmark buttons + any link, excluding
sign-out and destructive verbs (reset/delete/...)
```

**Downstream, in `ir.ts`:** `needsLoginPrefix(testCase, auth)` decides, per case, whether to
prepend `buildLoginPrefix(auth)` — the recorded `loginSteps` turned into ordinary `navigate`/
`fill`/`click`/`press` Steps (credential values as `${env:...}` sentinels, never literals) plus a
settle assertion (the password field, asserted `hidden`) so the case's own steps don't race the
still-in-flight login request. Gated on the case's `targetUrl`, not on
`credentialPolicyFor` — a case *about* the login page gets no prefix; everything else does.

**In `testCases.ts`:** `selectCases` caps how many surviving cases may target the login page
itself (`MAX_LOGIN_CASES`, default 1) — without it, the category-diversity pass lets several
differently-categorized login cases all survive, and a gated app's suite becomes mostly login
tests instead of tests of the app behind it.

**In `failureAnalysis.ts`:** before the generic classifier runs, `endedOnLoginPage` checks
whether a failed run's `final-page.txt` shows the login gate while `auth.status` was
`"authenticated"` — if so, the diagnosis reports the real cause (never signed in) instead of
whatever the first missing element downstream happened to be.

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
| `failureAnalysis.ts` | Gemini + Vision | Failure diagnosis; deterministic auth-bounce check runs first |
| `caseSelectionGate.ts` | Gemini (via testCases) | Optional human-review loop over generated case batches, incl. reactive-case rounds |
| `suiteRunner.ts` | No | Runs every case in its own browser context, per-case artifacts |
| `executor.ts` | No | Runs spec, captures artifacts, redacts secrets from served output |
| `discovery.ts` | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel (fallback path) |
| `liveExtend.ts` | No | Policy-aware browser replay: new-page discovery + terminal-assertion grounding |
| `testCases.ts` | Gemini | Coverage suite generation, `finalizeCaseSelection`, scope-filtered checklist, login-case cap |
| `generator.ts` | No | IR -> Playwright spec (pure code) |
| `hybridDiscovery.ts` | Gemini (text) | Discovery orchestrator: DOM first, auth-aware login + session verification, same-origin + click-probed site crawl, vision fallback; also owns `isAllowedEntryUrl`/`isPrivateOrLoopbackHost`, the entry-URL scheme + private-host allow-list |
| `credentials.ts` | No | Per-case/per-leg substitution policy + prompt credential extraction — no demo-site registry; `redactCredentials` skips DOM-keyword-colliding values |
| `domDiscovery.ts` | No | Drives Playwright for page HTML; `extractDomModelFromPage` snapshots an open page, detects generic clickables, re-checks real visibility |
| `domExtract.ts` | No | Cheerio DOM extraction — Node port of the deleted Python parser |
| `ir.ts` | Gemini | TestCase -> IR: grounding (role/selector/navigate-URL/visibility), login-prefix injection (`buildLoginPrefix`/`needsLoginPrefix`), credential policy, live-extend, truncation, action-coverage check (`missingActions`) |

**Added for the case library and the editor:**

| File | LLM? | Purpose |
|------|------|---------|
| `stepText.ts` | No | **The IR <-> English mapping, in one place.** `formatIrStep` renders a step as the sentence a person edits; `parseIrStep` reads it back, merged onto the step it came from. Also owns `STEP_VOCABULARY` and `estimateRegrounding` (what a save will cost, computed without doing any of it). `public/app.js` has a display-only copy of `formatIrStep` that `tests/stepText.test.ts` pins identical — drift is a failing test, not a silent bug |
| `caseEdit.ts` | Gemini (ceiling only) | Re-grounds the steps whose **target** changed, by replaying the earlier steps to arrive at the right page. Grounding is DOM-first, so it usually spends no model call at all |
| `replay.ts` | No | Walks a stored IR prefix in a real browser and snapshots where it lands. Prefix-cached, so two edits on the same page share one walk |

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

### `src/server/` — Web Server (16 files)

| File | Purpose |
|------|---------|
| `concurrency.ts` | In-process semaphore: caps concurrent runs, queues overflow |
| `runRegistry.ts` | SSE fan-out: broadcasts events, replays history on connect |
| `pendingCredentials.ts` | Parks a paused run's credential prompt in memory; resolved by the UI's answer or `CREDENTIAL_WAIT_MS` timeout |
| `pendingCaseSelection.ts` | Parks a paused run's case-review round in memory; resolved by the UI's decision or `CASE_SELECTION_WAIT_MS` timeout |
| `caseAccumulator.ts` | File-backed pool of accepted cases across gate rounds, capped at `MAX_ACCUMULATED_CASES` |
| `caseHistoryLedger.ts` | File-backed record of every case title ever shown and its outcome, so rejections never resurface |
| `gateCaseEdits.ts` | Folds a reviewer's edits and hand-written cases into the batch before it is persisted, so the accumulator and ledger need no changes (`DECISIONS.md` D-28) |
| `GET /api/runs/:runId/page-elements` | Serves `toElementIndex(appModel)` — role + name only — so the gate editor can show what is really on the page while a case is edited before grounding |
| `index.ts` | Express: `/api/runs` CRUD, credential-prompt + case-selection endpoints, SSE stream, polling, static files, `/api/health` diagnostic endpoint, entry-URL validation — plus every platform route below |

**The platform layer** (added by the phases in `docs/phases/`; every file is inert with its flag off):

| File | Purpose |
|------|---------|
| `auth.ts` | Resolves the caller's identity on every `/api/*` route. With `AUTH_ENABLED=false` it returns a synthetic local **owner** — a real identity that passes real checks, not a bypass that skips them |
| `authz.ts` | The two access axes: org **role** (`viewer` < `tester` < `admin` < `owner`) = what you may do; project **membership** = what you may see. `AccessError` carries the HTTP status |
| `organisations.ts` | Organisation records and their member roster |
| `projects.ts` | Projects, their membership, create/update. No delete — deliberately |
| `library.ts` | The test-case library: cases, versions, suites, suite membership, and every access check on them |
| `signup.ts` | Sign-up through Supabase's Admin API rather than the client SDK — the free tier's confirmation mailer hangs, and a 504 on sign-up is indistinguishable from a broken server. `SIGNUP_ENABLED` defaults **on**, so turn it off before exposing the server |
| `regroundJobs.ts` | A re-ground is a job, not a blocking request: `POST -> 202 {id}` + SSE + polling + cancel. The same protocol runs use, because a 90-second PATCH can report neither progress nor be stopped |
| `rewrite.ts` | Where a model proposes step text and **never writes**: `proposeRewrite` ("ask for a change") and `proposeStepTranslation` ("write it for me"). Both return sentences, not IR, so approving one re-enters the ordinary parse/re-ground path |
| `retention.ts` | Ages off `runs/` directories on a schedule, per `RUN_RETENTION_DAYS` |

### `public/` — Frontend (5 files)

| File | Purpose |
|------|---------|
| `icons.js` | Inline SVG icon set |
| `preview.js` | Static preview/demo states for UI development |
| `index.html` | Single-page HTML shell, case-selection panel, theme toggle |
| `style.css` | Dark theme (default) + `[data-theme="light"]` override, responsive design |
| `app.js` | Single-page app: run form, phase UI, suite cards, history, case-selection panel, theme toggle, renders executed IR steps (not raw case prose) in the results panel. Also the whole platform UI — login/sign-up, projects tree, Team screen, suites, and the case detail screen with its step editor, live estimate, job progress and diff-based proposal cards |

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
  auth?: AuthOutcome      set only when discovery found a live login gate (see below)
```

```
AuthOutcome
  status: "no-gate" | "no-credentials" | "login-failed" | "authenticated"
  url?                    where the login attempt ended up — the evidence for `status`
  loginUrl?               the gate page itself, distinct from `url` (where it landed)
  loginSteps?: AuthStep[] the exact fill/click/press sequence that worked, captured live —
                          `ir.ts`'s `buildLoginPrefix` replays these; never re-derived from
                          `elements`/`forms` after the fact
  detail?                 human-readable reason, populated on "no-credentials"/"login-failed"

AuthStep
  action: "fill" | "click" | "press"
  css                     a selector discovery verified against the live page, never invented
  credential?: "username" | "password"
  key?                    for a "press" step with no submit button to click
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

Multi-screen HTML/JS/CSS app (`public/`), no bundler — served raw by `express.static`, so the
files on disk are the files the browser runs.

**Shell.** A sidebar (brand, New run, search, Projects tree, recent runs) plus a sticky 52px topbar
(breadcrumb, History, a Settings popover). Below 900px the sidebar becomes a fixed drawer with a
scrim.

**Screens.** Each is a `<section class="view" data-view="...">`; exactly one carries
`.view-active`. `showView(name)` in `app.js` is the *only* thing that moves that class, and it is
also the only place run-scoped panels are cleared — see `resetRunUI()`. That single-site rule
exists because the pre-router code hid panels from three places and had already drifted
(`preview.js` forgot one, so a gate panel leaked across scenes). Routing is `location.hash`
(`#/`, `#/run/:id`, `#/history`, and the not-yet-built `#/suite/:id`, `#/case/:id`,
`#/compare/:id`) — no server routes needed.

- **Home:** prompt, URL, a coverage segmented control, template chips
- **Run:** four phase cards (`PENDING`/`WORKING`/`DONE`), the case-selection gate, live suite
  progress, the verdict banner, per-case results
- **History:** the newest runs, each viewable / re-runnable / deletable
- **Credential prompt:** a modal, because the run is genuinely parked on it; submitted values go
  straight into the paused pipeline's memory, never through `runStore`/disk
- **Settings popover:** two per-run overrides (review-cases-before-running, self-heal). These are
  sent with `POST /api/runs` as `options`; only a toggle the user actually changed is sent, so an
  untouched popover leaves the server on its env default. `GET /api/health` reports those defaults
  so the popover opens in the state the server is actually in.
- **Polling:** uses `GET /api/runs/:id/state` (works through Cloudflare tunnels; SSE is localhost-only)

**Status vocabulary.** The UI speaks seven statuses; the backend's are mapped onto them in
`RUN_STATUS` (`app.js`). Two collapses are deliberate: `truncated`/`truncated_no_assertion`/
`incomplete` all become **unconfirmed** (ran, proved nothing — never a pass), and `error` becomes
**blocked**, never `failed`, so an invalid API key is not reported as a broken website.

**Theme.** Light only. The design this implements ships no dark variant, so the previous dark/light
token pair and its toggle were removed rather than half-maintained.

### Concurrency

`concurrency.ts` implements an in-process semaphore that caps concurrent pipeline runs (default:
3, configurable via `MAX_CONCURRENT_RUNS`). Each run launches a Chromium instance. Overflow
requests queue and wait.

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
     |                      (DISCOVERY_LIVE_DOM=true: the element list instead comes from
     |                      liveDomDiscovery.ts walking the live page — see below)
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

**Live-DOM discovery (`DISCOVERY_LIVE_DOM`, default off).** `liveDomDiscovery.ts` walks the LIVE page
in one `page.evaluate` (no inner functions, TD-40) and returns the same `Element[]` shape, with the
accessible name computed in accname order (never the HTML `name` attribute), `visible` measured,
and a `css` on every element, verified to match exactly that element (stable attributes first, a
positional path last — D-40). It descends open shadow roots (`host >> inner` chains, re-verified
through Playwright whenever a shadow root exists — D-41) and same-origin iframes (`frame` paths —
D-42). The switch in `extractDomModelFromPage` swaps only `elements`; every other PageModel field
still comes from the cheerio parse, and with the flag off the output is byte-identical (D-43). This
closes TD-13 for the live path.

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


### Editing a case at the gate

A round is not read-only. Each proposed case can be opened and its title, steps and expected
outcome changed, removed, or written from scratch, before anything is compiled or a browser is
opened. `POST /api/runs/:runId/case-selection` gained two **optional** fields for this,
`editedCases` and `addedCases`; a client that sends neither behaves exactly as it did before.

`applyGateEdits` (`gateCaseEdits.ts`) folds those into the batch between the decision and the two
calls that persist it. Because `appendAcceptedCases` and `appendRoundToHistory` both address cases
by position, that one substitution makes the accumulator store the edited case, the pool cap count
hand-written ones, and the ledger record final titles — with no change to either module
(`DECISIONS.md` D-28). Removal is "not in `selectedIndexes`" plus a client-side hide, never a
splice, so batch positions never renumber.

**Scope, stated because it is easy to assume otherwise:** only the CURRENT round's batch is
editable. Cases accepted in an earlier round live in `accepted-cases.json` and are not in a later
round's batch, so they render as a count, not as cards.

Two supporting routes, both additive:

| Route | Purpose |
|---|---|
| `GET /api/runs/:runId/page-elements` | `toElementIndex(appModel)` — each page's discovered controls as **role + name only**, so the editor can show what actually exists while a case is edited before grounding. Never emits `value`, `css`, `id` or `testId`; hidden inputs are excluded by the same `isUsableElement` predicate `ir.ts` uses, so the panel shows exactly the set grounding will later accept |
| `POST /api/runs/:runId/case-selection/rewrite` | "Ask for a change" for a case that has no IR yet. Behind `GATE_CASE_EDIT_AI` (default off) because it spends a model call. Deliberately does NOT run `parseIrStep` or constrain the model to `STEP_VOCABULARY` — gate steps are prose, and the vocabulary check happens later at IR time, in the stage that owns it. It proposes; it never writes (D-27) |

Full walkthrough of the editing flow, saved cases and gate cases both:
[docs/EDITABLE_IR.md](docs/EDITABLE_IR.md).

---

## Source Files

### `src/stages/` — Pipeline Stages (19 files)

| File | LLM? | Purpose |
|------|:-----:|---------|
| `authSettle.ts` | No | Post-auth SPA redirect handling |
| `planner.ts` | Gemini | NL request -> structured Plan |
| `promptSelectors.ts` | No | Honors selectors the user wrote directly into their prompt |
| `classify.ts` | No | Deterministic failure classifier |
| `heal.ts` | Gemini (LLM path only) | Bounded, one-shot self-heal: try the deterministic structural fix first (see `deterministicHeal.ts`, gated on `DETERMINISTIC_HEAL`), then fall back to re-snapshot + regenerate + re-run |
| `deterministicHeal.ts` | No | Pure-code structural target matcher: re-matches a failing step's IR target (role/name) against the AppModel — no LLM, no browser relaunch. Tiered name matching shared in shape with `ir.ts`'s `bestNameMatch` |
| `targetResolver.ts` | No | IR Target -> Playwright Locator with fallbacks (role/css/testId, plus a dedicated field-locator path for `fill`/`select`/`check`). Every branch hangs off `frameRoot`/`frameRootCode` — `page`, or the `page.frameLocator(...)` chain `Target.frame` names; `tests/frameTarget.test.ts` pins the live and emitted forms to the same element |
| `failureAnalysis.ts` | Gemini + Vision | Failure diagnosis; deterministic auth-bounce check runs first |
| `caseSelectionGate.ts` | Gemini (via testCases) | Optional human-review loop over generated case batches, incl. reactive-case rounds |
| `suiteRunner.ts` | No | Runs every case in its own browser context, per-case artifacts. `buildSuiteSummary` also reads each failed case's own `05-result.json` off disk and surfaces the failing step and error onto the case (optional additive fields, TD-80) |
| `executor.ts` | No | Runs spec, captures artifacts, redacts secrets from served output. `extractFailureDetail` turns Playwright's own JSON report into the failing step number/title and the error line — the deterministic failure reason a replay gets with no model call (TD-80) |
| `discovery.ts` | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel (fallback path) |
| `liveExtend.ts` | No | Policy-aware browser replay: new-page discovery + terminal-assertion grounding. Its `select` step calls `chooseLive` rather than a bare `selectOption`, sharing option matching and waiting with the generated spec (TD-79). Credential fills resolve their kind from the step's `${env:...}` VALUE, the same way the compiled spec does (TD-84), and a walk that ends on the page it typed a credential into throws instead of snapshotting the login form. `refreshPageModelAt` additionally returns the landed URL, for TD-86's scoped grounding |
| `testCases.ts` | Gemini | Coverage suite generation, `finalizeCaseSelection`, scope-filtered checklist, login-case cap |
| `generator.ts` | No | IR -> Playwright spec (pure code) |
| `hybridDiscovery.ts` | Gemini (text) | Discovery orchestrator: DOM first, auth-aware login + session verification, same-origin + click-probed site crawl, vision fallback; also owns `isAllowedEntryUrl`/`isPrivateOrLoopbackHost`, the entry-URL scheme + private-host allow-list |
| `credentials.ts` | No | Per-case/per-leg substitution policy + prompt credential extraction — no demo-site registry; `redactCredentials` skips DOM-keyword-colliding values. `restoreCredentialRefs` guards the editor save path: a credential typed as a literal step value goes back behind `${env:...}` before anything is written, classified by the step's own history / the DOM's `inputType` / a password-only name check (TD-67). `credentialKindForStep`/`credentialForStep` resolve VALUE-first (env reference), falling back to the target only when the value is not one — used by the live walk so it agrees with the compiled spec (TD-84) |
| `domDiscovery.ts` | No | Drives Playwright for page HTML; `extractDomModelFromPage` snapshots an open page, detects generic clickables, re-checks real visibility. Holds the `DISCOVERY_LIVE_DOM` strategy switch (`elementStrategy`, the only read of the flag) and the strategy-aware cache key (`domCacheKey`) |
| `liveDomDiscovery.ts` | No | Live-DOM element walker (flag-on path): accessible name, measured visibility, a verified `css` for every element, open shadow roots, same-origin iframes. `enumerateLiveElements(page)` |
| `domExtract.ts` | No | Cheerio DOM extraction — Node port of the deleted Python parser |
| `ir.ts` | Gemini | TestCase -> IR: grounding (role/selector/navigate-URL/visibility), login-prefix injection (`buildLoginPrefix`/`needsLoginPrefix`), credential policy, live-extend, truncation, action-coverage check (`missingActions`) |
| `driftRecovery.ts` | Gemini | Drift recovery for the primary case (D-52, `DRIFT_RECOVERY`): `isDrift` gates on the page-change categories past step 0; `recoverFromDrift` waits `DRIFT_SETTLE_MS`, re-snapshots the failing page (`refreshPageModelAt`), asks the tester through a `drift-instruction` run question, rewrites the TestCase with one model call (parsed by `LLMTestCase`; `fromPrompt`/`targetUrl` stamped from the original), compiles, runs, and repeats up to `DRIFT_MAX_ROUNDS`. Accepted only on a passing, untruncated run; artifacts under `runs/<id>/recovered/` |
| `heal.ts` | Gemini | Bounded self-heal, at most once per case: re-snapshot up to the failing step, recompile the IR, regenerate the spec and run it again. Accepted only if it passes **and** is not truncated. `isHealable` gates on category `selector_changed`/`element_missing`, a failure past step 0, and **not** a deterministic grounding rejection (`meta.truncationKind`, TD-83) — a re-snapshot cannot make an invented route real. `selfHealDefault()` is the one definition of the `SELF_HEAL_DEFAULT` fallback, shared by the orchestrator and `/api/health` |

**Added for the case library and the editor:**

| File | LLM? | Purpose |
|------|------|---------|
| `stepText.ts` | No | **The IR <-> English mapping, in one place.** `formatIrStep` renders a step as the sentence a person edits; `parseIrStep` reads it back, merged onto the step it came from. `parseIrSteps` aligns edited rows to originals **by content**, in two passes, so a delete or an insert keeps every surviving step's id and re-verifies only what genuinely moved (TD-90). Also owns `STEP_VOCABULARY` and `estimateRegrounding` (what a save will cost, computed without doing any of it). `public/app.js` has a display-only copy of `formatIrStep` that `tests/stepText.test.ts` pins identical — drift is a failing test, not a silent bug |
| `caseEdit.ts` | Gemini (ceiling only) | Re-grounds the steps whose **target** changed, by replaying the earlier steps to arrive at the right page. Grounding is DOM-first, so it usually spends no model call at all. Passes a `GroundingScope` so only those steps are re-verified, and records the URL each walk reached so an edited step resolves against the page actually visited (TD-86). `caseElementContext` supplies the controls a rewrite may name — source-run model first, then cached walk snapshots for the same site (TD-91) |
| `replay.ts` | No | Walks a stored IR prefix in a real browser and snapshots where it lands. Prefix-cached, so two edits on the same page share one walk. Also owns the replay pre-pass: `ungroundedStepIndexes` + `maybeRegroundForReplay` ground a replay's un-grounded steps against the live page behind `REPLAY_REGROUND` (default off, zero LLM calls, never writes back to the saved case — TD-77) |

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
| `runStore.ts` | File-backed per-run NDJSON event log with replay + fallback reconstruction + orphaned-run detection |
| `orchestrator.ts` | Pipeline wiring: plan -> discovery -> test cases (-> optional gate) -> IR -> generate -> execute -> heal -> suite |
| `db.ts` | Supabase Postgres access. `getServiceClient()` (service role, bypasses RLS by design), `DEFAULT_ORG_ID`, `isDbEnabled()`, the fire-and-forget run-row writes (`recordRunStarted` / `recordRunStatus` / `recordRunProject` / `recordRunCases`) and the shadow comparison against `listRuns()`. **`DB_ENABLED` gates only those five things** — the library, projects and organisations surface goes through the same client with no such check, so it works whenever a service-role key is set and 503s when one is not |

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
| `llmCache.ts` | Two-tier response cache (in-memory, 30-min TTL + disk, no expiry); every stage's cache key also hashes its system prompt + model name (`DECISIONS.md` D-10). **Namespaced** (`runs/_cache/<ns>/`) so one kind of entry can be cleared alone — browser walks live under `walks` and are cleared by `POST /api/cache/walks/clear`, leaving the LLM answers that cost money (TD-85). `credentialFingerprint` hashes credential values for use as a key part |
| `testStrategy.ts` | Static QA knowledge: coverage taxonomy, scope classification, filtering |

### `src/server/` — Web Server (18 files)

| File | Purpose |
|------|---------|
| `concurrency.ts` | In-process semaphore: caps concurrent runs, queues overflow |
| `runRegistry.ts` | SSE fan-out: broadcasts events, replays history on connect |
| `pendingCredentials.ts` | Parks a paused run's credential prompt in memory; resolved by the UI's answer or `CREDENTIAL_WAIT_MS` timeout |
| `pendingQuestions.ts` | Parks a paused run's question (D-51, `RUN_QUESTIONS`) in memory, keyed by run and question id; resolved by `POST /api/runs/:runId/question` or `QUESTION_WAIT_MS` timeout |
| `pendingCaseSelection.ts` | Parks a paused run's case-review round in memory; resolved by the UI's decision or `CASE_SELECTION_WAIT_MS` timeout |
| `caseAccumulator.ts` | File-backed pool of accepted cases across gate rounds, capped at `MAX_ACCUMULATED_CASES` |
| `caseHistoryLedger.ts` | File-backed record of every case title ever shown and its outcome, so rejections never resurface |
| `gateCaseEdits.ts` | Folds a reviewer's edits and hand-written cases into the batch before it is persisted, so the accumulator and ledger need no changes (`DECISIONS.md` D-28) |
| `resolveCredentials.ts` | The one place the env-first/prompt-second credential policy lives (`DECISIONS.md` D-30): environment first, then the shared `askCredentials` waiter. Used by the case editor's re-ground walk and by replay, so the two cannot drift. Emits only the URL and which fields are wanted — never a value |
| `index.ts` | Express: `/api/runs` CRUD, credential-prompt + case-selection endpoints, SSE stream, polling, static files, `/api/health` diagnostic endpoint, entry-URL validation — plus every platform route below |

**The platform layer** (added by the phases in `docs/phases/`; every file is inert with its flag off):

| File | Purpose |
|------|---------|
| `auth.ts` | Resolves the caller's identity on every `/api/*` route. With `AUTH_ENABLED=false` it returns a synthetic local **owner** — a real identity that passes real checks, not a bypass that skips them |
| `authz.ts` | The two access axes: org **role** (`viewer` < `tester` < `admin` < `owner`) = what you may do; project **membership** = what you may see. `AccessError` carries the HTTP status |
| `organisations.ts` | Organisation records and their member roster |
| `projects.ts` | Projects, their membership, and full CRUD. `deleteProject` is admin-only and **refuses with 409 while the project still holds runs** rather than orphaning them — that refusal, not the absence of the operation, is the safeguard |
| `library.ts` | The test-case library: cases, versions, suites, suite membership, and every access check on them |
| `signup.ts` | Sign-up through Supabase's Admin API rather than the client SDK — the free tier's confirmation mailer hangs, and a 504 on sign-up is indistinguishable from a broken server. `SIGNUP_ENABLED` defaults **on**, so turn it off before exposing the server |
| `regroundJobs.ts` | A re-ground is a job, not a blocking request: `POST -> 202 {id}` + SSE + polling + cancel. The same protocol runs use, because a 90-second PATCH can report neither progress nor be stopped |
| `rewrite.ts` | Where a model proposes step text and **never writes**: `proposeRewrite` ("ask for a change") and `proposeStepTranslation` ("write it for me"). Both return sentences, not IR, so approving one re-enters the ordinary parse/re-ground path, and **both** now run every proposed line through `parseIrStep` before it is shown (TD-91). `proposeRewrite` is also given the site's actual controls, or it invents element names from page headings |
| `retention.ts` | Ages off `runs/` directories on a schedule, per `RUN_RETENTION_DAYS` |

### `public/` — Frontend (5 files)

| File | Purpose |
|------|---------|
| `icons.js` | Inline SVG icon set |
| `preview.js` | Static preview/demo states for UI development |
| `index.html` | Single-page HTML shell (348 lines): nine `<section class="view">` screens, sidebar, topbar, case-selection panel, credential and screenshot modals |
| `style.css` | Single **light** theme (1,915 lines) — white plus ThinkVibes blue `#0b63ce`, black text, every other surface that blue at low opacity. There is no dark variant and no `[data-theme]` override; the previous dark/light token pair and its toggle were removed rather than half-maintained. Responsive: the sidebar becomes a drawer below 900px |
| `app.js` | Single-page app (5,611 lines): run form, phase UI, suite cards, history, case-selection panel; renders executed IR steps (not raw case prose) in the results panel. Also the whole platform UI — login/sign-up, projects tree, Team screen, suites, and the case detail screen with its step editor, live estimate, job progress and diff-based proposal cards. Builds the topbar hamburger (`#hdrMenuBtn`) at runtime and applies the `role-no-edit` / `role-no-admin` body classes |

---

## Schema Contracts

Three Zod schemas: `src/schema/appModel.ts`, `src/schema/ir.ts`, `src/schema/caseSelection.ts`.

### AppModel (the discovery output)

```
AppModel
  baseUrl              origin the browser LANDED on, after redirects — NOT necessarily what the
                       user typed. Everything downstream resolves relative paths and compares
                       pages against it, so it has to describe reality (TECH_DEBT.md TD-82)
  enteredUrl?          what the user typed, when its origin differs. Provenance only — never
                       resolve anything against it
  pages: PageModel[]
    url, title, discoveryMethod: "dom" | "vision" | "hybrid"
    elements: Element[]
      role, name (accessibility role + name — the primary identity)
      concept?           e.g. "login-email", "search-box" — used for taxonomy matching
      css?                deterministic selector, NEVER invented by an LLM — set by
                          discovery for elements with an empty/synthetic accessible name
      visible?, enabled?, containerRole?, containerName?, pageSection?, path?, order?
      frame?, inShadow?,   written ONLY by the live walker (DISCOVERY_LIVE_DOM): the same-origin
      nameSource?,         iframe path (" >>> "-joined <iframe> selectors), open-shadow-root
      visibleSource?       membership, which accname rule produced `name`, and "computed" when
                           `visible` was measured. Absent on every cheerio-built element
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
    target?: { url?, role?, name?, nth?, label?, text?, placeholder?, testId?, css?,
               frame?, groundedAt? }
              -- css is written in code during grounding (copied from a verified AppModel
                 element), never produced by the LLM directly
              -- frame is copied the same way from the element's `frame`: the same-origin
                 iframe path. The generator and resolveLive wrap the locator in
                 page.frameLocator(...) once per segment (D-42)
              -- groundedAt: "replay" is PROVENANCE, not behaviour. It marks a target grounded
                 against the LIVE page during a replay (REPLAY_REGROUND) rather than against
                 the discovered model -- the case of a control revealed by a click, which
                 discovery never saw. Optional and additive; nothing branches on it. It exists
                 so the grounding is visible in the run's own 04-ir.json and a person can
                 choose to save it back (TECH_DEBT.md TD-77, CLAUDE.md rule 6)
    value?: string
    assertion?: "visible" | "hidden" | "text_equals" | "text_contains" |
                "url_contains" | "title_contains" | "title_equals" |
                "enabled" | "disabled"
    preAction?: { action: "hover" | "click", target: Target }

  meta.truncationKind?   WHICH grounding rejection truncated this IR ("navigate-url", ...), as a
                         structured value. `truncationNote` is prose written for a model, so
                         nothing branches on it — `isHealable` reads this instead (TD-83)
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
CaseSelectionDecision (discriminated on "action"; BOTH arms also carry the two
optional gate-edit fields, so a client that sends neither behaves exactly as before)
  { action: "done",          selectedIndexes: number[], editedCases?, addedCases? }
  { action: "not_satisfied", selectedIndexes: number[], newPrompt: string,
                             editedCases?, addedCases? }

  editedCases: { index, title?, steps?, expected?, whyItMatters? }[]   (max 50)
  addedCases:  { title, steps, expected, whyItMatters? }[]             (max 20)

  `editedCases[].index` is the SAME index space as selectedIndexes, which is why
  editing needed no new addressing scheme. addedCases deliberately does not accept
  `fromPrompt` or `generatedFrom` — those are routing state the pipeline stamps.

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

58 routes on Express (port 3000, `PORT` env), grouped by area. Auth column: **public** = no
credential; **authed** = signed in; **role:X** = `requireRole(X)` on the caller's own org;
**run:X** = `requireRunRole(X)` on the org owning that run; **org:X** = `requireOrgRole(X)`.

```
RUNNING A TEST
  POST   /api/runs                               role:tester  starts the pipeline behind the
                                                     concurrency semaphore; returns 202 {runId}
                                                     immediately. url/urls validated by
                                                     isAllowedEntryUrl — http(s) only,
                                                     loopback/link-local/RFC1918 rejected
  POST   /api/runs/:runId/credentials            run:tester   answers a paused credential prompt
                                                     (never logged, never written to disk)
  POST   /api/runs/:runId/case-selection         run:tester   answers a paused case-review round
  POST   /api/runs/:runId/case-selection/rewrite run:tester   LLM proposes revised gate steps;
                                                     404 unless GATE_CASE_EDIT_AI
  POST   /api/replay                             role:tester  re-runs saved cases from stored IR,
                                                     zero LLM calls

WATCHING A RUN
  GET    /api/runs/:runId/state                  run:viewer   the full event log as one array —
                                                     THE channel the UI actually uses
  GET    /api/runs/:runId/events                 run:viewer   SSE stream. Exists, but NO client
                                                     consumes it — see Frontend Architecture
  GET    /api/runs/:runId/accepted-cases         run:viewer   accepted-pool state (count, cap)
  GET    /api/runs/:runId/case-selection-status  run:viewer   snapshot of the pending round
  GET    /api/runs/:runId/page-elements          run:viewer   role+name index from 02-appmodel.json

RUN HISTORY
  GET    /api/runs                               role:viewer  newest first; filtered by access
                                                     FIRST, then capped at 20
  DELETE /api/runs/:runId                        run:admin    rmSync of the run directory

PUBLIC / SESSION
  GET    /api/health                             public       which critical env vars are set
                                                     (name + length only, never the value)
  GET    /api/auth/config                        public       Supabase URL + publishable key
  POST   /api/auth/signup                        public       creates a confirmed account —
                                                     see SIGNUP_ENABLED in Auth & Tenancy
  GET    /api/auth/me                            authed       identity + org + role
  POST   /api/auth/bootstrap                     authed       idempotent join of the default org

PROJECTS (7)          /api/projects  ·  /api/projects/:projectId  ·  …/members[/:userId]
ORGANISATIONS (6)     /api/organisations/:orgId/{members[/:userId],assignments,addable-users}
SUITES (8)            /api/suites  ·  /api/suites/:suiteId  ·  …/cases[/:caseId]  ·  …/order
CASES (17)            /api/cases  ·  /api/cases/:caseId{,/script,/versions/:version,/steps,
                        /steps/estimate,/steps/translate,
                        /steps/jobs/:jobId/{events,state,cancel,credentials},
                        /duplicate,/runs,/rewrite}
                      GET .../script[?version=N] -> { spec, source, version }. A saved case's
                      Playwright script, from the spec stored with that version or regenerated
                      from its IR. Deliberately NOT a field on GET /api/cases/:caseId (rule 1,
                      and the spec is large). TECH_DEBT.md TD-68.
LIBRARY <- RUN        POST /api/runs/:runId/cases/:caseId/save   run:tester
MAINTENANCE           POST /api/cache/walks/clear                admin
                      Drops every cached browser walk (the `walks` namespace only, never the
                      LLM answers beside it) and reports how many went. The escape hatch for a
                      cached walk that has gone stale in a way its key cannot express.
                      TECH_DEBT.md TD-85.

STATIC
  /                                              -> public/
  /runs/:runId/*                                 -> run artifacts. NOT under /api, so it does not
                                                     pass through requireAuth; it resolves the user
                                                     itself and is UNAUTHENTICATED with the shipped
                                                     defaults (TECH_DEBT.md TD-14)
```

Every route taking a `:runId` validates it against `RUN_ID` (`^[\dT-]+Z-[0-9a-f]{8}$`,
`makeRunId()`'s own shape) via a single `app.param("runId", ...)` middleware, so a crafted id can't
escape `runs/`.

### Frontend Architecture

Multi-screen HTML/JS/CSS app (`public/`), no bundler — served raw by `express.static`, so the
files on disk are the files the browser runs.

**Shell.** A sidebar (`#brandMark`, `#newRunBtn`, the Projects tree with `#addProjectBtn` and
`#addSuiteBtn`, `#allRunsBtn`, recent runs) plus a sticky 52px topbar (breadcrumb, a session badge,
and a header **hamburger menu** holding History / Team / Settings). Below 900px the sidebar becomes a
fixed drawer with a scrim.

The hamburger is built in `app.js`, not in `index.html` — `#hdrMenuBtn` inside a `.hdr-menu-wrap`,
opened by adding `.hdr-menu-open` to `.hdr-menu`. Those four class names join the contract list
below.

**Role-based UI.** Restrictions are expressed as *negative* classes on `<body>` —
`role-no-edit`, `role-no-admin` — so the default (no class) is exactly the pre-auth behaviour and
there is no flicker while identity is still being fetched.

**Screens.** Each is a `<section class="view" data-view="...">`; exactly one carries
`.view-active`. `showView(name)` in `app.js` is the *only* thing that moves that class, and it is
also the only place run-scoped panels are cleared — see `resetRunUI()`. That single-site rule
exists because the pre-router code hid panels from three places and had already drifted
(`preview.js` forgot one, so a gate panel leaked across scenes).

**Nine views exist and all nine are built:** `home`, `run`, `suite`, `case`, `compare`, `history`,
`team`, `login`, `signup`. Routing is `location.hash` — `#/`, `#/run/:id`, `#/history`, `#/team`,
`#/suite/:id`, `#/projects/:projectId/cases/:caseId`, `#/compare/:id?from=&to=` — no server routes
needed. `#/case/:id` is a **legacy** route kept working: it looks up the case's project and rewrites
the URL in place. `login` and `signup` are reached by the router's auth guard rather than by a hash.

- **Home:** prompt, URL, template chips. The Minimal/Standard/Full coverage segmented control was
  **removed from the composer**; `coverage` is pinned to `"standard"` in `app.js` and is still sent
  in the `POST /api/runs` body, so the route's request shape is unchanged and `budgetFor()` still
  sizes the run.
- **Run:** four phase cards (`PENDING`/`WORKING`/`DONE`), the case-selection gate, live suite
  progress, the verdict banner, per-case results
- **Suite / Case / Compare:** the library screens — `renderSuiteView`, `renderCaseView` (which
  carries the whole step editor), `renderCompareView` + `diffSteps`
- **History:** the newest runs, each viewable / re-runnable / deletable
- **Team:** members and roles
- **Credential prompt:** a modal, because the run is genuinely parked on it; submitted values go
  straight into the paused pipeline's memory, never through `runStore`/disk
- **Settings popover:** two per-run overrides (review-cases-before-running, self-heal). These are
  sent with `POST /api/runs` as `options`; only a toggle the user actually changed is sent, so an
  untouched popover leaves the server on its env default. `GET /api/health` reports those defaults
  so the popover opens in the state the server is actually in.
- **Polling, not SSE.** `connectToRun(runId)` is a plain `while` loop polling
  `GET /api/runs/:id/state` once a second, cancelled by a generation counter so an abandoned run
  can't write to the DOM of the one you are now watching; five consecutive failures paint a
  reconnecting banner. **`EventSource` appears nowhere in `public/` as code** — the SSE route
  exists server-side and no client has ever consumed it, because a Cloudflare Quick Tunnel buffers
  `text/event-stream` and only flushes when the connection closes, which a live stream never does.
  A second, independent poller (`pollCaseJob`) follows re-ground jobs for the same reason.

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

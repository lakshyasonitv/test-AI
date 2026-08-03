# Architecture Reference

This is the technical reference for the AI test automation platform. It covers every source file
with its role, data contracts, LLM integration, and key design decisions.

For a quick-read project statement, a detailed architecture diagram, and honest current-state
bullets, see [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md).

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Discovery Fallback Chain](#discovery-fallback-chain)
3. [Source Files by Module](#source-files)
4. [Schema Contracts](#schema-contracts)
5. [LLM Integration](#llm-integration)
6. [Frontend & Server](#frontend--server)
7. [Key Design Decisions](#key-design-decisions)
8. [Current Gaps](#current-gaps)

---

## Pipeline Overview

```
prompt + url
  -> Planner (Gemini)                 -> structured test plan
  -> Discovery                        -> app model: elements as accessibility role + name
       |_ DOM extraction (primary)     -> cheerio over page.content(), no LLM needed
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Structured Test Cases (Gemini)   -> full coverage suite (valid/invalid/boundary/security)
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (Groq) + grounding -> strict JSON test model (the contract)
       \_ credentialPolicyFor(case)    -> full / identifier-only / none, from case wording,
                                          computed before any credential ever gets substituted
       \_ live-extend (on demand)      -> reaches + models pages beyond the entry page,
                                          policy-aware during replay
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
1. AppModel cache hit?  -> Return immediately (zero cost)
     |
2. DOM extraction path  -> domDiscovery.ts drives Playwright to fetch page.content(),
     |                      domExtract.ts (cheerio) parses it into structured elements
     |                      + Gemini concept labeling (text-only, no screenshot)
     |                      = Fast, deterministic structure, ~1 Gemini call, no service to run
     |
3. If DOM returns null   -> Gemini Vision fallback
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

---

## Source Files

### `src/stages/` — Pipeline Stages (17 files, ~5,378 lines)

| File | Lines | LLM? | Purpose |
|------|------:|:-----:|---------|
| `authSettle.ts` | 43 | No | Post-auth SPA redirect handling |
| `planner.ts` | 72 | Gemini | NL request -> structured Plan |
| `targetResolver.ts` | 95 | No | IR Target -> Playwright Locator with fallbacks |
| `promptSelectors.ts` | 98 | No | Honors selectors the user wrote directly into their prompt |
| `classify.ts` | 146 | No | Deterministic failure classifier |
| `failureAnalysis.ts` | 176 | Gemini + Vision | Failure diagnosis (fallback only) |
| `executor.ts` | 259 | No | Runs spec, captures artifacts |
| `hybridDiscovery.ts` | 268 | Gemini (text) | Discovery orchestrator: DOM first, vision fallback |
| `suiteRunner.ts` | 300 | No | Runs every case in its own browser context, per-case artifacts |
| `testCases.ts` | 339 | Gemini | Coverage suite generation, capped by `MAX_CASES_PER_RUN` |
| `discovery.ts` | 354 | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel (fallback path) |
| `liveExtend.ts` | 358 | No | Policy-aware browser replay: new-page discovery + terminal-assertion grounding |
| `domDiscovery.ts` | 386 | No | Drives Playwright to fetch page HTML, hands it to `domExtract.ts` |
| `generator.ts` | 418 | No | IR -> Playwright spec (pure code) |
| `credentials.ts` | 439 | No | Demo credentials + full/identifier-only/none substitution policy |
| `domExtract.ts` | 606 | No | Cheerio DOM extraction — Node port of the deleted Python parser |
| `ir.ts` | 1021 | Groq | TestCase -> IR: grounding, credential policy, live-extend, truncation |

### `src/schema/` — Data Contracts (2 files, ~295 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `appModel.ts` | 234 | Element, PageModel, AppModel + DOM-structured types + `toLiteModel` |
| `ir.ts` | 61 | Target, Step (action/assertion enums), IR with truncation tracking |

### `src/` Core (3 files, ~563 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `orchestrator.ts` | 342 | Pipeline wiring: plan -> discovery -> test cases -> IR -> generate -> execute -> heal -> suite |
| `runStore.ts` | 183 | File-backed per-run NDJSON event log with SSE replay + fallback reconstruction |
| `cli.ts` | 38 | CLI entry point: parses `--prompt`/`--url`/`--urls`/`--coverage`, calls `runPipeline` |

Timeouts, retries, and other constants that used to live in a single `config.ts` are now inline
per-stage (mostly env-overridable — see `README.md`'s Configuration section and `.env.example`).

### `src/llm/` — LLM Layer (6 files, ~360 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `gemini.ts` | 59 | Google Gemini client (REST API, key-pool rotation, backoff) |
| `groq.ts` | 65 | Groq client (OpenAI-compatible REST API, key-pool rotation, backoff) |
| `keyPool.ts` | 39 | Round-robin API key pool with cooldown tracking |
| `groqBudget.ts` | 55 | Per-run hard cap on Groq calls; usage recorded to `08-groq-usage.json` |
| `backoff.ts` | 133 | Exponential backoff, per-attempt timeout, rate-limit detection + key rotation |
| `json.ts` | 9 | Strip markdown fences and parse JSON from LLM output |

### `src/kb/` — Knowledge Base (3 files, ~278 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `cache.ts` | 38 | SHA1-keyed file-based AppModel cache |
| `llmCache.ts` | 42 | Two-tier LLM response cache (in-memory, 30-min TTL + disk, no expiry) |
| `testStrategy.ts` | 198 | Static QA knowledge: coverage taxonomy, scope classification, filtering |

### `src/server/` — Web Server (4 files, ~225 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `concurrency.ts` | 36 | In-process semaphore: caps concurrent runs, queues overflow |
| `runRegistry.ts` | 37 | SSE fan-out: broadcasts events, replays history on connect |
| `pendingCredentials.ts` | 55 | Parks a paused run's credential prompt in memory; resolved by the UI's answer or `CREDENTIAL_WAIT_MS` timeout |
| `index.ts` | 97 | Express: `/api/runs` CRUD, credential-prompt endpoint, SSE stream, polling, static files |

### `public/` — Frontend (5 files, ~1,822 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `icons.js` | 90 | Inline SVG icon set |
| `index.html` | 143 | Single-page HTML shell |
| `preview.js` | 108 | Static preview/demo states for UI development |
| `style.css` | 575 | Dark theme, responsive design |
| `app.js` | 906 | Single-page app: run form, phase UI, suite cards, history |

---

## Schema Contracts

Two Zod schemas, `src/schema/appModel.ts` and `src/schema/ir.ts` (295 lines combined).

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
    domLinks?, navigation?: DomLink[] / NavigationItem[]  — raw link/nav structure
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

---

## LLM Integration

| Stage | Model | Input | Output | When Used |
|-------|-------|-------|--------|-----------|
| Planner | Gemini (`gemini-2.5-flash`) | Prompt + URL | Plan (steps, scope, coverage) | Every run, 1 call |
| Concept labeling | Gemini (`gemini-2.5-flash`) | DOM element list | Labeled AppModel | DOM discovery path, 1 call per page |
| Vision discovery | Gemini (`gemini-2.5-flash`) | ARIA snapshot + JPEG screenshot | AppModel | Fallback only, 1 call per page |
| Test cases | Gemini (`gemini-2.5-flash`) | Plan + AppModel + strategy | TestCase[] | Every run, 1 call |
| IR generation | Groq (`openai/gpt-oss-120b`) | TestCase + AppModel + sourcePrompt | IR (JSON) | Every run, up to `MAX_IR_ATTEMPTS` (default 4) calls per case, hard-capped run-wide by `MAX_GROQ_CALLS_PER_RUN` (default 60) |
| Failure analysis | Gemini (`gemini-2.5-flash`) | Error + ARIA + screenshots | Diagnosis | Only on failure, and only when the deterministic classifier can't resolve it |

**Key rotation:** Both Gemini and Groq clients use `keyPool.ts` for round-robin key selection with cooldown. `backoff.ts` handles rate-limit detection, exponential delay, key penalization, and a per-attempt abort (`LLM_TIMEOUT_MS`, default 45s) so a hung fetch can't stall a run indefinitely.

**Caching:** `llmCache.ts` provides a two-tier cache — in-memory (30-min TTL) + disk (no expiry) — keyed by a hash of concatenated inputs. Avoids duplicate LLM calls for identical inputs across runs. The disk half's lack of expiry has bitten this project more than once: a cache key that omits a real input dimension (e.g. credential policy) can silently serve stale results forever — see credential-policy fixes in the project history.

---

## Frontend & Server

### Server Architecture

```
Express (port 3000, PORT env)
  POST   /api/runs                     -> starts pipeline (via concurrency semaphore)
  POST   /api/runs/:runId/credentials  -> answers a paused run's credential prompt
                                           (never logged, never written to disk)
  GET    /api/runs/:runId/state        -> polling endpoint (for Cloudflare tunnels)
  GET    /api/runs/:runId/events       -> SSE event stream (for localhost)
  GET    /api/runs                     -> list all runs (newest first)
  DELETE /api/runs/:runId              -> remove a run
  /                                    -> static files (public/)
```

### Frontend Architecture

Single-page HTML/JS/CSS app (`public/`):
- **Run form:** prompt, URL, coverage dropdown
- **Credential prompt:** appears when a run pauses waiting for login details; submitted values go
  straight into the paused pipeline's memory, never through `runStore`/disk
- **Phase pipeline:** 4 phases (Plan & Discover, Generate & Execute, Analyze, Report) with live aggregate status
- **Suite progress:** per-case status, lazy-loaded details, screenshots, download buttons
- **History panel:** newest 20 runs, each deletable
- **Polling:** uses `GET /api/runs/:id/state` (works through Cloudflare tunnels; SSE is localhost-only)

### Concurrency

`concurrency.ts` implements an in-process semaphore that caps concurrent pipeline runs (default: 3, configurable via `MAX_CONCURRENT_RUNS`). Each run launches a Chromium instance. Overflow requests queue and wait.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **DOM-first discovery** | `domExtract.ts` extracts structured elements without LLM tokens. Vision is expensive and slow — used only when DOM extraction finds nothing usable (canvas/captcha/icon-only controls). |
| **Deterministic failure classifier** | Pattern-matching on Playwright error text is free and instant. Gemini vision diagnosis is used only for ambiguous cases. |
| **Bounded self-heal** | `MAX_LIVE_EXTENSIONS` (default 5) page hops, 1 heal attempt per test case, policy-aware re-snapshot. Prevents infinite loops and runaway LLM usage. |
| **Truncation as fallback** | A partial real test is better than a hard failure. IR truncation + `hasTerminalAssertion` guard ensures execution always happens on real, grounded steps. |
| **Credential policy is decided per case, from the case's own wording, before any substitution** | A boolean ("substitute or not") can't express a good negative-password test, which needs the identifier real but the password wrong. `credentialPolicyFor` returns `full` / `identifier-only` / `none`; getting the check order right matters (identifier-at-fault must be vetoed before the broader password-at-fault check, or a malformed-email case gets its email silently "fixed"). Currently case-scoped, not leg-scoped — a case with TWO login attempts in one browser session is a known open edge. |
| **Secrets never reach disk** | User-supplied (non-demo) credentials become `${env:...}` references in the IR/generated spec; the real value is injected only into the Playwright child process's environment at execution time. `runs/` is served as static files, so this is a hard requirement, not a nicety. |
| **LLM caching, two-tier** | Same input -> same response. In-memory (30-min TTL) + disk (no expiry) deduplicates across runs and stages — the cache key must include every real input dimension, or a result gets served stale forever (this has been a recurring bug source). |
| **Key rotation with cooldown** | Multiple API keys with round-robin selection and rate-limit cooldown prevents single-key exhaustion. |
| **SSE + polling dual mode** | SSE for localhost (real-time), polling for Cloudflare tunnels (which buffer SSE). |
| **Isolated per-case execution** | Every case in a suite gets its own Playwright `test()` — a fresh browser context, so one case's login session can't leak into the next case's assumptions. |

---

## Current Gaps

| Gap | Impact | Status |
|-----|--------|--------|
| No server authentication | Anyone with the URL can start runs and browse artifacts | Open |
| Cross-leg credential handling for multi-attempt cases | A case that logs in for real, then tries a second (wrong-credential) login in the same browser session, can substitute the real credential into the wrong attempt if the model doesn't order the real attempt last — confirmed in production | Open, diagnosed, fix not yet implemented |
| Failure diagnosis step attribution | `analyzeFailure` reported a different `failingStepId` than a run's raw Playwright trace actually showed, confirmed against a real run | Open, not yet investigated |
| No end-to-end self-heal test | Self-heal is verified in code but not against a real drifted site | Pending manual verification |
| No multi-user isolation | Single-process, shared run history, no per-user quotas | Open |
| Assertion quality beyond the terminal step | The case's final pure-text assertion is grounded against the live page; a mid-case free-text assertion has no equivalent check yet | Open |
| Playwright generator is pure code | No LLM used for spec generation (intentional) | Feature, not a gap |
| Cloudflare tunnel buffering | SSE events delayed; UI uses polling as workaround | Works, not a blocker |

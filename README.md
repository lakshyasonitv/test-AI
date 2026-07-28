# AI Test Platform

A pipeline that turns a natural-language testing request + a URL into **executed** Playwright tests — with a live progress UI, per-step screenshots, artifacts (trace, generated spec), per-case suite results, and plain-English failure diagnosis on failure. Handles multi-page flows by discovering pages on demand, and tries once to auto-repair broken locators before reporting failure.

## Quick Start

```bash
npm install                  # installs deps + playwright install chromium (postinstall)
cp .env.example .env         # fill in GEMINI_API_KEYS / GROQ_API_KEYS
npm run serve                # starts server on http://localhost:3000
```

Open the UI, enter a prompt + URL, and watch the phase panel update with live progress.

**CLI mode:**

```bash
npm run generate -- --prompt "Test login with an invalid password" --url "https://the-internet.herokuapp.com/login"
```

## How It Works

```
prompt + url
  -> Planner (LLM)                    -> high-level test plan
  -> Discovery (LLM + browser, vision)-> app model: elements as accessibility role + name
  -> Structured Test Cases (LLM)      -> full coverage suite (valid/invalid/boundary/security)
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (LLM) + grounding  -> strict JSON test model (the contract)
       \_ live-extend (on demand)      -> reaches + models pages beyond the entry page
       \_ truncation (fallback)        -> a real, partial test instead of a hard failure
  -> Reactive coverage generation     -> generate cases for newly-discovered pages
  -> Playwright Generator (no AI)     -> *.spec.ts with per-step test.step() blocks
  -> Execution Engine (no AI)         -> run + collect per-step artifacts
  -> Failure Analysis (LLM, vision)   -> diagnosis (only on failure)
       \_ Bounded self-heal (<=1x)    -> re-snapshot + regenerate + re-run once
```

## Current Capabilities

### What Works

| Capability | Status | Details |
|-----------|--------|---------|
| Natural language to executed test | Working | Prompt + URL -> real Playwright test running in a browser |
| Full coverage suite generation | Working | 6-11 test cases per run: valid path, invalid input, empty fields, boundaries, security |
| All suite cases executed | Working | Every generated case runs independently with per-case artifacts |
| Per-step screenshots | Working | Each IR step gets its own `test.step()` block and `step-N.png` screenshot |
| Per-step pass/fail status | Working | Individual step results in Playwright JSON output, not just overall test status |
| Phase pipeline (live UI) | Working | 4 phases track aggregate status across sub-stages; no premature green/red |
| Multi-page flows (live-extend) | Working | On-demand page discovery when steps target unseen pages (capped at 2 extensions) |
| Self-healing broken locators | Working | Re-snapshot + regenerate + re-run, bounded to 1 attempt, only for selector drift |
| Truncated test handling | Working | Graceful degradation: partial real test instead of hard failure |
| Terminal assertion guard | Working | Truncated tests without assertions marked as `truncated_no_assertion` |
| Auth settle-wait | Working | Bounded wait after auth-triggering steps to handle SPA redirects |
| Intent-aware credentials | Working | Protects "Invalid password" test cases from credential substitution |
| Scope filtering | Working | Prompt can request smoke/functional/regression/security scope |
| Suite result display | Working | Per-case cards with status, screenshots, download links for spec/IR/result |
| Run history | Working | Newest 20 runs persisted, each deletable, with suite summary |
| Full-site crawl mode | Working | Opt-in `--crawl` flag for BFS traversal + lazy labeling |
| Reactive coverage | Working | New pages discovered during execution get auto-generated test cases |

### What Partially Works

| Capability | Status | Known Issue |
|-----------|--------|-------------|
| Self-healing | Code verified | No end-to-end test against a real drifted site yet |
| Flows needing 3+ page-hops | Works up to 2 | `MAX_EXTENSIONS = 2` cap |
| Login gates without user credentials | Fails | Only demo sites have built-in credentials |

### Known Limitations

| Issue | Impact |
|-------|--------|
| No server authentication | Anyone with the URL can start runs and browse artifacts |
| Gemini key inconsistency | Different keys from different projects can have different model access |
| Credential substitution on demo hosts | "Invalid password" taxonomy cases still get overwritten on saucedemo/herokuapp |
| Assertion quality | Prompt-nudged, not code-level validated |

## Recent Updates

### Per-Step Screenshots & Test Isolation (Latest)

**Problem:** All IR steps were flat inside a single `test()` block. If step 2 failed, steps 3+ never ran. Only one screenshot per test. No per-step pass/fail status.

**Changes:**
- `src/stages/generator.ts` — Each IR step now wrapped in `await test.step("label", async () => { ... })` with `page.screenshot()` per step. Added `stepLabel()` helper for human-readable names (e.g., "Navigate to https://...", "Click 'Login'", "Assert 'Error' is visible")
- Generated specs now produce per-step pass/fail status and per-step `artifacts/step-N.png` screenshots

### Phase Pipeline Status Fix

**Problem:** Phase 3 ("Building & Executing Tests") flickered between "In Progress" and "Complete" on every sub-stage transition. If the pipeline ended mid-transition, it showed "Failed - Interrupted" even though the phase had completed.

**Changes:**
- `public/app.js` — Added `phaseStageStatus` tracking object, `computePhaseStatus()` aggregate function, and `applyPhaseUI()` renderer. Phase status now computed from all sub-stage statuses: any "failed" -> failed; all "completed" -> completed; any "started" -> started. Phase stays "In Progress" until ALL sub-stages finish, then turns green.

### Suite Case Screenshot Fix

**Problem:** Case cards fell back to `artifacts/trace.png` (which doesn't exist; traces are `retain-on-failure` only), causing broken images.

**Changes:**
- `public/app.js` — Removed `trace.png` fallback. Screenshot `<figure>` only renders when `screenshotUrl` is provided by the backend. Backend `suiteRunner.ts` already computes `screenshotUrl` via `findScreenshot()`.

### Phase 2a-2d: Full-Site Crawl Pipeline

**Changes:**
- `src/stages/crawler.ts` — Pure traversal pass (no LLM), deferred labeling via `labelPage()`
- `src/kb/siteOutline.ts` — Depth-first site outline helper for labeling context
- `src/stages/discovery.ts` — Optional `siteOutline` parameter for ambiguous label resolution
- `src/orchestrator.ts` — Opt-in `mode: "crawl"` flag, entry-page-only eager labeling
- `src/server/index.ts` — `mode` field validation in POST body
- `src/cli.ts` — `--crawl` flag

### Full Suite Execution

- `src/stages/suiteRunner.ts` — `runSuite()` iterates all cases, per-case artifacts under `cases/case-N/`
- `src/orchestrator.ts` — Primary case reused via `PrimaryCaseResult`, not re-executed
- `07-suite-summary.json` — Suite-wide pass/fail/truncated counts with per-case status

### Terminal Assertion Guard

- `src/stages/ir.ts` — `hasTerminalAssertion()` checks if IR ends with an assert step
- Truncated tests without terminal assertion marked as `truncated_no_assertion`

### Auth Settle-Wait

- `src/stages/authSettle.ts` — `isAuthTriggeringStep()` heuristic + `waitForAuthSettle()` bounded wait
- Integrated into live-extend and generated specs

### Intent-Aware Credentials

- `src/stages/testCases.ts` — `category` field on test cases, `shouldSkipCredentialSubstitution()`
- Protects "Invalid password" and similar negative test cases

### Intent-Scoped Test Case Generation

- `src/kb/testStrategy.ts` — Coverage categories with scope tags
- `src/stages/classify.ts` — `classifyScope()` heuristic from prompt
- `src/stages/testCases.ts` — `filterByScope()` filters cases to match requested scope

### Reactive Coverage Generation

- `src/stages/testCases.ts` — `generateCasesForNewPages()` creates cases for newly-discovered pages
- `src/orchestrator.ts` — Detects new pages post-execution, generates cases, merges suite
- `src/stages/ir.ts` — `toIR()` returns `{ ir, updatedAppModel }` for live-extend discoveries

### SPA State Change Fix

- `src/stages/ir.ts` — Fallback to `refreshPageModel()` when `extendAppModel()` fails with "already in model"

### Discovery Enhancements

- `src/stages/discovery.ts` — `discoverInteractiveElements(page)` via `page.evaluate()` DOM traversal
- Icon-only buttons, clickable divs, onclick handlers detected and appended to ARIA snapshot
- `modelFromAria()` prompt updated to incorporate interactive elements section

### Frontend Improvements

- `public/app.js` — Phase pipeline with aggregate status tracking
- `public/app.js` — Suite progress live updates during execution
- `public/app.js` — Per-case result cards with screenshots, download links, lazy-loaded technical details
- `public/app.js` — Run history with suite summaries and delete buttons
- `public/app.js` — Button disable/enable during execution
- `public/style.css` — Responsive design, phase badges, download buttons, case cards
- `public/index.html` — Viewport meta tag for mobile

### Bug Fixes

- `src/stages/generator.ts` — Fixed `${helpers}` (array) -> `${helper}` (joined string) syntax error
- `public/app.js` — Fixed "Generated undefined test case(s)" by handling both array and object data shapes
- `src/stages/testCases.ts` — Created `LLMTestCase` schema without `generatedFrom`, stamped in code post-parse
- `public/app.js` — Added null guards on `traceLinkEl` references
- `public/app.js` — Removed premature polling termination (`noNewEventsCount`)
- `public/app.js` — Fixed suite progress items not rendering from empty initial events
- `public/app.js` — Added `traceLink` element to HTML
- `public/app.js` — Fixed traceLink href from `generated/` to `generated.spec.ts`
- `public/app.js` — Added explicit `download` attributes on case card download buttons
- Merge conflict resolution across `orchestrator.ts`, `generator.ts`, `ir.ts`, `suiteRunner.ts`

## Architecture

### Pipeline Stages

| Stage | File | LLM? | Description |
|-------|------|------|-------------|
| Planner | `src/stages/planner.ts` | Gemini | NL request -> ordered high-level steps |
| Discovery | `src/stages/discovery.ts` | Gemini | Accessibility snapshot + screenshot -> AppModel |
| Hybrid Discovery | `src/stages/hybridDiscovery.ts` | Gemini | Combines crawl + discover for multi-page |
| Crawler | `src/stages/crawler.ts` | No | BFS traversal, captures raw signal per page |
| Test Cases | `src/stages/testCases.ts` | Gemini | Coverage suite (valid/invalid/boundary/security) |
| IR Generation | `src/stages/ir.ts` | Groq | Test case -> strict JSON test model + grounding |
| Live Extend | `src/stages/liveExtend.ts` | No | Browser replay to discover new pages |
| Generator | `src/stages/generator.ts` | No | IR -> Playwright spec with test.step() blocks |
| Executor | `src/stages/executor.ts` | No | Runs spec, captures screenshots/traces |
| Failure Analysis | `src/stages/failureAnalysis.ts` | Gemini + Vision | Diagnoses failures with screenshots |
| Suite Runner | `src/stages/suiteRunner.ts` | No | Executes all cases, per-case artifacts |
| Target Resolver | `src/stages/targetResolver.ts` | No | IR Target -> locator with fallback chain |
| Auth Settle | `src/stages/authSettle.ts` | No | Bounded wait after auth-triggering steps |
| Credentials | `src/stages/credentials.ts` | No | Test credentials for public demo sites |

### Shared Infrastructure

| Module | File | Description |
|--------|------|-------------|
| Orchestrator | `src/orchestrator.ts` | Wires stages, manages primary case, suite execution, self-heal |
| Run Store | `src/runStore.ts` | Durable per-run NDJSON event log |
| LLM - Gemini | `src/llm/gemini.ts` | Gemini API client with key rotation |
| LLM - Groq | `src/llm/groq.ts` | Groq API client with key rotation |
| Key Pool | `src/llm/keyPool.ts` | API key rotation + 429 handling |
| Backoff | `src/llm/backoff.ts` | Exponential backoff for retries |
| JSON Parse | `src/llm/json.ts` | Robust JSON extraction from LLM output |
| App Model Cache | `src/kb/cache.ts` | Per-URL AppModel cache |
| Test Strategy | `src/kb/testStrategy.ts` | Coverage taxonomy (floor, not ceiling) |
| Site Outline | `src/kb/siteOutline.ts` | Depth-first site tree for labeling context |
| Config | `src/config.ts` | Environment configuration |

### Schemas

| Schema | File | Description |
|--------|------|-------------|
| AppModel | `src/schema/appModel.ts` | Elements by accessibility role + name |
| IR | `src/schema/ir.ts` | Step, Target, Assertion — the contract |
| SiteGraph | `src/schema/siteGraph.ts` | Crawl output: pages + outbound links |
| CrawlDirective | `src/schema/crawlDirective.ts` | Crawl configuration |

### Server

| Module | File | Description |
|--------|------|-------------|
| Routes | `src/server/index.ts` | Express server, run CRUD, API endpoints |
| Run Registry | `src/server/runRegistry.ts` | SSE fan-out for live progress |
| Concurrency | `src/server/concurrency.ts` | Run cap enforcement |

### Frontend

| File | Description |
|------|-------------|
| `public/index.html` | Single-page HTML with phase pipeline, form, results |
| `public/app.js` | Event processing, polling, phase tracking, suite rendering |
| `public/style.css` | Responsive design, phase badges, case cards, download buttons |

## Project Structure

```
ai-test-platform/
  src/
    stages/          # Pipeline stages (18 files)
    schema/          # Zod contracts (4 files)
    llm/             # LLM layer with key rotation (6 files)
    kb/              # Knowledge base + caching (4 files)
    server/          # Express server + SSE (3 files)
    orchestrator.ts  # Pipeline wiring + self-heal
    runStore.ts      # Durable event log
    cli.ts           # CLI entry point
    config.ts        # Environment config
  public/            # Frontend (3 files)
  runs/              # Runtime artifacts (gitignored)
  PROJECT_OVERVIEW.md  # Full architecture + design decisions
  ENTERPRISE.md       # Scaling roadmap (documented, not built)
  PROGRESS.md         # Development timeline + verification status
  UPDATE.md           # Detailed changelog for recent phases
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEYS` | Yes | Comma-separated Gemini API keys (quota stacks across projects) |
| `GROQ_API_KEYS` | Yes | Comma-separated Groq API keys (failover only, same org) |

### Playwright Config

`playwright.config.ts` — Chromium headless, screenshots on, video retained on failure, traces retained on failure.

### Key Constants

| Constant | Location | Value | Description |
|----------|----------|-------|-------------|
| `MAX_EXTENSIONS` | `liveExtend.ts` | 2 | Max live-extend page hops per test case |
| `TEST_RUN` timeout | `executor.ts` | 60s | Per-test execution timeout |
| `RETRIES` | `executor.ts` | 2 | Retry attempts for flaky tests |
| History limit | `runStore.ts` | 20 | Max runs shown in history |

## Sharing Over the Internet

```bash
# terminal 1
npm run serve

# terminal 2 (no Cloudflare account needed)
cloudflared tunnel --url http://localhost:3000
```

This prints a random `https://<words>.trycloudflare.com` URL. Ephemeral, free, no sign-up.

**Note:** Quick Tunnels buffer SSE responses, so the UI uses polling (`GET /api/runs/:id/state`) instead of streaming. Both routes exist; SSE works fine on localhost. Named tunnels don't have this limitation.

**Security:** The server has no authentication. Anyone with the URL can start runs and browse artifacts. Fine for trusted audiences; know this before sharing widely.

## Future Plans

- **Server authentication** for safe tunnel sharing
- **Real/private site credentials** via env-var path (no artifact exposure)
- **Multi-framework export** (Selenium, Cypress from same IR)
- **Real Knowledge Base** — queryable store from run artifacts
- **Business Flow Graph / Risk Analysis / Improvement Suggestions**

## Further Reading

- [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) — Full architecture, every design decision, honest completion status
- [PROGRESS.md](PROGRESS.md) — Development timeline with verification evidence
- [UPDATE.md](UPDATE.md) — Detailed changelog for recent phases
- [ENTERPRISE.md](ENTERPRISE.md) — Scaling roadmap (documented, not built)

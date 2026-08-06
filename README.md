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

# multiple entry pages, and an explicit coverage level (minimal | standard | full, default standard)
npm run generate -- --prompt "Test the homepage" --urls "https://example.com,https://example.com/about" --coverage full
```

## Discovery

DOM-based discovery is built in and needs no setup — `domDiscovery.ts` drives Playwright and
extracts structured elements with cheerio (`domExtract.ts`), no LLM tokens involved. It is the
primary path and is tried first for every page.

Gemini vision is the fallback, used only when DOM extraction returns nothing usable:

- canvas/captcha/image-heavy pages, where there's no meaningful DOM to read
- controls with no accessible name and no text (an icon-only cart link that's styled purely
  with a CSS background image)

There is nothing to start and no Python involved. Earlier versions shelled out to a
Crawl4AI/FastAPI service on `localhost:8000`; that service is gone and its extraction logic
was ported to Node (`domExtract.ts` is a 1:1 port of the old Python parser).

## How It Works

```
prompt + url
  -> Planner (Gemini)                 -> structured test plan
  -> Discovery                        -> app model: elements as accessibility role + name
       |_ DOM extraction (primary)     -> cheerio over page.content(), no LLM needed
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Structured Test Cases (Gemini)   -> full coverage suite (valid/invalid/boundary/security)
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (Groq) + grounding -> strict JSON test model (the contract)
       \_ credentialPolicyFor(case)    -> full / identifier-only / none, decided from case
                                          wording before any substitution happens
       \_ live-extend (on demand)      -> reaches + models pages beyond the entry page,
                                          policy-aware (only the case's final credential
                                          attempt gets substituted during replay)
       \_ text-assertion grounding     -> replays the terminal step, corrects a wrong-worded
                                          guess against the real page instead of trusting it
       \_ truncation (fallback)        -> a real, partial test instead of a hard failure
  -> Playwright Generator (no AI)     -> *.spec.ts with per-step test.step() blocks
  -> Suite Runner (no AI)             -> every case in its own Playwright test() / browser
                                          context, run + collect per-case artifacts
  -> Failure Analysis (Gemini)        -> diagnosis (only on failure)
       \_ Deterministic classifier    -> pattern-matches Playwright errors first (free)
       \_ Gemini fallback             -> only for ambiguous cases
       \_ Bounded self-heal (<=1x)    -> re-snapshot (policy-aware) + regenerate + re-run once
```

## Current Capabilities

### What Works

| Capability | Status | Details |
|-----------|--------|---------|
| Natural language to executed test | Working | Prompt + URL -> real Playwright test running in a browser |
| Full coverage suite generation | Working | Up to 5 cases per run by default (`MAX_CASES_PER_RUN`): valid path, invalid input, empty fields, boundaries, security |
| All suite cases executed | Working | Every selected case runs in its own Playwright `test()` / browser context, with per-case artifacts |
| Per-step screenshots | Working | Each IR step gets its own `test.step()` block and `step-N.png` screenshot |
| Per-step pass/fail status | Working | Individual step results in Playwright JSON output, not just overall test status |
| Phase pipeline (live UI) | Working | 4 phases track aggregate status across sub-stages; no premature green/red |
| Multi-page flows (live-extend) | Working | On-demand page discovery when steps target unseen pages (capped, `MAX_LIVE_EXTENSIONS`, default 5) |
| Self-healing broken locators | Working | Re-snapshot (credential-policy-aware) + regenerate + re-run, bounded to 1 attempt, only for selector drift |
| Truncated test handling | Working | Graceful degradation: partial real test instead of hard failure |
| Terminal assertion guard | Working | Truncated tests without assertions marked as `truncated_no_assertion` |
| Auth settle-wait | Working | Bounded wait after auth-triggering steps to handle SPA redirects |
| Credential-policy substitution | Working for single-attempt cases | `credentialPolicyFor` distinguishes full / identifier-only / none per case from its own wording — a negative "invalid password" case keeps its deliberately-wrong value. A case with TWO login attempts in one browser session is a known open edge (see Known Limitations) |
| Terminal text-assertion grounding | Working | The case's final pure-text assertion is replayed against the real page and corrected if the model guessed the wording wrong |
| Secrets kept off disk | Working | User-supplied credentials become `${env:...}` references in the generated spec; the real value only reaches the test process's environment at execution time |
| Scope filtering | Working | Prompt can request smoke/functional/regression/security scope |
| Suite result display | Working | Per-case cards with status, screenshots, download links for spec/IR/result |
| Run history | Working | Newest 20 runs persisted, each deletable, with suite summary |
| Deterministic failure classifier | Working | Pattern-matches Playwright errors before spending a Gemini call |
| DOM-first discovery | Working | Node/cheerio extraction, vision-fallback, zero LLM tokens on the common path |
| LLM response caching | Working | File + in-memory cache for repeated prompts, 30-min TTL |

### What Partially Works

| Capability | Status | Known Issue |
|-----------|--------|-------------|
| Self-healing | Code verified | No end-to-end test against a real drifted site yet |
| Flows needing 3+ page-hops | Works up to `MAX_LIVE_EXTENSIONS` | Default 5, env-overridable |
| A case that logs in for real, then tries a second (wrong-credential) login attempt in the same case | Fragile | Substitution only guarantees the case's FINAL credential attempt gets the real value; if the model doesn't order the real attempt last, the wrong leg gets it. Most sites also redirect an already-authenticated session away from the login page, so "return to the login page" for a second attempt can find no form there at all |
| Login gates without user credentials | Fails | Only demo sites have built-in credentials |

### Known Limitations

| Issue | Impact |
|-------|--------|
| No server authentication | Anyone with the URL can start runs and browse artifacts |
| Gemini key inconsistency | Different keys from different projects can have different model access |
| Failure diagnosis step attribution | Confirmed against a real run: `analyzeFailure` can report a different `failingStepId` than the raw Playwright trace actually shows |
| Assertion quality | Prompt-nudged, not code-level validated, beyond the terminal-step grounding above |

## Architecture

### Pipeline Stages

| Stage | File | LLM? | Description |
|-------|------|------|-------------|
| Planner | `src/stages/planner.ts` | Gemini | NL request -> structured test plan |
| Hybrid Discovery | `src/stages/hybridDiscovery.ts` | Gemini (fallback only) | DOM-first, vision-fallback orchestrator |
| DOM Discovery | `src/stages/domDiscovery.ts` | No | Drives Playwright, hands page HTML to `domExtract.ts` |
| DOM Extraction | `src/stages/domExtract.ts` | No | Cheerio-based structured extraction (Node port of the old Python parser) |
| Vision Discovery | `src/stages/discovery.ts` | Gemini | Accessibility snapshot + screenshot -> AppModel (fallback path) |
| Prompt Selectors | `src/stages/promptSelectors.ts` | No | Honors selectors the user wrote directly into their prompt |
| Test Cases | `src/stages/testCases.ts` | Gemini | Coverage suite (valid/invalid/boundary/security), capped by `MAX_CASES_PER_RUN` |
| IR Generation | `src/stages/ir.ts` | Groq | Test case -> strict JSON test model + grounding + credential-policy decision |
| Live Extend | `src/stages/liveExtend.ts` | No | Policy-aware browser replay to discover new pages + ground terminal text assertions |
| Generator | `src/stages/generator.ts` | No | IR -> Playwright spec with test.step() blocks |
| Executor | `src/stages/executor.ts` | No | Runs spec, captures screenshots/traces |
| Failure Classifier | `src/stages/classify.ts` | No | Deterministic pattern matching on Playwright errors |
| Failure Analysis | `src/stages/failureAnalysis.ts` | Gemini + Vision | Diagnoses failures with screenshots (fallback) |
| Suite Runner | `src/stages/suiteRunner.ts` | No | Executes all cases in isolated browser contexts, per-case artifacts |
| Target Resolver | `src/stages/targetResolver.ts` | No | IR Target -> locator with fallback chain |
| Auth Settle | `src/stages/authSettle.ts` | No | Bounded wait after auth-triggering steps |
| Credentials | `src/stages/credentials.ts` | No | Demo-site credentials + per-case/per-leg substitution policy |

### Shared Infrastructure

| Module | File | Description |
|--------|------|-------------|
| Orchestrator | `src/orchestrator.ts` | Wires stages, manages primary case, suite execution, self-heal |
| Run Store | `src/runStore.ts` | Durable per-run NDJSON event log |
| LLM - Gemini | `src/llm/gemini.ts` | Gemini API client with key rotation |
| LLM - Groq | `src/llm/groq.ts` | Groq API client with key rotation |
| Groq Budget | `src/llm/groqBudget.ts` | Per-run hard cap on Groq calls (`MAX_GROQ_CALLS_PER_RUN`), usage recorded to `08-groq-usage.json` |
| Key Pool | `src/llm/keyPool.ts` | API key rotation + 429 handling |
| Backoff | `src/llm/backoff.ts` | Exponential backoff + per-attempt timeout (`LLM_TIMEOUT_MS`) for retries |
| JSON Parse | `src/llm/json.ts` | Robust JSON extraction from LLM output |
| App Model Cache | `src/kb/cache.ts` | Per-URL AppModel cache |
| LLM Cache | `src/kb/llmCache.ts` | LLM response cache (in-memory + disk; in-memory half honors a 30-min TTL, the disk half does not expire) |
| Test Strategy | `src/kb/testStrategy.ts` | Coverage taxonomy (floor, not ceiling) |

### Schemas

| Schema | File | Description |
|--------|------|-------------|
| AppModel | `src/schema/appModel.ts` | Elements by accessibility role + name |
| IR | `src/schema/ir.ts` | Step, Target, Assertion — the contract |

### Server

| Module | File | Description |
|--------|------|-------------|
| Routes | `src/server/index.ts` | Express server, run CRUD, credential-prompt endpoint, API endpoints |
| Run Registry | `src/server/runRegistry.ts` | SSE fan-out for live progress |
| Concurrency | `src/server/concurrency.ts` | Run cap enforcement |
| Pending Credentials | `src/server/pendingCredentials.ts` | Parks a paused run's credential prompt in memory (never written to disk); resolved by the UI's answer or a timeout (`CREDENTIAL_WAIT_MS`) |

### Frontend

| File | Description |
|------|-------------|
| `public/index.html` | Single-page HTML with phase pipeline, form, results |
| `public/app.js` | Event processing, polling, phase tracking, suite rendering |
| `public/preview.js` | Static preview/demo states, used for UI development |
| `public/icons.js` | Inline SVG icon set |
| `public/style.css` | Responsive design, phase badges, case cards, download buttons |

## Project Structure

```
ai-test-platform/
  src/
    stages/              # Pipeline stages (17 files, ~5,378 lines)
      hybridDiscovery.ts # Discovery orchestrator (DOM-first, vision-fallback)
      domDiscovery.ts    # Drives Playwright, hands page HTML to domExtract.ts
      domExtract.ts      # Cheerio DOM extraction (Node port of the old Python parser, 606 lines)
      discovery.ts       # Playwright + Gemini vision discovery (fallback path)
      promptSelectors.ts # Honors selectors the user wrote directly into their prompt
      planner.ts         # NL request -> structured plan
      testCases.ts       # Coverage suite generation, capped by MAX_CASES_PER_RUN
      ir.ts              # IR generation: grounding, credential policy, live-extend, truncation
      liveExtend.ts      # Policy-aware browser replay: new pages + terminal-assertion grounding
      targetResolver.ts  # IR Target -> locator with fallback chain
      generator.ts       # IR -> Playwright spec (pure code, zero LLM)
      executor.ts        # Runs spec, captures artifacts
      classify.ts        # Deterministic failure classifier (zero LLM)
      failureAnalysis.ts # Gemini vision failure diagnosis (fallback)
      suiteRunner.ts     # Executes all cases in isolated browser contexts
      authSettle.ts      # Bounded wait after auth-triggering steps
      credentials.ts     # Demo credentials + full/identifier-only/none substitution policy
    schema/              # Zod contracts (2 files: AppModel, IR)
    llm/                 # LLM layer with key rotation + budget (6 files)
    kb/                  # Knowledge base + caching (3 files)
    server/              # Express server + SSE + credential-prompt pause (4 files)
    orchestrator.ts      # Pipeline wiring + self-heal
    runStore.ts          # Durable event log
    cli.ts               # CLI entry point
  public/                # Frontend (5 files)
  runs/                  # Runtime artifacts (gitignored)
  ARCHITECTURE.md        # Technical reference: every file, schemas, design decisions
  PROJECT_SUMMARY.md     # Concise project statement, architecture diagram, current state
```

## Configuration

### Environment Variables

All optional except the two API key variables. Full descriptions and cost/reliability tradeoffs
are in `.env.example`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEYS` | Yes | Comma-separated Gemini API keys (quota stacks across distinct projects) |
| `GROQ_API_KEYS` | Yes | Comma-separated Groq API keys (failover only — Groq limits are per-org, not per-key) |
| `GEMINI_MODEL` | No | Gemini model for discovery/test-cases/failure-analysis (default: `gemini-2.5-flash`) |
| `GEMINI_MODEL_LITE` | No | Gemini model for labeling (default: `gemini-2.5-flash`) |
| `GROQ_MODEL` | No | Groq model for IR generation (default: `openai/gpt-oss-120b`) |
| `LLM_TIMEOUT_MS` | No | Per-attempt abort timeout for any Gemini/Groq call (default: 45000) |
| `MAX_GROQ_CALLS_PER_RUN` | No | Hard cap on total Groq calls per run, recorded to `08-groq-usage.json` (default: 60) |
| `MAX_IR_ATTEMPTS` | No | Max IR generate/validate retries per test case (default: 4) |
| `MAX_LIVE_EXTENSIONS` | No | Max browser replays per case to discover pages behind a login/click (default: 5) |
| `MAX_CASES_PER_RUN` | No | Hard ceiling on cases turned into runnable scripts (default: 5) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `CREDENTIAL_WAIT_MS` | No | How long a paused run waits for you to supply credentials before continuing without them (default: 300000 / 5 min) |
| `SCREENSHOT_SETTLE_MS` / `SCREENSHOT_MAX_SAMPLES` | No | Animation-settle detection before a screenshot (defaults: 150ms / 10 samples) |
| `PORT` | No | Web UI port (default: 3000) |
| `ENABLE_CASE_SELECTION_GATE` | No | Opt-in feature gate; when `"true"`, runs the case-selection-gate pipeline (Phases 1-8). Unset/anything else = current behavior (default: disabled) |

### Playwright Config

`playwright.config.ts` — Chromium headless, 50s per-test timeout, 0 retries, screenshot on every
result, trace + video retained on failure only.

### Key Constants

| Constant | Location | Default | Description |
|----------|----------|---------|-------------|
| `MAX_EXTENSIONS` | `ir.ts` (`MAX_LIVE_EXTENSIONS` env) | 5 | Max live-extend page hops per test case |
| `MAX_ATTEMPTS` | `ir.ts` (`MAX_IR_ATTEMPTS` env) | 4 | IR generate/validate retries per case |
| Coverage budget | `testCases.ts` | 2 / 4 / 5 | Cases per run for minimal / standard / full coverage, capped by `MAX_CASES_PER_RUN` |
| History limit | `runStore.ts` | 20 | Max runs shown in history (not env-configurable) |
| LLM cache TTL | `llmCache.ts` | 30min | In-memory half only — the on-disk half has no expiry |
| AppModel cache TTL | `cache.ts` (`APPMODEL_CACHE_TTL_MS` env) | 30min | Per-URL discovery cache |

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

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical reference: every file explained, schema contracts, design decisions, current gaps
- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) — Concise project statement, detailed architecture diagram, what works, next steps toward enterprise readiness

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

**Crawl mode** (full-site BFS traversal + lazy labeling):

```bash
npm run generate -- --prompt "Test the homepage" --url "https://example.com" --crawl
```

## Discovery Service (Optional)

The platform has a Python-based discovery service (`discovery-service/`) that provides faster, deterministic DOM-based page discovery using Crawl4AI. When running, it becomes the primary discovery path — Gemini vision is used only as a fallback.

```bash
# Terminal 1 — start the discovery service before running tests
cd discovery-service
pip install -r requirements.txt
python app.py

# Terminal 2 — run the platform
npm run serve
```

The service listens on `http://localhost:8000`. If it's not running, the platform automatically falls back to Playwright + Gemini vision discovery (slower, uses more LLM tokens). The auto-start mechanism in `domDiscovery.ts` will also try to spawn it if it detects the service is down.

**When to use it:**
- Standard pages with HTML forms, buttons, links, navigation — Crawl4AI extracts structured DOM data faster and cheaper than vision
- Pages that don't need JavaScript rendering for structure (most server-rendered sites)
- When you want to reduce Gemini API calls during discovery

**When to skip it:**
- Canvas/captcha/image-heavy pages — these need vision anyway
- Quick one-off tests where the fallback is fine
- If Python environment setup is a hassle

## How It Works

```
prompt + url
  -> Planner (LLM)                    -> high-level test plan
  -> Discovery (hybrid)                -> app model: elements as accessibility role + name
       |_ Crawl4AI (primary)           -> fast DOM extraction, no LLM needed
       |_ Playwright + Aria (fallback) -> accessibility snapshot + interactive elements
       |_ Gemini Vision (last resort)  -> only for canvas/captcha/image-heavy pages
  -> Structured Test Cases (LLM)      -> full coverage suite (valid/invalid/boundary/security)
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (LLM) + grounding  -> strict JSON test model (the contract)
       \_ live-extend (on demand)      -> reaches + models pages beyond the entry page
       \_ truncation (fallback)        -> a real, partial test instead of a hard failure
  -> Reactive coverage generation     -> generate cases for newly-discovered pages
  -> Playwright Generator (no AI)     -> *.spec.ts with per-step test.step() blocks
  -> Execution Engine (no AI)         -> run + collect per-step artifacts
  -> Failure Analysis (LLM, vision)   -> diagnosis (only on failure)
       \_ Deterministic classifier    -> pattern-matches Playwright errors first (free)
       \_ Gemini fallback             -> only for ambiguous cases
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
| Deterministic failure classifier | Working | Pattern-matches Playwright errors before spending a Gemini call |
| Hybrid discovery | Working | Crawl4AI DOM-first, vision-fallback, auto-starts service if needed |
| LLM response caching | Working | File + in-memory cache for repeated prompts, 30-min TTL |

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

## Architecture

### Pipeline Stages

| Stage | File | LLM? | Description |
|-------|------|------|-------------|
| Planner | `src/stages/planner.ts` | Gemini | NL request -> ordered high-level steps |
| Hybrid Discovery | `src/stages/hybridDiscovery.ts` | Gemini (optional) | DOM-first, vision-fallback discovery |
| Crawl4AI Discovery | `src/stages/domDiscovery.ts` | No | Calls Python Crawl4AI service for DOM extraction |
| Playwright Discovery | `src/stages/discovery.ts` | Gemini | Accessibility snapshot + screenshot -> AppModel |
| Crawler (BFS) | `src/stages/crawler.ts` | No | Deterministic BFS traversal for full-site crawl mode |
| Test Cases | `src/stages/testCases.ts` | Gemini | Coverage suite (valid/invalid/boundary/security) |
| IR Generation | `src/stages/ir.ts` | Groq | Test case -> strict JSON test model + grounding |
| Live Extend | `src/stages/liveExtend.ts` | No | Browser replay to discover new pages |
| Generator | `src/stages/generator.ts` | No | IR -> Playwright spec with test.step() blocks |
| Executor | `src/stages/executor.ts` | No | Runs spec, captures screenshots/traces |
| Failure Classifier | `src/stages/classify.ts` | No | Deterministic pattern matching on Playwright errors |
| Failure Analysis | `src/stages/failureAnalysis.ts` | Gemini + Vision | Diagnoses failures with screenshots (fallback) |
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
| Embeddings | `src/llm/embeddings.ts` | Gemini embedding API with caching |
| App Model Cache | `src/kb/cache.ts` | Per-URL AppModel cache |
| LLM Cache | `src/kb/llmCache.ts` | LLM response cache (file + memory, 30-min TTL) |
| Test Strategy | `src/kb/testStrategy.ts` | Coverage taxonomy (floor, not ceiling) |
| Site Outline | `src/kb/siteOutline.ts` | Depth-first site tree for labeling context |
| Config | `src/config.ts` | Centralized timeouts, retries, selector fixes |

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

### Discovery Service (Python)

| File | Description |
|------|-------------|
| `discovery-service/app.py` | FastAPI server — `/crawl` and `/health` endpoints |
| `discovery-service/crawler.py` | Crawl4AI-based crawler with BeautifulSoup fallback |
| `discovery-service/schemas.py` | Pydantic schemas for API request/response |
| `discovery-service/requirements.txt` | Python dependencies |
| `discovery-service/test_parse.py` | Parser tests |

## Project Structure

```
ai-test-platform/
  src/
    stages/              # Pipeline stages (18 files)
      hybridDiscovery.ts # Hybrid discovery orchestrator (DOM-first, vision-fallback)
      domDiscovery.ts    # Crawl4AI service client (652 lines)
      discovery.ts       # Playwright + Gemini vision discovery (399 lines)
      crawler.ts         # Deterministic BFS crawler for full-site crawl mode
      crawlDirective.ts  # Maps Plan -> CrawlDirective
      planner.ts         # NL request -> high-level plan
      testCases.ts       # Coverage suite generation + reactive cases
      ir.ts              # IR generation with grounding + live-extend
      liveExtend.ts      # Browser replay for new page discovery
      targetResolver.ts  # IR Target -> locator with fallback chain
      generator.ts       # IR -> Playwright spec (pure code, zero LLM)
      executor.ts        # Runs spec, captures artifacts
      classify.ts        # Deterministic failure classifier (zero LLM)
      failureAnalysis.ts # Gemini vision failure diagnosis (fallback)
      failure/
        ruleAnalysis.ts  # Rule-based failure analysis
      suiteRunner.ts     # Executes all cases, per-case artifacts
      authSettle.ts      # Bounded wait after auth-triggering steps
      credentials.ts     # Demo site credentials + substitution logic
    schema/              # Zod contracts (4 files)
    llm/                 # LLM layer with key rotation (7 files)
    kb/                  # Knowledge base + caching (5 files)
    server/              # Express server + SSE (3 files)
    scripts/             # Test scripts
    orchestrator.ts      # Pipeline wiring + self-heal
    runStore.ts          # Durable event log
    cli.ts               # CLI entry point
    config.ts            # Centralized configuration
  discovery-service/     # Python Crawl4AI discovery service
  public/                # Frontend (3 files)
  runs/                  # Runtime artifacts (gitignored)
  PROJECT_OVERVIEW.md    # Full architecture + design decisions
  ARCHITECTURE.md        # Technical reference: crawlers, files, design decisions
  ENTERPRISE.md          # Scaling roadmap (documented, not built)
  PROGRESS.md            # Development timeline + verification status
  UPDATE.md              # Detailed changelog for recent phases
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEYS` | Yes | Comma-separated Gemini API keys (quota stacks across projects) |
| `GROQ_API_KEYS` | Yes | Comma-separated Groq API keys (failover only, same org) |
| `GEMINI_MODEL` | No | Gemini model for discovery/test-cases/failure-analysis (default: `gemini-2.5-flash`) |
| `GEMINI_MODEL_LITE` | No | Gemini model for labeling (default: `gemini-2.5-flash`) |
| `GEMINI_EMBED_MODEL` | No | Gemini embedding model (default: `text-embedding-004`) |
| `GROQ_MODEL` | No | Groq model for IR generation (default: `openai/gpt-oss-120b`) |
| `MAX_IR_ATTEMPTS` | No | Max Groq IR-generation retry attempts per test case (default: 4) |
| `MAX_GROQ_CALLS_PER_RUN` | No | Hard cap on total Groq calls per pipeline run (default: 60) |
| `DISCOVERY_SERVICE_URL` | No | Crawl4AI service URL (default: `http://localhost:8000`) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `PORT` | No | Web UI port (default: 3000) |
| `DEBUG` | No | Enable debug logging (`true`/`false`) |
| `LOG_LEVEL` | No | Log level (default: `info`) |

### Playwright Config

`playwright.config.ts` — Chromium headless, screenshots on, video retained on failure, traces retained on failure.

### Key Constants

| Constant | Location | Value | Description |
|----------|----------|-------|-------------|
| `MAX_EXTENSIONS` | `liveExtend.ts` | 2 | Max live-extend page hops per test case |
| `TEST_RUN` timeout | `config.ts` | 60s | Per-test execution timeout |
| `RETRIES` | `config.ts` | 2 | Retry attempts for flaky tests |
| History limit | `runStore.ts` | 20 | Max runs shown in history |
| `SERVICE_STARTUP_TIMEOUT` | `domDiscovery.ts` | 15s | Max wait for Crawl4AI service to start |
| `REQUEST_TIMEOUT` | `domDiscovery.ts` | 30s | Crawl request timeout |
| LLM cache TTL | `llmCache.ts` | 30min | LLM response cache duration |

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

- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical reference: two crawlers comparison, every file explained, design decisions
- [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) — Full architecture narrative, every design decision, honest completion status
- [PROGRESS.md](PROGRESS.md) — Development timeline with verification evidence
- [UPDATE.md](UPDATE.md) — Detailed changelog for recent phases
- [ENTERPRISE.md](ENTERPRISE.md) — Scaling roadmap (documented, not built)

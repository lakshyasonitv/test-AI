# Architecture Reference

This is the technical reference for the AI test automation platform. It covers the two discovery/crawling systems, every source file with its role, data contracts, LLM integration, and key design decisions.

For the narrative version of design decisions, see [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Two Crawlers: Crawl4AI vs Playwright BFS](#two-crawlers)
3. [Discovery Fallback Chain](#discovery-fallback-chain)
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

---

## Two Crawlers: Crawl4AI vs Playwright BFS

These are two completely separate crawlers that serve different purposes. They do not share code or logic.

### Crawl4AI (Discovery Service)

| Aspect | Detail |
|--------|--------|
| **Location** | `discovery-service/crawler.py` (Python), `src/stages/domDiscovery.ts` (TypeScript client) |
| **Language** | Python 3.11+ |
| **Libraries** | Crawl4AI (primary), httpx + BeautifulSoup (fallback) |
| **Purpose** | Single-page DOM extraction for discovery — converts one URL into structured element data |
| **Scope** | One URL per request, no traversal |
| **BFS logic** | None — crawls only the requested URL |
| **Rendering** | Full headless Chromium via Crawl4AI's built-in browser |
| **Output** | Structured elements (forms, buttons, links, nav, tables, images, accessibility), page markdown, `needsVision` flag |
| **Fallback chain** | Crawl4AI -> httpx plain HTTP GET -> BeautifulSoup parse |
| **Caching** | Disk cache in `.discovery-cache/`, SHA256-keyed |
| **When to use** | Standard HTML pages with forms/buttons/links; server-rendered sites; reducing LLM token usage |
| **When NOT to use** | Canvas/image-heavy pages (needs vision anyway); quick one-offs where fallback is fine; if Python setup is a hassle |
| **Service** | FastAPI on port 8000 (`/crawl`, `/health`), auto-started by `domDiscovery.ts` if not running |
| **Total size** | ~1,023 lines across 3 files |

### Playwright BFS Crawler

| Aspect | Detail |
|--------|--------|
| **Location** | `src/stages/crawler.ts` |
| **Language** | TypeScript |
| **Libraries** | Playwright (Chromium), `modelFromAria` from `discovery.ts` for on-demand labeling |
| **Purpose** | Full-site breadth-first traversal — maps an entire site for `mode: "crawl"` |
| **Scope** | Entry URL + all reachable pages up to `maxPages` and `maxDepth` |
| **BFS logic** | Queue-based BFS with visited set, depth tracking, and deduplication |
| **Rendering** | Playwright Chromium |
| **Output** | `SiteGraph` — list of pages with titles, raw ARIA snapshots, outbound links, optional AppModel per page |
| **Labeling** | Lazy — `labelPage()` calls `modelFromAria()` on demand with LLM cache deduplication |
| **When to use** | Full-site crawl mode (`--crawl` flag); testing entire site navigation; site mapping |
| **Total size** | ~162 lines (single file, no service) |

### Which to Use

```
Is this a standard HTML page with forms/buttons/links?
  YES -> Use Crawl4AI discovery (default, auto-tried first)
  NO  -> Does it need vision (canvas, captcha, image-heavy)?
          YES -> Vision fallback (auto-selected by hybridDiscovery)
          NO  -> Still use Crawl4AI (it falls back to httpx + BeautifulSoup)

Do you need to crawl the entire site (multiple pages)?
  YES -> Use --crawl flag (Playwright BFS)
  NO  -> Single-page discovery (Crawl4AI or vision fallback)
```

---

## Discovery Fallback Chain

The hybrid discovery orchestrator (`hybridDiscovery.ts`) tries these in order:

```
1. AppModel cache hit?  -> Return immediately (zero cost)
     |
2. Crawl4AI DOM path    -> POST to localhost:8000/crawl (auto-starts service if needed)
     |                      + Gemini concept labeling (text-only, no screenshot)
     |                      = Fast, deterministic structure, ~1 Gemini call
     |
3. If DOM returns null   -> Gemini Vision fallback
   (service down,          = Playwright ARIA snapshot + JPEG screenshot
    error, timeout)          + Gemini with image input
                           = Slow, token-heavy, but works for everything
```

The `needsVisionFallback()` flag is set by the Python crawler when it detects canvas, embed/object, image-heavy pages, or CAPTCHA text. In that case, the DOM result is still used for structure, but vision is also consulted — the `discoveryMethod` becomes `"hybrid"`.

---

## Source Files

### `src/stages/` — Pipeline Stages (18 files, ~3,925 lines)

| File | Lines | LLM? | Purpose |
|------|------:|:-----:|---------|
| `hybridDiscovery.ts` | 260 | Gemini (text) | Discovery orchestrator: Crawl4AI first, vision fallback |
| `domDiscovery.ts` | 652 | No | Crawl4AI service client + auto-start logic + response conversion |
| `discovery.ts` | 399 | Gemini (vision) | Playwright + ARIA snapshot + screenshot -> AppModel |
| `crawler.ts` | 162 | No | BFS site crawler for full-site crawl mode |
| `crawlDirective.ts` | 18 | No | Maps Plan -> CrawlDirective schema |
| `planner.ts` | 72 | Gemini | NL request -> structured Plan |
| `testCases.ts` | 235 | Gemini | Coverage suite + reactive generation |
| `ir.ts` | 379 | Groq | TestCase -> IR with grounding + truncation |
| `liveExtend.ts` | 130 | No | Browser replay to discover new pages |
| `targetResolver.ts` | 206 | No | IR Target -> Playwright Locator with fallbacks |
| `generator.ts` | 295 | No | IR -> Playwright spec (pure code) |
| `executor.ts` | 199 | No | Runs spec, captures artifacts |
| `classify.ts` | 147 | No | Deterministic failure classifier |
| `failureAnalysis.ts` | 167 | Gemini + Vision | Failure diagnosis (fallback only) |
| `failure/ruleAnalysis.ts` | 72 | No | Rule-based failure pre-filter |
| `suiteRunner.ts` | 225 | No | Runs all cases, per-case artifacts |
| `authSettle.ts` | 44 | No | Post-auth SPA redirect handling |
| `credentials.ts` | 69 | No | Demo site credential substitution |

### `src/schema/` — Data Contracts (4 files, ~320 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `appModel.ts` | 230 | Element, PageModel, AppModel + DOM-structured types + `toLiteModel` |
| `ir.ts` | 56 | Target, Step (action/assertion enums), IR with truncation tracking |
| `siteGraph.ts` | 20 | SiteGraph, SiteGraphPage — crawl output structure |
| `crawlDirective.ts` | 14 | CrawlDirective — entry URL, scope limits, intent hints |

### `src/` Core (4 files, ~630 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `orchestrator.ts` | 343 | Pipeline wiring: plan -> discovery -> test cases -> IR -> generate -> execute -> heal -> suite |
| `runStore.ts` | 183 | File-backed per-run NDJSON event log with SSE replay + fallback reconstruction |
| `cli.ts` | 41 | CLI entry point: parses flags, calls `runPipeline` |
| `config.ts` | 63 | Centralized timeouts, retries, Playwright settings, selector fixes |

### `src/llm/` — LLM Layer (6 files, ~314 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `gemini.ts` | 54 | Google Gemini client (REST API, key-pool rotation, backoff) |
| `groq.ts` | 40 | Groq/Llama client (OpenAI-compatible REST API, key-pool rotation, backoff) |
| `keyPool.ts` | 39 | Round-robin API key pool with cooldown tracking |
| `backoff.ts` | 72 | Exponential backoff with rate-limit detection + key rotation |
| `json.ts` | 9 | Strip markdown fences and parse JSON from LLM output |
| `embeddings.ts` | 107 | Gemini text-embedding client with LRU + disk cache + cosine similarity |

### `src/kb/` — Knowledge Base (4 files, ~267 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `cache.ts` | 19 | SHA1-keyed file-based AppModel cache |
| `llmCache.ts` | 42 | Two-tier LLM response cache (in-memory LRU + disk, 30-min TTL) |
| `testStrategy.ts` | 156 | Static QA knowledge: coverage taxonomy, scope classification, filtering |
| `siteOutline.ts` | 50 | Depth-first SiteGraph text outline for LLM context injection |

### `src/server/` — Web Server (3 files, ~173 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `index.ts` | 77 | Express: `/api/runs` CRUD, SSE stream, polling, static files |
| `runRegistry.ts` | 37 | SSE fan-out: broadcasts events, replays history on connect |
| `concurrency.ts` | 59 | In-process semaphore: caps concurrent runs, queues overflow |

### `discovery-service/` — Python Service (3 files, ~1,023 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `app.py` | 67 | FastAPI: `/crawl` and `/health` endpoints |
| `crawler.py` | 771 | Crawl4AI crawler + httpx/BeautifulSoup fallback + disk cache |
| `schemas.py` | 185 | Pydantic models for all API types |

### `public/` — Frontend (3 files, ~1,098 lines)

| File | Lines | Purpose |
|------|------:|---------|
| `app.js` | 735 | Single-page app: run form, phase UI, suite cards, history |
| `style.css` | 299 | Dark theme, responsive design |
| `index.html` | 64 | Minimal HTML shell |

---

## Schema Contracts

### AppModel (the discovery output)

```
AppModel
  pages: PageModel[]
    url, title, discoveryMethod: "dom" | "vision" | "hybrid"
    elements: Element[]
      role: "link" | "button" | "textbox" | "checkbox" | "radio" | ...
      name: string
      selector: string (CSS)
      details: string (optional — placeholder, href, etc.)
```

This is the shared language between discovery, planning, test-case generation, IR grounding, and target resolution. Every stage reads or writes AppModels.

### IR (the execution contract)

```
IR
  meta: { truncated: boolean, ... }
  steps: Step[]
    action: "click" | "fill" | "press" | "select" | "navigate" | "assert_text" | ...
    target: { selector: string, role?: string, name?: string, fallbacks?: string[] }
    value?: string
    assertion?: { kind: "text_present" | "url_contains" | "visible" | "value_is", expected: string }
    screenshot?: string (step filename)
    grounded?: boolean
    needsLiveExtend?: boolean
```

The Generator reads this contract and emits Playwright code. The Executor runs it. Failure analysis inspects it step-by-step.

### SiteGraph (the crawl output)

```
SiteGraph
  pages: SiteGraphPage[]
    url, title
    rawAriaSnapshot: string
    outboundLinks: string[]
    appModel?: AppModel (lazily populated)
```

---

## LLM Integration

| Stage | Model | Input | Output | When Used |
|-------|-------|-------|--------|-----------|
| Planner | Gemini (`gemini-2.5-flash`) | Prompt + URL | Plan (steps, scope, coverage) | Every run, 1 call |
| Concept labeling | Gemini (`gemini-2.5-flash`) | DOM element list + markdown | Labeled AppModel | DOM discovery path, 1 call per page |
| Vision discovery | Gemini (`gemini-2.5-flash`) | ARIA snapshot + JPEG screenshot | AppModel | Fallback only, 1 call per page |
| Test cases | Gemini (`gemini-2.5-flash`) | Plan + AppModel + strategy | TestCase[] | Every run, 1 call |
| IR generation | Groq (`llama-3.3-70b-versatile`) | TestCase + AppModel + site outline | IR (JSON) | Every run, 1 call per case |
| Failure analysis | Gemini (`gemini-2.5-flash`) | Error + ARIA + screenshots | Diagnosis | Only on failure, 0-1 calls |
| Embeddings | Gemini (`text-embedding-004`) | Element role+name | Vector (768d) | Optional semantic matching |

**Key rotation:** Both Gemini and Groq clients use `keyPool.ts` for round-robin key selection with cooldown. `backoff.ts` handles rate-limit detection, exponential delay, and key penalization (up to 6 attempts).

**Caching:** `llmCache.ts` provides a two-tier cache (in-memory LRU + disk persistence, 30-min TTL) keyed by SHA1 of concatenated inputs. Avoids duplicate LLM calls for identical prompts across runs.

---

## Frontend & Server

### Server Architecture

```
Express (port 3000)
  POST /api/runs              -> starts pipeline (via concurrency semaphore)
  GET  /api/runs/:id/state    -> polling endpoint (for Cloudflare tunnels)
  GET  /api/runs/:id/events   -> SSE event stream (for localhost)
  DELETE /api/runs/:id        -> remove run
  GET  /api/history           -> list all runs (newest first)
  /                           -> static files (public/)
```

### Frontend Architecture

Single-page HTML/JS/CSS app (`public/`):
- **Run form:** prompt, URL, coverage dropdown, crawl toggle
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
| **Two separate crawlers** | Crawl4AI (Python) is fast and DOM-deterministic for single-page discovery. Playwright BFS (TypeScript) handles full-site traversal. They solve different problems and don't share code. |
| **DOM-first discovery** | Crawl4AI extracts structured elements without LLM tokens. Vision is expensive and slow — used only when DOM fails or for canvas/captcha pages. |
| **Deterministic failure classifier** | Pattern-matching on Playwright error text is free and instant. Gemini vision diagnosis is used only for ambiguous cases. |
| **Bounded self-heal** | `MAX_EXTENSIONS = 2` page hops, 1 heal attempt per test case. Prevents infinite loops and runaway LLM usage. |
| **Truncation as fallback** | A partial real test is better than a hard failure. IR truncation + `truncated_no_assertion` terminal guard ensures execution always happens. |
| **Intent-aware credentials** | "Invalid password" test cases get their literal values preserved, while normal flows get credential substitution for demo sites. |
| **LLM caching everywhere** | Same prompt -> same response. File + memory cache with 30-min TTL deduplicates across runs and stages. |
| **Key rotation with cooldown** | Multiple API keys with round-robin selection and rate-limit cooldown prevents single-key exhaustion. |
| **SSE + polling dual mode** | SSE for localhost (real-time), polling for Cloudflare tunnels (which buffer SSE). |
| **Auto-start discovery service** | `domDiscovery.ts` spawns the Python service if not running, removing a manual step. |

---

## Current Gaps

| Gap | Impact | Status |
|-----|--------|--------|
| No server authentication | Anyone with the URL can start runs and browse artifacts | Documented in ENTERPRISE.md |
| Credential substitution on demo hosts | "Invalid password" cases still get overwritten on saucedemo/herokuapp | Intent-awareness works but has edge cases |
| No end-to-end self-heal test | Self-heal is verified in code but not against a real drifted site | Pending manual verification |
| No multi-user isolation | Single-process, no per-user runs or quotas | Documented in ENTERPRISE.md |
| Playwright generator is pure code | No LLM used for spec generation (intentional) | Feature, not a gap |
| Assertion quality | Prompt-nudged, not code-level validated | Known limitation |
| Cloudflare tunnel buffering | SSE events delayed; UI uses polling as workaround | Works, not a blocker |

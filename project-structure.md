## Project Structure
```text
.
├── ARCHITECTURE.md                 # Technical reference: crawlers, files, design decisions
├── ENTERPRISE.md                   # Scaling roadmap (documented, not built)
├── PROGRESS.md                     # Development timeline + verification status
├── PROJECT_OVERVIEW.md             # Full architecture narrative + design decisions
├── README.md                       # Run-it documentation
├── UPDATE.md                       # Detailed changelog for recent phases
├── package.json
├── package-lock.json
├── playwright.config.ts            # Chromium headless, screenshots on, traces on failure
├── tsconfig.json
├── .env                            # API keys (not committed)
├── .env.example                    # Template with placeholder values
│
├── discovery-service/              # Python Crawl4AI discovery service
│   ├── app.py                      # FastAPI server: /crawl, /health endpoints
│   ├── crawler.py                  # Crawl4AI + httpx/BeautifulSoup fallback crawler
│   ├── schemas.py                  # Pydantic models for API request/response
│   ├── requirements.txt            # Python dependencies
│   └── test_parse.py               # Parser tests
│
├── public/                         # Frontend (single-page HTML/JS/CSS)
│   ├── index.html                  # Minimal HTML shell
│   ├── app.js                      # Phase UI, run form, suite cards, history
│   └── style.css                   # Dark theme, responsive design
│
├── src/
│   ├── cli.ts                      # CLI entry point (--prompt, --url, --crawl)
│   ├── config.ts                   # Centralized timeouts, retries, selector fixes
│   ├── orchestrator.ts             # Pipeline wiring + self-heal orchestration
│   ├── runStore.ts                 # File-backed NDJSON event log + SSE replay
│   │
│   ├── stages/                     # Pipeline stages (18 files)
│   │   ├── authSettle.ts           # Post-login SPA redirect handling
│   │   ├── classify.ts             # Deterministic failure classifier (no AI)
│   │   ├── crawler.ts              # BFS site crawler for full-site crawl mode
│   │   ├── crawlDirective.ts       # Maps Plan -> CrawlDirective schema
│   │   ├── credentials.ts          # Demo site credential substitution
│   │   ├── discovery.ts            # Playwright + Gemini vision discovery
│   │   ├── domDiscovery.ts         # Crawl4AI service client + auto-start
│   │   ├── executor.ts             # Runs spec, captures artifacts
│   │   ├── failureAnalysis.ts      # Gemini vision failure diagnosis (fallback)
│   │   ├── generator.ts            # IR -> Playwright spec (pure code, no LLM)
│   │   ├── hybridDiscovery.ts      # Discovery orchestrator (DOM-first, vision-fallback)
│   │   ├── ir.ts                   # IR generation + grounding + truncation
│   │   ├── liveExtend.ts           # Browser replay to discover new pages
│   │   ├── planner.ts              # NL request -> structured Plan
│   │   ├── suiteRunner.ts          # Executes all cases, per-case artifacts
│   │   ├── targetResolver.ts       # IR Target -> Playwright Locator with fallbacks
│   │   ├── testCases.ts            # Coverage suite + reactive generation
│   │   └── failure/
│   │       └── ruleAnalysis.ts     # Rule-based failure pre-filter
│   │
│   ├── schema/                     # Zod data contracts
│   │   ├── appModel.ts             # Element, PageModel, AppModel + DOM types
│   │   ├── crawlDirective.ts       # CrawlDirective (entryUrl, scope, intent)
│   │   ├── ir.ts                   # Target, Step, IR with truncation tracking
│   │   └── siteGraph.ts            # SiteGraph, SiteGraphPage (crawl output)
│   │
│   ├── llm/                        # LLM integration with key rotation
│   │   ├── backoff.ts              # Exponential backoff + rate-limit detection
│   │   ├── embeddings.ts           # Gemini text-embedding + disk cache + cosine similarity
│   │   ├── gemini.ts               # Google Gemini client (REST API)
│   │   ├── groq.ts                 # Groq/Llama client (OpenAI-compatible API)
│   │   ├── json.ts                 # Strip markdown fences, parse JSON
│   │   └── keyPool.ts             # Round-robin API key pool with cooldown
│   │
│   ├── kb/                         # Knowledge base + caching
│   │   ├── cache.ts                # SHA1-keyed AppModel file cache
│   │   ├── llmCache.ts             # Two-tier LLM response cache (memory + disk, 30m TTL)
│   │   ├── siteOutline.ts          # Depth-first SiteGraph text outline for LLM context
│   │   └── testStrategy.ts         # QA coverage taxonomy + scope filtering
│   │
│   └── server/                     # Express HTTP server
│       ├── concurrency.ts          # In-process semaphore (max concurrent runs)
│       ├── index.ts                # Routes: /api/runs, SSE, polling, static files
│       └── runRegistry.ts          # SSE fan-out + history replay
│
├── runs/                           # Runtime artifacts (gitignored)
│   └── _cache/                     # AppModel + LLM response caches
│
├── garvit.md                       # SPA fixes, interactive elements, network idle changes
└── project-structure.md            # This file

46 directories, 74 files
```

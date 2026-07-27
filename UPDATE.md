# Update Log

## Phases 2a–2d: Full-Site Crawl Pipeline

### Date
July 26, 2026

### Summary
Split the crawler into a pure traversal pass (no LLM) and a lazy labeling step, added a site outline helper, wired optional site-outline context into the labeling prompt, and hooked everything into the orchestrator as an opt-in `mode: "crawl"` flag.

---

### Phase 2a — Crawler Split & Schema Update

**`src/schema/siteGraph.ts`**
- Added required `raw: { title: string; ariaSnapshot: string }` field to `SiteGraphPage`
- Made `appModel` optional (`z.optional()`) — no longer set during crawl

**`src/stages/crawler.ts`**
- `crawlSite()` no longer calls `modelFromAria()` or `gemini()` — navigates, captures raw signal (title + aria snapshot), extracts outbound links, returns `SiteGraph`
- Dead/error pages record empty `raw` instead of a placeholder `appModel`
- Added `labelPage(crawledPage, url, siteOutline?)` — lazily calls `modelFromAria()` on demand using stored raw data, respects existing cache (`cacheGet`/`cacheSet`)

**`src/scripts/test-crawler.ts`**
- Added optional chaining on `page.appModel?.pages` (2 lines) to handle now-optional field

---

### Phase 2b — Site Outline Helper

**`src/kb/siteOutline.ts` (new file)**
- Pure function `buildSiteOutline(graph: SiteGraph): string`
- Depth-first tree rooted at `entryUrl`, labels from `raw.title`, edges from `outboundTargets`
- Deduplicates visited nodes, caps output at 40 lines
- Appends truncation notice when `truncatedByScope` is true
- Zero I/O, zero LLM calls

---

### Phase 2c — Outline as Labeling Context

**`src/stages/discovery.ts`**
- `modelFromAria()` gains optional 5th parameter `siteOutline?: string`
- When provided, injects a site-map context block into the user prompt with the instruction: "Use this only to interpret ambiguous links/labels — never to invent elements not in the snapshot below"
- When omitted, prompt is byte-identical to before

**`src/stages/crawler.ts`**
- `labelPage()` gains optional `siteOutline?: string`, passes it through to `modelFromAria()`

---

### Phase 2d — Pipeline Wiring (Opt-In)

**`src/orchestrator.ts`**
- `runPipeline()` options gain `mode?: "crawl"` (defaults to `undefined`)
- When `mode === "crawl"`: runs `crawlSite()` → `buildSiteOutline()` → `labelPage()` for the entry page only, saving `02-sitegraph.json` and `02-siteoutline.txt` as artifacts
- Non-crawl runs hit the exact same `discover()`/`discoverPages()` path as before
- Crawl mode runs inside the existing `"discovery"` step wrapper — event shape unchanged

**`src/server/index.ts`**
- Extracts `mode` from `req.body`, validates it (only `"crawl"` or omitted), threads to `runPipeline`

**`src/cli.ts`**
- Added `--crawl` flag via `flag()` helper, maps to `mode: "crawl"` or `undefined`

---

### Key Design Decisions

- **Opt-in only** — `mode` defaults to `undefined`, existing callers unaffected
- **No LLM in crawl pass** — `crawlSite()` is pure traversal; labeling is deferred
- **Entry page only labeled eagerly** — other crawled pages stay raw until downstream stages select them (future Phase 2e)
- **Byte-identical prompts** — without `siteOutline`, `modelFromAria()` produces the exact same prompt as before

---

### Backward Compatibility

- Existing runs (no `mode` field) are provably unaffected — no code path changes
- `SiteGraph.parse()` validates crawl output against updated schema
- `appModel` optional on `SiteGraphPage` — all existing callers that don't use it are unaffected
- All TypeScript compilation checks pass (`npx tsc --noEmit`)

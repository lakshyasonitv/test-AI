# AI Test Platform

A pipeline that turns a natural-language testing request + a URL into **executed** Playwright tests — with a live progress UI, per-step screenshots, artifacts (trace, generated spec), per-case suite results, and plain-English failure diagnosis on failure. Discovers a site's own internal links (not just the entry page), handles multi-page flows by extending discovery on demand, and tries once to auto-repair broken locators before reporting failure.

## Quick Start

```bash
npm install                  # installs deps + playwright install chromium (postinstall)
cp .env.example .env         # fill in GEMINI_API_KEYS / GROQ_API_KEYS
npm run serve                # starts server on http://localhost:3000
```

Open the UI, enter a prompt + URL, and watch the phase panel update with live progress. A
light/dark theme toggle sits at the bottom of the sidebar — dark is the default, and the choice
is remembered across visits.

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

By default, discovery doesn't stop at the entry page: `hybridDiscovery.ts`'s `discoverSiteHybrid`
follows the entry page's own same-origin internal links (bounded by `MAX_DISCOVERY_PAGES`,
default 5) and merges every reachable page into one AppModel — so a "not satisfied, focus on
Checkout" refinement in the case-selection gate can actually ground on a page discovery already
knows about, not just the page the user happened to type a URL for. A site whose entry page has
no crawlable links (auth walls, single-page apps) behaves exactly as before: a one-page model.

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
       |_ site crawl (same-origin)     -> follows the entry page's own internal links
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Test Cases (Gemini)              -> full coverage suite (valid/invalid/boundary/security)
       \_ case-selection gate (opt.)   -> pauses for you to review/accept/reject a batch and
                                          ask for a refined regeneration, ENABLE_CASE_SELECTION_GATE
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
| Site-wide discovery | Working | Follows the entry page's own same-origin internal links (bounded, `MAX_DISCOVERY_PAGES`), not just the one page you typed |
| Full coverage suite generation | Working | Up to 5 cases per run by default (`MAX_CASES_PER_RUN`): valid path, invalid input, empty fields, boundaries, security. The checklist itself is filtered by scope before it reaches the model — a functional-only run's prompt no longer lists security items it was just told not to write |
| Case-selection gate (optional) | Working, off by default | `ENABLE_CASE_SELECTION_GATE=true` pauses a run after generating a batch so you can accept/reject cases and ask for a refined regeneration; a rejected or already-accepted title is hard-excluded from every later batch, not just prompt-discouraged |
| All suite cases executed | Working | Every selected case runs in its own Playwright `test()` / browser context, with per-case artifacts |
| Per-step screenshots | Working | Each IR step gets its own `test.step()` block and `step-N.png` screenshot; the case's representative screenshot is the LAST step, not the first, so it actually reflects what the case tested |
| Per-step pass/fail status | Working | Individual step results in Playwright JSON output, not just overall test status |
| Phase pipeline (live UI) | Working | 4 phases track aggregate status across sub-stages; no premature green/red |
| Multi-page flows (live-extend) | Working | On-demand page discovery when steps target unseen pages (capped, `MAX_LIVE_EXTENSIONS`, default 5) |
| Self-healing broken locators | Working | Re-snapshot (credential-policy-aware) + regenerate + re-run, bounded to 1 attempt, only for selector drift |
| Truncated test handling | Working | Graceful degradation: partial real test instead of hard failure |
| Terminal assertion guard | Working | Truncated tests without assertions marked as `truncated_no_assertion` |
| Auth settle-wait | Working | Bounded wait after auth-triggering steps to handle SPA redirects |
| Credential-policy substitution | Working for single-attempt cases | `credentialPolicyFor` distinguishes full / identifier-only / none per case from its own wording — a negative "invalid password" case keeps its deliberately-wrong value. A case with TWO login attempts in one browser session is a known open edge (see Known Limitations) |
| Terminal text-assertion grounding | Working | The case's final pure-text assertion is replayed against the real page and corrected if the model guessed the wording wrong. The model is also told the page's `title` field is `<title>`-tag metadata, never visible body text, so it can't ground an assertion on something that can never render |
| Grounding: guessed navigate routes rejected | Working | A `navigate` step's URL is checked against `knownNavigationTargets` (every discovered page URL + every discovered link's resolved href). A route the model invented from a feature's name — "go to the Admin section" -> `/admin` — is rejected with feedback telling it to click the control that leads there instead. Allowances: step 0's entry URL, off-origin URLs, and any path you typed in your own prompt |
| Grounding: role mismatch tolerated | Working | A target's role is matched exactly first, then against a narrow clickable group (`link`/`button`/`menuitem`/`tab`) — so an SPA sidebar item built as `<button onClick=...>` still grounds when the IR guessed `link`. The real role is written back onto the target so the generated `getByRole` matches the live DOM. Deliberately not applied to `textbox`/`heading`/etc |
| Grounding: hidden elements can't be asserted visible | Working | An element discovery recorded as not visible is refused as the target of a `visible` assertion (a responsive/mobile-only control can't pass one). Asserting the same element `hidden` stays legal — that direction is load-bearing elsewhere |
| Discovery visibility accuracy | Working | Every element carrying a stable selector is re-checked for real computed visibility (geometry + `getComputedStyle`) in the live page, overwriting the `visible: true` that the static HTML parser has to assume |
| Credentials typed into the prompt | Working | `extractCredentialsFromPrompt` pulls a real username/password straight out of the prompt text (`email: a@b.c and password is "..."`), so a prompt that already carries credentials doesn't fall back to a model-invented placeholder. Treated as `secret` — same env-reference path as credentials typed into the UI. Picks the earliest keyword occurrence in the prompt regardless of which mention is quoted — a prompt naming a second, unrelated email later (e.g. for a "create user" step) no longer overrides the real login identifier |
| IR completeness check | Working | `missingActions` compares the case's own action-bearing step lines against what the IR actually carries out (`click`/`press`/`fill`/`select`/`check`) and rejects an IR that stops early — an IR covering 2 of a case's 5 named actions no longer ships as a silent "passed" |
| Secrets kept off disk | Working | User-supplied credentials become `${env:...}` references in the generated spec; the real value only reaches the test process's environment at execution time. Also scrubbed from `results.json`, `final-page.txt`, and error-context attachments — a page you're logged into routinely echoes the identifier back |
| Multi-hop flows don't starve the attempt budget | Working | A live-extend hop re-grounds the same parsed IR without spending one of `MAX_IR_ATTEMPTS` — a flow needing several hops to reach the right page state no longer burns its whole LLM budget getting there |
| Scope filtering | Working | Prompt can request smoke/functional/regression/security scope |
| Suite result display | Working | Per-case cards with status, screenshots, download links for spec/IR/result |
| Light/dark theme | Working | Toggle in the sidebar, persisted in `localStorage`; dark is the default |
| Run history | Working | Newest 20 runs persisted, each deletable, with suite summary. A run whose server process was killed mid-flight (restart, crash) closes itself out with a clear error instead of polling forever |
| Deterministic failure classifier | Working | Pattern-matches Playwright errors before spending a Gemini call. Distinguishes a genuinely-missing element (`resolved to 0 elements`) from one that was found but never reached the expected state — the two used to be misclassified as the same thing |
| DOM-first discovery | Working | Node/cheerio extraction, vision-fallback, zero LLM tokens on the common path. No duplicate elements when a tag carries both a semantic HTML role and an explicit `role` attribute |
| LLM response caching | Working | File + in-memory cache for repeated prompts, 30-min TTL |

### What Partially Works

| Capability | Status | Known Issue |
|-----------|--------|-------------|
| Self-healing | Code verified | No end-to-end test against a real drifted site yet |
| A case that logs in for real, then tries a second (wrong-credential) login attempt in the same case | Fragile | Substitution only guarantees the case's FINAL credential attempt gets the real value; if the model doesn't order the real attempt last, the wrong leg gets it. Most sites also redirect an already-authenticated session away from the login page, so "return to the login page" for a second attempt can find no form there at all. Diagnosed, not yet fixed — see `PROJECT_SUMMARY.md` |
| Wording drift between your prompt and the generated case | Improved, not guaranteed | The case-generation step can reword "click on Admin" into "Navigate to the Admin section", and can drop explicit waits you asked for. The IR stage no longer acts on the misleading wording (a guessed route is now rejected deterministically), but the case text itself is still LLM-authored prose |
| A vague "the whole header/nav is visible" case | Guarded, not eliminated | Elements with a stable selector now carry real computed visibility, and a hidden one can't be asserted visible. An element with no selector at all still falls back to the static parser's assumed `visible: true` |
| Filling fields inside a dynamic in-page modal (e.g. a "Raise a Ticket" popup) | Fails | Mechanism pinned: `liveExtend.ts`'s live re-snapshot only runs when `groundingError` reports a MISS, and a hallucinated field name can coincidentally match a real chrome element elsewhere on the same page (search box, status badge) — grounding then falsely "succeeds" and the modal is never captured. Reproduced against a real run, no code fix yet — see `PROBLEM_ANALYSIS.md` |

### Known Limitations

| Issue | Impact |
|-------|--------|
| No server authentication | Anyone with the URL can start runs and browse artifacts |
| No built-in demo credentials | There is no per-site autofill list, by design (general-purpose over site-specific). Credentials are taken from your prompt when it carries them, otherwise the run pauses and asks via the UI prompt (or times out and continues without them, `CREDENTIAL_WAIT_MS`) |
| Gemini key inconsistency | Different keys from different projects can have different model access |
| `AppModel` size has no ceiling | A complex site (large data tables, deeply nested menus) can produce a 17,000+ line `AppModel`; `toLiteModel()` keeps every crawled page's full structure in one payload, so `testCases.ts`/IR generation can hit the LLM's context/payload limit (`413`) instead of degrading gracefully |
| Failure diagnosis step attribution | Confirmed against a real run: `analyzeFailure` can report a different `failingStepId` than the raw Playwright trace actually shows |
| Assertion quality | Prompt-nudged, not code-level validated, beyond the terminal-step, title-metadata, and hidden-element grounding above |
| Discovery's `visible` field is only accurate for selector-bearing elements | `domExtract.ts` is a static HTML parser (cheerio) with no CSS engine. Elements carrying a stable selector are re-checked live and corrected; an element with no `id`/`data-test`/`css` still gets the assumed `visible: true` |
| A rejected step costs an LLM retry | Every deterministic grounding rejection (guessed route, hidden element, ungrounded target) feeds a correction back and re-generates. It's bounded by `MAX_IR_ATTEMPTS`, but a case the model keeps getting wrong will exhaust the budget and ship a truncated prefix |

## Architecture

### Pipeline Stages

| Stage | File | LLM? | Description |
|-------|------|------|-------------|
| Planner | `src/stages/planner.ts` | Gemini | NL request -> structured test plan |
| Hybrid Discovery | `src/stages/hybridDiscovery.ts` | Gemini (fallback only) | DOM-first, vision-fallback orchestrator; `discoverSiteHybrid` also crawls same-origin internal links |
| DOM Discovery | `src/stages/domDiscovery.ts` | No | Drives Playwright, hands page HTML to `domExtract.ts`; `extractDomModelFromPage` snapshots an already-open page (used by live-extend and the site crawl) so an authenticated page is modeled from the real session, not a fresh session-less browser |
| DOM Extraction | `src/stages/domExtract.ts` | No | Cheerio-based structured extraction (Node port of the old Python parser) |
| Vision Discovery | `src/stages/discovery.ts` | Gemini | Accessibility snapshot + screenshot -> AppModel (fallback path) |
| Prompt Selectors | `src/stages/promptSelectors.ts` | No | Honors selectors the user wrote directly into their prompt |
| Test Cases | `src/stages/testCases.ts` | Gemini | Coverage suite (valid/invalid/boundary/security), capped by `MAX_CASES_PER_RUN` |
| Case Selection Gate | `src/stages/caseSelectionGate.ts` | Gemini (via Test Cases) | Optional human-in-the-loop review loop over batches of generated cases |
| IR Generation | `src/stages/ir.ts` | Groq | Test case -> strict JSON test model + grounding + credential-policy decision |
| Live Extend | `src/stages/liveExtend.ts` | No | Policy-aware browser replay to discover new pages + ground terminal text assertions |
| Generator | `src/stages/generator.ts` | No | IR -> Playwright spec with test.step() blocks |
| Executor | `src/stages/executor.ts` | No | Runs spec, captures screenshots/traces, redacts secrets from served artifacts |
| Failure Classifier | `src/stages/classify.ts` | No | Deterministic pattern matching on Playwright errors |
| Failure Analysis | `src/stages/failureAnalysis.ts` | Gemini + Vision | Diagnoses failures with screenshots (fallback) |
| Suite Runner | `src/stages/suiteRunner.ts` | No | Executes all cases in isolated browser contexts, per-case artifacts |
| Target Resolver | `src/stages/targetResolver.ts` | No | IR Target -> locator with fallback chain |
| Auth Settle | `src/stages/authSettle.ts` | No | Bounded wait after auth-triggering steps |
| Credentials | `src/stages/credentials.ts` | No | Per-case/per-leg substitution policy — no built-in demo-site registry |

### Shared Infrastructure

| Module | File | Description |
|--------|------|-------------|
| Orchestrator | `src/orchestrator.ts` | Wires stages, manages primary case, suite execution, self-heal, the optional case-selection gate |
| Run Store | `src/runStore.ts` | Durable per-run NDJSON event log; closes out a run orphaned by a server restart with a synthetic error instead of leaving the frontend polling forever |
| Text | `src/text.ts` | `cutAtBoundary` — line/word-boundary-safe truncation, used anywhere a prompt or captured text needs a length cap without risking a mid-word (or mid-comment) cut |
| LLM - Gemini | `src/llm/gemini.ts` | Gemini API client with key rotation |
| LLM - Groq | `src/llm/groq.ts` | Groq API client with key rotation |
| Groq Budget | `src/llm/groqBudget.ts` | Per-run hard cap on Groq calls (`MAX_GROQ_CALLS_PER_RUN`), usage recorded to `08-groq-usage.json` |
| Key Pool | `src/llm/keyPool.ts` | API key rotation + 429 handling |
| Backoff | `src/llm/backoff.ts` | Exponential backoff + per-attempt timeout (`LLM_TIMEOUT_MS`) for retries |
| JSON Parse | `src/llm/json.ts` | Robust JSON extraction from LLM output |
| App Model Cache | `src/kb/cache.ts` | Per-URL AppModel cache |
| LLM Cache | `src/kb/llmCache.ts` | LLM response cache (in-memory + disk; in-memory half honors a 30-min TTL, the disk half does not expire) |
| Test Strategy | `src/kb/testStrategy.ts` | Coverage taxonomy (floor, not ceiling), scope classification/filtering |

### Schemas

| Schema | File | Description |
|--------|------|-------------|
| AppModel | `src/schema/appModel.ts` | Elements by accessibility role + name |
| IR | `src/schema/ir.ts` | Step, Target, Assertion — the contract |
| Case Selection | `src/schema/caseSelection.ts` | The gate's decision payload + on-disk accepted-cases/history file shapes |

### Server

| Module | File | Description |
|--------|------|-------------|
| Routes | `src/server/index.ts` | Express server, run CRUD, credential-prompt endpoint, case-selection endpoints, API endpoints |
| Run Registry | `src/server/runRegistry.ts` | SSE fan-out for live progress |
| Concurrency | `src/server/concurrency.ts` | Run cap enforcement |
| Pending Credentials | `src/server/pendingCredentials.ts` | Parks a paused run's credential prompt in memory (never written to disk); resolved by the UI's answer or a timeout (`CREDENTIAL_WAIT_MS`) |
| Pending Case Selection | `src/server/pendingCaseSelection.ts` | Parks a paused run's case-review round in memory; resolved by the UI's decision or a timeout (`CASE_SELECTION_WAIT_MS`) |
| Case Accumulator | `src/server/caseAccumulator.ts` | File-backed pool of accepted cases across gate rounds, capped at `MAX_ACCUMULATED_CASES` |
| Case History Ledger | `src/server/caseHistoryLedger.ts` | File-backed record of every case ever shown and what you did with it, so a rejected title never resurfaces |

### Frontend

| File | Description |
|------|-------------|
| `public/index.html` | Single-page HTML with phase pipeline, form, results, case-selection panel |
| `public/app.js` | Event processing, polling, phase tracking, suite rendering, theme toggle, case-selection panel |
| `public/preview.js` | Static preview/demo states, used for UI development |
| `public/icons.js` | Inline SVG icon set |
| `public/style.css` | Dark theme (default) + a light theme override, responsive design, phase badges, case cards, download buttons |

## Project Structure

```
ai-test-platform/
  src/
    stages/              # Pipeline stages (18 files, ~5,903 lines)
      hybridDiscovery.ts # Discovery orchestrator (DOM-first, vision-fallback, site crawl)
      domDiscovery.ts    # Drives Playwright, hands page HTML to domExtract.ts
      domExtract.ts      # Cheerio DOM extraction (Node port of the old Python parser, 613 lines)
      discovery.ts       # Playwright + Gemini vision discovery (fallback path)
      promptSelectors.ts # Honors selectors the user wrote directly into their prompt
      planner.ts         # NL request -> structured plan
      testCases.ts       # Coverage suite generation, capped by MAX_CASES_PER_RUN
      caseSelectionGate.ts # Optional human-in-the-loop review loop over generated case batches
      ir.ts              # IR generation: grounding, credential policy, live-extend, truncation
      liveExtend.ts      # Policy-aware browser replay: new pages + terminal-assertion grounding
      targetResolver.ts  # IR Target -> locator with fallback chain
      generator.ts       # IR -> Playwright spec (pure code, zero LLM)
      executor.ts        # Runs spec, captures artifacts, redacts secrets from served output
      classify.ts        # Deterministic failure classifier (zero LLM)
      failureAnalysis.ts # Gemini vision failure diagnosis (fallback)
      suiteRunner.ts      # Executes all cases in isolated browser contexts
      authSettle.ts       # Bounded wait after auth-triggering steps
      credentials.ts      # Per-case/per-leg substitution policy — no demo-site registry
    schema/              # Zod contracts (3 files: AppModel, IR, Case Selection)
    llm/                 # LLM layer with key rotation + budget (6 files)
    kb/                  # Knowledge base + caching (3 files)
    server/              # Express server + SSE + pause/resume gates (7 files)
    orchestrator.ts      # Pipeline wiring + self-heal + optional case-selection gate
    runStore.ts          # Durable event log
    text.ts              # cutAtBoundary — boundary-safe text truncation
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
| `GEMINI_API_KEYS` | Yes | Comma-separated Gemini API keys (quota stacks across distinct projects). `GEMINI_API_KEY` (singular) is accepted as a fallback if the plural var isn't set — convenient for a single-key deploy |
| `GROQ_API_KEYS` | Yes | Comma-separated Groq API keys (failover only — Groq limits are per-org, not per-key). `GROQ_API_KEY` (singular) is accepted as a fallback the same way |
| `GEMINI_MODEL` | No | Gemini model for discovery/test-cases/failure-analysis (default: `gemini-3-flash-preview`) |
| `GEMINI_MODEL_LITE` | No | Gemini model for labeling (default: `gemini-3.1-flash-lite`) |
| `GROQ_MODEL` | No | Groq model for IR generation (default: `openai/gpt-oss-120b`) |
| `LLM_TIMEOUT_MS` | No | Per-attempt abort timeout for any Gemini/Groq call (default: 45000) |
| `MAX_GROQ_CALLS_PER_RUN` | No | Hard cap on total Groq calls per run, recorded to `08-groq-usage.json` (default: 60) |
| `MAX_IR_ATTEMPTS` | No | Max IR generate/validate retries per test case (default: 4) |
| `MAX_LIVE_EXTENSIONS` | No | Max browser replays per case to discover pages behind a login/click (default: 5) |
| `MAX_DISCOVERY_PAGES` | No | Max pages a single site crawl may collect (entry page + followed links) (default: 5) |
| `MAX_CASES_PER_RUN` | No | Hard ceiling on cases turned into runnable scripts (default: 5) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `CREDENTIAL_WAIT_MS` | No | How long a paused run waits for you to supply credentials before continuing without them (default: 300000 / 5 min) |
| `ENABLE_CASE_SELECTION_GATE` | No | Set `true` to pause a run after generating each batch of cases for your review (default: off) |
| `MAX_CASE_REGEN_ATTEMPTS` | No | "Not satisfied" regeneration rounds allowed before the gate runs with whatever's accepted (default: 3) |
| `MAX_ACCUMULATED_CASES` | No | Cap on cases accepted into the gate's pool across all rounds (default: 5) |
| `CASE_SELECTION_WAIT_MS` | No | How long a gate round waits for your pick before timing out as "done" (default: 600000 / 10 min) |
| `SCREENSHOT_SETTLE_MS` / `SCREENSHOT_MAX_SAMPLES` | No | Animation-settle detection before a screenshot (defaults: 150ms / 10 samples) |
| `PORT` | No | Web UI port (default: 3000) |

### Playwright Config

`playwright.config.ts` — Chromium headless, 50s per-test timeout, 0 retries, screenshot on every
result, trace + video retained on failure only.

### Key Constants

| Constant | Location | Default | Description |
|----------|----------|---------|-------------|
| `MAX_EXTENSIONS` | `ir.ts` (`MAX_LIVE_EXTENSIONS` env) | 5 | Max live-extend page hops per test case |
| `MAX_ATTEMPTS` | `ir.ts` (`MAX_IR_ATTEMPTS` env) | 4 | IR generate/validate retries per case |
| `MAX_DISCOVERY_PAGES` | `hybridDiscovery.ts` | 5 | Max pages collected by a single site crawl |
| `CLICKABLE_ROLE_GROUP` | `ir.ts` | link, button, menuitem, tab | Roles grounding may swap between when the exact role isn't present |
| `MAX_GENERIC_CLICKABLES` | `domDiscovery.ts` | 40 | Cap on non-semantic (`div`/`span`/`li`/`p`) clickables added per page |
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

**Security:** The server has no authentication. Anyone with the URL can start runs and browse artifacts. Fine for trusted audiences; know this before sharing widely. The entry URL itself is validated — non-`http(s)` schemes and loopback/link-local/private-range hosts are rejected (`isAllowedEntryUrl`, `stages/hybridDiscovery.ts`) — but nothing gates who can submit a run at all.

## Docker / Render Deployment

`Dockerfile` (`mcr.microsoft.com/playwright:v1.49.0-jammy` base — Node, Chromium, and Linux deps
pre-bundled), `.dockerignore`, and `render.yaml` (a Render Blueprint) are in the repo root for a
one-`docker build` or one-click Render deploy. Playwright's own npm package is pinned to an exact
version (`1.49.0`, no `^`) matching the base image's bundled browser build — a caret range here
can let `npm install` pull a newer Playwright than the image's pre-installed Chromium, which then
fails to launch. `MAX_CONCURRENT_RUNS=1` is recommended on a free-tier instance (512MB RAM) — each
run launches its own Chromium instance.

`GET /api/health` reports which critical env vars are set (name/length only, never the value) —
useful for confirming a deploy's secrets actually landed without exposing them.

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical reference: every file explained, schema contracts, design decisions, current gaps
- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) — Concise project statement, detailed architecture diagram, what works, next steps toward enterprise readiness
- [SESSION_SUMMARY.md](SESSION_SUMMARY.md) — What changed in the most recent working session, in detail
- [TECH_DEBT.md](TECH_DEBT.md) — Audited defects, dead code, and prompt hygiene, with evidence and fix status

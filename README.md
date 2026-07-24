# AI Test Platform

A pipeline that turns a natural-language testing request + a URL into an **executed** Playwright test — with a live progress UI, artifacts (screenshot, trace, generated spec), and a plain-English failure diagnosis on failure. Handles multi-page flows ("log in and buy something") by discovering pages it hasn't seen yet, on demand, instead of failing outright when a step targets a page discovery never visited. On a failure that looks like a broken locator rather than a real app bug, it tries once, automatically, to repair and re-run before giving up.

See [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the full architecture write-up, every design decision and why it was made, an honest list of what's solid vs. still a known gap, and — importantly — **exactly what testing this can currently do** (only one generated test case runs per request; read § 4 there before trusting a result). This file is the practical "how do I run it" doc.

```
prompt + url
  → Planner (LLM)                    → high-level plan
  → Discovery (LLM + browser, vision)→ app model: elements as accessibility role + name (entry page only)
  → Structured Test Cases (LLM)      → a full coverage suite (valid/invalid/boundary/security);
                                        one case tagged fromPrompt:true = the literal ask
  → Primary-case selection           → fromPrompt case, else highest priority — the ONE case that runs
  → IR generation (LLM) + grounding  → strict JSON test model (THE CONTRACT)
       ↳ live-extend (browser, on demand) → reaches + models pages beyond the entry page
       ↳ truncation (fallback)            → a real, partial test instead of a hard failure
  → Reactive coverage generation     → generate cases for newly-discovered pages (if any)
  → Playwright Generator (no AI)     → *.spec.ts (with a deterministic locator-fallback helper)
  → Execution Engine (no AI)         → run + collect artifacts (screenshot, trace)
  → Failure Analysis (LLM, vision)   → diagnosis (only if it failed)
       ↳ Bounded self-heal (≤1×)          → re-snapshot + regenerate + re-run once, only for a
                                             broken-locator-shaped diagnosis, never a real app bug
```

## Setup

```bash
npm install
cp .env.example .env   # fill in GEMINI_API_KEYS / GROQ_API_KEYS
```

`postinstall` runs `playwright install chromium` automatically.

## Run it

**CLI:**

```bash
npm run generate -- --prompt "Test login with an invalid password" --url "https://the-internet.herokuapp.com/login"
```

**Web UI:**

```bash
npm run serve
```

Open `http://localhost:3000`, enter a prompt + URL, and watch the phase panel update (pending → running → done/failed) with a one-line plain-English summary per phase (the raw JSON is still there, collapsed behind "Technical details"), ending in a pass/fail/partial/healed banner, a "what we tested" checklist with the expected outcome, a labeled final-state screenshot, and — on failure — the diagnosis text. Run history keeps the newest 20 and each has a delete button.

Both modes write everything under `runs/<id>/`: every stage's JSON output (`NN-stage.json`, including the **full generated test suite** in `03-cases.json` — only one case of which actually runs, see PROJECT_OVERVIEW.md § 4), the generated `generated.spec.ts`, a real Playwright run (screenshot + trace under `artifacts/`), and — on failure — a diagnosis JSON. If a self-heal attempt succeeds, a `healed/` subfolder holds the repaired IR + spec that actually ran.

### Sharing it over the internet (Cloudflare Quick Tunnel)

To let someone outside your machine hit the running server — a demo link, testing from a phone — run a Cloudflare Quick Tunnel alongside the server. Two terminals:

```bash
# terminal 1 — the app itself
npm run serve

# terminal 2 — no Cloudflare account, login, or config file needed
cloudflared tunnel --url http://localhost:3000
```

This prints a random `https://<four-random-words>.trycloudflare.com` URL that proxies to your local server. It's ephemeral — a new URL every time you restart the tunnel — and free, with no sign-up.

**Why the UI polls instead of streaming:** Cloudflare Quick Tunnels buffer `text/event-stream` (SSE) responses sent over `GET` — the tunnel holds every event and only flushes them once the connection closes, which for a long-lived progress stream means "not until the run ends." This is a known, still-open cloudflared limitation ([cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449)), not a bug in this app — it reproduces even with the standard anti-buffering headers set. The web UI works around it by polling `GET /api/runs/:id/state` (a plain JSON snapshot of the run's event log) once a second, instead of subscribing to `GET /api/runs/:id/events` (SSE). Both routes exist; the SSE one still works fine on `localhost` and is left in place. A **named tunnel** (your own domain, `cloudflared tunnel login` + `cloudflared tunnel create`) doesn't have this buffering problem, so SSE would work there — Quick Tunnel is just the zero-setup option this project uses for demos.

**Before sharing a tunnel link:** the server has no authentication. Anyone with the URL can start a run (spends your Gemini/Groq quota) and browse every past run's screenshots/traces under `/runs`, since that's served as plain static files. Fine for a trusted audience; know that before sending it wider — see [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the full list of known gaps.

## API keys & quota — the honest model

Free-tier numbers move; check the source of truth before relying on any number here:
- `ai.google.dev/gemini-api/docs/rate-limits`
- `console.groq.com/docs/rate-limits`

- **Gemini keys stack quota only across distinct Google Cloud projects / accounts.** Four teammates each using their own key gives ~4x the free quota, legitimately. Two keys from the same project do not stack.
- **Groq enforces limits at the org level.** Extra keys in one account add no quota — list them only for failover. Do not create multiple accounts to pool quota (against Groq's ToS). If Groq throughput is the wall, upgrade that one account to the paid Developer tier.
- The `KeyPool` earns its place regardless of stacking: it gives failover and graceful 429 handling via rotation + exponential backoff.
- **Team dev pattern:** each developer runs locally with their own keys in their own `.env`. No shared secrets are committed to the repo.
- **Gotcha hit in practice:** keys from different projects can have **different model access entirely**, not just different quota. The `/v1beta/models` list endpoint isn't reliable for checking this — it advertised a model as available on a key that then 404'd on the real `generateContent` call. If a pipeline run fails at the very first LLM call (`plan`), or works intermittently as `KeyPool` rotates keys, re-verify the configured model with a real call against every key in the pool before assuming it's a code bug.

## Architecture notes

- The **Playwright Generator** (`src/stages/generator.ts`) and **Execution Engine** (`src/stages/executor.ts`) contain zero LLM calls — they are pure/deterministic, driven entirely by the IR contract (`src/schema/ir.ts`).
- Every LLM output is schema-validated with `zod`. Invalid JSON triggers one retry, then a clear thrown error.
- All LLM traffic goes through `src/llm/gemini.ts` / `src/llm/groq.ts`, which own key rotation (`keyPool.ts`) and backoff (`backoff.ts`). No other file calls an LLM endpoint directly.
- Every stage's output is persisted to `runs/<id>/NN-stage.json` so a mid-pipeline failure is debuggable.
- **Grounding is a code-level check, not just a prompt instruction.** `src/stages/ir.ts`'s `groundingError()` verifies every `{role, name}` target in the generated IR actually exists in the app model — deterministically, after generation, not by trusting the model to behave. This is the single authority; `testCases.ts` deliberately does **not** run its own grounding filter (it used to — that filter was silently killing multi-page test cases, since it only ever saw the entry-page model and couldn't distinguish "hallucinated" from "not discovered yet").
- **Multi-page flows use reactive, on-demand discovery ("live-extend"), not upfront crawling.** When a generated step targets an element the app model doesn't have, `extendAppModel()` (`src/stages/liveExtend.ts`) replays the already-grounded prefix of steps in a real browser, reaches whatever page that leads to, snapshots and labels it (reusing discovery's own `modelFromAria()`), and merges it into the model before retrying generation. Bounded to 2 extensions per test case. After primary-case execution discovers new pages, `generateCasesForNewPages()` (`src/stages/testCases.ts`) generates test cases specifically for those newly-discovered pages and merges them into the suite, tagged with `generatedFrom: "reactive"` to distinguish them from upfront-generated cases.
- **Graceful degradation over hard failure.** If a flow can't be fully grounded, `toIR` returns a real, executable test truncated to the last verified step (`meta.truncated`) instead of throwing the whole run away. Known gap: a truncated test isn't currently required to end in an assertion, so "passed" can mean "nothing threw" rather than "verified something" — see PROJECT_OVERVIEW.md.
- **Discovery uses vision, narrowly.** `discovery.ts` passes a screenshot alongside the accessibility snapshot to the same Gemini call — zero extra requests — used only to improve *labeling* of elements already in the snapshot (icon-only buttons, duplicate names). It's never a basis for adding an element the snapshot doesn't contain; the grounding invariant is unchanged.
- **The generated coverage suite (`03-cases.json`) is bigger than what executes.** `testCases.ts` produces a full suite (valid/invalid/empty/boundary/security) per the checklist in `src/kb/testStrategy.ts` — a floor, not a ceiling; the LLM also reasons from first principles about concepts the checklist doesn't cover. Exactly one case is tagged `fromPrompt: true` (the literal translation of the request); `orchestrator.ts` runs *only* that case, falling back to the highest-priority one if none was tagged. This exists because the naive "run highest priority" selection let an auto-generated SQL-injection case silently replace whatever the user actually asked to test.
- `src/stages/targetResolver.ts` is the single source of truth for turning an IR `Target` into a locator, shared by the generator (emits code) and the live-extend runner (executes live) — they can't disagree about which element a step means. A role+name target that doesn't resolve uniquely also tries the button/link role swapped, then a broad text match, before giving up (zero LLM cost). Every locator ends in `.first()` since accessible names aren't guaranteed unique and Playwright's strict mode treats a 2-match locator as a hard error.
- **A bounded, automatic self-heal** (`orchestrator.ts`) fires only when a failure is diagnosed as `selector_changed` or `element_missing`: re-snapshot the current page, regenerate the IR once against the fresh snapshot, regenerate the spec, re-run once. Capped at exactly one attempt, never a loop. A heal is only accepted if the re-run passes **and** the fresh IR isn't itself truncated — a truncated "pass" would mean the failing step got silently dropped, not repaired. `assertion_failed`/`timeout`/`navigation_error` never trigger a heal attempt — a real app bug has to stay a reported failure.
- `src/stages/credentials.ts` holds real, published test credentials for well-known **public** demo sites only (saucedemo, the-internet.herokuapp.com) — used so live-extend can actually get past a login wall. Substitution is skipped for a `fromPrompt` case (a user's own literal credentials are never overwritten), but still fires for the taxonomy's own "Invalid password" case on those two hosts — a known, open gap (see PROJECT_OVERVIEW.md). For any other site, whatever credentials the user typed into the prompt flow through as plain values; there's no secret-storage mechanism, deliberately, since `/runs` is served publicly.
- The web UI polls `GET /api/runs/:id/state` rather than streaming SSE, specifically so it survives being shared over a Cloudflare Quick Tunnel (see above). `src/runStore.ts`'s durable per-run event log backs both the SSE and the polling route.
- Discovery caches the `AppModel` per URL under `runs/_cache/appmodels/` (a proto knowledge base) so repeat runs against the same site skip re-crawling. Live-extend's discovered pages are **not** cached — they're specific to one flow, and caching them risks serving a stale/wrong-flow model to a different prompt against the same URL.

## Known limitations

See [PROJECT_OVERVIEW.md § 4 — What testing this can currently do](PROJECT_OVERVIEW.md#4-what-testing-this-can-currently-do--read-this-before-trusting-a-result) for the full, honest list, including exactly which testing scenarios are verified working, which are generated but never executed, and which are known-unreliable. Found during real development against real sites, including a friend's live site, not hypothetical. In short: only one of the several generated test cases actually runs, truncated tests can still pass without asserting anything in some cases, live-extend can race a single-page app's own auth redirect, credential substitution can still clobber one specific taxonomy case on the two demo hosts, and there's no server auth.

## Repo layout

- `src/stages/` — the pipeline: `planner.ts`, `discovery.ts` (vision), `testCases.ts` (coverage suite + `fromPrompt` tagging), `ir.ts` (+ `liveExtend.ts`, `targetResolver.ts` with deterministic fallback, `credentials.ts`), `generator.ts`, `executor.ts`, `failureAnalysis.ts`.
- `src/llm/` — the shared LLM layer: `gemini.ts`, `groq.ts`, `keyPool.ts`, `backoff.ts`, `json.ts`.
- `src/schema/` — the zod contracts: `appModel.ts`, `ir.ts`.
- `src/kb/` — the proto knowledge base: `cache.ts` (per-URL `AppModel` cache), `testStrategy.ts` (the coverage taxonomy).
- `src/server/` — the web server: `index.ts` (routes, incl. run delete), `runRegistry.ts` (SSE fan-out), `concurrency.ts` (run cap).
- `src/orchestrator.ts` — wires the stages together, picks the one case that runs, persists every stage's output, emits progress events, runs the bounded self-heal branch.
- `src/runStore.ts` — durable per-run NDJSON event log.
- `public/` — the single-page vanilla JS/CSS frontend (human-readable phase/result summaries, technical JSON behind a disclosure).
- `runs/` — created at runtime, gitignored.
- `ENTERPRISE.md` — the seam map for scaling this beyond a single-machine MVP (job queue, object storage, auth, etc.) — documented, not built, until real load demands it.
- `PROJECT_OVERVIEW.md` — the full design/architecture narrative, every design decision and why, and an honest completion status — **the single place to understand the whole project end to end.**

## Phase 2+ (not built — extension points)

- **Execute every generated test case**, not just the one tagged `fromPrompt` — the biggest gap between what this generates and what it verifies today. Reactive coverage generation now ensures cases exist for newly-discovered pages, but only the primary case runs in the main pipeline; full suite execution is still a Phase 2+ item.
- **Real/private site credentials:** an env-var + `process.env`-reference-in-generated-spec path, so a login can be tested without the credential ever touching a `runs/` artifact. `credentials.ts` is already structured for this.
- **Multi-framework export:** add `selenium.ts` / `cypress.ts` alongside `generator.ts`, consuming the same IR.
- **Real Knowledge Base:** promote the `runs/<id>/*.json` layout and the app-model cache to a queryable store.
- **Business Flow Graph / Risk Analysis / Improvement Suggestions:** new stages reading existing outputs; none require changing the spine.

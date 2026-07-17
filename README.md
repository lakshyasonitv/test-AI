# AI Test Platform

A pipeline that turns a natural-language testing request + a URL into an **executed** Playwright test — with a live progress UI, artifacts (screenshot, trace, generated spec), and a plain-English failure diagnosis on failure. Handles multi-page flows ("log in and buy something") by discovering pages it hasn't seen yet, on demand, instead of failing outright when a step targets a page discovery never visited.

See [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the full architecture write-up, every design decision and why it was made, and an honest list of what's solid vs. still a known gap. This file is the practical "how do I run it" doc.

```
prompt + url
  → Planner (LLM)                    → high-level plan
  → Discovery (LLM + browser)        → app model: elements as accessibility role + name (entry page only)
  → Structured Test Cases (LLM)      → human-readable, ordered steps
  → IR generation (LLM) + grounding  → strict JSON test model (THE CONTRACT)
       ↳ live-extend (browser, on demand) → reaches + models pages beyond the entry page
       ↳ truncation (fallback)            → a real, partial test instead of a hard failure
  → Playwright Generator (no AI)     → *.spec.ts
  → Execution Engine (no AI)         → run + collect artifacts (screenshot, trace)
  → Failure Analysis (LLM, vision)   → diagnosis (only if it failed)
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

Open `http://localhost:3000`, enter a prompt + URL, and watch the phase panel update (pending → running → done/failed), ending in a pass/fail/partial banner, the result screenshot, and — on failure — the diagnosis text.

Both modes write everything under `runs/<id>/`: every stage's JSON output (`NN-stage.json`), the generated `generated.spec.ts`, a real Playwright run (screenshot + trace under `artifacts/`), and — on failure — a diagnosis JSON.

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
- **Multi-page flows use reactive, on-demand discovery ("live-extend"), not upfront crawling.** When a generated step targets an element the app model doesn't have, `extendAppModel()` (`src/stages/liveExtend.ts`) replays the already-grounded prefix of steps in a real browser, reaches whatever page that leads to, snapshots and labels it (reusing discovery's own `modelFromAria()`), and merges it into the model before retrying generation. Bounded to 2 extensions per test case.
- **Graceful degradation over hard failure.** If a flow can't be fully grounded, `toIR` returns a real, executable test truncated to the last verified step (`meta.truncated`) instead of throwing the whole run away. Known gap: a truncated test isn't currently required to end in an assertion, so "passed" can mean "nothing threw" rather than "verified something" — see PROJECT_OVERVIEW.md.
- `src/stages/targetResolver.ts` is the single source of truth for turning an IR `Target` into a locator, shared by the generator (emits code) and the live-extend runner (executes live) — they can't disagree about which element a step means. Every locator ends in `.first()` since accessible names aren't guaranteed unique (a product card routinely exposes the same name on its image and its title link) and Playwright's strict mode treats a 2-match locator as a hard error.
- `src/stages/credentials.ts` holds real, published test credentials for well-known **public** demo sites only (saucedemo, the-internet.herokuapp.com) — used so live-extend can actually get past a login wall. For any other site, whatever credentials the user typed into the prompt flow through as plain values; there's no secret-storage mechanism, deliberately, since `/runs` is served publicly.
- The web UI polls `GET /api/runs/:id/state` rather than streaming SSE, specifically so it survives being shared over a Cloudflare Quick Tunnel (see above). `src/runStore.ts`'s durable per-run event log backs both the SSE and the polling route.
- Discovery caches the `AppModel` per URL under `runs/_cache/appmodels/` (a proto knowledge base) so repeat runs against the same site skip re-crawling. Live-extend's discovered pages are **not** cached — they're specific to one flow, and caching them risks serving a stale/wrong-flow model to a different prompt against the same URL.

## Known limitations

See [PROJECT_OVERVIEW.md § Current completion status](PROJECT_OVERVIEW.md#4-current-completion-status) for the full, honest list (found during real development against a friend's live site, not hypothetical) — in short: truncated tests can pass without asserting anything yet, live-extend can race a single-page app's own auth redirect, only the top-priority test case executes, and there's no server auth.

## Repo layout

- `src/stages/` — the pipeline: `planner.ts`, `discovery.ts`, `testCases.ts`, `ir.ts` (+ `liveExtend.ts`, `targetResolver.ts`, `credentials.ts`), `generator.ts`, `executor.ts`, `failureAnalysis.ts`.
- `src/llm/` — the shared LLM layer: `gemini.ts`, `groq.ts`, `keyPool.ts`, `backoff.ts`, `json.ts`.
- `src/schema/` — the zod contracts: `appModel.ts`, `ir.ts`.
- `src/kb/` — the proto knowledge base: `cache.ts` (per-URL `AppModel` cache).
- `src/server/` — the web server: `index.ts` (routes), `runRegistry.ts` (SSE fan-out), `concurrency.ts` (run cap).
- `src/orchestrator.ts` — wires the stages together, persists every stage's output, emits progress events.
- `src/runStore.ts` — durable per-run NDJSON event log.
- `public/` — the single-page vanilla JS/CSS frontend.
- `runs/` — created at runtime, gitignored.
- `ENTERPRISE.md` — the seam map for scaling this beyond a single-machine MVP (job queue, object storage, auth, etc.) — documented, not built, until real load demands it.
- `PROJECT_OVERVIEW.md` — the full design/architecture narrative and honest completion status.

## Phase 2+ (not built — extension points)

- **Real/private site credentials:** an env-var + `process.env`-reference-in-generated-spec path, so a login can be tested without the credential ever touching a `runs/` artifact. `credentials.ts` is already structured for this.
- **Execute every generated test case**, not just the top-priority one.
- **Multi-framework export:** add `selenium.ts` / `cypress.ts` alongside `generator.ts`, consuming the same IR.
- **Real Knowledge Base:** promote the `runs/<id>/*.json` layout and the app-model cache to a queryable store.
- **Business Flow Graph / Risk Analysis / Improvement Suggestions:** new stages reading existing outputs; none require changing the spine.

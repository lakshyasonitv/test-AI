# AI Test Platform (Phase 1)

A pipeline that turns a natural-language testing request + a URL into an **executed** Playwright test with artifacts and, on failure, a plain-English diagnosis.

```
prompt + url
  → Planner (LLM)                → high-level plan
  → Application Understanding    → app model (elements as accessibility role + name)
  → Structured Test Cases (LLM)  → human-readable cases
  → Intermediate Representation  → strict JSON test model (THE CONTRACT)
  → Playwright Generator (NO AI) → *.spec.ts
  → Execution Engine (NO AI)     → run + collect artifacts
  → Failure Analysis (LLM)       → diagnosis (only if it failed)
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

Open `http://localhost:3000`, enter a prompt + URL, and watch all 8 stages update live (pending → running → done/failed), ending in a pass/fail banner, the failure screenshot (if any), and the diagnosis text.

Both modes write everything under `runs/<id>/`: every stage's JSON output (`NN-stage.json`), the generated `generated.spec.ts`, a real Playwright run (screenshot + trace under `artifacts/`), and — on failure — a diagnosis JSON.

## API keys & quota — the honest model

Free-tier numbers move; check the source of truth before relying on any number here:
- `ai.google.dev/gemini-api/docs/rate-limits`
- `console.groq.com/docs/rate-limits`

- **Gemini keys stack quota only across distinct Google Cloud projects / accounts.** Four teammates each using their own key gives ~4x the free quota, legitimately. Two keys from the same project do not stack.
- **Groq enforces limits at the org level.** Extra keys in one account add no quota — list them only for failover. Do not create multiple accounts to pool quota (against Groq's ToS). If Groq throughput is the wall, upgrade that one account to the paid Developer tier.
- The `KeyPool` earns its place regardless of stacking: it gives failover and graceful 429 handling via rotation + exponential backoff.
- **Team dev pattern:** each developer runs locally with their own keys in their own `.env`. No shared secrets are committed to the repo.

## Architecture notes

- The **Playwright Generator** (`src/stages/generator.ts`) and **Execution Engine** (`src/stages/executor.ts`) contain zero LLM calls — they are pure/deterministic, driven entirely by the IR contract (`src/schema/ir.ts`).
- Every LLM output is schema-validated with `zod`. Invalid JSON triggers one retry, then a clear thrown error.
- All LLM traffic goes through `src/llm/gemini.ts` / `src/llm/groq.ts`, which own key rotation (`keyPool.ts`) and backoff (`backoff.ts`). No other file calls an LLM endpoint directly.
- Every stage's output is persisted to `runs/<id>/NN-stage.json` so a mid-pipeline failure is debuggable.
- The web UI streams live per-stage progress over Server-Sent Events (`src/server/runRegistry.ts` + `src/server/index.ts`) — one-way server→client push, no polling, no WebSocket library.
- Discovery caches the `AppModel` per URL under `runs/_cache/appmodels/` (a proto knowledge base) so repeat runs against the same site skip re-crawling.

## Phase 2 (not built — extension points only)

- **Browser Use discovery:** swap `discover()`'s body for a Browser Use agent returning the same `AppModel`; the interface is already the seam.
- **Multi-framework export:** add `selenium.ts` / `cypress.ts` alongside `generator.ts`, consuming the same IR.
- **Real Knowledge Base:** promote the `runs/<id>/*.json` layout and the app-model cache to a queryable store.
- **Business Flow Graph / Risk Analysis / Improvement Suggestions:** new stages reading existing outputs; none require changing the spine.

## Repo layout

See `src/` for the 8-stage pipeline (`stages/`), the shared LLM layer (`llm/`), schemas (`schema/`), the proto knowledge base cache (`kb/`), and the web server (`server/`). `public/` holds the single-page vanilla JS/CSS frontend. `runs/` is created at runtime and is gitignored.

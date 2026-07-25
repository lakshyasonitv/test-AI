# From MVP to Enterprise — the seam map

The Phase-1 architecture is intentionally a single Node process: the API, the pipeline,
and the browser work all run together, state is files on local disk. That is the correct,
cheapest MVP. This doc records the few **seams** that let it grow into a real product
**without a rewrite** — and, just as important, says *when* to spend on each so you don't
pay for scale you don't have yet.

## What's already built for this (Option 1)

- **`RunStore` (`src/runStore.ts`)** — every run's event timeline is a durable NDJSON log,
  not in-memory. Server restarts and SSE reconnects replay full history. This is the seam
  you later back with Postgres by swapping *only this file's body*; callers use just
  `append()` / `read()`.
- **Concurrency cap (`src/server/concurrency.ts`)** — a slot limiter (`MAX_CONCURRENT_RUNS`,
  default 3) around pipeline runs. Each run launches Chromium, so this directly bounds
  RAM/CPU — i.e. bounds your bill — and stops one busy moment from OOMing the box.

## The remaining seams (documented, not built — build on the trigger, not before)

| # | Seam | MVP today | Enterprise swap | Build it when |
|---|------|-----------|-----------------|---------------|
| 1 | **RunStore → database** | NDJSON file per run | Postgres (query "all runs for tenant X", retention) | You need cross-run queries, or >1 server instance |
| 2 | **In-process cap → job queue + worker** | `Semaphore` in the API process | SQS/Redis queue + separate worker pool; API only enqueues | Runs must survive an API restart, or you scale browsers past one box |
| 3 | **Local `runs/` → object store** | `express.static("runs")` | S3/GCS + signed URLs, lifecycle expiry on traces/videos | Multiple workers write artifacts, or disk fills |
| 4 | **In-proc SSE fan-out → shared bus** | `runRegistry` Map of connections | Redis pub/sub, so any API node can stream any run | You run >1 API node behind a load balancer |
| 5 | **`.env` keys → secret manager** | env vars | Vault / cloud KMS, rotation | Real multi-tenant deploy |
| 6 | **No auth → authn/z + tenancy** | open endpoint | per-user auth, per-tenant quotas & isolation | Anyone but you can reach it |
| 7 | **`console.log` → observability** | stdout | structured logs + OpenTelemetry traces + metrics | You need to debug prod without a repro |

The order above is roughly the order you'll hit the triggers. Seams 1–2 usually come first
(durability + surviving restarts), 3–4 when you go multi-instance, 5–7 when real users arrive.

## Target shape (north star — for orientation, not to build now)

```
Client ──> API (stateless, auth, multi-tenant)
             │  enqueue(runId)                       ┌── stream events (Redis pub/sub)
             ▼                                        │
        Job queue (SQS/Redis) ──> Worker pool ──> RunStore=Postgres, Artifacts=S3
                                  (isolated browsers, autoscaled)
```
Everything above is a swap of one existing seam, not new spine. The IR contract, the
`gemini()`/`groq()` LLM boundary, and `discover()` do not change.

## Cost levers (this is where the money actually goes)

Architecture is cheap; **LLM calls and browser compute are the real bill.** In rough order
of impact:

1. **App-model cache (already built, `src/kb/cache.ts`)** — repeat runs against the same
   URL skip both a browser crawl *and* a Gemini labeling call. Biggest single saver. When
   you move to S3/DB, keep this cache.
2. **Concurrency cap (built)** — bounds simultaneous browsers = bounds the machine size you
   pay for. Set `MAX_CONCURRENT_RUNS` to what one box can hold.
3. **LLM response caching (seam, in the `llm/` layer)** — identical (prompt+model) → cache
   the response. Add inside `gemini.ts`/`groq.ts` so it's transparent. Build when repeat
   prompts show up in logs.
4. **Cheaper models per stage** — planning/labeling can use `GEMINI_MODEL_LITE`; reserve the
   bigger model for the IR/diagnosis steps. Already parameterized via env.
5. **Artifact retention** — traces/videos are large. On S3, a lifecycle rule expiring them
   after N days is a one-line cost control (seam #3).
6. **Free tiers + KeyPool** — rotation across legitimately-owned keys keeps you on free tiers
   longer; upgrade one account to paid only when throughput is genuinely the wall.

Rule of thumb: **defer every seam until its trigger fires.** Managed free tiers (Postgres,
Redis, S3) cover a lot before any of this costs real money.

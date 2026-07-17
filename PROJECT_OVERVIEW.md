# AI Test Platform — Project Overview & Design Notes

This is the "why," not just the "what": the architecture, the reasoning behind each design decision, and an honest account of what's actually verified working versus what's a known, open gap. [README.md](README.md) is the practical run-it doc; this is the deeper one.

## 1. What this is

A pipeline that takes a natural-language testing request and a URL, and produces a **real, executed** Playwright test — not a suggestion, not pseudocode. It runs the test against the live site, captures a screenshot and trace, and if it fails, explains why in plain English with a suggested fix.

Two ways to use it:
- **CLI** — one-shot: `npm run generate -- --prompt "..." --url "..."`.
- **Web UI** — `npm run serve`, a form + live phase panel, run history, and (optionally) shareable over the internet via a Cloudflare Quick Tunnel.

What a run produces, all persisted under `runs/<id>/`:

| File | What it is |
|---|---|
| `00-input.json` | the raw prompt + URL |
| `01-plan.json` | the LLM's high-level plan |
| `02-appmodel.json` | the discovered page(s): elements by accessibility role + name |
| `03-cases.json` | human-readable test case(s) |
| `04-ir.json` | the strict JSON test model (the contract) — may be `truncated: true` |
| `generated.spec.ts` | the literal Playwright test, generated with zero LLM involvement |
| `05-result.json` | the real Playwright execution result |
| `06-diagnosis.json` | only present on failure: category, explanation, suggested fix |
| `events.ndjson` | every stage-progress event, durable, replayable |
| `artifacts/` | screenshot + trace.zip from the actual browser run |

It handles the five built-in templates (login, homepage smoke test, navigation, search, form validation) reliably — those stay on the one page discovery actually visits. It can now also attempt **multi-page flows** ("log in and buy something") by discovering additional pages on demand when a step needs one, instead of hard-failing the moment a step references something discovery never saw.

## 2. Pipeline architecture

```
prompt + url
      │
      ▼
 ┌─────────┐   Gemini. NL request → ordered high-level steps. No grounding
 │ Planner │   needed — it runs before discovery exists.
 └────┬────┘
      ▼
 ┌───────────┐  Playwright launches the entry URL, takes an accessibility
 │ Discovery │  snapshot, Gemini labels it into an AppModel (elements by role
 └────┬──────┘  + name). Strictly grounded to the literal snapshot — the
      │         anti-hallucination prompt forbids inventing anything not
      │         present. Cached per URL.
      ▼
 ┌────────────┐ Gemini turns (plan + AppModel) into concrete, ordered,
 │ Test Cases │ human-readable steps. Only checks entry-page elements
 └────┬───────┘ verbatim; steps past a login/navigation action describe
      │         *intent* in plain language — grounding for those is
      │         deferred to the next stage, which can actually see them.
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │ IR generation (Groq) + grounding + live-extend            │
 │                                                             │
 │  groq() writes the strict JSON IR from the test case.      │
 │  groundingError() checks every {role,name} target against  │
 │  the current AppModel.                                     │
 │                                                             │
 │  ungrounded? → extendAppModel() replays the grounded       │
 │    prefix live in a real browser (real creds for known     │
 │    demo sites), reaches the next page, labels it via the    │
 │    SAME discovery prompt, merges it in. Retry. (≤2×)        │
 │                                                             │
 │  still stuck? → truncate to the grounded prefix, mark       │
 │    meta.truncated, return a real partial test instead of    │
 │    failing the whole run.                                   │
 └────┬────────────────────────────────────────────────────┘
      ▼
 ┌───────────┐  IR → literal Playwright source text. Zero LLM calls.
 │ Generator │  Shares locator-resolution logic with live-extend via
 └────┬──────┘  targetResolver.ts so they can't disagree.
      ▼
 ┌──────────┐  Spawns the real Playwright CLI. Zero LLM calls.
 │ Executor │  Collects JSON results, screenshot, trace.
 └────┬─────┘
      ▼
   passed? ──yes──→ done
      │no
      ▼
 ┌───────────────────┐  Gemini (vision). Reads the real Playwright error +
 │ Failure Analysis   │  a screenshot. Returns category, explanation,
 └────────────────────┘  suggested fix. Only runs on failure.
```

Every arrow that touches an LLM is either grounded against real, observed data (discovery, IR) or explicitly not trusted for anything downstream (generator/executor are pure code). The one place grounding *used* to double up — testCases.ts had its own fuzzy filter — was removed; see below for why.

## 3. Key design decisions, and why

### Grounding is a code-level check, not a better-worded prompt
Every LLM stage that can reference concrete UI elements is either constrained to only what a real accessibility snapshot showed (discovery), or deterministically checked against the AppModel after generation (`ir.ts`'s `groundingError`). Prompting alone — "don't invent elements" — was tried first and found insufficient on its own; the fix that actually held was a code-level check with a precise, per-step error, layered on top of (not instead of) a well-written prompt.

### Why `testCases.ts` stopped grounding
It originally had its own fuzzy grounding filter — quoted-phrase substring matching against known elements — as a second gate before IR generation. This actively broke multi-page prompts: since `testCases.ts` only ever sees the entry-page AppModel, any step describing a page beyond it ("add to cart") looked exactly like a hallucination to that filter and got silently dropped, before the live-extend mechanism — which *can* look beyond the entry page — ever got a turn. The fix: delete that filter, loosen the prompt to explicitly allow describing intent for unseen pages, and let `ir.ts`'s exact `groundingError` + live-extend be the single, authoritative gate. Two gates, where the earlier one is strictly more restrictive than the later one can compensate for, doesn't add safety — it silently discards fixable cases.

### Reactive, on-demand discovery over upfront crawling
When a prompt implies a multi-page flow, the alternative to "fail because the page isn't known" was either (a) crawl the whole site upfront before planning, or (b) reactively extend the model only when and where a generated step actually needs a page it hasn't seen. (b) won: crawling upfront is expensive, can't know which pages are relevant to a given prompt, and still can't get past a login wall without credentials anyway — so the cost buys nothing a targeted, on-demand replay doesn't. Live-extend replays only the already-proven-safe (grounded) prefix, in a real browser, exactly once per missing page, capped at 2 extensions per test case — bounded cost, bounded blast radius.

### Graceful degradation over hard failure
A test that can't be fully grounded (extension exhausted, or the site genuinely lacks the flow) now returns a real, executable test truncated to the last verified step, marked `truncated: true`, rather than discarding the whole run. "We verified you can reach the product page" beats nothing.

**Known gap this created:** a truncated test currently has no guaranteed terminal assertion, so "passed" can mean "nothing threw an exception," not "verified something real." This was found via an actual run against a friend's live site (`acadtracker.vercel.app`) — a test truncated right after login reported ✅ Passed, while the requested attendance-marking action never ran at all, and the login itself likely never even completed before the test ended (see § 4).

### Credentials: a table for public demo sites, not a general secrets system
Live-extend needs real login credentials to get past auth — the LLM's invented placeholder credentials won't authenticate against a real site. For well-known public QA demo sites (saucedemo, the-internet.herokuapp.com), the actual published test credentials are hardcoded in `credentials.ts` — they're not secrets, the sites print them on their own login pages. For any other site, whatever credentials the user literally typed into the prompt flow through as plain values instead. There's deliberately no generic secret-storage mechanism yet: `/runs` is served publicly as static files, so anything written to a run's JSON is effectively public. A proper env-var + `process.env`-reference-in-spec path is the natural next step, deferred until a real private login actually needs testing.

### Deterministic generator/executor — no LLM in the "trusted" half
Once the IR exists, everything downstream (spec generation, execution) is pure code with zero model calls. The IR is the one contract that has to be exactly right, and it's the one thing that's both schema-validated (zod) and grounding-checked — not just trusted LLM output.

### SSE → polling, because of where this actually got shared
The web UI originally streamed progress via Server-Sent Events — fine on `localhost`. Once the project moved to sharing a run link over a Cloudflare Quick Tunnel, SSE-over-GET turned out to be silently buffered by the tunnel's edge until the connection closes — a known, still-open cloudflared issue ([#1449](https://github.com/cloudflare/cloudflared/issues/1449)), not a bug in this code, and it reproduces even with the standard anti-buffering headers set. Rather than chase unreliable tunnel-specific SSE workarounds, the UI switched to polling a plain JSON snapshot endpoint (`GET /api/runs/:id/state`), backed by the same durable per-run event log that already existed for SSE replay — no proxy can silently buffer a polled JSON response the way it can a held-open stream. The SSE route was left in place rather than deleted, since it still works fine locally and costs nothing to keep.

### Live-extend reuses, rather than reimplements
The "run this step for real" logic in `liveExtend.ts` and the "emit this step as code" logic in `generator.ts` share one locator-resolution module (`targetResolver.ts`) so the two can never disagree about which element a step means. The page-labeling step inside live-extend reuses discovery's own `modelFromAria()` function, so a newly-discovered page is graded by the exact same anti-hallucination prompt as the entry page — not a second, drifted copy of it.

## 4. Current completion status

### Solid — verified working end to end
- Full pipeline (plan → discovery → testCases → IR → generate → execute → diagnosis) on both CLI and web UI.
- Single-page flows — login test, homepage smoke test, navigation test, search test, form validation test — verified passing against real sites (`the-internet.herokuapp.com`).
- **Multi-page flow via live-extend** — verified against `saucedemo.com`: a "log in and buy a backpack" prompt reached login → product page → add-to-cart across two chained live extensions (AppModel grew 1→2→3 pages), truncating honestly at the point it genuinely couldn't go further. The result screenshot shows the cart badge incremented and the button flipped to "Remove" — a real state change, not a cosmetic pass.
- Grounding guard (`ir.ts`) catches every step addressing an element the AppModel doesn't have, and either resolves it (via extension) or reports it precisely (`Step sN targets role="X" name="Y", which is not present...`).
- Result screenshot + pass/fail/partial verdict rendered in the web UI, including through a Cloudflare Quick Tunnel.
- Failure diagnosis using the real Playwright error text plus a screenshot (vision).
- Per-run durable artifacts for every stage — this document's own § "known gaps" below was written by reading exactly these artifacts after a real failure.

### Known, real gaps — found during development, not yet fixed
1. **Truncated/partial tests can pass without asserting anything.** Confirmed via the `acadtracker.vercel.app` run: a test truncated right after login reported ✅ Passed while the actually-requested action (marking attendance) never ran, because the fallback IR ends on a bare `navigate`/`click`/`fill` with zero `assert` steps. A truncated IR should require a terminal assertion (e.g. URL changed, or some expected element appeared) before it's allowed to report success.
2. **Live-extend can race a single-page app's own client-side auth redirect.** In the same run, the replay's `click "Sign In"` was immediately followed by `page.goto("/attendance")` with no wait for the login's async request or the SPA's own redirect to settle — the replay landed back on `/login`. Both `liveExtend.ts`'s replay and `generator.ts`'s emitted spec need an explicit settle-wait (`waitForLoadState('networkidle')` or similar) after any step that triggers navigation, not just once at the very end.
3. **Only the top-priority test case executes.** `testCases.ts` can produce several cases; `orchestrator.ts` sorts by priority and runs only the first, silently discarding the rest.
4. **No authentication on the server.** Anyone with a tunnel link can start runs (spends API quota) and browse every past run's artifacts under `/runs`.
5. **Credentials only cover built-in public demo sites.** A real/private login relies on the user typing credentials directly into the prompt text; there's no secret-storage mechanism, by design, given `/runs` is public.
6. **Gemini model/key availability is inconsistent across the configured key pool.** Verified empirically: different keys have access to different models, and the `/v1beta/models` list endpoint doesn't reliably predict what a real `generateContent` call will accept. A model that works can start silently 404ing purely because `KeyPool` rotated to a different key.

### Deliberately not built (scoped out, not gaps)
- Multi-framework export (Selenium/Cypress) from the same IR — the IR is designed to support this; `generator.ts` is the only file that would need a sibling.
- A queryable knowledge base beyond the per-URL file cache.
- Business-flow-graph / risk-analysis / improvement-suggestion stages.
- Horizontal scaling (job queue, object storage, multi-instance SSE fan-out) — documented as future seams in [ENTERPRISE.md](ENTERPRISE.md), intentionally deferred until real load demands it.

## 5. File-by-file map

```
src/
├── cli.ts                  entry point for the CLI (npm run generate)
├── orchestrator.ts         wires all stages together, persists every stage's
│                           output, emits progress events (StageEvent)
├── runStore.ts             durable per-run NDJSON event log (events.ndjson)
│
├── stages/
│   ├── planner.ts          prompt+url → high-level plan (Gemini)
│   ├── discovery.ts        entry URL → AppModel (Playwright + Gemini);
│   │                       exports modelFromAria(), reused by liveExtend
│   ├── testCases.ts        plan+AppModel → human-readable test case(s) (Gemini);
│   │                       no grounding filter here — see § 3
│   ├── ir.ts                test case → strict IR (Groq); groundingError(),
│   │                       the extension/truncation retry loop
│   ├── liveExtend.ts        extendAppModel() — live browser replay to reach
│   │                       and model a page beyond the entry point
│   ├── targetResolver.ts    Target → locator, shared by generator (code) and
│   │                       liveExtend (live), always .first()
│   ├── credentials.ts        built-in demo-site credential table + field matcher
│   ├── generator.ts         IR → Playwright spec source text (no AI)
│   ├── executor.ts          spawns Playwright CLI, collects results (no AI)
│   └── failureAnalysis.ts   failed result + screenshot → diagnosis (Gemini, vision)
│
├── llm/
│   ├── gemini.ts / groq.ts  the only two files that call an LLM endpoint
│   ├── keyPool.ts           key rotation + cooldown
│   ├── backoff.ts           retry with exponential backoff on 429/503
│   └── json.ts              tolerant JSON parsing of LLM output
│
├── schema/
│   ├── appModel.ts          zod: AppModel, PageModel, Element
│   └── ir.ts                zod: IR, Step, Target (the contract)
│
├── kb/
│   └── cache.ts             per-URL AppModel cache (runs/_cache/appmodels/)
│
└── server/
    ├── index.ts              Express routes: POST /api/runs, GET /api/runs,
    │                        GET /api/runs/:id/state (polling), GET .../events (SSE)
    ├── runRegistry.ts        SSE fan-out + durable replay
    └── concurrency.ts        Semaphore capping concurrent pipeline runs

public/
├── index.html               single page: form, phase panel, result, history
├── app.js                   polling loop, template buttons, history list
└── style.css

runs/<id>/                   created at runtime, gitignored — see § 1 table
```

## 6. Suggested next steps, in priority order

1. **Terminal-assertion requirement for truncated IRs.** Closes the false-positive gap in § 4.1 — this is a trust bug, highest priority.
2. **Settle-wait after auth-triggering actions** in both `liveExtend.ts` and `generator.ts`'s emitted specs — likely fixes real multi-page flows against single-page-app sites like the one that surfaced this.
3. **Execute all test cases**, not just the top-priority one.
4. **Basic auth / access control** before sharing tunnel links beyond a trusted audience.
5. **Real-site credential handling** beyond "typed into the prompt" — the env-var + `process.env`-reference path already sketched in `credentials.ts`.

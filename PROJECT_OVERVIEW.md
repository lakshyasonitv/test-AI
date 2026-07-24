# AI Test Platform — Project Overview & Design Notes

This is the "why," not just the "what": the architecture, the reasoning behind each design decision, and an honest account of what's actually verified working versus what's a known, open gap. [README.md](README.md) is the practical run-it doc; this is the deeper one — read this to understand the whole project end to end.

## 1. What this is

A pipeline that takes a natural-language testing request and a URL, and produces a **real, executed** Playwright test — not a suggestion, not pseudocode. It runs the test against the live site, captures a screenshot and trace, and if it fails, explains why in plain English with a suggested fix. If the failure looks like a broken locator rather than a real app bug, it tries once, automatically, to repair and re-run the test before reporting failure.

Two ways to use it:
- **CLI** — one-shot: `npm run generate -- --prompt "..." --url "..."`.
- **Web UI** — `npm run serve`, a form + live phase panel (plain-English progress, not raw JSON), run history (newest 20, deletable), and (optionally) shareable over the internet via a Cloudflare Quick Tunnel.

What a run produces, all persisted under `runs/<id>/`:

| File | What it is |
|---|---|
| `00-input.json` | the raw prompt + URL |
| `01-plan.json` | the LLM's high-level plan |
| `02-appmodel.json` | the discovered page(s): elements by accessibility role + name, labeled with help from a screenshot |
| `03-cases.json` | the **full generated coverage suite** — typically 6–11 human-readable test cases (valid path, invalid input, empty fields, boundaries, security). Exactly one is tagged `fromPrompt: true` |
| `04-ir.json` | the strict JSON test model for the **primary case** (the contract) — may be `truncated: true` |
| `generated.spec.ts` | the literal Playwright test for the primary case, generated with zero LLM involvement |
| `05-result.json` | the real Playwright execution result for the primary case |
| `06-diagnosis.json` | only present on failure (primary case): category, explanation, suggested fix |
| `healed/` | only present if a self-heal attempt succeeded: `ir.json` + `generated.spec.ts` for the repaired, re-run test |
| `07-suite-summary.json` | suite-wide summary: total, passed, failed, truncated counts with per-case status |
| `cases/` | per-case subdirectories (`case-0`, `case-1`, …), each containing that case's `04-ir.json`, `generated.spec.ts`, `05-result.json`, optionally `06-diagnosis.json`, and `artifacts/` |
| `events.ndjson` | every stage-progress event, durable, replayable |
| `artifacts/` | screenshot + trace.zip from the primary case's actual browser run |

**The single most important thing to understand about current capability:** `03-cases.json` contains a whole QA-style suite, and **every case in that suite is now executed** — see § 4 for what that means for coverage, known limitations (self-heal is primary-case-only, truncated cases can still pass without assertion), and what to check before trusting a result.

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
 │ Discovery │  snapshot + a screenshot. Gemini labels the snapshot into an
 └────┬──────┘  AppModel (elements by role + name), using the screenshot only
      │         to disambiguate labeling (icon-only buttons, duplicate names)
      │         — never to add an element the snapshot doesn't contain.
      │         Strictly grounded to the literal snapshot. Cached per URL.
      ▼
 ┌────────────┐ Gemini turns (plan + AppModel + a coverage-checklist floor)
 │ Test Cases │ into a full SUITE of human-readable cases: valid path, invalid
 └────┬───────┘ input, empty fields, boundaries, security — one case tagged
      │         fromPrompt:true (the literal translation of what you asked).
      │         Only entry-page elements are verbatim; steps past a
      │         login/navigation action describe *intent* in plain language.
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │ Primary-case selection (orchestrator.ts)                   │
 │  cases.find(fromPrompt) ?? highest-priority case.          │
 │  This is the ONE case that runs — see § 4.                 │
 └────┬────────────────────────────────────────────────────┘
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │ IR generation (Groq) + grounding + live-extend             │
 │                                                              │
 │  groq() writes the strict JSON IR from the test case,       │
 │  guided to pick success assertions that are actually        │
 │  discriminating (false before the action, true after).      │
 │  groundingError() checks every {role,name} target against   │
 │  the current AppModel.                                      │
 │                                                              │
 │  ungrounded? → extendAppModel() replays the grounded         │
 │    prefix live in a real browser (real creds for known       │
 │    demo sites — skipped for a fromPrompt case, see § 3),      │
 │    reaches the next page, labels it via the SAME discovery    │
 │    prompt (+ vision), merges it in. Retry. (≤2×)               │
 │                                                              │
 │  still stuck? → truncate to the grounded prefix, mark        │
 │    meta.truncated, return a real partial test instead of      │
 │    failing the whole run.                                    │
 └────┬────────────────────────────────────────────────────┘
      ▼
 ┌───────────┐  IR → literal Playwright source text. Zero LLM calls.
 │ Generator │  Shares locator-resolution logic (incl. a deterministic
 └────┬──────┘  role/text fallback chain) with live-extend via
      │         targetResolver.ts so they can't disagree.
      ▼
 ┌──────────┐  Spawns the real Playwright CLI. Zero LLM calls.
 │ Executor │  Collects JSON results, screenshot, trace.
 └────┬─────┘
      ▼
   passed? ──yes──→ done (test summary + labeled screenshot shown in UI)
      │no
      ▼
 ┌───────────────────┐  Gemini (vision). Reads the real Playwright error +
 │ Failure Analysis   │  a screenshot. Returns category, explanation,
 └────────┬──────────┘  suggested fix.
          ▼
   category is selector_changed / element_missing,
   and the failing step has a real prefix?
          │yes                              │no
          ▼                                 ▼
 ┌───────────────────────┐            report the diagnosis,
 │ Bounded self-heal (×1)  │            done — no repair attempted
 │ re-snapshot the page →  │            (this is deliberate for
 │ fresh IR → regenerate → │            "assertion_failed": a real
 │ re-run, ONCE.           │            app bug must stay a failure)
 │ Only accepted if the    │
 │ healed IR is NOT itself │
 │ truncated (else it'd be │
 │ a false pass — see § 3) │
 └───────────┬────────────┘
             ▼
     passed → done, healed:true
     still failed → report the ORIGINAL diagnosis, unchanged
```

Every arrow that touches an LLM is either grounded against real, observed data (discovery, IR) or explicitly not trusted for anything downstream (generator/executor are pure code). The self-heal branch is the one place the pipeline gets a second attempt — and it's deliberately narrow (two categories, one attempt, one extra guard) rather than a general retry loop.

## 3. Key design decisions, and why

### Grounding is a code-level check, not a better-worded prompt
Every LLM stage that can reference concrete UI elements is either constrained to only what a real accessibility snapshot showed (discovery), or deterministically checked against the AppModel after generation (`ir.ts`'s `groundingError`). Prompting alone — "don't invent elements" — was tried first and found insufficient on its own; the fix that actually held was a code-level check with a precise, per-step error, layered on top of (not instead of) a well-written prompt.

### Why `testCases.ts` stopped grounding
It originally had its own fuzzy grounding filter — quoted-phrase substring matching against known elements — as a second gate before IR generation. This actively broke multi-page prompts: since `testCases.ts` only ever sees the entry-page AppModel, any step describing a page beyond it ("add to cart") looked exactly like a hallucination to that filter and got silently dropped, before the live-extend mechanism — which *can* look beyond the entry page — ever got a turn. The fix: delete that filter, loosen the prompt to explicitly allow describing intent for unseen pages, and let `ir.ts`'s exact `groundingError` + live-extend be the single, authoritative gate.

### The coverage taxonomy is a floor, not a ceiling
Early on, every run produced exactly one bare happy-path case — asking for "coverage" with no guidance just wasn't enough signal. The fix was a hardcoded lookup table (`src/kb/testStrategy.ts`) mapping common feature types (login, signup, search, checkout, cart, contact) to the standard QA checklist for each, at a priority. **This was then challenged directly**: a hardcoded table alone would look like "just static templates" to an outside reviewer, not an autonomous QA engineer reasoning about *this* application. That challenge was correct. The fix: the checklist is now explicitly framed to the LLM as a known-reliable *floor*, not the ceiling — `testCases.ts` also requires applying 5 QA reasoning dimensions (valid / invalid / boundary / security / verifiable state change) to **every** concept discovery found, whether or not it's on the checklist, with `unmatchedConcepts()` calling out anything the table doesn't cover so the model can't just fall back to a generic case for it. The table guarantees a reliable minimum; genuine reasoning covers the rest.

### Primary-case selection has to honor what you actually asked for
`testCases.ts` generates a whole suite, but only one case executes (see § 4). The first version picked the single highest-*priority* case — and the taxonomy tags exactly one item "critical": SQL injection. That meant **any** login prompt got silently hijacked: a user typing their own real email/password got a SQL-injection test run instead, with a diagnosis about reformatting the injection payload — nothing to do with what they asked. `priority` was designed to order cases for an eventual multi-case run, not to pick a single winner; at N=1, "most severe" is never "what the user asked for." The fix: `TestCase` gained a `fromPrompt: boolean` field — exactly one case per run, the literal translation of the request, concrete values used verbatim — and the orchestrator prefers it (`cases.find(c => c.fromPrompt) ?? [...cases].sort(byPriority)[0]`, falling back to the old behavior if the model doesn't tag one). Verified live: the same login prompt that used to run a SQL-injection case now runs the actual login, with the actual credentials.

### Credentials: a table for public demo sites, not a general secrets system
Live-extend needs real login credentials to get past auth — the LLM's invented placeholder credentials won't authenticate against a real site. For well-known public QA demo sites (saucedemo, the-internet.herokuapp.com), the actual published test credentials are hardcoded in `credentials.ts` — they're not secrets, the sites print them on their own login pages. This created two follow-on bugs, one fixed and one still open (§ 4): substitution was firing unconditionally, so it would silently overwrite a user's own literal credentials for a demo host (fixed — skipped for `fromPrompt` cases) and it still overwrites the taxonomy's deliberately-*wrong* password in the "Invalid password" checklist case on those same two hosts (open). There's still no generic secret-storage mechanism: `/runs` is served publicly as static files, so anything written to a run's JSON is effectively public.

### A success assertion has to actually discriminate success from failure
Found via a real user's own site (`learnvibes.vercel.app`): a login test passed the login step for real (screenshot proof — the actual dashboard, actual name greeting) but the test still reported *failure*, because the assertion targeted the site's logo text. The obvious-looking fix — just match the text more loosely — was a trap: that logo is visible on the login page too, so an assertion built on it is true before the action and after it, and verifies nothing. Root cause: the assertion target was a `text`-only field (grounding-exempt), so it never triggered live-extend, and `toIR` never actually saw the post-login page — it fell back to the only plausible-looking element on the page it *could* see. The fix is prompt-level guidance in `ir.ts`: prefer an assertion that's only true after the action — most cheaply, the triggering control itself (e.g. the "Sign In" button) going `hidden`, since that's already grounded and needs no extra discovery. A decorative element with no `concept` in the AppModel is flagged as a signal to avoid. **This is a prompt nudge, not a deterministic guarantee** — it makes a good assertion more likely, not certain; there's no code-level check yet that rejects a bad one the way `groundingError` rejects an ungrounded one.

### Self-healing: vision (free) + a deterministic fallback (free) + one bounded LLM retry
Modeled loosely on how commercial tools (KaneAI) get better results, scoped to what's buildable without new infra and without risking an uncapped retry loop against a small API key pool:
- **Vision** threads a screenshot through the same `gemini()` call `modelFromAria()` already makes (`discovery.ts`) — zero extra requests. Scoped strictly to *improving labeling* of elements already in the snapshot (disambiguating icon-only buttons, same-named controls), never to adding elements the snapshot doesn't contain — the grounding invariant has to survive this unchanged.
- **Deterministic fallback** (`targetResolver.ts`, zero LLM calls): a role+name locator that doesn't resolve uniquely now also tries the button/link role swapped, then a broad text match, before giving up — the single most common real-world break (a styled `<a>` used as a button, or vice versa).
- **Bounded LLM re-heal** (`orchestrator.ts`): only on a `selector_changed`/`element_missing` diagnosis with a resolvable failing step, exactly one attempt: re-snapshot the current page (not "find a new page" — see below), regenerate the IR once, regenerate the spec, re-run once. `assertion_failed`/`timeout`/`navigation_error` never trigger this — a real app bug must stay a reported failure, not get silently retried into a pass.

Two real bugs were caught and fixed *before* this shipped, worth recording because they're the same failure mode (a "fix" that quietly turns a real failure into a false pass) that keeps showing up in this project:
1. The re-heal's re-snapshot step needs "what does this page look like *right now*," but the existing `extendAppModel()` is built for "is this a genuinely *new* page" and throws otherwise — which would have fired on exactly the most common heal case (a renamed control on a page already known). Fixed by splitting out a `refreshPageModel()` that upserts by URL instead of requiring novelty.
2. A heal that lands on a *truncated* fresh IR means the failing element still can't be grounded even after a fresh look (genuinely gone, not renamed) — accepting that as "healed" would silently drop the failing step and report a false pass. Guard: a heal only counts if the re-run passes **and** the fresh IR is not truncated.

### Results have to be readable by someone who isn't reading the code
The web UI originally showed a bare pass/fail badge, a screenshot, and a wall of raw JSON per phase — genuinely not presentable to an end user. Fixed by: showing a one-line human summary per phase (with the raw JSON still available, just tucked behind a native `<details>` disclosure instead of dumped inline) and adding a "what we tested" block to the results panel — the executed case's title, numbered steps, and expected outcome in plain English, sourced from the same data that was already being generated but never surfaced. Test steps can legitimately contain literal `<script>` payloads (the security coverage cases do this on purpose) — they're HTML-escaped before insertion, not trusted.

### Deterministic generator/executor — no LLM in the "trusted" half
Once the IR exists, everything downstream (spec generation, execution) is pure code with zero model calls. The IR is the one contract that has to be exactly right, and it's the one thing that's both schema-validated (zod) and grounding-checked — not just trusted LLM output.

### SSE → polling, because of where this actually got shared
The web UI originally streamed progress via Server-Sent Events — fine on `localhost`. Once the project moved to sharing a run link over a Cloudflare Quick Tunnel, SSE-over-GET turned out to be silently buffered by the tunnel's edge until the connection closes — a known, still-open cloudflared issue ([#1449](https://github.com/cloudflare/cloudflared/issues/1449)), not a bug in this code. The UI switched to polling a plain JSON snapshot endpoint (`GET /api/runs/:id/state`), backed by the same durable per-run event log that already existed for SSE replay. The SSE route was left in place since it still works fine locally.

### Live-extend reuses, rather than reimplements
The "run this step for real" logic in `liveExtend.ts` and the "emit this step as code" logic in `generator.ts` share one locator-resolution module (`targetResolver.ts`) so the two can never disagree about which element a step means, and both get the deterministic fallback chain identically (the generated spec inlines a copy since it must stay import-free/self-contained — the two copies are kept in sync manually, noted in comments on both sides). The page-labeling step inside live-extend reuses discovery's own `modelFromAria()` function (now with vision), so a newly-discovered page is graded by the exact same anti-hallucination prompt as the entry page.

## 4. What testing this can currently do — read this before trusting a result

This is the section to read if you're deciding whether to rely on a result. Two different things happen on every run, and they are **not** the same:

1. `testCases.ts` generates a **full coverage suite** (`03-cases.json`) — typically 6–11 cases spanning valid input, invalid input, empty/boundary values, and security (SQL injection, XSS) for every feature discovery found. This is real, useful output.
2. **Every case in that suite is now executed through a real browser.** Each case produces its own per-case artifacts under `cases/<caseId>/` — independent IR, Playwright spec, execution result, and (on failure) diagnosis. A suite-level summary is written to `07-suite-summary.json`.

### How cases are selected and executed

The suite executor iterates the cases in the order they appear in `03-cases.json`, running each through the full per-case pipeline. The primary case (tagged `fromPrompt: true`) is also executed through the legacy single-case pipeline first — its top-level artifacts (`04-ir.json`, `05-result.json`, etc.) remain unchanged for backward compatibility, and it alone receives bounded self-heal on failure (see § 3). Non-primary cases are executed sequentially without self-heal; if they fail, they are diagnosed and recorded as failed.

**Verified working, with a real executed run as evidence, this session:**
- **Login with specific, literal credentials you provide** — verified against `the-internet.herokuapp.com` and against a real third-party site (`learnvibes.vercel.app`): the executed test used the exact email/password typed into the prompt, not a placeholder, not a security payload, and reached the intended authenticated state.
- **Homepage / smoke tests** ("verify the homepage loads and key elements are visible") — verified against `the-internet.herokuapp.com` and `thinkvibes.com`.
- **Multi-page flows via live-extend** ("log in and buy a backpack") — verified against `saucedemo.com`: reached login → product page → add-to-cart across two chained live extensions, with a real state change in the final screenshot (cart badge incremented, button flipped to "Remove").
- **Navigation / search / form-validation single-page tests** — the original five templates, still on the one page discovery visits directly.
- **A discriminating success assertion for a login test**, when the destination page isn't visible to discovery — verified via direct IR generation against a real AppModel: the assertion now grounds on the login control disappearing, not a page it can't see.

**Structurally correct, but not yet observed against a real drifted site:**
- **Self-healing a broken/renamed locator.** The mechanism (vision, deterministic fallback, bounded LLM re-heal) is implemented and verified at the code level — targeted checks confirm the upsert-vs-throw semantics, the truncation guard, and the category gating all behave correctly — but no run in this session's history actually hit a real selector-drift failure on a live site and healed it end to end. Treat it as "should work," not "has been seen working."
- **Auth settle-wait for SPA redirects.** After an auth-triggering step (click/press on a button matching login/submit vocabulary), a bounded wait for URL change → network idle is now inserted in both `liveExtend.ts`'s replay and `generator.ts`'s emitted spec. The mechanism is deterministic and mirrors the same logic in both paths, but has not been observed end to end against a real SPA with the race condition. Treat it as "should fix the known race."

**Known-unreliable — don't trust these without checking the artifacts yourself:**
- **The "Invalid password" taxonomy case, specifically, on the two hardcoded demo hosts** (saucedemo.com, the-internet.herokuapp.com) — if this ever becomes the executed case, its deliberately-wrong password still gets silently overwritten with the real one (§ 3), so it can never actually test what it claims to.
- **~~A truncated (partial) result can still end without a terminal assertion.~~ (FIXED — Phase 2)** The platform now tracks `meta.hasTerminalAssertion` in the IR. If a truncated IR's surviving prefix has no assertion step, the result is forced to `"truncated_no_assertion"` regardless of Playwright's verdict. The acadtracker.vercel.app false-pass scenario is provably fixed. Check `meta.truncated` and `meta.hasTerminalAssertion` in `04-ir.json`; a `"truncated_no_assertion"` status in `05-result.json` means the test ran but verified nothing.
- **Assertion quality generally is a prompt nudge, not a guarantee.** The rule added in § 3 covers the specific "decorative persistent element" failure mode observed; other bad-assertion shapes aren't ruled out by anything deterministic yet.
- **Flows needing more than 2 page-hops beyond the entry page**, or a login gate this project doesn't have credentials for and you didn't type your own into the prompt, will genuinely truncate or fail — that's the honest current ceiling of live-extend, not a bug.

### Full-pipeline mechanics that are solid regardless of which case runs
- Grounding (`groundingError`) — catches every ungrounded `{role,name}` target deterministically, not by trust.
- Screenshot + trace capture on every run, pass or fail, shown in the UI.
- Failure diagnosis using the real Playwright error text plus a screenshot (vision).
- Per-run durable artifacts for every stage — this document's own findings above were written by reading exactly these artifacts after real runs, including runs against a live user's own site.
- Run history (newest 20) with a working delete action.

### Known, real gaps — found during development, not yet fixed
1. **(CLOSED — Phase 1: Suite Executor) Every case in the suite now executes.** Per-case artifacts are produced under `cases/<caseId>/` and a `07-suite-summary.json` is written. The primary case alone still receives bounded self-heal; non-primary cases are diagnosed on failure but not healed. See also: suggested next step #1 below — the UI has not been updated to display per-case results.
2. **(CLOSED — Phase 2: Terminal Assertion) Truncated/partial tests can no longer pass without asserting anything.** A new `hasTerminalAssertion` field on the IR meta tracks whether the surviving (post-truncation) step list ends in a real assertion. If truncated and no terminal assertion survived, the result is forced to `"truncated_no_assertion"` regardless of Playwright's verdict — the acadtracker.vercel.app false-pass scenario is provably fixed.
3. **(CLOSED — Phase 3: Auth Settle-Wait) Live-extend can race a single-page app's own client-side auth redirect.** After an auth-triggering step (click/press on a button whose accessible name matches login/submit vocabulary), a bounded wait for URL change → network idle is now inserted in both `liveExtend.ts`'s replay and `generator.ts`'s emitted spec. See `stages/authSettle.ts`.
4. **Credentials substitution still overwrites the taxonomy's own "Invalid password" case** on the two hardcoded demo hosts (narrower than it used to be — a user's own literal credentials are now protected — but this specific non-`fromPrompt` case is not).
5. **No authentication on the server.** Anyone with a tunnel link can start runs (spends API quota) and browse every past run's artifacts under `/runs`.
6. **Credentials only cover built-in public demo sites** beyond what a user types directly into the prompt.
7. **Gemini model/key availability is inconsistent across the configured key pool.** Verified empirically: different keys have access to different models, and the `/v1beta/models` list endpoint doesn't reliably predict what a real `generateContent` call will accept.

### Deliberately not built (scoped out, not gaps)
- Multi-framework export (Selenium/Cypress) from the same IR — the IR is designed to support this; `generator.ts` is the only file that would need a sibling.
- A queryable knowledge base beyond the per-URL file cache and the static coverage taxonomy.
- Business-flow-graph / risk-analysis / improvement-suggestion stages.
- The step-by-step observe-then-act execution loop some commercial tools use as their primary mode (this project's discovery is upfront + reactive live-extend, not a step-by-step live agent loop).
- Horizontal scaling (job queue, object storage, multi-instance SSE fan-out) — documented as future seams in [ENTERPRISE.md](ENTERPRISE.md), intentionally deferred until real load demands it.

## 5. File-by-file map

```
src/
├── cli.ts                  entry point for the CLI (npm run generate)
├── orchestrator.ts         wires all stages together: primary-case selection,
│                           persists every stage's output, emits progress events,
│                           runs the bounded self-heal branch on failure
├── runStore.ts             durable per-run NDJSON event log (events.ndjson)
│
├── stages/
│   ├── planner.ts          prompt+url → high-level plan (Gemini)
│   ├── discovery.ts        entry URL → AppModel (Playwright + Gemini, vision);
│   │                       exports modelFromAria(), reused by liveExtend
│   ├── testCases.ts        plan+AppModel+taxonomy → full coverage suite (Gemini);
│   │                       tags exactly one case fromPrompt:true; no grounding
│   │                       filter here — see § 3
│   ├── ir.ts                test case → strict IR (Groq); groundingError(), the
│   │                       extension/truncation retry loop, assertion-quality
│   │                       guidance, credential substitution (skipped for
│   │                       fromPrompt cases)
│   ├── liveExtend.ts        extendAppModel() — live browser replay to reach and
│   │                       model a genuinely NEW page; refreshPageModel() — same
│   │                       replay, but upserts an already-known page's CURRENT
│   │                       state (used by self-heal, not by toIR's own loop)
│   ├── targetResolver.ts    Target → locator, shared by generator (code) and
│   │                       liveExtend (live); role+name gets a deterministic
│   │                       fallback chain (role swap, text match); always .first()
│   ├── credentials.ts        built-in demo-site credential table + field matcher
│   ├── generator.ts         IR → Playwright spec source text (no AI); inlines the
│   │                       same locator-fallback helper so the spec stays
│   │                       self-contained
│   ├── executor.ts          spawns Playwright CLI, collects results (no AI)
│   └── failureAnalysis.ts   failed result + screenshot → diagnosis (Gemini,
│                           vision); category feeds the self-heal decision
│
├── llm/
│   ├── gemini.ts / groq.ts  the only two files that call an LLM endpoint;
│   │                       gemini() accepts an optional image for vision
│   ├── keyPool.ts           key rotation + cooldown
│   ├── backoff.ts           retry with exponential backoff on 429/503
│   └── json.ts              tolerant JSON parsing of LLM output
│
├── schema/
│   ├── appModel.ts          zod: AppModel, PageModel, Element
│   └── ir.ts                zod: IR, Step, Target (the contract)
│
├── kb/
│   ├── cache.ts             per-URL AppModel cache (runs/_cache/appmodels/)
│   └── testStrategy.ts       the coverage taxonomy: concept → checklist categories
│                            + priority; strategyFor(), unmatchedConcepts() — the
│                            floor, not the ceiling (see § 3)
│
└── server/
    ├── index.ts              Express routes: POST /api/runs, GET /api/runs,
    │                        GET /api/runs/:id/state (polling), .../events (SSE),
    │                        DELETE /api/runs/:id
    ├── runRegistry.ts        SSE fan-out + durable replay
    └── concurrency.ts        Semaphore capping concurrent pipeline runs

public/
├── index.html               single page: form, phase panel, test summary,
│                           labeled screenshot, result, history
├── app.js                   polling loop, template buttons, history list,
│                           human-readable phase/result summaries
└── style.css

runs/<id>/                   created at runtime, gitignored — see § 1 table
```

## 6. Suggested next steps, in priority order

1. **[DONE — Phase 1] Execute more than one test case.** The suite runner now executes every case in `03-cases.json` and produces per-case artifacts under `cases/<caseId>/` plus `07-suite-summary.json`. Next: update the UI to display per-case results.
2. **[DONE — Phase 2] Terminal-assertion requirement for truncated IRs.** The false-positive path is closed: `hasTerminalAssertion` on IR meta, result status forced to `"truncated_no_assertion"` when no terminal assertion survived. Next: the UI should display this status distinctly.
3. **[DONE — Phase 3] Settle-wait after auth-triggering actions** — inserted in both `liveExtend.ts`'s replay and `generator.ts`'s emitted specs. Closes the SPA-redirect race. Next: the UI does not yet need changes for this phase, but if per-case results now show fewer truncated logs for login flows that previously raced, that's the intended effect.
4. **Give `applyCredentials` intent-awareness** so it stops overwriting the taxonomy's own deliberately-wrong "Invalid password" case on the two demo hosts.
5. **Basic auth / access control** before sharing tunnel links beyond a trusted audience.
6. **Real-site credential handling** beyond "typed into the prompt" — the env-var + `process.env`-reference path already sketched in `credentials.ts`.
7. **Observe a real self-heal end to end** against a genuinely drifted live site, not just the targeted code-level checks that exist today.

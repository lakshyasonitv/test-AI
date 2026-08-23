# AI Test Platform

A pipeline that turns a natural-language testing request + a URL into **executed** Playwright
tests — with a live progress UI, per-step screenshots, artifacts (trace, generated spec), per-case
suite results, and plain-English failure diagnosis on failure. Discovers a site's own internal
links (not just the entry page), handles multi-page flows by extending discovery on demand, and
tries once to auto-repair broken locators before reporting failure.

## Documentation Map

Five documents, one job each. **Each topic has exactly one owner** — they link to each other
rather than repeating, because six copies of the same list is how they drifted out of date before
(see `DECISIONS.md` D-01).

| You want to know… | Read |
|---|---|
| What this is, how to run it, what it can do | **this file** |
| How it works internally — every file, schema | [ARCHITECTURE.md](ARCHITECTURE.md) |
| **What's broken, ranked, with remediation** | [TECH_DEBT.md](TECH_DEBT.md) |
| Why a design choice was made, what was rejected | [DECISIONS.md](DECISIONS.md) |
| Working guidance for an agent editing this repo | [CLAUDE.md](CLAUDE.md) |

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
default 5) and merges every reachable page into one AppModel. A page whose navigation has no
usable `href`s at all (a React/Next SPA routing entirely via `onClick`) is probed by clicking
instead, once the ordinary link pass comes back empty.

**Auth-aware:** if the entry page shows a live login form, discovery signs in before crawling —
detected against the real page (a visible `input[type="password"]`), not the extracted model, so
it works even on a login with no `<form>` tag or no labelled inputs. Credentials come from the
prompt or the same UI dialog used elsewhere, asked as soon as the gate is found rather than after
case generation. The exact steps that worked are carried forward and replayed at the start of
every generated test, so the test itself starts authenticated in its own fresh browser. Full
mechanics: [ARCHITECTURE.md's Auth-Aware Discovery section](ARCHITECTURE.md#auth-aware-discovery).
Covers a plain email/password login only — no multi-step, SSO, or MFA flow.

Gemini vision is the fallback, used only when DOM extraction returns nothing usable:

- canvas/captcha/image-heavy pages, where there's no meaningful DOM to read
- controls with no accessible name and no text (an icon-only cart link styled purely with a CSS
  background image)

**Not currently handled:** a bot-check/interstitial page (Amazon-style "click to continue"
challenge) is not distinguished from the real page it's standing in front of — see
`TECH_DEBT.md` TD-04.

## How It Works

```
prompt + url
  -> Planner (Gemini)                 -> structured test plan
  -> Discovery                        -> app model: elements as accessibility role + name
       |_ DOM extraction (primary)     -> cheerio over page.content(), no LLM needed
       |_ auth-aware login             -> signs in on a live login gate before crawling on;
                                          credentials from the prompt or a UI prompt asked
                                          right when the gate is found
       |_ site crawl (same-origin)     -> follows the entry page's own internal links; probes
                                          JS-only nav by clicking once href-following finds none
       |_ Gemini Vision (fallback)     -> only when DOM extraction finds nothing usable
  -> Test Cases (Gemini)              -> full coverage suite (valid/invalid/boundary/security)
       \_ case-selection gate (opt.)   -> pauses for you to review/accept/reject a batch and
                                          ask for a refined regeneration, ENABLE_CASE_SELECTION_GATE
       \_ login-case cap              -> at most one case targets the login page itself
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (Gemini) + grounding -> strict JSON test model (the contract)
       \_ login prefix (on auth)      -> discovery's recorded login replayed as real steps,
                                          prepended before grounding, so the generated test
                                          starts authenticated in its own fresh browser
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

Full technical detail, file by file: [ARCHITECTURE.md](ARCHITECTURE.md).

## Current Capabilities

### What Works

| Capability | Details |
|-----------|---------|
| Natural language to executed test | Prompt + URL -> real Playwright test running in a browser |
| Site-wide discovery | Follows the entry page's own same-origin internal links (bounded, `MAX_DISCOVERY_PAGES`), not just the one page you typed; probes JS-only navigation (no `href`) by clicking once the link pass finds nothing |
| Auth-aware discovery | Signs into a live login gate (email + password) before crawling, verified against the real page state, not inferred from a URL change. Works on logins with no `<form>` tag, no labelled inputs, or session state kept only in `sessionStorage`. See [ARCHITECTURE.md](ARCHITECTURE.md#auth-aware-discovery) |
| Generated tests start authenticated | Discovery's recorded login is replayed at the start of every relevant case's own fresh browser session — the test signs in itself, it doesn't rely on discovery's session. At most one case targets the login page itself (`MAX_LOGIN_CASES`), so the rest of the suite tests the app behind it |
| Auth-failure diagnosis | A run that ends back on the login page is reported as an authentication failure, not a misleading "element may have been renamed" |
| Full coverage suite generation | Up to 5 cases per run by default (`MAX_CASES_PER_RUN`): valid path, invalid input, empty fields, boundaries, security. The checklist itself is filtered by scope before it reaches the model |
| Case-selection gate (optional) | `ENABLE_CASE_SELECTION_GATE=true` pauses a run after generating a batch so you can accept/reject cases and ask for a refined regeneration; a rejected or already-accepted title is hard-excluded from every later batch |
| All suite cases executed | Every selected case runs in its own Playwright `test()` / browser context, with per-case artifacts |
| Per-step screenshots | Each IR step gets its own `test.step()` block and `step-N.png` screenshot; the case's representative screenshot is the LAST step, not the first |
| Multi-page flows (live-extend) | On-demand page discovery when steps target unseen pages (capped, `MAX_LIVE_EXTENSIONS`, default 5) |
| Self-healing broken locators | Re-snapshot (credential-policy-aware) + regenerate + re-run, bounded to 1 attempt, only for selector drift |
| Truncated test handling | Graceful degradation: partial real test instead of hard failure |
| Credential-policy substitution | `credentialPolicyFor` distinguishes full / identifier-only / none per case from its own wording — a negative "invalid password" case keeps its deliberately-wrong value. A case with TWO login attempts in one browser session is a known limitation (`TECH_DEBT.md` TD-10) |
| Terminal text-assertion grounding | The case's final pure-text assertion is replayed against the real page and corrected if the model guessed the wording wrong |
| Page-title assertions | `title_contains`/`title_equals` compile to `expect(page).toHaveTitle(...)` — a title check is verified against `<title>` metadata, not searched for in body text where it can never appear |
| Grounding: guessed navigate routes rejected | A `navigate` step's URL is checked against every discovered page URL + link href. A route invented from a feature's name ("go to the Admin section" -> `/admin`) is rejected with feedback |
| Grounding: role mismatch tolerated | An SPA control built as `<button onClick=...>` still grounds when the IR guessed `link` |
| Grounding: hidden elements can't be asserted visible | An element recorded not visible can't be the target of a `visible` assertion |
| Credentials typed into the prompt | `extractCredentialsFromPrompt` pulls a real username/password straight out of prompt text, treated as `secret` — same env-reference path as UI-entered credentials |
| IR completeness check | `missingActions` compares the case's own action-bearing step lines against what the IR actually carries out — a false-positive failure mode here (`TECH_DEBT.md` TD-01) is fixed |
| Secrets kept off disk | Credentials become `${env:...}` references; scrubbed from `results.json`, `final-page.txt`, and error-context attachments too |
| Scope filtering | Prompt can request smoke/functional/regression/security scope |
| Deterministic failure classifier | Pattern-matches Playwright errors before spending a Gemini call |
| LLM response caching | File + in-memory cache for repeated prompts, 30-min in-memory TTL, disk tier never expires |

### What's Broken

**Tracked in one place: [TECH_DEBT.md](TECH_DEBT.md)** — every known gap, ranked by severity, with
remediation. Not repeated here so it can't drift out of sync (see `DECISIONS.md` D-01).

The headline items, for orientation:

| Issue | Short version |
|---|---|
| Duplicate-named elements can still make a locator ambiguous | Partial mitigation shipped, real fix (page-scoping) still open — `TECH_DEBT.md` TD-05 |
| No blocking-interstitial detection (CAPTCHA/bot walls) at discovery time | `TECH_DEBT.md` TD-04 |
| No server authentication | Anyone with the URL can start runs and browse artifacts (`TECH_DEBT.md` TD-14) |
| No CI | The test suite exists; nothing runs it automatically (`TECH_DEBT.md` TD-20) |

Fixed since first written up, kept here only so the fix isn't re-discovered as new: a correct test
could be rejected outright (TD-01), a failing test's report could be destroyed before diagnosis
ever read it (TD-02), a Groq rate limit could kill a run instead of backing off (TD-03), a
role target with no name could crash spec generation and take down an entire run with zero cases
produced (TD-30), a not-yet-hydrated page could be cached as a valid empty AppModel with nothing
to ground against (TD-31), a page
title could only be asserted as body text where it can never appear (TD-06), live locator
resolution matched by substring instead of exact name (TD-32), the deterministic failure
classifier missed one common Playwright timeout wording (TD-33), a `visible` assertion could lock
onto a hidden same-named element (TD-34), and one hidden-element click could burn ~113s and blow
the executor's kill timer (TD-36).

By design, not a defect: **no built-in demo credentials.** There's no per-site autofill list —
credentials come from your prompt when it carries them, otherwise the run pauses and asks via the
UI the moment discovery finds a live login gate (or times out and continues without them,
`CREDENTIAL_WAIT_MS`). See `DECISIONS.md` D-08 and D-26.

## Configuration

### Environment Variables

All optional except the API key variable. Full descriptions and cost/reliability tradeoffs
are in `.env.example`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEYS` | Yes | Comma-separated Gemini API keys (quota stacks across distinct projects). `GEMINI_API_KEY` (singular) is accepted as a fallback |
| `GEMINI_MODEL` | No | Gemini model for IR generation/discovery/test-cases/failure-analysis — verify against your deployed `.env`, not this table |
| `GEMINI_MODEL_LITE` | No | Gemini model for labeling |
| `LLM_TIMEOUT_MS` | No | Per-attempt abort timeout for any Gemini call (default: 45000) |
| `MAX_LLM_CALLS_PER_RUN` | No | Hard cap on total LLM calls per run, across every stage (default: 60) |
| `MAX_IR_ATTEMPTS` | No | Max IR generate/validate retries per test case (default: 4) |
| `MAX_LIVE_EXTENSIONS` | No | Max browser replays per case to discover pages behind a login/click (default: 5) |
| `MAX_DISCOVERY_PAGES` | No | Max pages a single site crawl may collect (default: 5) |
| `DISCOVERY_HYDRATION_POLL_MS` | No | Max time a zero-element page extraction keeps re-checking before being accepted as final (default: 6000) |
| `MAX_CASES_PER_RUN` | No | Hard ceiling on cases turned into runnable scripts (default: 5) |
| `MAX_LOGIN_CASES` | No | Max cases in a suite that may target the login page itself, on an auth-aware run (default: 1) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `CREDENTIAL_WAIT_MS` | No | How long a paused run waits for credentials before continuing without them (default: 300000 / 5 min) |
| `ENABLE_CASE_SELECTION_GATE` | No | Set `true` to pause a run after generating each batch of cases for review (default: off) |
| `MAX_CASE_REGEN_ATTEMPTS` | No | "Not satisfied" regeneration rounds allowed (default: 3) |
| `MAX_ACCUMULATED_CASES` | No | Cap on cases accepted into the gate's pool across all rounds (default: 5) |
| `CASE_SELECTION_WAIT_MS` | No | How long a gate round waits for your pick before timing out (default: 600000 / 10 min) |
| `PORT` | No | Web UI port (default: 3000) |

### Playwright Config

`playwright.config.ts` — Chromium headless, 50s per-test timeout, 0 retries, screenshot on every
result, trace + video retained on failure only (`DECISIONS.md` D-16).

## Sharing Over the Internet

```bash
# terminal 1
npm run serve

# terminal 2 (no Cloudflare account needed)
cloudflared tunnel --url http://localhost:3000
```

This prints a random `https://<words>.trycloudflare.com` URL. Ephemeral, free, no sign-up.

**Note:** Quick Tunnels buffer SSE responses, so the UI uses polling (`GET /api/runs/:id/state`)
instead of streaming. Both routes exist; SSE works fine on localhost.

**Security:** The server has no authentication (`TECH_DEBT.md` TD-14). Anyone with the URL can
start runs and browse artifacts. Fine for trusted audiences; know this before sharing widely. The
entry URL itself is validated — non-`http(s)` schemes and loopback/link-local/private-range hosts
are rejected — but nothing gates who can submit a run at all.

## Deployment

There is no container or hosting config in this repo — run it directly with `npm run serve`.

Two things worth knowing if you re-add a deployment target:

- **Pin Playwright to an exact version** matching whatever browser build the host image ships. A
  caret range lets `npm install` resolve a newer Playwright than the pre-installed Chromium, which
  then fails to launch with `browserType.launch: Executable doesn't exist`.
- **`MAX_CONCURRENT_RUNS=1` on a small instance** (≤512 MB RAM) — every run launches its own
  Chromium.

`GET /api/health` reports which critical env vars are set (name and length only, never the value).

## Further Reading

See the [Documentation Map](#documentation-map) at the top of this file — one line per document,
one job each.

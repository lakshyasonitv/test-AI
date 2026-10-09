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
| **What each shipped phase changed, and how to roll it back** | [docs/phases/](docs/phases/) |

`docs/phases/` is the build log for the multi-user platform layered on top of the original
single-user tool. One report per phase, each with the same ten sections: what changed, new files,
new flags, new routes, schema changes, what was deliberately left alone, how to verify, how to
roll back, and what was found but not fixed.

## Quick Start

```bash
npm install                  # installs deps + `playwright install` (postinstall — all browsers)
cp .env.example .env         # fill in GEMINI_API_KEYS
npm run serve                # starts server on http://localhost:3000
```

Open the UI, enter a prompt + URL, and watch the phase panel update with live progress. A sidebar
carries the Projects tree (with controls to add a project or a suite) and your recent runs; the
topbar carries a hamburger menu holding History, Team and a Settings popover. The two Settings
toggles — review cases before running, self-heal broken selectors — are **per-session and reset on
reload**; they are held in a plain in-memory object, not in storage.

> **If `npm install` appears to hang,** the `playwright install` postinstall is the usual culprit.
> Check for an `oopDownloadBrowserMain.js` process and a stale `__dirlock` directory under
> `%LOCALAPPDATA%\ms-playwright` (or `~/.cache/ms-playwright`) before assuming anything else is
> wrong — that installer can stall indefinitely without timing out, and it can leave a truncated
> binary behind that looks present but will not execute.

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
| Full coverage suite generation | Up to **4** cases on the default `standard` coverage — `CASE_BUDGET` is `{minimal: 2, standard: 4, full: 5}` and `MAX_CASES_PER_RUN` (default 5) is the *ceiling above* that budget, not the budget itself. Since the composer pins `standard`, 5 is now reachable only from the CLI with `--coverage full`. Kinds: valid path, invalid input, empty fields, boundaries, security. The checklist itself is filtered by scope before it reaches the model |
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

### The platform layer

Built on top of the pipeline above, in the phases logged under `docs/phases/`. Everything here is
behind a flag; with all flags off the tool behaves exactly as it did before any of it existed.

| Capability | Details |
|-----------|---------|
| Sign-in and sign-up | Supabase Auth. `AUTH_ENABLED=false` substitutes a synthetic local owner, so the permission checks still *run* and still *pass* rather than being skipped — a flag-off server exercises the same code path |
| Four org roles | `viewer` < `tester` < `admin` < `owner`. The role is what you may **do** |
| Project membership | A separate axis from the role: it is what you may **see**. A new user is a `viewer` in nothing until an owner or admin adds them to a project |
| Team management | Owners and admins assign roles and project membership from the Team screen |
| Test-case library | Save a finished run's case, then re-run it with **zero LLM calls** — the stored IR replays as pure code |
| Suites | Club cases into suites and execute a chosen subset |
| Case detail view | Per-case screen with steps, the generated script (read-only), version history, and a diff against any earlier version |
| Plain-English step editing | Steps are edited as sentences, not JSON. An edit that changes *which element* a step points at is re-verified against the live site before it saves; an edit that does not (a retyped value, a rename) saves instantly and free |
| Cost shown before it is spent | The editor says how many steps will be re-checked and roughly how long, *before* Save is pressed. Re-grounding runs as a cancellable job with live per-step progress |
| "Write it for me" | A step line typed in loose English is translated into the vocabulary the parser accepts — as a **proposal** you approve. `NL_STEPS_ENABLED`, see [docs/phases/PHASE_NL_STEPS_REPORT.md](docs/phases/PHASE_NL_STEPS_REPORT.md) |
| "Ask for a change" | Describe a change in a sentence and get a proposed step list back, as a diff. Also a proposal — approving it goes through the ordinary parse/re-ground/version path |
| Editing cases at the review gate | With the gate on, a proposed case can be opened and its title, steps and expected outcome changed, removed, or written from scratch — before anything is compiled or a browser opens. The editor lists the page's real controls so you can use the site's own wording. Only the current round's batch is editable |
| Run retention | `RUN_RETENTION_DAYS` ages off `runs/` directories on a schedule |
| History is access-scoped | `GET /api/runs` returns the newest 20 runs **you may see** — filtering happens before the cap, so unfiled runs on disk cannot crowd out your own (`TECH_DEBT.md` TD-54) |

Two rules hold across all of it, and the reason is the same one both times — **one way in, one set
of guarantees**:

- A model **proposes**, it never writes. Every proposal is approved by a person and then travels
  the same parse -> re-ground -> version path a hand-typed edit does.
- Real credentials **never touch disk or the database**. They live in process memory for the
  length of one walk; stored steps keep `${env:...}` references.

### What's Broken

**Tracked in one place: [TECH_DEBT.md](TECH_DEBT.md)** — every known gap, ranked by severity, with
remediation. Not repeated here so it can't drift out of sync (see `DECISIONS.md` D-01).

The headline items, for orientation:

| Issue | Short version |
|---|---|
| Duplicate-named elements can still make a locator ambiguous | Partial mitigation shipped, real fix (page-scoping) still open — `TECH_DEBT.md` TD-05 |
| No blocking-interstitial detection (CAPTCHA/bot walls) at discovery time | `TECH_DEBT.md` TD-04 |
| Authentication is off by default | It **exists** — Supabase Auth, four roles, project-scoped visibility — but `AUTH_ENABLED` defaults off, and with it off every guard resolves a synthetic local owner and allows everything. An unconfigured server is open to anyone who can reach the port (`TECH_DEBT.md` TD-14) |
| CI is not a merge gate | `.github/workflows/test.yml` **does** run `tsc --noEmit` and `npm test` on every push and PR. What is missing is branch protection, so a red run can still merge (`TECH_DEBT.md` TD-20) |

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

All optional except the API key variable. **Most** descriptions and cost/reliability tradeoffs are
in `.env.example` — but that file is not a complete index of this table. `MAX_CASES_PER_RUN`,
`MAX_DISCOVERY_PAGES`, `PLAYWRIGHT_TIMEOUT`, `MAX_SUITE_HEALS`, `APPMODEL_CACHE_TTL_MS`,
`REGROUND_TIMEOUT_MS` and the `SCREENSHOT_*` group are read by the code and documented here only.
(The reverse also holds: `.env.example` lists `GEMINI_EMBED_MODEL`, which nothing in `src/` reads.)

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
| `DISCOVERY_LIVE_DOM` | No | Set `true` to take each page's element list from the LIVE page instead of the static `page.content()` parse: measured visibility, a verified `css` for every element, open shadow roots and same-origin iframes (`DECISIONS.md` D-40–D-43). Every other model field is unchanged. After flipping it, cached models from the other mode can be served for up to `APPMODEL_CACHE_TTL_MS`. Default off — output is then byte-identical to before |
| `MAX_CASES_PER_RUN` | No | Hard ceiling on cases turned into runnable scripts (default: 5) |
| `MAX_LOGIN_CASES` | No | Max cases in a suite that may target the login page itself, on an auth-aware run (default: 1) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `CREDENTIAL_WAIT_MS` | No | How long a paused run waits for credentials before continuing without them (default: 300000 / 5 min) |
| `ENABLE_CASE_SELECTION_GATE` | No | Set `true` to pause a run after generating each batch of cases for review (default: off) |
| `MAX_CASE_REGEN_ATTEMPTS` | No | "Not satisfied" regeneration rounds allowed (default: 3) |
| `MAX_ACCUMULATED_CASES` | No | Cap on cases accepted into the gate's pool across all rounds (default: 5) |
| `CASE_SELECTION_WAIT_MS` | No | How long a gate round waits for your pick before timing out (default: 600000 / 10 min) |
| `GATE_CASE_EDIT_AI` | No | Set `true` to offer "Ask for a change" on a case at the review gate. Editing cases there by hand needs no flag and spends nothing; this gates only the model call (default: off) |
| `SELF_HEAL_DEFAULT` | No | Whether a run self-heals when the request does not say (default: `false`). A heal is a second full test run **and** a full IR regeneration, so it is opt-in — the Settings toggle overrides it per run, and the toggle now opens in whatever state this sets (`TECH_DEBT.md` TD-83) |
| `MAX_SUITE_HEALS` | No | Cap on self-heal attempts across one suite run (default: 3) |
| `LLM_MAX_PROMPT_CHARS` | No | **Hard ceiling on any single prompt** (default: 200000). A prompt over this is refused before it is sent, with a typed error naming the stage. A tripwire, not a tuning knob — one discovery call once sent 514,427 prompt tokens (`TECH_DEBT.md` TD-73) |
| `DISCOVERY_SNAPSHOT_MAX_CHARS` | No | Cap on the accessibility snapshot sent to the vision fallback (default: 40000 ≈ 9.6k tokens, against a largest-observed real call of 3.7k). The JS-detected interactive-elements section is never truncated |
| `LABEL_ELEMENT_NAME_MAX_CHARS` | No | Longest accessible name one element may contribute to the concept-labeling prompt (default: 200). Guards against a name that is really an inlined stylesheet |
| `LABEL_ELEMENTS_MAX_CHARS` | No | Cap on that whole element list (default: 40000) |
| `APPMODEL_CACHE_TTL_MS` | No | How long a discovered site model stays cached, against file mtime (default: 1800000 / 30 min). **Set to `0` to disable caching entirely** — what you want while iterating against a site you are actively editing |
| `RUN_LOCALE` | No | Locale every browser this project opens presents (default: `en-US`) — DOM discovery, the vision fallback, the site crawl, live-extend replays, and the generated spec's own Playwright run. Sets `navigator.language`, the `Accept-Language` header (as the bare tag — Playwright derives it from the locale and an explicit header cannot override it) and number/date formatting. Unpinned, each inherited the **host's** locale, so a content-negotiating site was discovered in whatever language the container asked for and every later stage inherited it — a run that produced Korean test cases is the recorded symptom. **Set explicitly empty (`RUN_LOCALE=`) to restore the old host-inherited behaviour** — the rollback switch; leaving it *unset* is not the same and means the default. A single run may override it with `POST /api/runs` `{options:{locale}}`, which is checked against the allow-list in `src/browserLaunch.ts`; this variable is not, being operator-set |
| `RUN_TIMEZONE` | No | Timezone every browser reports (default: `UTC`). UTC rather than the host zone so a rendered date does not depend on which machine discovered the page. **This changes dates a site renders**, so a test asserting one may need its expectation regenerated |
| `REGROUND_TIMEOUT_MS` | No | Ceiling on one edited-case re-ground walk (default: 180000 / 3 min) |
| `REWRITE_ELEMENTS_MAX_CHARS` | No | Cap on the element list "Ask for a change" is shown (default: 4000). Without that list the model invents element names from page headings — it once proposed `button "Admin Panel"`, the heading, for a control actually called `button "Admin"` (`TECH_DEBT.md` TD-91) |
| `REPLAY_REGROUND` | No | Set `true` to re-ground a replay's ungrounded steps against the live page before it runs — the steps inside a modal or tab, which discovery never saw (`TECH_DEBT.md` TD-77). Costs a browser walk of the prefix before the run starts and **zero LLM calls**; it never writes back to the saved case, only to the run's own `04-ir.json` marked `groundedAt: "replay"`. Default off |
| `SCREENSHOT_SETTLE_MS` | No | Gap between frames when detecting the page has stopped animating (default: 150) |
| `SCREENSHOT_MAX_SAMPLES` | No | Ceiling on those frames (default: 10) |
| `SCREENSHOT_PAINT_TIMEOUT_MS` | No | How long a step screenshot waits for real rendered content before giving up (default: 8000) |
| `TEST_USERNAME` / `TEST_PASSWORD` | No | Credentials for the site under test. **Setting these suppresses every credential prompt** — in runs, in the case editor and in replay. Convenient for an operator, confusing if you are waiting for a dialog that will never appear. The only two variable names a generated spec may reference |
| `PORT` | No | Web UI port (default: 3000) |
| `SELECT_TIMEOUT_MS` | No | How long a `select` step waits for its options and for the action itself (default: 10000). Server-populated dropdowns are the norm, so the wait is the default — but it exits the moment the control is populated and still has no match, so a wrong-control resolution fails fast instead of looking like a slow network (`TECH_DEBT.md` TD-79) |
| `PLAYWRIGHT_TIMEOUT` | No | Per-test timeout in ms, read by `playwright.config.ts` (default: 50000). Note this one is **not** listed in `.env.example` |
| `AUTH_VERIFY_TIMEOUT_MS` | No | How long discovery polls for the login gate to disappear before reporting `login-failed` (default: 10000, matching `ASSERTION_TIMEOUT_MS`). Polled, so a fast login returns immediately. Raise it for an app that resolves its session slowly after load |
| `PLAYWRIGHT_VIDEO` | No | `on` records every case **and then deletes the recordings of `passed` cases**, so you keep videos for exactly the outcomes worth debugging — failed, blocked, truncated, unconfirmed. `off` records none; unset is `retain-on-failure`, which keeps only what Playwright itself failed and therefore can never give you a blocked or unconfirmed recording. Storage is bounded by the prune; the recording cost per case is not |

#### Platform flags — every one defaults OFF

Added by the phases in `docs/phases/`. The default is off in each case so that a server which has
not been configured for a capability never advertises it.

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ENABLED` | `false` | Real Supabase sign-in. Off substitutes a synthetic local owner |
| `AUTH_TOKEN_REFRESH` | `false` | Renew the sign-in token so a session survives past one hour and idle/sleep. Off = a signed-in tab stops working after an hour (`TECH_DEBT.md` TD-108) |
| `DB_ENABLED` | `false` | Server-side database reads. Requires `SUPABASE_SERVICE_ROLE_KEY` |
| `SUPABASE_URL` | — | Browser-safe project URL |
| `SUPABASE_PUBLISHABLE_KEY` | — | Browser-safe key. Every table is RLS deny-all to it, by design |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Secret.** Server-side only. Never sent to a browser |
| `SIGNUP_ENABLED` | `true` | Note the default: sign-up is **on** unless set to `false`. Set it to `false` before exposing this server beyond localhost |
| `NL_STEPS_ENABLED` | `false` | "Write it for me" — translate loosely-typed step lines. Spends one Gemini call per press |
| `RUN_RETENTION_DAYS` | unset | Age off `runs/` directories after N days. Unset keeps everything |

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

**Note:** Quick Tunnels buffer SSE responses, so the UI uses polling (`GET /api/runs/:id/state`,
once a second) instead of streaming. Both routes exist, but **no browser code consumes the SSE one
anywhere** — `EventSource` does not appear in `public/` at all, on localhost or behind a tunnel. The
same applies to the re-ground job routes, where `pollCaseJob` polls `/state` every 800 ms.

**Security:** authentication exists but is **off by default** (`TECH_DEBT.md` TD-14). With
`AUTH_ENABLED=false` every guard resolves a synthetic local owner and allows everything, so an
unconfigured server lets anyone with the URL start runs and browse artifacts. Before sharing
widely, set `AUTH_ENABLED=true` **and** `SIGNUP_ENABLED=false` — sign-up defaults *on* and creates
real accounts with the service-role key. The entry URL itself is always validated — non-`http(s)`
schemes and loopback/link-local/private-range hosts are rejected — but that is input validation,
not access control.

## Deployment

### Docker Compose (local)

```bash
cp .env.example .env         # fill in GEMINI_API_KEY[S]
docker compose up -d
curl http://localhost:3000/api/health
```

`shm_size: 1g` is set in `docker-compose.yml` so Chromium has enough shared memory; a bare
`docker run` without it will hang or crash on busy pages.

### Azure Container Apps

The image is built in CI (`.github/workflows/image.yml`) and pushed to GHCR — ACR Tasks is
blocked on the student subscription (`TasksOperationsNotAllowed`), so Azure just pulls the
pre-built image.

```bash
# 0. CI pushes ghcr.io/<github-user>/testbench:v1 on every push to main.
#    Manual push (override):
#    docker login ghcr.io -u <github-user>
#    docker buildx build --push -t ghcr.io/<github-user>/testbench:v1 .

# 1. Create the Container App pulling from GHCR
az containerapp up \
  --name ai-test-platform \
  --resource-group <rg> \
  --environment <env-name> \
  --image ghcr.io/<github-user>/testbench:v1 \
  --target-port 3000 \
  --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --env-vars "GEMINI_API_KEYS=<key>" "CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage"

# 2. Mount an Azure Files volume at /app/runs
#    (az containerapp update with volume + volume-mount — see Azure docs for the exact flag set)
```

GHCR packages are private by default — either publish `testbench` publicly or attach a
`repo`-scope PAT as the registry credential on the container app so ACA can pull it.

Azure Container Apps cannot resize `/dev/shm` (it is fixed at 64 MB); set
`CHROMIUM_EXTRA_ARGS="--disable-dev-shm-usage"` so Chromium uses an alternative instead of
crashing. Locally this var is unset, so bare-metal and `docker compose up` are byte-identical.

### Things worth knowing

- **Pin Playwright to an exact version** matching the pre-installed browser. The base
  `playwright:v1.49.0-noble` image and `package-lock.json` resolve the same `1.49.0` — a
  caret range lets `npm install` drift to a newer Playwright than the pre-installed Chromium,
  which fails with `browserType.launch: Executable doesn't exist`.
- **`MAX_CONCURRENT_RUNS=1` on a small instance** (≤512 MB RAM) — every run launches its own
  Chromium. The default is 3; reduce it if the container OOMs.
- **Single replica.** The credential prompt and case-selection gate hold promises in process
  memory; a reschedule drops the promise and wastes the full timeout. Scaling horizontally
  requires an external scheduling layer.
- **`/api/health`** reports which critical env vars are set (name and length, never the value).
  It is a liveness probe only — it returns 200 regardless of Gemini/DB readiness.

Full phase report: [`docs/phases/PHASE_CONTAINERIZATION_REPORT.md`](docs/phases/PHASE_CONTAINERIZATION_REPORT.md).

## Further Reading

See the [Documentation Map](#documentation-map) at the top of this file — one line per document,
one job each.

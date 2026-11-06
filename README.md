# Testbench

**Describe a test in plain English, give a web address, and get real, executed Playwright tests
back** — with per-step screenshots, video, a trace, an HTML report and a plain-English reason for
every failure.

Testbench explores the site the way a new tester would, plans a coverage suite, compiles each case
into a strict test model that is **checked against the live page before it runs**, generates the
Playwright spec with plain code (no AI), and runs every case in its own browser. The AI proposes;
deterministic code verifies.

## Features

- **Prompt + URL → executed tests.** Normal path, wrong input, boundaries and security cases, each
  run in its own browser context with screenshots, video and trace.
- **Discovery without AI cost.** DOM-first page reading, a same-origin site crawl, sign-in on a live
  login form, and AI vision only as a fallback.
- **Grounded, not guessed.** Every button, field, link and route the AI names is checked against
  what was actually found on the site; anything invented is rejected before a test is built.
- **Stay in control.** Review and edit proposed cases before they run, edit steps as plain English,
  save tests to a library, group them into suites and replay them with zero AI calls.
- **Self-repair.** A structural repair first (no AI, no new browser), then a bounded AI self-heal.
- **Requirements in, tests out (Pro).** Upload a PDF, Word or Markdown requirements document; its
  rules and open questions steer which cases are written.
- **Salesforce.** Hardened password login, or **Connect org** over OAuth (no password in runs),
  saved org scans, valid test data from the org's own metadata, and a screen map between runs.
- **Jira.** Each user connects their own Atlassian account; a story key fills the prompt.
- **Your choice of AI.** Google Gemini, Azure OpenAI or Anthropic Claude, per role.
- **Built for teams.** Sign-in, four roles, project-scoped visibility and per-company separation;
  a project's discovery can be shared by its runs.
- **Secrets stay out of storage.** Credentials live in memory for one run; generated tests carry
  `${env:...}` references, and served artifacts are scrubbed.

Every capability beyond the core pipeline sits behind a setting that defaults **off** — with nothing
set, the app behaves exactly as the core pipeline always has.

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install                  # dependencies + Playwright's browsers (postinstall)
cp .env.example .env         # add one AI provider's key, e.g. GEMINI_API_KEYS
npm run serve                # http://localhost:3000
```

Open the UI, type what to test and the address, and press **Run test**. The phase cards update live;
when the run finishes, every case has its result, screenshots, video and a downloadable report.

> **If `npm install` appears to hang,** the `playwright install` postinstall is the usual culprit.
> Check for an `oopDownloadBrowserMain.js` process and a stale `__dirlock` directory under
> `%LOCALAPPDATA%\ms-playwright` (or `~/.cache/ms-playwright`) — that installer can stall without
> timing out, and can leave a truncated binary that looks present but will not run.

**Command line:**

```bash
npm run generate -- --prompt "Test login with an invalid password" --url "https://the-internet.herokuapp.com/login"

# several entry pages and an explicit coverage level (minimal | standard | full, default standard)
npm run generate -- --prompt "Test the homepage" --urls "https://example.com,https://example.com/about" --coverage full
```

## How it works

```
prompt + url
  -> Planner (AI)                     -> structured test plan
  -> Discovery                        -> app model: elements as accessibility role + name
       |_ DOM extraction (primary)     -> cheerio over page.content(), no LLM needed
       |_ auth-aware login             -> signs in on a live login gate before crawling on;
                                          credentials from the prompt or a UI prompt asked
                                          right when the gate is found
       |_ site crawl (same-origin)     -> follows the entry page's own internal links; probes
                                          JS-only nav by clicking once href-following finds none
       |_ AI vision (fallback)         -> only when DOM extraction finds nothing usable
  -> Test Cases (AI)                  -> full coverage suite (valid/invalid/boundary/security)
       \_ case-selection gate (opt.)   -> pauses for you to review/accept/reject a batch and
                                          ask for a refined regeneration, ENABLE_CASE_SELECTION_GATE
       \_ login-case cap              -> at most one case targets the login page itself
  -> Primary-case selection           -> fromPrompt case, else highest priority
  -> IR generation (AI) + grounding   -> strict JSON test model (the contract)
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
  -> Failure Analysis (AI)            -> diagnosis (only on failure)
       \_ Deterministic classifier    -> pattern-matches Playwright errors first (free)
       \_ AI fallback                 -> only for ambiguous cases
       \_ Bounded self-heal (<=1x)    -> re-snapshot (policy-aware) + regenerate + re-run once
```

<details>
<summary><b>Discovery in detail</b></summary>

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

</details>

Full technical detail, file by file: [ARCHITECTURE.md](ARCHITECTURE.md).

<details>
<summary><b>Capabilities in detail</b></summary>

### The pipeline

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

</details>

**Known limitations** are tracked in one place, ranked, with their fixes:
[TECH_DEBT.md](TECH_DEBT.md). They are not repeated here so the two cannot drift apart
(`DECISIONS.md` D-01). By design, there are no built-in demo credentials: a run takes them from your
prompt or asks for them the moment it finds a live login form (`DECISIONS.md` D-08, D-26).

## Project layout

```
src/            the pipeline (stages/), AI providers (llm/), schemas (schema/), server (server/), Jira (jira/)
public/         the single-page UI (no build step)
tests/          vitest suite, including real-browser checks
supabase/       database migrations (identity, organisations, projects, library, org connections)
scripts/        operational scripts (Salesforce discovery probe)
docs/           guides, phase reports, research and an archive — see docs/README.md
project-brain/  working notes carried between development sessions
```

## Documentation

| You want to know… | Read |
|---|---|
| What this is, how to run it, every setting | **this file** |
| How it works internally — every file, every schema | [ARCHITECTURE.md](ARCHITECTURE.md) |
| What is broken or weak, ranked, with the fix | [TECH_DEBT.md](TECH_DEBT.md) |
| Why a design choice was made, and what was rejected | [DECISIONS.md](DECISIONS.md) |
| Working rules for anyone (or any AI agent) changing the code | [CLAUDE.md](CLAUDE.md) |
| Everything else: guides, phase reports, research, archive | [docs/README.md](docs/README.md) |

## Development

```bash
npm run typecheck            # tsc --noEmit (strict, no unused code)
npm test                     # vitest run
```

`.github/workflows/test.yml` runs both on every push and pull request. It is not yet a required
check, so run them before you push (`TECH_DEBT.md` TD-20).

## Configuration

### Environment variables

All optional except one AI provider's key. Every setting the code reads is listed in `.env.example`
with its default and its cost/reliability tradeoff; this table is the short version.

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEYS` | Yes (also for document upload) | Comma-separated Gemini API keys (quota stacks across distinct projects). `GEMINI_API_KEY` (singular) is accepted as a fallback |
| `LLM_PROVIDER` / `LLM_PROVIDER_LITE` | No | Which provider's keys the pipeline uses: `gemini` (default), `azure` (`AZURE_OPENAI_*`) or `claude` (`ANTHROPIC_*`). `_LITE` covers the cheap stages and defaults to `LLM_PROVIDER`. Any other value stops the server at startup |
| `ANTHROPIC_API_KEY` | When a role is `claude` | Claude API key (`ANTHROPIC_API_KEYS` comma-separated also works). `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_MODEL_LITE` (default = `ANTHROPIC_MODEL`), `ANTHROPIC_EFFORT[_LITE]` (unset = model default). See `.env.example` and `DECISIONS.md` D-66 |
| `GEMINI_MODEL` | No | Gemini model for IR generation/discovery/test-cases/failure-analysis — verify against your deployed `.env`, not this table |
| `GEMINI_MODEL_LITE` | No | Gemini model for labeling |
| `LLM_TIMEOUT_MS` | No | Per-attempt abort timeout for any Gemini call (default: 45000) |
| `MAX_LLM_CALLS_PER_RUN` | No | Hard cap on total LLM calls per run, across every stage (default: 60) |
| `MAX_IR_ATTEMPTS` | No | Max IR generate/validate retries per test case (default: 4) |
| `MAX_LIVE_EXTENSIONS` | No | Max browser replays per case to discover pages behind a login/click (default: 5) |
| `MAX_DISCOVERY_PAGES` | No | Max pages a single site crawl may collect (default: 5) |
| `DISCOVERY_HYDRATION_POLL_MS` | No | Max time a zero-element page extraction keeps re-checking before being accepted as final (default: 6000) |
| `DISCOVERY_LIVE_DOM` | No | Set `true` to take each page's element list from the LIVE page instead of the static `page.content()` parse: measured visibility, a verified `css` for every element, open shadow roots and same-origin iframes (`DECISIONS.md` D-40–D-43). Every other model field is unchanged. After flipping it, cached models from the other mode can be served for up to `APPMODEL_CACHE_TTL_MS`. Default off — output is then byte-identical to before |
| `NETWORK_SETTLE_ENABLED` | No | Set `true` to wait until a page has really finished loading before every discovery snapshot and screen capture: in-flight fetch/XHR requests reach 0 for 500 ms (cap 5 s), ignoring long-lived ones (CometD/streaming/long-poll by URL or Bayeux body, or anything open over 3 s), then the existing spinner/control-count settle. Never `networkidle`, which never fires on Salesforce. Adds up to ~1-5 s per snapshot. The walk, single-page and hybrid-crawl cache keys gain a part when it is on, so no model taken under the other setting is served (see `docs/phases/PHASE_NETWORK_SETTLE_REPORT.md`). **It also tightens grounding:** the post-click reveal check counts a field that became visible as revealed and rejects a target still hidden after the click (TD-158). Default off: behaviour and keys are exactly as before |
| `SCREEN_BEST_MATCH_ENABLED` | No | Set `true` so a recaptured screen replaces the stored screen it matches BEST (highest field-label overlap; ties: exact key, exact title, earliest), not the first one the loose same-screen rule accepts. Applies to the run's own screens and to the stored screen map. Without it, two wizard steps that share most labels can swap: step 1 is overwritten by a recapture of step 2 (`docs/phases/PHASE_SCREEN_BEST_MATCH_REPORT.md`). Default off: exactly the old first-match rule |
| `VOLATILE_ID_DETECTION_ENABLED` | No | Set `true` to judge element ids by EVIDENCE across walks, not by their shape: the same element (role + accessible name on the same screen) seen on two walks with a different id has that id marked volatile and never used as a locator again; the same id twice is trusted even if it looks generated (so a meaningful `unit-102` survives on Salesforce runs, TD-133), but only as a FALLBACK: role and label locators (D-55) always come first, and the id is used only when none of them is unique; one sighting keeps the old rule. The store holds role, name, screen, stable yes/no and a 12-hex SHA-1 of the last id (never the id, css, values or credentials), keyed per site, org, credential, locale and cache version (cache namespace `volatileids`). Walk, single-page and crawl cache keys gain a part when on. Default off: exactly the old behaviour |
| `BUTTON_EXPLORER_ENABLED` | No | Set `true` to run the SAFE button explorer after discovery: it clicks tabs, `aria-haspopup`/`aria-expanded` controls and a short list of navigational names (New, Next, Back, View, Open, Show, More, Details, Explore, Expand), never anything with a destructive or committing name, a submit button inside a form, an off-site link, any control inside a Salesforce Screen Flow (`lightning-flow` / `flowruntime-*`, including inside shadow roots), or "Next"/"Finish" on a Salesforce Lightning app (`*.lightning.force.com`, `*.my.salesforce.com`, `/lightning/`); it aborts any non-GET navigation (a form post) while exploring and never types. After each click it settles, records the screen, restores (Escape / Close / Back / reload) and checks the original screen is back. New same-origin pages join the app model; on a Salesforce run with `SCREEN_MAP_ENABLED`, screens and the clicks that open them go into the stored screen map as hints. Every click and skip (with the reason) is written to `runs/<id>/explorer.json`. **Must stay OFF against production orgs:** the network guard cannot block writes, because Aura/LWC send reads AND writes as POST requests, so the name and structure rules are the only protection. Use it only on sandboxes and test sites. Default off |
| `EXPLORER_MAX_CLICKS` | No | Clicks the explorer may make per run (default 15) |
| `EXPLORER_BUDGET_MS` | No | Wall-clock budget for one exploration (default 120000) |
| `HOLLOW_PASS_GUARDS_ENABLED` | No | Set `true` so a positive case (category `valid` or `state-change`) cannot PASS on a screen where the page shows its own error (TECH_DEBT TD-162). Structural checks only, never the wording: before an IR is accepted, the steps before its final assertion are replayed and the screen is read for error markers (a shown `role="alert"` or `aria-live="assertive"` region inside a form; one OUTSIDE a form that was not on screen before the case's last interaction, such as a Salesforce save-error toast, where a banner already showing and a 1px screen-reader route announcer do not count; an `aria-invalid` field and the message its `aria-errormessage` / `aria-describedby` points at; never `role="status"` or `aria-live="polite"`). If there is one, whatever the final assertion says, the IR goes back to the model with the reason; if the attempts run out, the flow ships WITHOUT its trailing assertions, truncated (`truncationKind` `error-assertion`, status truncated_no_assertion: "Unconfirmed", never passed, never self-healed). Every other exit of the compile that could ship a passing IR is checked the same way. It relies on ARIA: an error the page marks only visually (no alert role, no `aria-invalid`) is not seen, and a success message shown as a `role="alert"` inside a form (Bootstrap's `alert-success`) is read as an error, which makes that case incomplete, never passed. Negative and `functional-other` cases are unchanged. For guarded cases the IR cache key and the replay's walk cache key gain a part. Default off: exactly the old behaviour |
| `SALESFORCE_OAUTH_ENABLED` | No | Set `true` (together with `SALESFORCE_ENABLED`) to offer **Connect org** beside "This URL is a Salesforce org" (D-63). The person signs in to the org on Salesforce's own page in a popup (MFA, SSO, passkeys are Salesforce's job), and the run's browsers are then signed in through `frontdoor.jsp` instead of a username and password: no credential prompt, no two-screen login. The IR's login is one step, `navigate ${env:SF_FRONTDOOR_URL}`; the grounding replay and the executed spec resolve it to a fresh signed-in URL, which is never written to disk, events or caches (it is scrubbed from the console, `results.json` and the text artifacts; `trace.zip` is NOT scrubbed, TD-166). Scratch orgs, sandboxes and Developer Edition orgs only (`.scratch.` / `.sandbox.` / `.develop.` in the host, checked on the typed URL and on the `instance_url` Salesforce returns); production is refused. Tokens live in server memory only: a restart forgets connections. A connection is usable only by the organisation that made it, and only for a URL of the same org. Discovery on such a run is not cached. Needs the three variables below. Default off: the routes answer 403 and nothing else changes |
| `SALESFORCE_OAUTH_CLIENT_ID` / `SALESFORCE_OAUTH_CLIENT_SECRET` | With the flag | The Consumer Key and Secret of ONE Salesforce OAuth app, registered once: a **Connected App** is available to users of ANY org (creation is OFF by default since Spring '26: Setup → External Client App Manager → Settings → "Allow creation of connected apps", then App Manager → New App → New Connected App; some orgs need Salesforce Support to enable it), so every org connects by its own URL with no per-org setup; a Local **External Client App** works only inside the org that created it (a Packaged one needs a managed package). OAuth on, scopes `api`, `web`, `refresh_token`, "Require secret for Web Server Flow" and PKCE on, callback below. Put them in `.env` yourself; never in chat, code or tickets |
| `SALESFORCE_OAUTH_CALLBACK_URL` | No | The callback registered on the app. Default `http://localhost:<PORT>/api/salesforce/callback`. Its origin is also the only origin the popup posts the connection id to |
| `MAX_CASES_PER_RUN` | No | Hard ceiling on cases turned into runnable scripts (default: 5) |
| `MAX_LOGIN_CASES` | No | Max cases in a suite that may target the login page itself, on an auth-aware run (default: 1) |
| `MAX_CONCURRENT_RUNS` | No | Max parallel pipeline runs (default: 3) |
| `SUITE_CASE_CONCURRENCY` | No | Suite cases of one run built and executed at once (default: 1, one after another). The primary case still runs first. Every case is a Chromium, and cases of one run share one login (`DECISIONS.md` D-73, `TECH_DEBT.md` TD-180) |
| `MAX_PARALLEL_CASES` | No | Suite cases running at once across every run on the server (default: `MAX_CONCURRENT_RUNS`) |
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
| `PLAYWRIGHT_TIMEOUT` | No | Per-test timeout in ms, read by `playwright.config.ts` (default: 50000) |
| `AUTH_VERIFY_TIMEOUT_MS` | No | How long discovery polls for the login gate to disappear before reporting `login-failed` (default: 10000, matching `ASSERTION_TIMEOUT_MS`). Polled, so a fast login returns immediately. Raise it for an app that resolves its session slowly after load |
| `PLAYWRIGHT_VIDEO` | No | `on` records every case **and then deletes the recordings of `passed` cases**, so you keep videos for exactly the outcomes worth debugging — failed, blocked, truncated, unconfirmed. `all` records every case **and keeps every recording**, passed ones included, so every case has a video. `off` records none; unset is `retain-on-failure`, which keeps only what Playwright itself failed and therefore can never give you a blocked or unconfirmed recording. Storage is bounded by the prune; the recording cost per case is not |

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
| `SPEC_INTAKE_ENABLED` | `false` | Pro document intake: a Pro toggle on the home screen to upload one requirements document (PDF/.docx ≤ 10 MB, Markdown ≤ 2 MB), distilled by one Gemini call — pinned to Gemini even under `LLM_PROVIDER=azure`, so `GEMINI_API_KEYS` must be set — into rules and open questions the user corrects before they steer case generation. The document is never stored. Off: no toggle, `/api/spec/*` return 403, `options.spec` is ignored. `SPEC_DISTILL_MAX_OUTPUT_TOKENS` (default 8192) caps that call's output |
| `PRO_STORY_PROMPT` | `false` | With `SPEC_INTAKE_ENABLED`: after Continue, an empty prompt box is filled with a plain request built from the confirmed story (a typed prompt is never overwritten; a "Use the requirements as the prompt" button is offered instead), and a Pro run's planner also reads the story, so a vague prompt like "test as per the story" still plans the story's flow. No extra AI call. See `TECH_DEBT.md` TD-184 |
| `SALESFORCE_ENABLED` | `false` | Shows "This URL is a Salesforce org" under the URL box on the run screen. Ticking it sends `options.targetApp: "salesforce"` with the run, which stages read through `currentRunTargetApp()` (`src/runTarget.ts`) and which is recorded in `runs/<id>/00-run-target.json`. Nothing is stored or configured in advance — the URL and credentials are given exactly as for any run. Off: no checkbox, and the field is ignored. See `DECISIONS.md` D-50 |
| `EXTENDED_LOGGING` | `false` | Extra diagnostic output only. Per-call LLM lines, a per-run token line, a wider `[startup]` block, and (D-61) one `[insight] run=… stage=… key=value` line per pipeline fact — discovery element counts and stable-locator share, app-model / Pro-rules / IR / spec sizes, compile rejections, per-step execution times, cache hits, stage durations — also saved as `runs/<id>/10-insights.json`. Never logs credentials, page text, AI-written prose or URL query strings |
| `SALESFORCE_FIXED_LOGIN` | `false` | Ticked Salesforce runs only. Generated tests log in through one fixed Salesforce login routine (email-first screen, ad block, one- or two-screen login, clear failure reasons, no login screenshots), and a "log in with valid credentials" case reuses the login discovery recorded instead of writing its own. Also (D-70): the org's login and Lightning hosts count as one app, a post-login "go to login page" step goes where the login landed, and a test that only checked login is labelled. Off, or unticked: every compile and spec is exactly as before. See `DECISIONS.md` D-65, D-70 |
| `SALESFORCE_ALLOW_ALL_ORGS` | `false` | Ticked Salesforce runs accept every Salesforce org (production, Developer Edition, `login.`/`test.salesforce.com`), not only scratch orgs and sandboxes; a non-Salesforce URL is still refused. A production or other non-test org is named in the server log, on the run screen's discovery line and in the HTML report, since generated tests create and change real records. See `DECISIONS.md` D-68 |
| `PROJECT_DISCOVERY_SHARING` | `false` | A project's site discovery is saved for **7 days** and reused by every run of that project with the same URL and the same login, instead of exploring the site each time (and instead of the 30-minute global cache). If several people start runs on one project at once, one explores and the others wait and reuse it. "Explore the site again" on the home screen makes the next run explore afresh and replace the saved one. Separate per company and per project. Org-connection Salesforce runs keep their own saved scan (`SALESFORCE_DISCOVERY_CACHE_ENABLED`). See `DECISIONS.md` D-72 |
| `REGRESSION_MEMORY_ENABLED` | `false` | Regression testing step 1, "Remember": a case saved from a run also keeps its plain-English meaning (steps, expected result, intent, category), the Salesforce org's setup for the objects it touches, and its one-time values (an org record id, a fixed date: returned as `warnings` on save). The generated test also records what each element looked like just before its step acted (how many elements matched, tag, name, page path, and the Salesforce field from Lightning's `data-target-selection-name`) into `artifacts/elements.json`; a case saved from a passing run keeps it. A case that only passed after a self-heal is not saved until the person confirms (409 `healed-needs-review`, then `acceptHealed: true`). See `DECISIONS.md` D-76 |
| `REGRESSION_CHANGE_CHECK_ENABLED` | `false` | Regression testing step 2: "Check this suite for changes" (`POST /api/suites/:suiteId/change-check` with `sfConnectionId`). Compares the Salesforce org now with what each saved case remembered, per object, with read-only API calls through Connect org: **affected** (a field it uses removed or retyped, a picklist value or record type it uses gone), **likely to fail** (a new required field it does not fill), **changed** (a label renamed on the same field, a validation rule or flow changed), **unknown** (could not be read — never reported as unchanged), plus a note when the Salesforce release changed. The connection must belong to the same org as every case. See `DECISIONS.md` D-76 |
| `REGRESSION_REPAIR_ENABLED` | `false` | Regression testing step 3, the safe repair. After a replay, a case whose click, fill, select or press lost its element gets a repair looked for — no model: the same Salesforce field by its API name at its current label, or one exact unique match of the same role and name. Kept only if it changes that one locator, is a real change, the whole test passes again from step 1, and (Salesforce) the saved record reads back with the typed values. A failed check is reported as a possible bug and never repaired; most of a suite failing at once repairs nothing. Shown as **Healed, needs review** (still failed) until approved; the saved case is untouched. Step 4: **Approve** saves the verified test as the next version of the same case (refused if the case changed since the run), **Reject** is remembered so that repair is not proposed again, and a step edited by hand is pinned and never repaired automatically. See `DECISIONS.md` D-76 |
| `MULTI_VALUE_CONTROLS_ENABLED` | `false` | Fields that take several values. A `select` step ADDS its value: in a Salesforce multi-select picklist (Lightning dual listbox) the option is moved into the chosen list and that is confirmed (before, it was only highlighted and the step passed); in a checkbox group the named box is checked; in a `<select multiple>` it joins the selection. A checkbox or radio drawn by SLDS (hidden input, painted box) is checked through its label and verified, in the spec and the grounding replay (before, `check` timed out). On Salesforce screens a select naming a box in a checkbox group becomes a `check`; the test data splits `A;B` on a multi-select picklist into one select per option. Off: specs and replays exactly as before. See `DECISIONS.md` D-77 |
| `SALESFORCE_FLOW_CHECKS_ENABLED` | `false` | Org-connection runs only. Record-triggered flows that set fields on their own record (before-save "fast field updates", after-save "update triggering record") are checked: when a case saves a record and its own typed values meet the flow's start conditions, the test reads each field the flow sets from the SAVED record through the org connection (REST, GET only) and compares it with the flow's value. Conditions it cannot decide, assignments behind a decision or from a formula: not checked, and the compile log says why. Off: org model and IRs as before. See `DECISIONS.md` D-78 |
| `JIRA_ENABLED` | `false` | Jira Phase 1: "Connect Jira" above the prompt box. Each user signs in to their own Atlassian account (OAuth 2.0, read-only `read:jira-work`), types a story key, and the story's title and description fill the prompt box; the URL and Run are unchanged. Needs `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`; `JIRA_REDIRECT_URL` defaults to `http://localhost:<PORT>/api/jira/callback` and must match the Atlassian console exactly. The Jira token is held in server memory only, so a restart means connecting again. `JIRA_MAX_PROMPT_CHARS` (default 4000) caps the text. See `DECISIONS.md` D-71 |
| `DETERMINISTIC_HEAL` | `false` | A failed step is first re-matched against the discovered page by structure (renamed or moved element), with no AI call and no new browser, before the AI self-heal is tried |
| `SCREEN_MAP_ENABLED` | `false` | Salesforce runs remember the screens their captures reach (names only, never selectors) and show them to the next run as hints. See `DECISIONS.md` D-54 |
| `ORG_LLM_CONFIG_ENABLED` | `false` | An organisation can store its own Gemini key, model and budget (sealed with `LLM_KEY_FILE`, never returned to a browser). Off: the routes 404 and runs use the env keys |
| `SCRIPT_OVERRIDE_ENABLED` | `false` | A saved case can carry a hand-written Playwright script. Off: the routes 404 and a stored override does not run |
| `TEST_DATA_ENABLED` | `false` | On Salesforce org-connection runs, positive cases get valid typed values from the org's own metadata (unique names, required fields filled by type, real picklist options). Negative cases are never touched |
| `SALESFORCE_DISCOVERY_CACHE_ENABLED` | `false` | An org-connection run reuses a saved discovery (up to 24 h) while the org's setup fingerprint is unchanged, instead of crawling again |
| `SALESFORCE_DEEP_DISCOVERY_ENABLED` | `false` | Org-connection runs only. For up to 3 objects the request names, also reads each record type's own form fields and picklist values, the Dynamic Forms visibility rules on the record page, and what formula and roll-up fields compute; the case writer is told these facts. Read-only API calls, a few per object. See `DECISIONS.md` D-75 |
| `SALESFORCE_PRODUCTION_ORGS_ENABLED` | `false` | "Connect org" also accepts production orgs, not only scratch, sandbox and Developer Edition. Runs create real records there |
| `SALESFORCE_CLEANUP_ENABLED` | `false` | After an org-connection run, delete the records that run created (only those the org confirms the connected user created since the run began) |
| `RUN_RETENTION_DAYS` | unset | Age off `runs/` directories after N days. Unset keeps everything |

### Playwright config

`playwright.config.ts` — Chromium headless, 50s per-test timeout, 0 retries, screenshot on every
result, trace + video retained on failure only (`DECISIONS.md` D-16).

## Sharing over the internet

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

Every push to `main` runs `.github/workflows/deploy.yml`: it builds the image, pushes it to GHCR
(tagged with the commit SHA, `v1` and `latest`), rolls it out to the `testbench` Container App in
`testbench-rg`, waits for the new revision to be the only active one, then calls `/api/health`.
A deploy changes the image only; settings and secrets are managed on the Container App with
`az containerapp update --set-env-vars …` and `az containerapp secret set …`, and stay as set.

First-time creation, for reference:

```bash
# 1. Create the Container App pulling from GHCR
az containerapp up \
  --name testbench \
  --resource-group <rg> \
  --environment <env-name> \
  --image ghcr.io/<github-user>/testbench:v1 \
  --target-port 3000 \
  --ingress external \
  --min-replicas 0 --max-replicas 1 \
  --env-vars "CHROMIUM_EXTRA_ARGS=--disable-dev-shm-usage"

# 2. Store API keys as secrets, never as plain values
az containerapp secret set -n testbench -g <rg> --secrets gemini-keys="<key1>,<key2>"
az containerapp update -n testbench -g <rg> --set-env-vars GEMINI_API_KEYS=secretref:gemini-keys

# 3. Mount an Azure Files volume at /app/runs so run results survive restarts
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
- **Size `MAX_CONCURRENT_RUNS` to the machine** — every run launches its own Chromium. The default
  is 3; use 1 on a small instance (≤512 MB RAM). Roughly 1 vCPU and 2 GB per concurrent run is a
  safe starting point; watch memory and lower it if the container restarts. With
  `SUITE_CASE_CONCURRENCY` above 1, size `MAX_PARALLEL_CASES` the same way: it counts suite cases,
  each one a Chromium, across all runs.
- **Single replica.** The credential prompt and case-selection gate hold promises in process
  memory; a reschedule drops the promise and wastes the full timeout. Scaling horizontally
  requires an external scheduling layer.
- **`/api/health`** reports which critical env vars are set (name and presence, never the value
  and not even its length — `DECISIONS.md` D-38).
  It is a liveness probe only — it returns 200 regardless of Gemini/DB readiness.

Full phase report: [`docs/phases/PHASE_CONTAINERIZATION_REPORT.md`](docs/phases/PHASE_CONTAINERIZATION_REPORT.md).

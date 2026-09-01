# Technical Debt Register

This is the single owner of "what's broken and why." `README.md` and `ARCHITECTURE.md` point
here instead of keeping their own copies — this list used to live in up to six documents at once
and every copy drifted out of date; see `DECISIONS.md` D-01 for why the docs are structured this
way now.

Every item was verified against the real code or a real run under `runs/` — not inferred from a
comment or a previous doc's claim. Where an item cites a run id, that run's artifacts are (or
were, at time of writing) on disk and were inspected directly.

## Legend

**Severity** — `Critical` breaks correctness or loses data for a user today · `High` frequent,
costly, no workaround · `Medium` real impact, bounded or has a workaround · `Low` cosmetic, rare,
or already mitigated.

**Type** — `Strategic` a conscious tradeoff made to ship faster or keep scope narrow; the team
knows the corner was cut and could reconsider it deliberately · `Accidental` unintended — code
drifted from its own stated intent, a bug slipped through, or a gap nobody chose on purpose.

**Owner** — who should decide/fix this. `?` means genuinely undecided — not "unassigned busywork,"
but "nobody has yet judged whether this is worth fixing, or how." Don't clear a `?` without
actually making that call.

## Status of fixes landed this session

- **TD-01 (`missingActions` false-positive), TD-02 (SIGKILL destroys the report), TD-03 (Groq 429
  feedback loop): fixed and confirmed working against a real post-restart run**
  (`runs/2026-08-14T20-25-38…70279845`) — `execute` completed in 79.9s (no SIGKILL), `raw` was a
  real parsed Playwright report (not `null`), and the failure diagnosis had actual error text to
  work from for the first time. (Initial verification of TD-02/TD-03 was blocked by a stale,
  pre-fix `npm run serve` process — `tsx` has no watch/reload, so a running server keeps
  executing whatever was on disk when it started. Restarting the server was the missing step;
  see `CLAUDE.md`'s sharp-edges list.)
- **TD-05 (duplicate-locator ambiguity): partial mitigation shipped**, not the full fix. See
  TD-05's own entry — `.first()` on a genuinely-ambiguous match landed as a stopgap; the real
  fix (page-scoping the merged AppModel) is still open.
- **TD-21 (`strategy.test.ts` flake): fixed** — the dynamic `hybridDiscovery.js` import is now a
  single module-level `await import`, not five inline re-imports.
- **TD-32, TD-33: new, found and fixed while diagnosing the confirmation run above** — see their
  entries below.

## Summary

| ID | Item | Severity | Type | Owner |
|---|---|---|---|---|
| TD-01 | `missingActions` can hard-fail a run over a *correct* IR | Critical | Accidental | Lakshya |
| TD-02 | Executor's SIGKILL destroys the report needed to diagnose the failure it just caused | Critical | Accidental | Lakshya |
| TD-03 | Rate-limit handling burned IR-attempt budget instead of backing off — **fixed** (backoff wording + free rate-limit retries; the whole provider it was filed against, Groq, is also gone — `DECISIONS.md` D-21) | High | Accidental | Lakshya |
| TD-04 | No general mechanism for a blocking interstitial (CAPTCHA, cookie wall, OTP, age gate) | High | Strategic | ? |
| TD-05 | Duplicate element names in a merged multi-page AppModel produce ambiguous locators — *partial mitigation shipped, `.first()` fallback on genuine ambiguity; page-scoping fix still open* | High | Accidental | Lakshya |
| TD-06 | IR assertion vocabulary has no title assertion — **fixed** (`title_contains`/`title_equals`) | Medium | Accidental | Lakshya |
| TD-07 | Generated spec's locator helpers have already diverged from `targetResolver.ts` | Medium | Strategic (root) / Accidental (drift) | Lakshya |
| TD-08 | `safeClick` treats `javascript:`/`mailto:`/`tel:` hrefs as real navigation | Medium | Accidental | Lakshya |
| TD-09 | `safeClick` swallows a strict-mode error on duplicate-named links | Medium | Accidental | Lakshya |
| TD-10 | Credential policy is case-scoped, not leg-scoped | Medium | Strategic | Lakshya |
| TD-11 | Wording-based (regex-over-English) detection is used well beyond login fields | Medium | Strategic | ? |
| TD-12 | The user's literal prompt instructions are paraphrased before any deterministic stage sees them | Medium | Strategic | ? |
| TD-13 | Visibility accuracy only guaranteed for selector-bearing elements | Low | Strategic | Lakshya |
| TD-14 | No server authentication | High | Strategic | ? |
| TD-15 | A stale poll response can misdirect a credential submission to the wrong run | High | Accidental | Lakshya |
| TD-16 | `runs/` grows unbounded and is served publicly with no pruning | Medium | Strategic | ? |
| TD-17 | `store.read()` / `listRuns()` have no per-entry error isolation | Medium | Accidental | Lakshya |
| TD-18 | Entry-URL allow-list is a pre-DNS-lookup hostname check (DNS-rebinding residual) | Low | Strategic | Lakshya |
| TD-19 | Single-process, no multi-user isolation or per-user quotas | Low | Strategic | Lakshya |
| TD-20 | No CI runs the test suite | High | Strategic | Lakshya |
| TD-21 | `tests/strategy.test.ts` flakes ~1 run in 6 under parallel load — **fixed**, import hoisted to module scope | Medium | Accidental | Lakshya |
| TD-22 | LLM disk cache never expires; a key missing an input dimension serves stale results forever | Medium | Strategic | Lakshya |
| TD-23 | Case-selection-gate progress events briefly corrupt the phase summary text | Low | Accidental | Lakshya |
| TD-24 | `PLAYWRIGHT_TIMEOUT` env var is set but never read; comment implies otherwise — **fixed** | Low | Accidental | Lakshya |
| TD-25 | Deleting the currently-viewed run leaves its polling loop running forever | Low | Accidental | Lakshya |
| TD-26 | Credential prompt fires even when no case in the suite has a login step | Low | Accidental | ? |
| TD-27 | `caseAccumulator.appendAcceptedCases` doesn't dedup near-duplicate titles within one batch | Low | Accidental | Lakshya |
| TD-28 | `wantsRealCredentials` — dead code, or the policy entry point that was never wired in? | Low | ? | ? |
| TD-29 | A username was once observed reaching disk unreferenced — never root-caused | Low | ? | ? |
| TD-30 | A role target with no name (empty-string OR absent) bypasses grounding entirely and crashes spec generation — **fixed** | High | Accidental | Lakshya |
| TD-31 | A not-yet-hydrated page (0 extracted elements) is accepted as a valid AppModel with no retry — **fixed** (polls before accepting) | High | Strategic (root) / Accidental (in effect) | Lakshya |
| TD-32 | `locate()`/`resolveRoleWithFallback` matched names by substring, not exactly — **fixed** | High | Accidental | Lakshya |
| TD-33 | `classify.ts` didn't recognize the "Timed out ... waiting for expect(...)" assertion-timeout wording — **fixed** | Medium | Accidental | Lakshya |
| TD-34 | A `visible` assertion's locator could resolve to a hidden same-named candidate ahead of a visible one — **fixed** | High | Accidental | Lakshya |
| TD-36 | `safeClick`'s ladder had unbounded calls (~113s worst case), blowing the executor kill timer — **fixed** | High | Accidental | Lakshya |
| TD-37 | "Assert submit button hidden" generalized from login to any form with a preceding fill — **fixed** | High | Accidental | Lakshya |
| TD-38 | `Diagnosis.suggestedFix`/`explanation` are untrusted free text with no deterministic verification fed back into IR generation or heal | Medium | Accidental | ? |
| TD-39 | `MESSAGE_LIKE` keyword scan missed gratitude-phrased confirmation copy, leaving a wrong guessed assertion uncorrected — **fixed** | High | Accidental | Lakshya |
| TD-40 | Login detection read the extracted PageModel, which is lossy on real SPA logins (no `<form>`, placeholder-only naming) — **fixed** (live-DOM detection) | High | Accidental | Lakshya |
| TD-41 | A shared `BrowserContext` was not enough — sessionStorage is scoped to a tab, not a context — **fixed** (one shared `Page` for the whole crawl) | High | Accidental | Lakshya |
| TD-42 | "Login succeeded" was inferred from the URL changing, wrong in both directions — **fixed** (verify the login form is actually gone) | High | Accidental | Lakshya |
| TD-43 | The login prefix was gated by credential-substitution policy instead of the case's target page — **fixed** (`needsLoginPrefix`) | High | Accidental | Lakshya |
| TD-44 | The login prefix raced its own submit request, navigating on before the session landed — **fixed** (settle assertion) | High | Accidental | Lakshya |
| TD-45 | Redaction corrupted the AppModel when a credential value collided with an ordinary DOM keyword — **fixed** | High | Accidental | Lakshya |
| TD-46 | Discovery-time credential prompt could park a run with no UI to answer it — **fixed** (missing `credentials` event pair) | Medium | Accidental | Lakshya |
| TD-47 | A failed login was cached for up to 30 minutes, silently repeating the failure — **fixed** (never cache `login-failed`) | Medium | Accidental | Lakshya |
| TD-48 | SPA nav-button click-probe missed anchor-based routes with no `href` (saucedemo shape) — **fixed** (widened + destructive-verb guard) | Medium | Accidental | Lakshya |
| TD-49 | `discoverPagesHybrid` (multi-URL entry) remains auth-unaware | Medium | Strategic | ? |
| TD-50 | Click-probe candidate cap is document order, not priority order | Low | Strategic | ? |
| TD-51 | History screen can only ever show the newest 20 runs — `listRuns()` has no paging and re-reads every run's full event log per call | Medium | Strategic | ? |

---

## Pipeline correctness

### TD-01. `missingActions` can hard-fail a run over a *correct* IR — Critical / Accidental

**What it is.** `missingActions` (`src/stages/ir.ts:724-759`) flags an IR as incomplete by testing
regexes (`CASE_ACTION_LINE`, `ir.ts:721`) against the case's own title/steps/expected text joined
together — not against anything structural. `check` is itself in the action-verb regex, so any
"Check that X is visible" step counts as an action the IR must contain a `click`/`press` for.
There is no quote-awareness: an element *name* quoted inside a step (`'Click the button below to
continue shopping'`) matches the same regex as an instruction.

**Why it hurts.** Reproduced twice against real runs (`2026-08-14T13-34-57…8650cdc3`,
`…12-56-15…5fdb82c2`): a purely assertive, correctly-grounded IR was rejected 4 times running,
each rejection re-spending an LLM call, and — confirmed by reading the loop — a `missingActions`
rejection `continue`s without calling `trackBestPartial` (`ir.ts:1217-1223`), so `bestPartial`
stays null and after `MAX_ATTEMPTS` the function reaches `throw new Error(...)` at `ir.ts:1425`.
There is no truncation fallback on this path — the entire run dies, not just the case. Same defect
class already fixed twice elsewhere in this file (A11-equivalent: leftmost-match-over-whole-string
bugs; D3-equivalent: an unrelated field bridging a match) — the pattern keeps recurring because the
underlying idea (verify prose against prose) is the wrong tool.

**Remediation.** (1) Strip quoted spans (`'...'`/`"..."`) from the joined text before testing the
action-verb regexes — a name mentioned inside quotes is not an instruction. (2) Drop `check` from
`CASE_ACTION_LINE`; "check" is used both as an instruction verb and, constantly, as ordinary
element-name prose. (3) Regardless of (1)/(2), a `missingActions` rejection should feed
`trackBestPartial` like every other kind of grounding rejection, so a run that can't get past this
guard degrades to `truncated` instead of throwing — matching what `TECH_DEBT.md`'s own predecessor
document predicted this guard would do.

### TD-02. Executor's SIGKILL destroys the report needed to diagnose the failure it just caused — Critical / Accidental

**What it is.** `executor.ts`'s per-run timer (`CONFIG.TIMEOUTS.TEST_RUN = 60_000`, lines ~20-24)
`SIGKILL`s the Playwright child at 60s (kill site, lines 176-181); `runSpec` retries once
(`RETRIES: 2`, `RETRY_DELAY: 2_000`). A killed process never reaches the JSON reporter's `onEnd`,
so `results.json` is never written and `raw` stays `null`.

**Why it hurts.** Confirmed against two real runs on unrelated sites
(`2026-08-14T10-46-05…667f7f76`, `…08-02-37…a3e854b6`): both `execute` stages measured **122.1s**
— exactly 60 + 2 + 60 — and both runs' failure diagnoses blamed the wrong step (`s5` instead of the
real `s2`; `s3` instead of the real `s2`), confirmed by screenshot-count forensics
(`step-N.png` highest index = last completed step) against `06-diagnosis.json`. `results.json`
exists for exactly the *passing* cases in both runs and is absent for exactly the *failing* ones.
Every diagnosis on this path is a guess with no error text behind it — this is the mechanism
behind what used to be recorded only as "failure diagnosis can attribute a failure to the wrong
step, never investigated further." It is now investigated: it's this.

**Remediation.** Don't kill before the child can flush a report. Either raise
`CONFIG.TIMEOUTS.TEST_RUN` comfortably above Playwright's own per-test timeout
(`playwright.config.ts:5`, currently 50s and now genuinely configurable via `PLAYWRIGHT_TIMEOUT`
per TD-24's fix — the two are no longer at risk of silently drifting apart), or give the child a
bounded grace period after Playwright's own timeout fires before
sending `SIGKILL`, so `onEnd` gets a chance to write `results.json` even for a test that legitimately
timed out. Consider `trace: "on-first-retry"` (cheaper than `retain-on-failure`) if trace/video
finalization on a large failing case turns out to be what's pushing total time past 60s — worth
confirming with a timed instrumented run before assuming it's the whole story.

### TD-03. Rate-limit handling burned IR-attempt budget instead of backing off — High / Accidental — Fixed

**What it is.** Originally filed against Groq: `groq.ts:64` passed `maxRetries: 2` to
`callWithPool` on the grounds that `ir.ts`'s own `MAX_ATTEMPTS` loop was the outer retry (comment
at `groq.ts:22-26`). But `backoff.ts`'s `parseRetryDelay` only matched the literal string
`retry in Ns` — Groq's actual 429 body says `"Please try again in 495ms"`, which the regex didn't
match, so the server's own hint was discarded and a generic exponential backoff was used instead.
Separately, and worse: when retries were exhausted, `ir.ts` caught, burned one of
`MAX_IR_ATTEMPTS`, and immediately re-sent the same multi-thousand-token prompt — adding load to
the very per-minute-token budget that had just rejected it. Two distinct bugs under one filing:
a backoff-wording mismatch, and a rate-limit failure being charged like a genuine schema error.

**Why it hurt.** Reproduced directly: run `2026-08-14T13-29-09…a1677304` died after a **495ms**
rate-limit wait turned into a dead run within 18 seconds, at `TPM: Limit 12000` against measured
per-run spend of 11.6k-46.5k tokens (`08-groq-usage.json` across the last 5 runs) — this wasn't
edge-case token usage, it was routine.

**Fix applied.** In two parts, on different timelines:
- The backoff-wording clause was fixed first: `parseRetryDelay` (`backoff.ts`) now also matches a
  millisecond form (`retry in Nms`), and `maxRetries` was raised 2 → 4.
- The attempt-budget clause — "a rate-limit failure shouldn't cost one of `MAX_ATTEMPTS` the way a
  genuine schema failure does" — was the part this filing left unimplemented; `isRateLimitError`
  (`backoff.ts`) existed as a dead export, defined but never imported, until it was wired into
  `ir.ts`'s retry loop: up to 3 separately-bounded free retries (`rateLimitRetries`,
  `MAX_RATE_LIMIT_RETRIES`) for a rate-limit error, decrementing the loop counter so the retry
  doesn't also cost an `MAX_ATTEMPTS` slot, before falling through to the normal (attempt-costing)
  path for a permanently rate-limited key. Verified via `tests/irAuthError.test.ts`'s 429 case.
- Overtaken by a bigger change in the same pass: the provider this was filed against is gone.
  IR generation moved from Groq to Gemini entirely (`DECISIONS.md` D-21) — partly *because of*
  this class of pressure (Groq's per-org, not per-key, rate limit meant adding keys couldn't
  relieve it the way it can for Gemini). The fix above is written provider-agnostically
  (`isRateLimitError` takes any `err`, not a Groq-shaped one) and was verified against the
  now-live Gemini call path, not against Groq.

### TD-04. No general mechanism for a blocking interstitial (CAPTCHA, cookie wall, OTP, age gate) — High / Strategic

**What it is.** The only "a form is blocking the target element" handling that exists is
login-shaped: `credentials.ts` + `pendingCredentials.ts` + the server's pause/ask flow. Discovery
has no equivalent concept, and `executor.ts`'s `detectBlocked` only recognizes a block
*post-execution*, by matching English phrases ("verification code", "captcha") against page text
— it can report a block, never resolve one, and won't recognize a non-English or unconventionally
worded gate.

**Why it hurts.** Reproduced directly: three consecutive runs against `amazon.in`
(`2026-08-14T13-34-57…8650cdc3`, `…13-29-09…a1677304`, `…12-56-15…5fdb82c2`) all modelled the
site's bot-check interstitial — a textbox with a randomized name, a "Continue shopping" button,
and a heading reading "Click the button below to continue shopping" — as if it were the real
homepage. Every test case generated from it targeted the wrong page. `07-suite-summary.json`
reported `blocked: 0` in every one. This is also causally upstream of TD-01 in the same runs: the
interstitial's own heading text is what supplied the trigger word that made `missingActions`
misfire.

**Remediation.** This is a design project, not a one-line fix (see `README.md`'s "Eight Steps"
successor in `DECISIONS.md`) — flagged `?` deliberately, needs a product decision on scope before
implementation. A first useful increment that doesn't require the general mechanism: detect the
interstitial shape at *discovery* time (near-empty page, a single dominant CTA, page title/URL
unchanged from a known "challenge" pattern) and surface it as `blocked` before any case generation
spends tokens on it, rather than only detecting it after execution has already run against the
wrong page.

### TD-05. Duplicate element names in a merged multi-page AppModel produce ambiguous locators — High / Accidental

**What it is.** `hybridDiscovery.ts`'s site crawl merges every reachable page's elements into one
`AppModel`. Shared header/footer/nav markup repeats per page, so a name that appears once per
crawled page appears `N` times in the merged model. No IR target carries `nth` — the IR stage
never emits it, even though `Target.nth` exists in the schema and the generated `locate()` helper
already honors it.

**Why it hurts.** Reproduced against `2026-08-14T08-02-37…a3e854b6` (anandice.ac.in, 5 crawled
pages): 209 of 313 distinct element names are duplicated, several 8×. 3 of 4 case failures in that
run trace directly to `locate()` exhausting every fallback and returning the deliberately-ambiguous
`original` locator, which Playwright then correctly reports as a strict-mode violation. **The fix
is not "emit `nth` from the AppModel ordinal"** — the model's ordinal (e.g. 8th occurrence across 5
merged pages) has no relationship to the live single-page ordinal (typically 2, header + footer);
an `nth` derived from the merged model would as often point at the wrong element as the right one.

**Remediation.** Two independent angles, either alone helps: (1) for a `visible`/`hidden` assertion
specifically — where any matching instance genuinely proves the assertion — have `locate()` fall
back to `.first()` on a resolvable-but-ambiguous match instead of returning an unresolvable
`original`; this doesn't require the model to disambiguate anything. (2) Page-scope the AppModel
(elements already carry `path`/`order` — group and query by the page a target's *preceding*
navigate step actually lands on) so an `nth` computed for a specific page becomes meaningful.
Related, found investigating this: `safeClick`'s `href` lookup (`generator.ts`'s
`SAFE_CLICK_HELPER`) swallows the same strict-mode error via `.catch(() => null)` and silently
falls through — see TD-09.

### TD-06. IR assertion vocabulary has no title assertion — Medium / Accidental — Fixed

**What it is.** `src/schema/ir.ts`'s assertion enum was
`visible | hidden | text_equals | text_contains | url_contains | enabled | disabled` — no
page-title assertion, with `url_contains` the only page-level (non-locator) option available.
When a test case said "verify the page title is X," the IR degraded it to a `text_contains`/
`text_equals` against a `{text: X}` target, which `generator.ts`'s `emitAssert` compiled to a
body-text search for a string that, on most sites, only ever exists in `<title>`.

**Why it hurts.** Reproduced across **three separate runs** before being fixed —
`2026-08-14T10-46-05…667f7f76`, and again at `2026-08-14T21-45-47…4a2261b4` case-0, whose raw
Playwright error is unambiguous:
```
Locator: getByText('Online Shopping site in India: Shop Online for Mobiles, ... - Amazon.in').first()
Received: <element(s) not found>
```
The string occurs **0** times in the rendered body (confirmed directly against the live page).
Because it was step `s2`, every later assertion in that case never ran at all. `README.md` had
claimed a prompt-level guard for exactly this ("the model is told the page's `title` field is
`<title>`-tag metadata, never visible body text") — prompt-only, and these runs are direct proof
it doesn't hold. Textbook instance of this project's own established pattern (`DECISIONS.md`
D-03/D-04): a prompt rule without a structural backstop eventually gets ignored.

**Fix applied.** Made the correct thing *expressible* rather than merely requested:
- `title_contains` / `title_equals` added to the IR assertion enum (`src/schema/ir.ts`).
- `generator.ts` compiles them to `await expect(page).toHaveTitle(...)` — regex for `_contains`,
  exact string for `_equals` — and both are page-level, taking no target (like `url_contains`).
- `PAGE_LEVEL_ASSERTIONS` in `ir.ts` marks the no-target set; `normalizeIR` folds a
  model-attached `{ text: ... }` target into `value` and drops the target, so a title assertion
  the model *meant* correctly can't silently compile as a body-text one — the exact bug this
  eliminates.
- `vacuousAssertion`'s `NEEDS_VALUE` set extended, so a valueless title assertion is rejected
  rather than emitted as something that matches anything.
- The system prompt now lists the new assertions and states explicitly that they are the ONLY
  correct way to express a title check (the old "never assert the title as body text" rule stays
  as first-line steering, but is no longer the only guard).

**Verified**: `normalizeIR` + schema round-trip on a model-shaped title step (target folded into
value, target dropped); emitted line is `await expect(page).toHaveTitle(new RegExp("..."))`, no
`getByText`; and against the **live** amazon.in page, `toHaveTitle` polling passes on the real
title while the old body-text approach finds 0 matches. Covered by `tests/generator.test.ts`
(both variants, plus the vacuous-value rejection). `npx tsc --noEmit` clean, `npx vitest run`
297/297.

### TD-07. Generated spec's locator helpers have already diverged from `targetResolver.ts` — Medium / Strategic (root) / Accidental (drift)

**What it is.** By design (`DECISIONS.md` D-06) the generated spec is standalone, so
`generator.ts`'s `LOCATE_HELPER`/`SAFE_CLICK_HELPER`/`FIELD_HELPER` restate
`targetResolver.ts`'s `resolveRoleWithFallback`/`resolveField` as inline strings rather than
importing them. `targetResolver.ts:68` defines `ROLE_SWAP = { button: "link", link: "button" }`
so a styled `<a>` acting as a button still resolves during IR generation and live-extend replay.
`generator.ts`'s `LOCATE_HELPER` has no equivalent (confirmed by grep — no `ROLE_SWAP` or
equivalent anywhere in `generator.ts`).

**Why it hurts.** An element can ground successfully during IR generation and then fail to resolve
in the *executed* spec — the two implementations have already drifted apart, this isn't a
theoretical risk. Nothing pins them equal, so the next divergence will also go unnoticed until a
user's run breaks on it.

**Remediation.** One test that runs both implementations against the same fixture page (or, more
cheaply, asserts the injected helper source lists the same role-fallback candidates in the same
order as `targetResolver.ts`'s own list) — enough to catch the *next* divergence even without
unifying the two.

### TD-08. `safeClick` treats `javascript:`/`mailto:`/`tel:` hrefs as real navigation — Medium / Accidental

**What it is.** `generator.ts`'s `SAFE_CLICK_HELPER` checks only `href !== "#" && href !== ""`
before calling `page.goto(href)`. Three other places in this codebase agree on the fuller
non-navigating set (`ir.ts`'s `NON_NAVIGATING_HREF = /^\s*(#|javascript:|mailto:|tel:)/i`, mirrored
in `discovery.ts` and `domExtract.ts`) — `safeClick` alone omits it.

**Why it hurts.** `<a href="javascript:void(0)" onclick="openModal()">` makes `safeClick` call
`page.goto("javascript:void(0)")` instead of clicking the element — the `onclick` handler never
fires, no error is raised, and every later step in the case runs against an unchanged page. Silent,
not loud — the worst kind.

**Remediation.** Extend `SAFE_CLICK_HELPER`'s check to match `NON_NAVIGATING_HREF`. Same
duplication risk as TD-07 — generate it from one shared source if that refactor ever happens.

### TD-09. `safeClick` swallows a strict-mode error on duplicate-named links — Medium / Accidental

**What it is.** `SAFE_CLICK_HELPER`'s `el.getAttribute("href").catch(() => null)` swallows any
error from resolving `el`, including a strict-mode violation from an ambiguous locator (TD-05),
and silently falls through to the non-link click branch instead of surfacing the ambiguity.

**Why it hurts.** Masks the same duplicate-name problem TD-05 describes, but for `click` steps
instead of `assert` steps — which is part of why clicks on a duplicated `Training & Placement`
link succeeded in one anandice case while asserts on equally-duplicated names failed in others:
click and assert paths handle the same ambiguity differently, one loudly, one silently.

**Remediation.** Fix TD-05 first (page-scoping or `.first()`-on-ambiguous); once locate() stops
returning an unresolvable locator for a same-page duplicate, this swallow stops mattering. If TD-05
isn't addressed first, at minimum stop swallowing the error here so a genuinely ambiguous click
fails loudly instead of silently misfiring.

### TD-10. Credential policy is case-scoped, not leg-scoped — Medium / Strategic

**What it is.** `credentialPolicyFor` returns one `CredentialPolicy` for a case's *entire* step
list. A case embedding two login attempts in one browser session (deliberately-wrong, then real)
has no way to get different substitution behavior for each leg.

**Why it hurts.** The symptom — such a case substituting the real credential into the wrong leg
about half the time, depending on model-chosen step order — was closed by avoidance in `c456de9`
(`testCases.ts` now forbids the shape; `dropCompoundLoginCases` enforces it), not by solving the
underlying limitation. The same class of bug will recur for any other stateful flow that can't
simply be split into two cases: an invalid coupon then a valid one, a failed validation then a
correction, a multi-step checkout.

**Remediation.** Give the IR/credential-policy system a first-class notion of state transitions
within one flow, rather than one policy per whole case. A real design project — start by cataloging
every flow shape currently forced into avoidance rather than handled.

### TD-11. Wording-based (regex-over-English) detection is used well beyond login fields — Medium / Strategic

**What it is.** `credentials.ts` guesses field purpose from English regexes (`PASSWORD_NAME`,
`AUTH_WORDING`, `REGISTRATION_URL`). `credentialFieldMap` proved a better pattern exists — read the
DOM's own `inputType` instead of guessing from wording — but only for login fields.
`executor.ts`'s `detectBlocked` (TD-04) has the identical fragility for CAPTCHA/OTP detection.

**Why it hurts.** Every wording-based check inherits every weakness English text has: synonyms,
non-English sites, a page whose real copy happens to contain a trigger phrase for an unrelated
reason (see TD-01, which is this exact failure mode one layer over — case *prose* instead of *page*
prose). It's the load-bearing idea behind several of this register's other items, not just one bug.

**Remediation.** Where a structural signal exists (a DOM attribute, an ARIA role, an input `type`),
prefer it over a wording match, following `credentialFieldMap`'s own precedent. Not a single fix —
an audit of every regex-over-page/prompt-text check in the codebase, `credentialFieldMap`'d one at
a time.

### TD-12. The user's literal prompt instructions are paraphrased before any deterministic stage sees them — Medium / Strategic

**What it is.** The prompt passes through `planner.ts` and `testCases.ts`, both of which rewrite it
as free prose, before IR generation ever sees it. Observed: "click on Admin" became "Navigate to
the Admin section via the sidebar," which the IR stage read literally and turned into a guessed
route; explicit "wait 3 sec" instructions were dropped entirely.

**Why it hurts.** The guessed-route case is caught deterministically downstream today (a navigate
URL not matching a known target is rejected) — but that's containment, not a fix. Nothing carries
the user's literal intent (a named control, an explicit wait, an exact value) through the pipeline
as structured data that later stages must honor.

**Remediation.** `promptSelectors.ts` already does exactly this for CSS selectors the user writes
directly into their prompt — the model worth generalizing to named controls, waits, and literal
values, so every downstream stage is accountable to what was actually asked for.

### TD-13. Visibility accuracy only guaranteed for selector-bearing elements — Low / Strategic

**What it is.** `domExtract.ts` is a static cheerio parser with no CSS engine — it assumes
`visible: true` for everything. `recheckVisibility` (`domDiscovery.ts`) corrects this live, in one
batched `page.evaluate()`, but only for elements carrying a stable selector (`id`/`data-test`/
`css`) — precisely the set eligible for grounding's selector auto-attach.

**Why it hurts.** An element with no stable selector at all still ships with the parser's assumed
`visible: true`, uncorrected. Bounded impact today because `groundingError` already refuses a
`visible` assertion against anything *recorded* hidden — this only matters for the elements that
were never re-checked in the first place.

**Remediation.** Extend `recheckVisibility`'s candidate set beyond selector-bearing elements — e.g.
an accessible-name + role pair resolvable via `getByRole` doesn't strictly need a CSS selector to
be checked live.

---

## Security & operations

### TD-14. No server authentication — High / Strategic

**What it is.** Anyone with the URL can start runs and browse every artifact under `/runs`. The
entry-URL allow-list (`isAllowedEntryUrl`) narrows what an unauthenticated request can *reach*, but
nothing gates who can submit one at all.

**UPDATE 2026-09-01 — partially overtaken by events; re-verify before acting on this entry.**
`AUTH_ENABLED` now exists, and the blanket `app.use("/runs", express.static("runs"))` has been
replaced by `app.get("/runs/:runId/*")` sitting behind `canAccessRun`. Verified live: with
`AUTH_ENABLED=true`, `/api/runs` answers **401** and `/runs/<id>/events.ndjson` answers **403** to
an unauthenticated caller. The exposure described above is therefore closed **when the flag is on**.
It is NOT closed with the flag off (the default): `canAccessRun` then resolves the synthetic local
owner and returns true unconditionally, which the code comments describe as "identical to the
blanket mount this route replaced". So this entry now reads: *the default posture is still open,
the configured posture is not.*

**Why it hurts.** `README.md`'s own "Sharing Over the Internet" section recommends exposing the
server via a Cloudflare tunnel, which compounds the exposure rather than mitigating it.

**Remediation.** Needs a product decision before building — local-only tool vs. shared deployment
scope the fix differently (a shared secret / basic auth is enough for the former; real
session/user auth is a bigger project for the latter). Flagged `?` for exactly that reason.

### TD-15. A stale poll response can misdirect a credential submission to the wrong run — High / Accidental

**What it is.** `public/app.js`'s `connectToRun` (~line 1079) checks
`generation === pollGeneration` only at the top of each loop iteration — never re-checked after the
`await fetch`/`await res.json()`, before `applyEvent(event, runId)` runs with the OLD `runId`
closed over in that iteration.

**Why it hurts.** Run A's poll is in flight; before it resolves, the user switches to run B. A's
stale event batch still applies. If that batch includes a credential-prompt event, the modal for
run A's site pops over what the user believes is run B's screen — credentials typed there post to
`/api/runs/A/credentials`, potentially the wrong site's credentials landing against the wrong run.
The only item in this register that can misdirect a secret, which is why it outranks the rest of
this section.

**Remediation.** Re-check `generation === pollGeneration` immediately after the awaited fetch,
before calling `applyEvent`.

### TD-16. `runs/` grows unbounded and is served publicly with no pruning — Medium / Strategic

**What it is.** `runs/` holds every screenshot, trace, generated spec and `results.json` ever
produced. (The "served with no authentication" half of this entry is out of date — see the update
on TD-14: the static mount is now a guarded route. The unbounded-growth half below still stands.) `runStore` caps the
*history list* shown in the UI at 20 but never prunes the underlying files. Measured at 344MB
across 27 run directories at time of writing — a moving number; don't trust this doc's figure
without re-measuring, that's exactly the drift `DECISIONS.md` D-01 exists to prevent.

**Why it hurts.** Disk usage and exposure both grow forever, unbounded by the same 20-run cap that
governs what the UI even shows a user.

**Remediation.** Partly shipped: `src/server/retention.ts` ages directories off on a schedule when
`RUN_RETENTION_DAYS` is set, and is a no-op when it is unset or `0` — which is the default, so on a
default install nothing is pruned and this entry stands as written. Setting that variable is the
whole fix for age-based pruning; a count-based "keep the N newest" cap is still unbuilt.

### TD-17. `store.read()` / `listRuns()` have no per-entry error isolation — Medium / Accidental

**What it is.** `runStore.ts:51` parses NDJSON with no try/catch —
`events = lines.map((l) => JSON.parse(l) as StageEvent)`. `listRuns()` (`runStore.ts:180`) calls
`store.read()` inside a `.map()` over the newest 20 run dirs with no try/catch either, and also
calls `statSync()` (line 211) unguarded, which a concurrent `DELETE /api/runs/:runId` can race into
an `ENOENT`. `GET /api/runs` (`server/index.ts:137-139`) calls `listRuns()` with no try/catch of
its own.

**Why it hurts.** A torn write (crash mid-append) in any single run's `events.ndjson`, or a delete
racing a list, 500s the shared `/api/runs` endpoint every connected client polls — not scoped to
the one bad or deleted run.

**Now observed, not just theorised (2026-09-01).** `tests/apiContract.test.ts`'s
`GET /api/runs` case fails intermittently — roughly one full-suite run in six, never in isolation
(5/5 clean when run alone). Mechanism confirmed by replay: `summariseRun` on a directory that no
longer exists throws `ENOENT`, and six test files create and delete real directories under `runs/`
while vitest runs files in parallel. `allRunIds()` sorts descending, and test directories are named
`test-run-*` — `"t"` sorts above every digit — so they land inside the `slice(0, 20)` window every
time, which makes the race window maximal rather than incidental. Adding tests to
`tests/caseSelectionGate.test.ts` tripled how often one of those directories is created and
deleted, which is why it began surfacing. The fix is unchanged (per-entry try/catch); this note
only records that the defect is real and reproducible, not hypothetical.

**Remediation.** Try/catch the `JSON.parse` (skip/flag the bad line rather than throwing);
try/catch each `.map()` entry in `listRuns()` so one bad/missing run drops from the list instead of
failing the whole response.

### TD-18. Entry-URL allow-list is a pre-DNS-lookup hostname check (DNS-rebinding residual) — Low / Strategic

**What it is.** `isPrivateOrLoopbackHost` checks the literal hostname string before any DNS
resolution. A hostname that only resolves to a private/loopback IP at request time (DNS rebinding)
still gets through.

**Why it hurts.** Theoretical at this project's current scale — a small, trusted-deployment tool —
but a real gap in the allow-list's guarantee.

**Remediation.** Resolve DNS and check the resolved IP rather than the literal hostname. Explicitly
deferred as not worth the complexity at current scale; revisit if TD-14's scope decision moves
toward a shared/untrusted deployment.

### TD-19. Single-process, no multi-user isolation or per-user quotas — Low / Strategic

**What it is.** Shared run history across every client, no per-user quota on concurrent runs beyond
the global `MAX_CONCURRENT_RUNS` semaphore.

**Why it hurts.** Fine for the current deployment model (single trusted operator); would need
rework for a genuinely multi-tenant deployment.

**Remediation.** None planned; recorded so it isn't mistaken for an oversight if the deployment
model changes.

---

## Reliability & test infrastructure

### TD-20. No CI runs the test suite — High / Strategic

**What it is.** 790 tests across 51 files exist (a moving number — re-check with `npx vitest run`
rather than trusting this doc) and nothing executes them automatically. The only GitHub Actions
workflow, `.github/workflows/directory-tree.yml`, regenerates a directory tree and pushes to
`main`.

**Why it hurts.** Every deterministic guard this project has built — grounding, credential policy,
scope filtering — is unenforced on any change. Highest leverage-per-effort item in this whole
register: one workflow file protects every other fix listed here.

**Remediation.** One workflow: `npm ci`, `npx tsc --noEmit`, `npx vitest run`. TD-21 (the flake
that would have made this intermittently red) is now fixed, so nothing else blocks landing this.

### TD-21. `tests/strategy.test.ts` flakes ~1 run in 6 under parallel load — Medium / Accidental

**What it is.** The `rejects non-http/https schemes like file://` case times out at 5s on its
dynamic `await import("../src/stages/hybridDiscovery.js")` (which pulls in Playwright) under
parallel test load.

**Why it hurts.** Reproduced at `HEAD` independent of any other change. Blocks TD-20 from landing
green.

**Remediation.** Hoist the import to module scope so it isn't re-triggered per test run, or raise
this specific test's timeout.

### TD-22. LLM disk cache never expires; a key missing an input dimension serves stale results forever — Medium / Strategic

**What it is.** `llmCache.ts` is two-tier: in-memory (30-minute TTL) + disk (no expiry). Each
stage's cache key must include every real input dimension that changes its output. This has been a
recurring bug source: system prompt + model name were once missing from every key (fixed — see
`DECISIONS.md`), and the case-selection gate's rejected-titles/refinement-prompt dimensions were
also once missing.

**Why it hurts.** A cache key that's missing a dimension doesn't error — it silently serves a wrong
answer, forever, until someone notices the *symptom* and traces it back to caching. Two confirmed
false negatives during past verification work came from exactly this.

**Remediation.** No structural fix planned (the two-tier design itself is a deliberate tradeoff,
`DECISIONS.md`) — the mitigation is discipline: when adding a new parameter to any cached call,
add it to that call's cache key in the same change, and prefer hashing the actual prompt text over
a hand-maintained version constant (a version number is something a future edit can forget to
bump; hashed text can't be forgotten to update).

---

## UI / operational rough edges

### TD-23. Case-selection-gate progress events briefly corrupt the phase summary text — Low / Accidental

**What it is.** `app.js`'s `applyEvent` calls `setPhaseFromStage` unconditionally before the
gate-specific `action`-based early returns. Every gate event on the `"testcases"` stage carries an
`action` field but no `generated`/`selected`/`total`/`length`, so `summarize()`'s fallback computes
`0` and briefly repaints a correct "Generated 15 → selected 4" summary as "Generated 0 test
scenarios" — and, on the reactive round, the literal string "(true reactive)".

**Why it hurts.** 100% reproducible on every interactive run using the gate, but cosmetic — the
case-review panel below shows the correct data throughout; only one summary line flickers wrong
text momentarily.

**Remediation.** Give `summarize()` a branch for `data.action` before falling through to the
count-based text, or skip `setPhaseFromStage` entirely for gate `action` events.

### TD-24. `PLAYWRIGHT_TIMEOUT` env var is set but never read; comment implies otherwise — Low / Accidental — **fixed**

**What it is.** `playwright.config.ts:5` hardcoded `timeout: 50_000`, ignoring
`process.env.PLAYWRIGHT_TIMEOUT` entirely.

**Correction to this entry's own history, found while fixing it (Phase 0, Step 0.4):** this entry
originally claimed `executor.ts` injects `PLAYWRIGHT_TIMEOUT: String(CONFIG.TIMEOUTS.TEST_RUN)`
into the spawned Playwright process's env. That is not true of the code as it stands —
`executePlaywright`'s `spawn(...)` call only sets `...process.env`, `...secretEnv`,
`PLAYWRIGHT_JSON_OUTPUT_NAME`, and `PLAYWRIGHT_HEADLESS`; `PLAYWRIGHT_TIMEOUT` appears nowhere in
`src/` before this fix. Either the injection was removed in a later refactor without updating this
entry, or it never existed and this entry described an intended-but-unshipped change — either way,
this is itself an instance of the doc-drift pattern `DECISIONS.md` D-01 already covers. `TEST_RUN`
(currently `100_000`ms) only ever drove the *parent* process's own `setTimeout`/`SIGKILL` kill timer
(TD-02); it was never actually connected to Playwright's own per-test timeout.

**Remediation (done).** `playwright.config.ts` now reads
`Number(process.env.PLAYWRIGHT_TIMEOUT) || 50_000` — genuinely configurable, and since nothing sets
that env var today (confirmed: absent from `.env`, and no longer any injection site to remove),
behavior is unchanged — every run still gets Playwright's own 50s timeout, comfortably under the
parent's 100s kill timer, exactly as before this fix.

### TD-25. Deleting the currently-viewed run leaves its polling loop running forever — Low / Accidental

**What it is.** The history delete button's handler calls `DELETE /api/runs/:runId` and
`loadHistory()` but never touches `pollGeneration`.

**Why it hurts.** Deleting the run currently on screen leaves `connectToRun`'s poll loop hitting the
now-deleted run's `/state` endpoint forever.

**Remediation.** Bump `pollGeneration` in the delete handler when the deleted id matches the
currently-viewed run.

### TD-26. Credential prompt fires even when no case in the suite has a login step — Low / Accidental

**What it is.** Observed across multiple recent runs against `amazon.in` for a purely
homepage-visibility prompt with no login anywhere in the generated cases: a credential prompt still
fired and the run paused for the full `CREDENTIAL_WAIT_MS` (5 minutes) before continuing.

**Why it hurts.** Wastes 5 minutes of wall clock on every affected run for no benefit — no case
ever uses the credentials even if supplied. Flagged `?` because the actual trigger condition
wasn't traced to a specific line in this pass; worth a quick read of wherever the credential prompt
is decided (`orchestrator.ts`) before assuming a fix.

**Remediation.** Gate the credential prompt on whether any case actually contains a login-shaped
step, not on some broader per-run default.

### TD-27. `caseAccumulator.appendAcceptedCases` doesn't dedup near-duplicate titles within one batch — Low / Accidental

**What it is.** `caseAccumulator.ts:42-53` pushes every selected index checking only the capacity
count — no title dedup. `getAllAcceptedCases()` (lines 67-78), which is what actually becomes the
run's case list, *does* dedup by `normalizeTitle`. `filterNovelCases` only filters a new batch
against previously accepted/rejected titles, not duplicates within the same batch.

**Why it hurts.** If one generation round returns two near-duplicate titles (differing only in
case/whitespace/trailing punctuation) and the user selects both, `appendAcceptedCases` reports both
accepted (two capacity slots consumed) but `getAllAcceptedCases()` collapses them to one — the user
believes they used two of five pool slots on two different tests; only one exists and runs.

**Remediation.** Dedup `selectedIndexes`/resulting titles by the same `normalizeTitle` rule inside
`appendAcceptedCases` before counting against the cap, and reflect collapsed picks back to the
caller instead of silently reporting them as separately accepted.

---

## Dead code / undecided

### TD-28. `wantsRealCredentials` — dead code, or the policy entry point that was never wired in? — Low / Undecided

**What it is.** `credentials.ts`'s `wantsRealCredentials` has zero references in `src/`, six in
`tests/`. Either it's the real policy entry point and `credentialPolicyFor` should be calling it,
or the six tests are pinning dead behavior.

**Why it hurts.** Nothing today — it's inert. Left open because deleting it without deciding which
case it is would silently delete the six tests' actual subject.

**Remediation.** Needs a decision, not a delete: read what it does, decide whether
`credentialPolicyFor` should route through it, then either wire it in or remove it and its tests
together.

### TD-29. A username was once observed reaching disk unreferenced — never root-caused — Low / Undecided

**What it is.** In one historical run, a step filled a literal `'admin@thinkvibes.com'` while the
adjacent password step correctly used `${env:TEST_PASSWORD}` — an asymmetry, in a project where
`runs/` is served publicly and identifiers reaching disk unreferenced is a real (if lesser)
exposure next to a literal password.

**Why it hurts.** Unknown severity — it may simply have been the model inventing a value that was
never recognized as a credential in the first place (in which case a later credential-extraction
fix may have already resolved it), rather than a substitution bug that's still live.

**Remediation.** Confirm which case it is against a current run before deciding this needs code
changes at all.

---

## Newly discovered — checking the fixes above against a real run

Found while verifying TD-01/02/03 against `runs/2026-08-14T19-24-27…0413c4c8`, the first run after
those fixes landed. Neither is caused by that work — both are pre-existing gaps the run happened
to exercise — but neither was on this register before.

### TD-30. A role target with no name (empty-string OR absent) bypasses grounding entirely and crashes spec generation — High / Accidental — Fixed

**What it is.** `groundingError` (`src/stages/ir.ts:438`) reads `if (!t?.role || !t?.name) continue;`
— skip grounding this step, nothing to check. An empty string is falsy in JS, so a target shaped
`{ role: "textbox", name: "" }` takes the exact same path as a step with no role/name at all
(navigate/wait/text-only), even though it plainly has a role and *almost* has a name. It reaches
spec generation completely unchecked. `targetResolver.ts`'s `resolveCode` also treats `t.role &&
t.name` as the role+name branch's gate (line 90) — same falsy-empty-string behavior — so it falls
through to `pick(t)`, which has no css/label/placeholder/text/testId to resolve either, and throws
`No semantic locator for target: {"role":"textbox","name":""}`.

**Why it hurts.** Reproduced directly: `runs/2026-08-14T19-24-27…0413c4c8`, case-3 ("Verify
keyboard accessibility of navigation"), `s2` is `{ action: "press", target: { role: "textbox",
name: "" } }` — the model wanted to press a key (plausibly Tab, to test keyboard navigation)
without a specific named element to anchor it to, and the IR schema gave it no other way to
express that intent, so it emitted a role with no name rather than omit the target. The thrown
error isn't caught inside `generator.ts`'s own step-emission loop, so it propagates out of spec
generation entirely — the suite runner catches it one layer up and reports the case as `"failed"`
with none of the normal failure fields (`resultPath` present, but no `screenshotUrl`, `intent`, or
`expected` the way every other failure in the same run's `07-suite-summary.json` has) — materially
less diagnostic information than an ordinary Playwright failure gets.

**Remediation.** Two independent angles: (1) `groundingError`'s skip condition should treat an
explicitly-empty name as absent-and-invalid when a role IS present, not as "nothing to check" —
`if (t?.role && !t?.name) return { index, message: "... has a role but no name to target it
with" }`, forcing a correction instead of silent pass-through. (2) Give the IR schema a real way to
express "press a key with no specific target" (a keyboard-only step shape, or an optional target)
so the model isn't forced to fabricate a role+empty-name target just to say what it actually means.
(1) alone stops the crash; (2) fixes the underlying reason the model reached for this shape.

**Recurred twice more before being fixed**, confirming it wasn't a one-off:
`runs/2026-08-14T21-04-16…2b2858b9` case-3 (same "keyboard accessibility" shape, `s2`/`s3` both
`{role, name: ""}`), then `runs/2026-08-15T05-25-38…901f5358` — this one **took down the entire
run**, not just one case: a thin AppModel (see TD-31, its root cause here) left the model nothing
specific to name for "confirm the nav landmark is visible," so it emitted `{role: "heading"}`,
`{role: "navigation"}`, `{role: "main"}` — role present, **`name` key absent entirely**, the same
crash site via a slightly different trigger shape. Because this hit the *primary* case (before
the suite fans out into isolated per-case execution), there was no per-case isolation to catch it:
`generate failed: No semantic locator for target: {"role":"heading"}`, the run terminated as
`stage: "error"` at 71.4s, and zero cases, zero screenshots, zero artifacts were ever produced —
the worst blast radius any bug in this register has caused.

**Fix applied.** Option (1) from the original remediation, exactly as scoped: `groundingError`
(`ir.ts`) now explicitly checks `t?.role && !t?.name` *before* the existing skip condition and
returns a rejection — routed through the same correction/retry/truncate path every other
grounding failure already uses, so the model gets a chance to correct itself, and if it can't,
the case degrades to a truncated-but-real IR instead of crashing spec generation outright. Option
(2) (a first-class "no specific target" step shape) is still open — recorded as a real,
independent improvement, not required to close the crash. Verified by replaying the exact IR that
killed the `901f5358` run directly through `groundingError`: rejected at `s3` (the first
role-only target) instead of ever reaching `generateSpec`. Covered by `tests/grounding.test.ts`
(both the empty-string and absent-name shapes, plus a check that a step with no role at all is
still correctly skipped); regression-verified.

### TD-31. A not-yet-hydrated page (0 extracted elements) is accepted as a valid, cacheable AppModel with no vision fallback — High / Strategic (root) / Accidental (in effect) — Fixed

**What it is.** `domDiscovery.ts:515` navigates with `waitUntil: "domcontentloaded"` and
`extractDomModelFromPage` calls `page.content()` immediately after with no settle wait —
`domcontentloaded` fires once the initial HTML document is parsed, before deferred/async scripts
that inject a JS-rendered `<body>` have necessarily run. `hybridDiscovery.ts` explicitly treats a
zero-element extraction as acceptable, not a failure — the comment at line ~436 names the exact
case: *"DOM succeeded but found no elements (auth wall, not-yet-hydrated) — still a valid,
cacheable result."* Both the single-page path (line ~173) and the site-crawl path (line ~435) take
this branch, and neither falls back to Gemini Vision the way a genuinely-failed extraction would
(`README.md`/`ARCHITECTURE.md`'s stated fallback trigger is "DOM extraction finds nothing usable" —
in practice this IS that case, but it's routed to "valid, cache it" instead).

**Why it hurts.** Reproduced directly: `runs/2026-08-14T19-24-27…0413c4c8`'s entry-page
`cleanedHtml` is 32.8KB of real `<head>` content (meta tags, Amazon's own bootstrap scripts) and
ends at `</head></html>` — **there is no `<body>` at all** in the captured HTML. `elements: []`,
`title: ""`, `discoveryMethod: "dom"`. Test-case generation had nothing structural to work from
and fell back to the plan's own generic wording — `{text: "header"}`, `{text: "navigation"}`,
`{text: "main content"}` — none of which are real page text, so the primary case's very first
assertion (`s2`) was guaranteed to fail. Discovery itself took only 5.2s (vs. 42–53s in other
recent runs against the same site), consistent with returning almost immediately after an
under-loaded snapshot rather than actually crawling anything.

**Fix applied.** Option (1) from the original remediation. `extractDomModelFromPage`
(`domDiscovery.ts`, the one function every discovery path shares) now polls rather than accepting
the first zero-element read as final: when both the semantic extraction AND
`detectGenericClickables` return nothing, it re-extracts every second, up to
`DISCOVERY_HYDRATION_POLL_MS` (default 6000ms), and keeps whichever result stops being empty
first. Placed in this one shared function rather than duplicated at each of the three call sites
in `hybridDiscovery.ts`/`domDiscovery.ts` that invoke it.

**How the threshold was chosen — measured, not guessed.** Ran the real extraction pipeline
against the real site at increasing waits past `domcontentloaded`: **0 elements at +800ms** (the
wait every call site already had — confirms the bug directly), **347 at +2.8s**, **576 (stable)
by +4s**. The default budget (6s) sits comfortably above the measured convergence point.

**The "auth wall" case is provably not regressed**, not just assumed: `detectGenericClickables`
is now also part of the exit condition (an earlier version of this fix checked only semantic
elements, which made a real page whose *only* interactive content is a non-ARIA
`cursor:pointer`/`onclick` div poll for the full budget every time, since generic clickables are
normally detected *after* this check — caught by `tests/genericClickables.test.ts`'s existing
negative-case tests going from passing to timing out, fixed before landing). A page that
genuinely never renders anything — the true auth-wall case — still correctly resolves to 0 after
the poll window, verified directly (a static `page.setContent()` page with nothing ever added:
resolves to 0 elements, bounded by the poll budget, not longer).

Option (2) (route a zero-element result through the vision fallback too) is not applied — the
poll fix addressed the measured root cause directly and more cheaply; vision remains available as
a fallback for the cases the poll genuinely can't resolve, unchanged.

**Verified against the exact original failure**: replayed `extractDomModelFromPage` against the
live site at the exact reproduction conditions (the pre-existing 800ms wait, nothing else
changed) — 0 elements before this fix (matching the real run), 102 elements and the real page
title after it, in 1.55s total. Covered by `tests/genericClickables.test.ts` (a delayed-render
page picked up within the poll window; a truly-empty page still correctly resolves to 0);
regression-verified. `npx tsc --noEmit` clean, `npx vitest run` 301 tests (299 passing — the 2
failures are unrelated deleted-fixture data, not this change).

### TD-32. `locate()`/`resolveRoleWithFallback` matched names by substring, not exactly — High / Accidental — Fixed

**What it is.** Playwright's `getByRole(role, { name })` defaults to a case-insensitive
**substring** match on the accessible name, not an exact one — and the CSS fallback chain in
`generator.ts`'s `LOCATE_HELPER` used `:has-text()`, which is the same kind of substring match
over an element's whole subtree. Neither ever passed `exact: true`, in either implementation
(`generator.ts`'s generated-spec helper or `targetResolver.ts`'s live-replay
`resolveRoleWithFallback`).

**Why it hurts.** Reproduced directly, twice, in one run (`runs/2026-08-14T20-25-38…70279845`)
against a target that grounding had correctly resolved to exactly one real, discovered element
(`{role: "button", name: "All"}`, Amazon's "All Categories" control):
- **case-0** (`assert visible button "All"`): the CSS fallback `button:has-text("All")` resolved
  to exactly one match — but the wrong one, an embedded video player's hidden "restore **all**
  settings to the default" button, which discovery never modeled and grounding had no way to rule
  out. Accepted confidently (count was 1), then timed out because that element genuinely is
  hidden.
- **case-1** (`click button "All"`): a real Playwright strict-mode violation, 4 elements —
  including a hamburger menu labeled "Open **All** Categories Menu" and a lazy-loaded product
  tile. This one is also a time-of-check-to-time-of-use race worth naming precisely:
  `locate()`'s uniqueness check runs once; `safeClick`'s non-link branch then does
  `scrollIntoViewIfNeeded()` → `waitFor()` → `hover()` before the actual `.click()` — real
  wall-clock time on a still-hydrating page, long enough for more substring-matching elements to
  mount between the check and the click. The locator Playwright ultimately called `.click()` on
  is lazy and re-queries live, so a uniqueness check that passed at `locate()`-time doesn't hold
  by click-time.

Since `groundingError` already rewrites a target's name to the exact, verified accessible name of
a real discovered element before the IR ever reaches generation (never a guess by this point),
requiring an exact match at resolution time costs nothing for a correctly-grounded target — it
only stops unrelated page furniture discovery never modeled from winning a lookup.

**Fix applied.** `exact: true` added to every `getByRole`/`getByText` name match in both
`generator.ts`'s `LOCATE_HELPER` and `targetResolver.ts`'s `resolveRoleWithFallback` (and the
`resolveLive`/`nth` path, where an index computed against one element set silently pointing at a
different element if the set widens is arguably worse than the non-nth case). The CSS fallback
chain switched from `:has-text()` to `:text-is()` for the same reason. Covered by
`tests/generator.test.ts` ("injects a locate() helper that matches names exactly, not by
substring") — regression-verified: fails with the exact real error shape when the fix is
reverted, passes on restore.

**Known residual:** this closes the false-positive-match half of the problem; it doesn't
independently close TD-05 (genuine duplicate real elements with the identical exact name still
need the `.first()` mitigation or the page-scoping fix). It does shrink TD-05's practical surface
area, since far fewer unrelated elements now qualify as "matching" at all.

### TD-33. `classify.ts` didn't recognize the "Timed out ... waiting for expect(...)" assertion-timeout wording — Medium / Accidental — Fixed

**What it is.** Playwright reports an assertion timeout two different ways depending on whether
the awaited condition ever becomes true: `"expect(locator).toBeVisible() failed"` (an immediate
failure) vs. `"Timed out Nms waiting for expect(locator).toBeVisible()"` (the retry window closed
first, without the condition ever being met). `classify.ts`'s `element_hidden` check
(`/toBeVisible\(\)\s*failed/i`) matched only the first wording — the second, at least as common
for a genuine visibility timeout, matched nothing in the file and fell through to `return null`.

**Why it hurts.** Reproduced directly: the real error text for `runs/2026-08-14T20-25-38…70279845`
case-0 read *"Timed out 10000ms waiting for expect(locator).toBeVisible()... Received: hidden...
locator resolved to \<button class="vjs-default-button"\>"* — a single, cleanly-resolved element,
correctly reported as hidden. This should have classified deterministically and for free as
`element_hidden`. Instead it fell through every branch in `classify.ts` to the Gemini fallback,
which was given the same information and **still got it wrong** — it reported category
`multiple_matches`, "matched multiple elements," a claim the raw log it was handed directly
contradicts (it names exactly one resolved element). Two independent problems stacked: TD-32
picked the wrong element, and this bug meant the explanation of *why* was fabricated on top of it,
even with `raw` populated (TD-02's fix already confirmed working in this same run).

**Fix applied.** Broadened both the `element_hidden` (`toBeVisible`) and its mirror
`assertion_failed` (`toBeHidden`) checks to match either wording — `/\bfailed\b/` or
`/Timed out\s+\d+m?s\s+waiting for/`, both required alongside the existing `Received:` check.
Covered by `tests/strategy.test.ts` with the real (ANSI-stripped) error text from the run as the
test fixture, plus a symmetric `toBeHidden` case; regression-verified both ways.

### TD-34. A `visible` assertion's locator could resolve to a hidden same-named candidate ahead of a visible one — High / Accidental — Fixed

**What it is.** `emitAssert`'s `"visible"` case (`generator.ts`) called `toBeVisible()` directly
on whatever `resolveCode()`/`locate()` returned, with no way to prefer a visible candidate over a
hidden same-named one when more than one exists. TD-32's `exact: true` fix stops *unrelated*
elements (a video player, a hamburger menu) from winning a name lookup, but does nothing when the
duplicate really does share the exact same accessible name and role — a real, semantically
different element (a page's visible brand text vs. a hidden `<option>` inside a collapsed
dropdown, both legitimately named "Amazon") still collides.

**Why it hurts.** Reproduced directly: `runs/2026-08-14T21-04-16…2b2858b9`, case-0, `s2` —
`assert visible {text: "Amazon"}` — the deterministic classifier (now fixed, TD-33) correctly
explained it: *"getByText('Amazon') incorrectly matched a hidden `<option>` element within a
dropdown menu instead of the visible text expected on the page."* The assertion polled the wrong,
hidden element for the full timeout instead of finding the real, visible one elsewhere on the
page.

**First fix attempt was wrong, and shipped believing it was verified — recorded because the
discipline that caught it is the useful part.** `.filter({ visible: true })` was added to the
assertion's locator and confirmed via `npx vitest run` and a string-level replay of the real
failing IR through `generateSpec` — both passed, because both only checked the *emitted source
text*, never executed it. **`Locator.filter()` doesn't have a `visible` option in this project's
pinned Playwright (1.49.0)** — only `has`/`hasNot`/`hasText`/`hasNotText` — so
`.filter({ visible: true })` silently no-ops instead of erroring. Caught only when a live run
against the real site failed with the exact same error a second time, at which point reading
Playwright's own `types.d.ts` and running a real headless-browser check against synthetic HTML
(hidden `<option>` + visible `<span>`, both named "Amazon") confirmed it directly: `.filter()`
left the match count at 3 (all three "Amazon"-named elements), unchanged from no filter at all.
**Lesson, stated plainly for next time:** verifying a generated *string* is not the same as
verifying the *behavior* — a plausible-looking Playwright API call needs to be run once for real
before being called fixed, not just type-checked and pattern-matched.

**Fix applied.** `.and(page.locator(':visible'))` — Playwright's `:visible` pseudo-class,
intersected via the real `Locator.and()` method (confirmed present in this Playwright version) —
on the assertion's locator, `"visible"` case only. Verified against the same synthetic-HTML
browser test: correctly narrows the 3-element match down to the 1 genuinely visible one. **Order
is still the whole fix, not a detail, and this got re-verified too**: `resolveCode()`'s output
already ends in a narrowing `.first()` (text/label/placeholder/testId targets) or `.first()`/
`.nth(N)` (a css target) for two of its three output shapes. Applying `.and()` *after* that
narrowing doesn't help — it locks onto whichever candidate DOM order put first, and if that one
happens to be the hidden one, intersecting it with `:visible` afterward just empties the locator
(a confusing "resolved to 0" instead of correctly finding the visible sibling) rather than
falling through to the visible match — confirmed directly with a browser test where the hidden
element is deliberately placed first in DOM order: 0 matches with `.and()` applied after
`.first()`, 1 correct match with `.and()` applied before it. The fix inserts it *before* any
trailing `.first()`/`.nth()` so the visible subset is chosen from first, then narrowed. The
role+name path via `locate()` has no such trailing modifier (it already resolves to one specific
element internally), so `.and()` is simply appended there. Scoped to `"visible"` only —
`hidden`/`enabled`/`disabled`/click/fill all need the *same* element the step already resolved,
not a narrowed candidate set.

**Verified three ways this time, not one:** (1) replayed the same real failing `04-ir.json`
through `generateSpec` and confirmed the emitted line is
`expect(page.getByText("Amazon").and(page.locator(':visible')).first()).toBeVisible(...)`;
(2) ran the *actual generated locator expressions* — old and new — against the real, live
`amazon.in` page in a real headless browser: the old one resolves to
`<option value="search-alias=amazon-devices">Amazon Devices</option>`, `isVisible() === false`
(the exact bug, reproduced); the new one resolves to a real visible nav link,
`isVisible() === true`; (3) `tests/generator.test.ts` covers all three `resolveCode()` output
shapes plus a check that `hidden` does *not* gain the narrowing, and regression-verified (fails
with the fix reverted, passes restored). `npx tsc --noEmit` clean, `npx vitest run` 294/294.

### TD-36. `safeClick`'s ladder had unbounded calls (~113s worst case), blowing the executor kill timer — High / Accidental — Fixed

**What it is.** `SAFE_CLICK_HELPER`'s non-link path (`generator.ts`) ran a fallback ladder —
`scrollIntoViewIfNeeded()` → `waitFor` → `hover({force:true})` → `waitFor` → `hover()` →
`click()` → `click({force:true})` — in which **`scrollIntoViewIfNeeded()` and `hover()` carried
no explicit timeout**, so each inherited Playwright's 30s action default. Both wait for the
element to become *actionable*, which a genuinely hidden element never does. Worst case:
30 + 5 + 30 + 3 + 30 + 10 + 5 ≈ **113 seconds for a single click step**.

**Why it hurts.** This is what makes TD-02 keep recurring even after its kill timer was raised.
Reproduced at `2026-08-14T21-45-47…4a2261b4` case-2, whose `s2` clicks a hidden
"Show/Hide shortcuts shift + alt + Z" keyboard control: the case ran **249.3s** — 100s (raised
`TEST_RUN`) + 2s retry delay + 100s + overhead — meaning *both* attempts were SIGKILLed. The
physical signature is unmistakable: `artifacts/.playwright-artifacts-0/` still present with **397
un-swept files and 36MB** of trace resources, versus 7 files / 1.1MB for the passing case in the
same run. `raw: null`, no `results.json`, so the failure could not be diagnosed at all. Raising
the executor's ceiling can never fix this — a single step could always outlast whatever ceiling
is chosen; the step itself has to be bounded.

**Fix applied.** Every call in the ladder now carries an explicit timeout
(`scrollIntoViewIfNeeded({timeout:2000})`, `waitFor({timeout:3000})`,
`hover({force:true,timeout:2000})`, `waitFor({timeout:2000})`, `hover({timeout:2000})`,
`click({timeout:5000})`, `click({force:true,timeout:3000})`) — worst case ~13s instead of ~113s.
A hidden element now fails fast and **reports honestly**, which is the outcome that was wanted:
the diagnosis pipeline gets a real Playwright error instead of a SIGKILL and an empty report.

**Verified**: the timeout options were confirmed real and actually binding by running them
against a hidden element in a real headless browser (each returned in ~2010ms, not 30s) — this
project has already shipped one plausible-looking-but-nonexistent Playwright option
(`.filter({visible:true})`, TD-34), so an API-surface change gets executed now, not assumed.
Covered by `tests/generator.test.ts` (asserts no bare `scrollIntoViewIfNeeded()`/`hover()`
survives and that every ladder call carries a `timeout:`), comment lines stripped before matching
so the test checks the code rather than its own explanation; regression-verified (fails with the
bare calls restored). `npx tsc --noEmit` clean, `npx vitest run` 297/297.

**Related, observed but deliberately not changed here:** `liveExtend.ts`'s replay actions
(`click()`/`fill()`/`press()`/`check()` at ~lines 43-49) have the same no-explicit-timeout shape.
They sit on a different path (browser replay during IR generation, not the generated spec), and
weren't implicated in this failure, so they're left alone rather than scope-creeping this fix —
but they are the same defect class and worth bounding if IR-stage hangs ever show up.

### TD-37. "Assert submit button hidden" generalized from login to any form with a preceding fill — High / Accidental — Fixed

**What it is.** `ir.ts`'s system prompt taught: "when you can't ground a success assertion on
the destination page, assert instead that the form's own submit button goes hidden after you
submit it" — written for login, where the "Sign In" button really does vanish once auth
succeeds, but the prompt text never scoped it to authentication forms specifically. The one
structural guard against misuse, `clickedElementHiddenAssertion()`, only asked "was there at
least one `fill` step before the click" (`fillsBefore > 0` ⇒ allowed) — a contact form, a
newsletter signup, or any other form with at least one field satisfies that exactly as well as a
real login form, so the guard let all of them through indistinguishably.

**Why it hurts.** Reproduced twice in one session against `thinkvibes.com`: a "Join our
Newsletter" case and, word-for-word matching a user's own bug report, a "Subscribe" case
(`2026-08-15T17-57-40…0b385264` case-4) — fill an email field, click Subscribe, assert Subscribe
hidden. The button is a Mailchimp `<input type="submit">` that stays in the DOM regardless of
outcome (the real confirmation renders into `#mce-success-response`, which discovery never sees
— it's hidden until an AJAX submit unhides it via JS, long after the crawl). The assertion times
out against a perfectly working site, and no AppModel element existed for the generator to
target instead.

**Fix applied.** Prompt tightened to name authentication specifically, not "a submit button."
`clickedElementHiddenAssertion(ir, appModel, testCase)` (signature grew two params) now requires
a real structural signal the flow is actually a login before allowing the pattern: a preceding
fill resolves to `"password"` via `credentials.ts`'s DOM-derived `credentialFieldMap`/
`credentialKindForTarget` (the same signal credential injection itself already relies on — not
a new, second guess at what "looks like a password field"), or — for a progressive login whose
password field isn't revealed yet — `credentialFieldsNeeded`'s existing INTENT fallback (the
case is auth-worded and the page offers a way in). Neither a contact form nor a newsletter form
trips either signal, so both are now rejected at IR-generation time, before a single Playwright
run is spent.

**Verified**: replayed directly against the real failing run's saved `02-appmodel.json` and IR
(artifact replay, no live run) — `clickedElementHiddenAssertion` now rejects case-4's exact
shape. `tests/grounding.test.ts` covers the rejection, a real password-field submission still
being allowed, and the progressive-login fallback; regression-verified (reverting the check to
the old `fillsBefore > 0` logic makes the new rejection test fail with the exact "would have
allowed it" signature). `npx tsc --noEmit` clean, `npx vitest run` 303/305 (2 pre-existing
unrelated fixture failures, unchanged baseline).

### TD-38. `Diagnosis.suggestedFix`/`explanation` are untrusted free text with no deterministic verification fed back into IR generation or heal — Medium / Accidental

**What it is.** `analyzeFailure`'s Gemini-fallback path (the deterministic `classify.ts` path
never reaches this) produces `suggestedFix`/`explanation` as ordinary LLM free text. A real
example (`2026-08-15T17-57-40…0b385264` case-3): the diagnosis correctly identified the real
validation text ("Please enter a valid email address.") as a quoted substring inside its
explanation — but nothing in the pipeline ever confirms that claim against anything real, or
acts on it. The case still just reports "failed"; a correct, already-known fix sits unused in
`06-diagnosis.json`.

**Why it hurts.** Per this project's central rule (an LLM instruction/claim needs a deterministic
check behind it, not a trust-and-hope), feeding a diagnosis's free text straight into a retry —
either as a `toIR` correction hint or as a heal-eligibility signal — would risk over-firing on a
plausible-sounding but wrong guess, burning a Groq call and a Playwright run for nothing, or
worse, "fixing" a case that was correctly failing for a real reason.

**Remediation (partially landed).** `verifyDiagnosisText()` (`failureAnalysis.ts`) is the
deterministic check: it extracts quoted substrings from `suggestedFix`/`explanation` and
confirms whether any of them actually appear in `ExecResult.accessibilitySnapshot` — Playwright's
own auto-captured `error-context` output, real captured DOM state, not an LLM's report about it.
`Diagnosis.verifiedText` is set only when confirmed, kept deliberately separate from the raw free
text so "the model's guess" and "independently confirmed" stay visibly distinct. **Landed now:**
the field and the verification function, wired into `analyzeFailure`'s Gemini-fallback return.
**Deliberately not landed yet:** feeding `verifiedText` into `toIR` as a correction hint (a
`toIR` signature change, pre-seeding its internal correction loop before the first attempt) and
extending heal's category gate to `assertion_failed && verifiedText` — real plumbing, left for a
follow-up once there's evidence `accessibilitySnapshot` is populated and matches often enough in
practice to be worth it, rather than building it blind.

**Verified**: `tests/diagnosisVerify.test.ts` covers a confirmed quote, an unconfirmed (wrong)
quote, no snapshot to check against, whitespace/case-insensitivity, and a diagnosis with no
quoted text at all; regression-verified (neutering the function to always return `undefined`
makes the two positive-confirmation tests fail). Real diagnosis text used as the test fixture
(case-3's actual `explanation`/`suggestedFix`), not an invented example. `npx tsc --noEmit`
clean, `npx vitest run` 325/327 (same 2 pre-existing unrelated fixture failures).

### TD-39. `MESSAGE_LIKE` keyword scan missed gratitude-phrased confirmation copy, leaving a wrong guessed assertion uncorrected — High / Accidental — Fixed

**What it is.** `groundTerminalTextAssertion()` (`liveExtend.ts`) exists specifically to catch a
wrong-guessed terminal-text assertion and correct it to whatever the live page actually shows —
but its only candidate source, `candidateMessageLines()`, filters every line through a keyword
regex (`invalid|error|success|welcome|confirmed|complete|please|...`). A confirmation phrased as
plain gratitude, with none of those words, produces zero candidates, and the function silently
leaves the wrong guess in place rather than correcting it.

**Why it hurts.** Reported directly by a user watching the failure video for
`runs/2026-08-16T16-07-28-094Z-261d4022/cases/case-0`: the contact form filled correctly, the
right submit button was clicked, and the site's real WPForms "thank you" page loaded —
"Thanks for contacting us! We will be in touch with you shortly." None of that sentence matches
`MESSAGE_LIKE`, so the case was reported failed over an assertion checking for invented text
("Message sent successfully") that the site never had any intention of showing. This is the same
"the model can't know the real wording" problem TD-38 documents for diagnosis text, one layer
earlier in the pipeline — here it's the grounding net meant to catch it that has the gap.

**Fix applied.** `diffNewMessageLines()`: when the keyword scan finds nothing, replay the page
one step earlier (before the triggering action) and diff its text against the already-captured
after-state — whatever's genuinely new is a structural signal, not another wording guess. Two
noise guards, since a real page navigation can change more than the confirmation line: a
candidate is dropped if it also appears verbatim on some *other* already-discovered page
(`page.markdown`, reusing the same "persistent chrome proves nothing" principle `ir.ts`'s prompt
already states for assertion targets); if more than 15 candidates survive that filter, the diff
bails out entirely rather than guess among many plausible lines. Diff-sourced candidates use a
different tie-break than keyword-sourced ones — longest, not closest-to-the-wrong-guess'-length —
caught directly while writing the test for it: a real WPForms confirmation page has both its
message AND a short "Click here to re-submit the form" link, and length-to-guess picked the link
(34 chars, coincidentally close to a 26-char wrong guess) over the real 65-char message. The
original guess's length has no relationship to the truth once the keyword scan already came up
empty, so closest-to-guess is exactly the wrong heuristic there.

**Verified**: `tests/liveExtend.test.ts`'s new describe block covers the diff correcting a real
gratitude-phrased confirmation (the exact case-0 shape), the chrome filter dropping a candidate
that also appears on another known page (constructed deliberately *longer* than the real message
so the test actually depends on the filter — dropping only a short chrome line first passed even
with the filter disabled, since "longest wins" dodged it either way), the noise cap bailing out
on 20 candidates, and the keyword path still winning outright when it finds something (diff is a
fallback, not a replacement). All three guards individually regression-verified (reverting each
one in turn makes its specific test fail with the exact wrong-candidate signature, restored
after). `npx tsc --noEmit` clean, `npx vitest run` 329/331 (same 2 pre-existing unrelated
fixture failures).

## Auth-aware discovery — found and fixed across three real sites

Discovery was extended to log into a site before crawling it (`DECISIONS.md` D-22–D-26 record the
design). Every item below is a real bug caught against an actual target — saucedemo.com,
learnvibes.vercel.app, assettrack-web.onrender.com — not a hypothetical. Several were only
visible on a live `npm run serve` run; the corresponding fix is noted where a unit/vitest run
could not have caught it.

### TD-40. Login detection read the extracted PageModel, which is lossy on real SPA logins — High / Accidental — Fixed

**What it is.** The first version of `loginOnPage` found the password field via
`credentialFieldMap`, built only from `PageModel.forms[]` — and `extractForms` requires a literal
`<form>` tag. A React login with bare `<input>`s (no `<form>` wrapper) yields `forms: []`; the
fallback then matched the element's accessible *name* against `/pass/i`, and on
assettrack-web.onrender.com that name was the placeholder `"••••••••"`, matching nothing.

**Why it hurts.** No password field found means no login attempted at all, silently — the run
produced a one-page, login-only AppModel with `auth` absent and no error anywhere, indistinguishable
from a site that simply has no login. Confirmed directly against `runs/2026-08-22T04-18-57…040dd5ae`.

**Fix applied.** Detect and drive the login against the **live DOM**: the first visible, enabled
`input[type="password"]` is the anchor, with an escalating selector ladder for the identifier and
submit control (see D-22). This is immune to a missing `<form>`, a missing label, or a
placeholder-as-name.

**Verified**: `tests/authCrawl.test.ts`'s `/login-formless` fixture asserts the model-derived path
finds nothing (`credentialFieldMap(...).size === 0`) while the live-DOM path succeeds. The
`/login-bare` fixture (inputs with no id/name/data-* at all, only a placeholder — the exact
learnvibes shape) is covered by the `it.each` login table instead: it does have a `<form>`, so its
bug isn't a missing-form miss but the selector ladder itself needing a placeholder/aria-label/type
rung (part of this same fix, see D-22) — proven there by the live-DOM path still reaching a
verified session.

### TD-41. A shared `BrowserContext` was not enough — sessionStorage is scoped to a tab — High / Accidental — Fixed

**What it is.** The crawl opened a fresh `Page` per hop under one shared `BrowserContext`,
assuming cookie-based session persistence covered every site. assettrack-web.onrender.com stores
its session as `sessionStorage` keys (`token`, `user`) with **no cookie at all** — verified
directly: a second page opened on the same context came back with empty `sessionStorage` and the
login form.

**Why it hurts.** Every crawl hop after the login started logged out, producing the identical
symptom as TD-40 (a one-page model) even after the login itself had genuinely succeeded — the two
bugs were indistinguishable from the outside without reading `server.log`.

**Fix applied.** One long-lived `Page` for the entire crawl (`sharedPage()`), navigating URL to
URL instead of closing and reopening. Carries cookies, localStorage, and sessionStorage alike —
see `DECISIONS.md` D-23 for the rejected `storageState()` alternative.

**Verified**: `tests/authCrawl.test.ts`'s sessionStorage fixture asserts both directions in one
test — the same tab keeps the session across a second `goto`, and a genuinely new tab on the same
context does not, pinning the exact mechanism rather than just the end symptom.

### TD-42. "Login succeeded" was inferred from the URL changing — High / Accidental — Fixed

**What it is.** `page.url() !== urlBefore` was the sole success signal. Wrong in both directions:
an SPA that renders its dashboard at the same route (assettrack, confirmed live — the URL stayed
on `/login` while React swapped the whole page in) reports failure on a login that plainly worked
("Logged in successfully" was on screen); a site that bounces `/login -> /login?error=1` on a
rejected attempt reports success.

**Why it hurts.** A false failure here made a working login look broken and fell back to an
anonymous crawl, discarding a session that was fine. A false success (not observed live, but
reachable on the bounce-with-query-param shape) would have been worse: crawling a logged-out site
while believing it was authenticated.

**Fix applied.** `verifySession`: the login form itself must be gone from the page currently
loaded (`!hasLoginGate(page)`); if the app navigated somewhere, that destination is reloaded in the
SAME tab (not a fresh one — a fresh tab loses sessionStorage, see TD-41) and checked again.

**Verified**: `tests/authCrawl.test.ts` covers in-place SPA auth (no URL change, must report
success) and a wrong password (URL unchanged, form still visible, must report failure) as separate
cases — the two together are what a pure URL-diff check cannot distinguish.

### TD-43. The login prefix was injected into the wrong subset of cases — High / Accidental — Fixed

**What it is.** The prefix-injection gate reused `credentialPolicyFor(testCase, ...) === "full"`,
which returns `"full"` only for `valid`/`fromPrompt` cases — a check built to answer "should this
case's field values be replaced with real credentials," not "does this case need a session first."

**Why it hurts.** Verified against a real 5-case suite (`runs/2026-08-22T16-10-40…04cfa936`): an
`invalid-input` search case and a `state-change` sign-out case both ran with no login prefix and
both failed on the login page, while the two `valid` cases correctly received one. 3 of 5 cases
failed; the app being tested was never at fault.

**Fix applied.** `needsLoginPrefix(testCase, auth)` — gates on whether the case's `targetUrl` is
the login page itself, structurally (same `pageKey` comparison the login-case cap uses), not on
the case's credential-substitution policy. See `DECISIONS.md` D-26.

**Verified**: `tests/loginPrefix.test.ts` replays the exact category table from that run
(`valid`/`invalid-input`/`state-change`/`security-injection` all sign in; the login-page case does
not) and separately confirms artifact replay against that run's own saved `03-cases.json` matches.

### TD-44. The login prefix raced its own submit request — High / Accidental — Fixed

**What it is.** The prefix's last step was the submit click; the case's own steps started
immediately after, with nothing waiting for the login request to resolve.

**Why it hurts.** Caught directly from a step screenshot on a real run
(`runs/2026-08-22T16-10-40…04cfa936`, case-1): credentials were filled correctly, and the
following screenshot shows the "Sign In" button **still displaying its loading spinner** while the
next step had already fired `navigate /dashboard` — which bounced straight back to `/login`. This
is a pure timing bug; the login itself was correct.

**Fix applied.** `buildLoginPrefix` appends one more step: assert the password field's own
selector is `hidden`. `expect(...).toBeHidden({timeout:10000})` auto-waits, so it costs nothing on
a fast login and still covers a slow one (a cold serverless start) that a fixed
`page.waitForTimeout` could not size correctly either way.

**Verified**: a dedicated `tests/authCrawl.test.ts` fixture whose login endpoint responds after a
1.2s delay — every other login fixture in that file resolves instantly, which is exactly why this
shape reached a live run before anything caught it. The test fails without the settle step and
passes with it (confirmed both ways while writing it).

### TD-45. Redaction corrupted the AppModel when a credential value collided with an ordinary DOM keyword — High / Accidental — Fixed

**What it is.** `redactCredentials` JSON-stringifies its input and blind-replaces every occurrence
of a secret credential value, string-wide, with no awareness of what the surrounding field means.

**Why it hurts.** A real run's password was the literal string `"password"`. The saved AppModel
came back with `inputType: "[redacted]"` (was `"password"`), `id: "[redacted]"`, and
`css: "#[redacted]"` — eight structural replacements. `credentialFieldMap` could no longer find a
password field afterward, and the generator would have emitted `#[redacted]`, a selector matching
nothing. This fires *after* a successful login, so it silently poisons everything downstream of a
correct discovery run.

**Fix applied.** Refuse to redact a secret value that is itself a common DOM/HTML keyword — see
`DECISIONS.md` D-25 for why the alternative (a key-aware object walk) was rejected instead
(it would have broken `executor.ts`'s raw-string redaction of `final-page.txt`).

**Verified**: `tests/credentials.test.ts` pins the exact corruption shape (an `inputType`/`id`/
`css` all equal to `"password"` survive redaction intact) alongside a case in the *same* model
proving a real credential value (an email) is still scrubbed — the guard is per-value, not
all-or-nothing.

### TD-46. The discovery-time credential prompt could park a run with no UI to answer it — Medium / Accidental — Fixed

**What it is.** Moving the credential ask from after case-generation to inside discovery (so
discovery itself could use the answer) called `askCredentials(...)` directly. `askCredentials`
only parks a promise server-side; it is the `credentials`/`started` **event**
(`store.append` -> SSE -> `app.js`'s `showCredentialPrompt`) that makes the frontend render the
form at all.

**Why it hurts.** Without the event pair, the run held one of `MAX_CONCURRENT_RUNS` slots for the
full `CREDENTIAL_WAIT_MS` (5 min default) against a UI showing no way to type anything — reported
directly: "it is stuck on discovering ... but there is no option to provide credentials in the ui."

**Fix applied.** The discovery-side ask emits `credentials`/`started` before parking and
`credentials`/`completed` on every path, including a skip — mirroring the pre-existing
post-discovery ask exactly.

**Verified**: live in the browser pane — the credential form rendered mid-`discovery` stage
(step 2 still showing `WORKING`) for a prompt that carried no credentials, with the existing
footer copy ("Used for this run only...") still accurate.

### TD-47. A failed login was cached for up to 30 minutes, silently repeating the same failure — Medium / Accidental — Fixed

**What it is.** `discoverSiteHybrid`'s result — including a `login-failed` outcome — was written
to the AppModel disk cache like any other result, under `APPMODEL_CACHE_TTL_MS` (default 30 min).

**Why it hurts.** Caught directly: after fixing an unrelated selector bug, the very next run
against the same URL logged `cache hit for ... — skipping login and crawl` and reported the *old*
`login-failed` outcome, even though the new code would have succeeded. A transient failure (wrong
value typed, a login form that briefly changed, a slow deploy) should not pin a run to a broken
model for half an hour.

**Fix applied.** `auth.status === "login-failed"` is never cached; only `authenticated`,
`no-gate`, and `no-credentials` are.

**Verified**: manually only, once — clearing a stale cache entry and re-running reached the login
step again instead of short-circuiting. No automated test covers this: the fix is a single
`if (auth.status === "login-failed")` guard around the existing `cacheSet` call, and nothing in
this file's test suite currently exercises `discoverSiteHybrid`'s cache path at all.

### TD-48. The SPA nav-button click-probe only considered `nav`-landmark buttons, missing real anchor-based routes — Medium / Accidental — Fixed

**What it is.** `discoverUrlsByClicking` (added to get past a Next.js dashboard whose nav is
`<button onClick={router.push()}>` with zero `<a href>`) only looked at `role=button` elements
scoped to a `nav` landmark.

**Why it hurts.** saucedemo.com's inventory page has the opposite shape: its cart link is
`<a class="shopping_cart_link" data-test="shopping-cart-link">` with **no `href` attribute at
all**, and its product links are `href="#"` — both `role=link`, and neither inside a `<nav>`
landmark. `extractLinks`'s `$("a[href]")` skips the cart entirely; the click-probe's
nav-button-only filter found zero candidates either. Confirmed by replaying the new candidate rule
against the real captured page model: the old rule found 0 candidates, the new rule finds 12,
including the shopping cart link.

**Fix applied.** Widen candidates to `(button AND landmark==="nav") OR any link` — anchors need no
landmark scoping (they are semantically navigation, and the probe only runs once the href pass has
already returned nothing). Added `DESTRUCTIVE_VERB` (reset/delete/remove/clear/discard/cancel/
deactivate/archive, anchored) alongside the existing sign-out exclusion, since the widened rule
also surfaced saucedemo's real "Reset App State" anchor — discovery must stay a read-only pass.

**Verified**: a local `/anchor-spa` fixture in `tests/authCrawl.test.ts` reproduces the exact
saucedemo shape (no href anywhere) and asserts `internalUrls` is empty first, so the test can't
silently stop covering the bug it exists for; a second assertion confirms the reset control is
never among the discovered targets.

### TD-49. `discoverPagesHybrid` (multi-URL entry) remains auth-unaware — Medium / Strategic

**What it is.** All of TD-40 through TD-48 apply to `discoverSiteHybrid`, the single-URL entry
path. `discoverPagesHybrid`, used when a run is given multiple URLs directly, calls
`discoverHybrid` per URL with no credentials and no login step at all.

**Why it hurts.** A multi-URL run against a login-gated app gets the pre-auth-aware behaviour —
each URL modelled as its own login page, same failure mode this whole effort exists to fix.

**Owner.** Undecided whether multi-URL entry is common enough to justify duplicating the auth flow
there, versus routing it through the same login-aware path `discoverSiteHybrid` uses.

### TD-50. The click-probe's candidate cap is document order, not priority order — Low / Strategic

**What it is.** `MAX_CLICK_PROBES` (default 12) takes the first N qualifying elements in DOM
order. A page listing many repeated items (a large product grid) before its real navigation
controls could exhaust the cap before reaching them.

**Why it hurts.** Not yet observed on a real site — saucedemo's nav links happen to precede its
product grid — but it is a real ceiling with no signal today if it's ever hit silently.

**Owner.** Revisit if a real site's routes get cut off; the fix would be de-duplicating
structurally-identical repeated candidates (a pattern-detection pass, not attempted here) before
applying the cap, rather than raising the cap itself.

### TD-51. The History screen can only ever show 20 runs, and costs a full event-log read to do it — Medium / Strategic

**What it is.** `listRuns()` (`src/runStore.ts:177`) hard-caps at `.slice(0, 20)` newest run
directories, and for each one calls `store.read(runId)` (`:180`), which parses every line of that
run's `events.ndjson` — files that embed whole AppModels and IRs. `GET /api/runs` is the only
list endpoint; there is no paging, filtering, or search parameter.

**Why it hurts.** The cap was invisible while the only consumer was a sidebar rail showing recent
runs. The new History screen is a browsable list of past work, so the cap is now a product
limitation rather than a rendering detail: runs older than the newest 20 are unreachable from the
UI even though their directories are still on disk and still served at `/runs/<id>/`. The heading
says "Your 20 most recent runs" precisely so the screen does not claim more than it delivers —
that wording is a placeholder for a fix, not the intended end state. The per-call cost is the
second half: every visit to the screen re-parses up to 20 full event logs to extract a handful of
summary fields.

**Remediation.** Two independent pieces, either alone helps. (1) Accept `?limit`/`?before` on
`GET /api/runs` and page the directory listing, so the UI can ask for more. (2) Write a small
per-run summary file at the end of a run (status, prompt, url, suite counts) and have
`listRuns()` read *that* instead of replaying the event log — the data it needs is already
computed at `done` time. (2) also removes the incentive to keep the cap low.

---


**Update (TD-54).** The cap is now applied *after* access filtering, so the twenty rows
are twenty rows the caller may actually see rather than twenty directories that mostly get
discarded. The remediation below is unchanged and still wanted — this only removed the way
the cap was silently eating the whole list.
## The platform layer — found while building the case library and editor

Each of these is recorded in the phase report that found it (`docs/phases/`) and repeated here so
the ranked list stays the single place to look.

### TD-52. `replayAndSnapshot`'s cache key omits the credentials it was given — Medium / Accidental

**Symptom.** Fix a wrong username or password in the credential prompt, retry the save, and the
walk returns the **stale failed snapshot** instead of signing in again. The retry appears to run
and appears to fail the same way, which reads as "the fix did not work" rather than "the fix was
never tried".

**Cause.** The prefix-replay cache is keyed on `(baseUrl, prefix, policy)`. That is correct for
what the cache was built for — two edits on the same page sharing one browser walk — but
credentials are an input to the walk that the key does not mention, so two walks that differ *only*
in credentials collide.

**Why it matters more than it looks.** The failure is silent and self-reinforcing: the second
attempt is cheaper and faster than the first, which is exactly what a successful cache hit looks
like from outside.

**Remediation.** Include a non-reversible fingerprint of the credentials in the key — a hash, never
the values, since D-09 keeps secrets off disk and the cache key is a plain string. Alternatively,
bypass the cache entirely for any walk that consumed credentials: those walks are rare and already
the expensive path, so the lost sharing costs little.

*Found in `PHASE_CASE_CREDENTIALS_REPORT.md`, still open.*

### TD-53. A malformed case id returns 500 with raw Postgres text — Low / Accidental

**Symptom.** `GET /api/cases/xyz/steps` (or any `/api/cases/:caseId/*` route) with a non-UUID id
returns `500 {"error":"could not read case: invalid input syntax for type uuid: \"xyz\""}`.

**Cause.** `getCase` passes the path parameter straight to the query and lets the driver's error
text through. A value that cannot be an id is a **client** error — the right answer is 404, the
same one a well-formed-but-absent id gets.

**Why it matters.** Two small things, neither urgent. It tells an authenticated caller which
database engine is behind the API, and it turns a routine typo into a 5xx, which is the class of
error that pages an on-call.

**Remediation.** Validate the parameter shape at the route boundary and 404 on a mismatch, so the
answer for "no such case" is the same whether the id was malformed or simply absent.

*Found in `PHASE_NL_STEPS_REPORT.md`, out of that phase's scope, not fixed.*

### TD-54. `/api/runs` capped the list BEFORE access-filtering it, so history shrank toward empty — High / Accidental — Fixed

**Symptom.** History showed **2 runs** while **85 run directories** sat on disk and the pipeline was
writing new ones correctly. From the outside this is indistinguishable from "runs stopped being
recorded", which is how it was reported.

**Cause.** An ordering that looks equivalent and is not:

```ts
const diskRuns = listRuns();                       // newest 20 DIRECTORIES off disk
res.json(await filterRunsForUser(userId, diskRuns)); // then drop what you cannot prove you own
```

`filterRunsForUser` removes any run with no ownership row — correctly, and by design (TD-49's
sibling rule: "we cannot tell whose this is" must mean nobody's). But because the cap ran **first**,
every unfiled directory consumed one of the twenty visible slots before the filter ever saw it.
Measured directly: of the newest 20 directories, exactly **2** had rows.

**Why it degrades rather than fails.** Unfiled directories accumulate for entirely ordinary
reasons — runs created before `DB_ENABLED` was switched on, a dual-write that lost its race, a
stray process, and (TD-55) the test suite itself. Every one of them permanently costs a slot, so
the visible history shrinks monotonically while every individual component reports success.

**Fix.** Filter first, cap second. `listRuns(ids?)` now takes the id list to summarise, and the
route hands it only the ids that survived filtering:

```ts
const visible = await filterRunsForUser(userId, allRunIds().map((runId) => ({ runId })));
res.json(listRuns(visible.map((r) => r.runId)));
```

This is also the cheaper order: filtering is one database lookup over an id list, while
summarising is a full event-log parse per run — so only survivors pay for a parse.

Verified on the real server: **2 rows -> 20 rows**, same data, same response shape. Pinned by three
cases in `tests/tenancy.test.ts` ("the cap is applied AFTER access filtering"), one of which was
confirmed to fail against the old ordering before the fix was kept.

**Still open, and related:** TD-51 — there is no paging past 20 in either order.

### TD-55. The test suite leaked two real run directories into `runs/` on every invocation — Medium / Accidental — Fixed

**Symptom.** `ls runs/ | wc -l` grew by exactly 2 on every `npx vitest run`. The directories held
genuine pipeline output (`generated.spec.ts`, `cases/`, `07-suite-summary.json`) against
`https://example.com`, labelled "Replayed 2 saved cases" / "Replayed 1 saved case".

**Cause.** Two tests in `tests/library.test.ts` exercise the **real** `POST /api/replay` route,
which is the point — it is where authorization actually happens. But that route calls
`makeRunId()` itself, so unlike the file's other run fixtures the id cannot be fixed in advance,
and nothing recorded what the route returned. The existing `afterAll` cleaned only the two
hard-coded `TEST_RUN_IDS`.

**Why it mattered more than ordinary debris.** Combined with TD-54, it was actively degrading the
product: history reads the newest directories off disk, so two fresh unfiled runs per test
invocation pushed two of the user's real runs out of the visible window every time the suite ran.
A test that quietly makes the application worse is worse than no test.

**Fix.** `trackMintedRun(res)` records `res.body.runId` from any response that carries one, and
`afterAll` removes those alongside the fixed ids. Verified: `runs/` count unchanged across a full
suite run (87 -> 87, previously 85 -> 87).

---

## Site Store / View — Phase 0 measurement result

`SITE_STORE_VIEW_SPEC_v2.md` proposes replacing the AppModel-in-prompt with a Store + retrieval +
View. Its ground rule 7 gates the whole project on one unmeasured number, and rule 8 says the
finding is recorded here either way. `scripts/measureView.ts` produced it over **all 38 saved runs
that have an `02-appmodel.json`**, with a real tokenizer (`gpt-tokenizer`), no browser and no LLM.

**Outcome: the gate was not met. Phases 1, 2.5 and 3 are NOT STARTED, BLOCKED ON EVIDENCE — not
abandoned, not in progress.** The spec cost two days and prevented seventeen. Read what follows as
a method that worked, not a project that failed.

### TD-56. The token premise is half stale, and the half that holds is narrower than it looked — High / Strategic

#### A retracted number, first

> ~~`irCoverage` 100% on 38/38 runs~~

**This line measured nothing and must not be quoted.** `04-ir.json` stores `{ir, updatedAppModel}`,
not a bare IR; reading `.steps` off the wrapper produced zero references, and `coverage()` returned
`1` for zero references. Every run scored a perfect, empty pass. It is struck rather than quietly
replaced because it will otherwise be read back out of a diff and believed.

**The distribution figures below never depended on it and stand unchanged.** Reduction compares the
whole `toLiteModel` JSON against the whole View text; the coverage bug lived in a different
computation. A blanket "the earlier numbers were wrong" would throw away the good measurements
along with the bad.

The corrected figure is **`irCoverage` 100% on 28 of the 29 runs that have grounded references**,
with nine runs recorded as NOT MEASURED rather than counted as passes. The one drop is
`link "Contact Us"` on `2026-08-25T10-06-10`.

#### The correction that changes the result

The spec's Phase 0 says to measure "the AppModel exactly as it is serialized into the IR prompt
today" and points at `toLiteModel`. Appendix C says to follow the repo when a name differs, and the
repo has **two** serializers feeding **two** prompts:

| Stage | Call site | What it emits |
|---|---|---|
| test cases | `testCases.ts:427` `toLiteModel(appModel)` | **every** page, capped per page, 3 fields per element |
| IR | `ir.ts:1263` `toMicroModel(filtered, {currentPageUrl})` | **one** page, at most 30 elements, 3 fields |

`toMicroModel` already does most of what the View was proposed to do. So the spec's problem
statement — "large, page-unscoped, and full of fields the model cannot use" — is **true of the
test-case prompt and false of the IR prompt**.

#### The numbers

| Comparison | Result |
|---|---|
| purpose `testcases` — View vs `toLiteModel` | **max 80.7% / p95 69.0% / median 39.4%** smaller |
| — same, as a mean | 32.0% (kept for completeness; the wrong headline for a token-pressure problem) |
| — worst case | **-35.8%**, and **8 of 38 runs regress** |
| purpose `ir` — View vs `toMicroModel`, page-for-page | **56.6% LARGER** |
| retrieval — test View vs generic View | 16,214 vs 16,200 tokens |

Totals: `toLiteModel` 36,005 tokens, `toMicroModel` 9,563, generic View 16,200, single-page IR View
14,979.

**The IR half fails outright — not "under target", negative.** Building the Store and View for
`purpose: "ir"` would make that prompt bigger and replace a working path with a costlier one.

**The test-case half is real but uneven.** The win comes from a handful of dense runs while a third
of the corpus measures negative, which is why it is reported as max/p95 rather than as a mean.

**Retrieval was not measured, and this records a CORPUS LIMITATION, not a verdict against
retrieval.** 34 of the 38 runs are single-page (3 have two pages, 1 has five), so
`retrieveSubgraph` had nothing to choose between and the retrieved View is the generic View.
**Re-measure when at least 10 saved runs have 4 or more crawled pages.**

#### Why these numbers can be trusted where the first set could not

The harness shipped **four** bugs, none of which threw — each produced a confident, wrong table.
Three were arithmetic on the wrong data; the fourth is the one worth naming:

1. `04-ir.json` unwrapping, above.
2. **Keys joined on `\u0000` in some functions and on a space in others.** A NUL key never equals a
   space key, so every comparison returned "missing" — 29/29 runs "truncating", 0/0 "covered".
3. Live-extended elements scored as truncations, blaming `toMicroModel` for elements that did not
   exist when it ran.
4. Coverage counted `elements[]` only, while the prompt also carries a `navigation` tree and a
   `forms` block. Three nav links were reported as dropped by the element cap while the nav tree
   listed all three, as links, with hrefs.

Bugs 2 and 4 are **the same failure class**: a key or a prompt modelled incompletely, compared
confidently. A further instance was then caught *by the guard written for bug 2* — a hand-rolled
`(role, name)` joiner still sitting inside `elementId`, which nothing had noticed. That is four
occurrences of one root cause inside a single piece of work.

So it is not fixed, it is **guarded**, in `tests/measureView.test.ts`:

- `coverage()` **throws** on zero references instead of returning `1`. The caller decides "not
  measured"; the function refuses to invent a score. This is TD-01's shape — a check that passes
  because it never looked.
- the source is scanned for any hand-rolled `(role, name)` key, for raw NUL bytes, and for a second
  `NUL_SEP` declaration
- exact counts throughout — a fixture of 5 references with 3 present asserts **3/5**, never
  "greater than zero" and never "did not throw"
- an element present only in the nav tree, and one present only as a form label, each assert as
  covered

**Those two guards are the reason the rewritten figures are quotable and the originals are not.**

#### The threshold: 70 chars per element, and the band it sits in

Baseline **size** does not separate winners from losers — 87 elements in 15.5k chars reduces 69%,
while 108 elements in 6.1k chars regresses 25%, and size buckets stay mixed at every level.
Baseline **density** separates cleanly, and the mechanism is understood: `toLiteModel` also carries
forms, navigation trees, buttons, headings and breadcrumbs, all of which the View drops. A baseline
that is mostly bare elements has nothing to give up, so the View's per-element ids cost more than
compact JSON.

**Record the band, not just the number:**

| | |
|---|---|
| highest density that still **regresses** | **56.4** ch/el |
| lowest density that **improves** | **72.6** ch/el |
| empty band between them | **56.4 to 72.6**, containing no run of any kind |

`VIEW_MIN_CHARS_PER_ELEMENT = 70` therefore **sits inside a gap, not on a curve**. It clears the
worst regressor by 13.6 ch/el and keeps a cluster of seven runs at +39.4% that a higher setting
inside the same band would have forfeited for no gain in safety. A threshold chosen for margin is
the right instinct against a cliff; against an empty band it only forfeits value.

The threshold is **fitted to this corpus**. `tests/appModelText.test.ts`'s per-run assertion
therefore passes by construction and is a regression guard, not evidence of generalisation.

**Re-check trigger — point it at the BAND, not the number: re-fit when 15 saved runs postdate the
threshold's selection.** As runs accumulate inside 56.4–72.6 the band acquires a shape, and the
threshold should be re-fitted against that shape rather than defended as a chosen constant. **A run
above the threshold that regresses means the threshold is wrong**, not that the per-run test is too
strict — the per-run assertion stays per-run.

Chars track tokens closely across the corpus (ratio 3.49–4.38, median 4.15), so gating in
characters is sound and no runtime tokenizer dependency is needed. `ir.ts:1294` already gates on
`prompt.length` for the same kind of decision.

#### What this work produced besides a negative

The Store/View **artifact** failed its gate. The **harness built to measure it** did not: replaying
saved runs offline surfaced TD-57 (an Authentication case compiled without the login page — fixed,
truncation misses 10 to 2 corpus-wide), TD-58, TD-59 and TD-60, none of which anyone was looking
for. Recorded so the negative headline does not bury it.

#### Recommendation

Do not build Phases 1–3 as specified. Build the narrow projection of the test-case prompt only,
above the threshold above, and re-measure retrieval when the corpus can support it.

**Re-run with:** `npx tsx scripts/measureView.ts`. Touches no shipped file, costs nothing.
`VIEW_TOKEN_BUDGET` overrides the 2500-token default.

**Caveat on the tokenizer.** `gpt-tokenizer` counts GPT tokens; this pipeline sends Gemini. The
ratios the gate turns on hold across tokenizers, but the absolute counts are not Gemini's.

### TD-57. A bare-origin entry URL sent the IR prompt the wrong page — an Authentication case never saw the login form — High / Accidental — Fixed

**Symptom.** Three saved runs (`2026-08-24T11-10-01`, `2026-08-24T14-52-21`,
`2026-08-25T06-51-31`), all identical in shape: entry `https://learnvibes.vercel.app`, two
discovered pages `/dashboard` and `/login`, primary case feature `"Authentication"`. The IR prompt
was built from `/dashboard`. `"Sign In"`, the email box and the password box appear **nowhere** in
it — not in `elements`, not in the `navigation` tree, not in `forms`. The IR still grounded against
all three, because `groundingError()` validates against the *full* model rather than the prompt.

**Cause — two silent fallbacks compounding onto the same wrong page.** `toMicroModel` emits exactly
ONE page, so the lead page decides what the model can see at all.

1. `ir.ts` tested `p.url.startsWith(entryOrigin) && entryPath && p.url.includes(entryPath)`. For a
   bare origin `entryPath` is `"/"`, and every URL contains `"/"` — so the test matched whichever
   page came first in the array. It stops being a path test at that point.
2. `toMicroModel` then received `{ currentPageUrl: entryUrl }`, matched no page by `pageKey`, and
   fell back to `model.pages[0]` — the same wrong page, chosen a second time.

**The relevance filter was never at fault.** It correctly kept `/login` (its `concepts` are
`["Authentication", "Registration"]`, which the filter matches against the case's feature). The page
was discarded *after* the filter deliberately kept it.

**Fix.** Read `testCase.targetUrl` when choosing the lead page. That is a Zod schema field
(`testCases.ts:259`), documented to the model as *"when the model has multiple pages, this tells the
later stage which page to start from"*, and already compared with `pageKey` at `ir.ts:393` and
`testCases.ts:104`. It was simply never read here — structural, not a regex over prose. Two smaller
changes with it: the path test is only trusted when there *is* a path, and `toMicroModel` is told
which page `ir.ts` chose rather than left to re-resolve the entry URL and disagree with it.

**Measured, over all 29 runs with a saved IR: page-filter misses 9 → 1.** Two runs fully fixed
(3 missing → 0 each). The third went 4 → 1 — see TD-59.

Pinned by `tests/irPagePick.test.ts`, with `/dashboard` deliberately first in the fixture because
that ordering is what made the old code look correct. Verified failing against the old code.

### TD-58. `toMicroModel`'s 30-element cap dropped one grounded element — Low / Accidental — Filed, not fixed; NOT closed by TD-62

**Symptom.** On `2026-08-25T10-06-10` (87 elements, one page), `toMicroModel` logs
`capped 73 -> 30 elements`, and `link "custom logo link"` — which that run's IR grounds against —
reaches the prompt in no form: not as an element, not in the nav tree, not as a form label.

**Scope, and why it is Low.** This is **one element, on one run, across the whole 38-run corpus.**
The first measurement reported four, but three of those (`"Who We Are"`, `"Services"`,
`"Contact Us"`) were listed in the `navigation` tree as links with hrefs — the check was reading
`elements[]` only and ignoring two thirds of the prompt. The remaining one is the WordPress
custom-logo anchor.

**Deliberately not fixed.** The proposed fix was to make the cap rank before it cuts, reusing the
View's Pass 3 priority function. That would change how *every* IR prompt is built, on evidence of
one logo anchor on one run — the same disproportion that killed Phases 1–3 of
`SITE_STORE_VIEW_SPEC_v2.md`. **Do not fix by raising the cap**; if this is ever fixed, rank before
cutting and keep the cap at 30.

**Promote to Medium when:** a run grounds against an element the cap dropped *and* that element is
load-bearing for the case (a form field, a submit control), rather than a decorative logo link.
`scripts/measureView.ts` reports this per run under `element-cap`.

**TD-62 did NOT close this, though it was expected to.** The theory was that hidden inputs were
competing for the 30 slots, so evicting them would let the missing element back in. Measured after
the fix: on `2026-08-25T10-06-10` the cap emits 30 elements and `link "custom logo link"` is
**still absent** — that page had **zero** junk slots to recover, so nothing was freed. The recovery
TD-62 produced (11 slots) was entirely on a different run. Ranking the cap before it cuts remains
the only route, and on evidence of one decorative anchor it is still not worth taking.

### TD-59. `toMicroModel` sends one page, so a case spanning two pages cannot see both — Medium / Strategic

**Symptom.** `2026-08-24T14-52-21` grounds against four targets: `"Sign In"`, the email box and the
password box on `/login`, and `"Sign out"` on `/dashboard`. `toMicroModel` emits exactly one page,
so whichever is chosen, one target is invisible to the model. After TD-57's fix the run improved
from 4 missing to 1, and that last one is not reachable by any choice of single page.

**Why it is left standing.** The one-page reduction is what makes the IR prompt the most compressed
artifact in the pipeline — Phase 0 measured it at 9,563 tokens against `toLiteModel`'s 36,005, and a
projected View was **56.6% larger** than it. Widening the page pick to fix this is the token problem
returning by another door.

**Remediation, when it earns its way in.** Send the lead page in full and a *name-only* digest of
the other pages the relevance filter kept — enough for the model to reference an element on a second
page without carrying that page's whole element list. Measure before and after; if the digest costs
more than a few hundred tokens it is not worth it.

### TD-60. Grounding validates against the full model while the prompt shows a subset — Medium / Strategic — Theoretical, with a trigger

**The gap.** `groundingError()` (`ir.ts:1472`) checks a target against the complete `AppModel`.
The prompt shows a reduced projection: one page, ≤30 elements, plus a capped nav tree and form
block. So a target naming anything that exists *anywhere* on the site is accepted, whether or not
the model was ever shown it. Real by construction.

**Undemonstrated.** The run that prompted this note turned out not to be evidence: three of the four
elements were in the prompt's nav tree, and the fourth (TD-58) is a single decorative anchor. Across
29 runs with a saved IR there is currently **no** confirmed case of the model naming a load-bearing
element it was never shown.

**Why it is worth writing down anyway.** The failure it would produce is silent and would look like
a good IR: the model guesses a plausible name, grounding accepts it because it exists on some other
page, and the test fails at run time against the page it is actually on.

**Trigger — promote to a bug when:** any run grounds a target absent from the prompt in **all three**
blocks (elements, navigation tree, form labels) *and* that target is load-bearing. This is not
something to remember to check — `scripts/measureView.ts` §3.0 computes exactly this and attributes
each miss to its cause. A non-`live-extended` miss on a form or submit control is the signal.

### TD-61. The identity hypothesis was never a token argument, and has never been measured — Medium / Strategic — Open

`SITE_STORE_VIEW_SPEC_v2.md` bundled two independent claims. Phase 0 tested one of them.

- **Token argument** — the View is smaller than what ships today. Tested. Fails on the IR prompt,
  partially holds on the test-case prompt. That is TD-56.
- **Identity argument** — the model addresses elements by **id** rather than authoring a name, so
  grounding becomes a dictionary lookup; `nth` is computed from the Store instead of invented; and
  repeated-group discriminators disambiguate the duplicate `(role, name)` pairs that make grounding
  ambiguous today (TD-05). **Never a token argument, and never measured.**

Filed separately so it cannot re-enter under the token banner. Phase 0's negative says nothing about
it either way — a smaller prompt and an unambiguous one are different goods, and this one was never
on the scale.

**If it is revived it needs its own hypothesis and its own measurement**, stated before any code:
what fraction of grounding failures in saved runs are caused by ambiguous `(role, name)` pairs, and
would id-addressing have prevented them? `runs/` already holds the evidence, and answering it costs
nothing.

### TD-62. Hidden form inputs and a live CSRF token reach the model as if they were controls — High / Accidental — Fixed

**Both paths are fixed.** The View was where it was noticed, because the View promotes the junk to
its most prominent line, but the defect was in the element filter both stages share.
`isUsableElement` now lives in `appModel.ts` next to `INTERACTIVE_ROLES` and is called by
`ir.ts`'s `withFilteredElements` and by the projection, so the two cannot drift apart again — a
second copy is how they diverged in the first place.

**A narrower leak on a different path remains: see TD-63.** Filtering elements does not touch the
`forms` block, which is emitted verbatim with every hidden field's name and value.

**Symptom, on `2026-08-14T07-13-38` (amazon.in).** `toLiteModel`'s output — the block sent to the
test-case model — carries **55 hidden form inputs out of 440 elements**, including a live CSRF
token, each presented as an ordinary `textbox`:

```
textbox "SIGNIN_CLAIM_COLLECT"   textbox "FullPageUnifiedClaimCollect"   textbox "true"
textbox "claimType"   textbox "countryCode"   textbox "1"
textbox "hLJv+ZAi/ZCOz9pLnTdj9vNiN9BjFZcn/4qCiyrYi8cPAAAAAGp+wC0AAAAB"
```

**Cause.** `withFilteredElements` (`ir.ts`) keeps an element when it has a name and its role is in
`INTERACTIVE_ROLES`. `textbox` is interactive and these all have names, so all 55 survive. The same
predicate is what the View copied.

**Why they appear to have names.** The accessible name of an unlabelled hidden input **is its
value**, which is why a CSRF token looks like it is named after its own contents:

| hidden field `name` | `value`, which becomes the element's "name" |
|---|---|
| `appAction` | `SIGNIN_CLAIM_COLLECT` |
| `anti-csrftoken-a2z` | `hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD` |
| `metadata1` | `true` |

**Two signals are needed; neither is sufficient alone.**

- `Element` carries **no `tag` and no `inputType`**, so `type=hidden` cannot be read off the
  element at all. It *can* be read off `PageModel.forms[].fields[]`, which does carry `inputType` —
  a schema field, not a guess about wording. Match on the field's **value as well as its name**.
- `visible === false` catches only part: 30 of the 474 elements carry it, while
  `SIGNIN_CLAIM_COLLECT`, `claimType` and `countryCode` are all recorded **`visible: true`**.

**Fixed in the View** (`scripts/measureView.ts`), filtered in **two** places — the per-page element
filter and Pass 1's shared hoist, because the hoist runs first and on raw `p.elements`. Without the
second, a CSRF token still led the `shared:` line, precisely because appearing on every sign-in
page makes it look like site chrome. Six tests in `tests/measureView.test.ts`, at four densities
plus the hoist and the visible-alone case; all six verified failing without the filter.

**What the fix recovered, measured.** `toMicroModel` caps at 30, so junk does not merely add
noise — it takes slots from real controls. On `2026-08-14T07-13-38` (amazon.in), **11 of the 30
elements the model saw were things no test can act on**:

| what it was | how many |
|---|---|
| keyboard skip-links (`nav top`, `Cart, shift, alt, c`, ...) | 6 |
| hidden inputs (`add-new` x2, `IP2LOCATION`, a CSRF token, a hidden `Search in` combobox) | 5 |

Eleven real category links took their place — `Electronics`, `Fashion`, `Prime`, `Home & Kitchen`,
`Computers`, `Toys & Games`, `Beauty & Personal Care` and four more — none of which had reached the
model before. **Playwright would have refused to act on any of the eleven**, since its actionability
checks require visibility, so a case written against one could never have passed.

**Honest note on which signal did the work.** On that page all 11 were caught by
`visible === false`; the `forms[].inputType` signal contributed nothing there, because the hidden
fields live on the *sign-in* pages that the single-page pick never reaches. `forms[]` is still
required — it is the only witness for `SIGNIN_CLAIM_COLLECT`, `claimType` and `countryCode`, which
are all recorded `visible: true` — but it does not show up in these particular numbers.

**Corpus-wide the effect is narrow: 1 run of 38 spent slots on junk, 11 slots in total.** It is
filed as High because of what it cost on the run where it happened, not because it is widespread.

**Why this was not caught by any measurement.** Token reduction, `irCoverage` and the §6 A/B
comparison are all structurally blind to it: the junk is present in *both* arms and in *both*
prompts, so every comparison cancels it out. It was found by reading the View's output during §6 —
a defect in the INPUT, surfaced by an exercise designed to compare OUTPUTS.

### TD-63. The `forms` block sent every hidden field's name AND value to the model, including CSRF tokens — High / Accidental — Fixed in the prompts; the run artifacts are TD-64

**Distinct from TD-62, and not fixed by it.** TD-62 filters the `elements` array. `toLiteModel` and
`toMicroModel` also emit a **`forms` block**, copied through with `fields.slice(0, 20)` and no
regard for `inputType`. So a hidden field excluded from `elements` reappears in `forms`, complete
with its value.

**Measured across the 38-run corpus, after TD-62's fix:**

| Prompt | Runs still leaking hidden fields |
|---|---|
| IR (`toMicroModel`) | **1** — `2026-08-25T10-06-10`, 6 fields |
| test cases (`toLiteModel`) | **2** — including 53 fields on the amazon run |

What goes out on the amazon run includes `anti-csrftoken-a2z` with its live token value
(`hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD`), plus `appAction`, `claimType`, `countryCode` and
the rest of the OpenID handshake parameters.

**Severity: High, not Medium.** `DECISIONS.md` D-09 is "secrets never reach disk", and this is the
exact channel that rule exists to close. The value is session-scoped and short-lived, which is why
it is not Critical — but it left the process to a third-party API, and it was written to disk in a
publicly-served directory.

**Fixed.** `promptFormFields(form, cap)` in `appModel.ts` filters `inputType === "hidden"` **before**
the cap, and both serializers call it. Order matters: slicing first spends the field budget on
entries the model can do nothing with — 30 hidden fields ahead of one real one would emit 20 hidden
and lose the real field entirely. A hidden field has no label and cannot be typed into, so dropping
it costs no capability.

Verified across all 38 saved runs: **hidden fields in the IR prompt 1 -> 0, in the test-case prompt
2 -> 0**, and no token marker survives in either projection.

#### Check 1 — the run artifacts. CONFIRMED EXPOSED, and NOT fixed by this. See TD-64.

`runs/` is served publicly (TD-14). The token is on disk in **two** files of
`2026-08-14T07-13-38`:

| File | Size | `anti-csrftoken` | token value |
|---|---|---|---|
| `02-appmodel.json` | 2.2 MB | 11 | 3 |
| `events.ndjson` | 2.1 MB | 11 | 3 |

Carried by the `discovery` / `completed` event. This fix does not touch it: both files record the
**full** AppModel, not a projection, so filtering the projection cannot reach them.

**`scrubServedSecrets` could not have caught it either, and extending it there would not work.**
That function redacts KNOWN secret values — the operator's `TEST_USERNAME` / `TEST_PASSWORD`. A
CSRF token is supplied by the *site under test*, so it is on no list to redact against. It also
covers only `results.json`, `final-page.txt` and error-context files, not these two.

#### Check 2 — the caches. CLEAN, and by construction for one of them.

| Cache | Entries | Contains the token |
|---|---|---|
| `runs/_cache/llm` | 311 | **0** |
| `runs/_cache/appmodels` | 20 | **0** |

**Why the LLM cache is clean, so nobody re-investigates this:** `llmCacheSet` writes only the
**response**, to a file named after a SHA-1 **hash** of the prompt (`src/kb/llmCache.ts`). Prompt
text never reaches disk at all. A prompt carrying a secret therefore leaves nothing in the cache,
by construction rather than by luck — and the "a never-expiring cache turns a leak into a durable
artifact" concern does not apply to this cache for any secret, present or future.

The AppModel cache stores the full model and therefore *could* hold one; it happens not to today.
Its 30-minute TTL governs reads only — files stay on disk indefinitely — so a fix that stops the
value being recorded at all is the durable answer, which is TD-64.

**No purge is required.** Nothing needs deleting from either cache.

### TD-64. Hidden field values were recorded into publicly-served run artifacts — High / Accidental — Fixed at capture; `cleanedHtml` remains, see TD-65

**Split from TD-63, which fixed only the prompts.** `02-appmodel.json` and `events.ndjson` record
the **full** AppModel, not a projection, so filtering `toLiteModel` / `toMicroModel` cannot reach
them. On `2026-08-14T07-13-38` both files carry `anti-csrftoken-a2z` and its live token value, and
`runs/` is served publicly (TD-14).

**Why `scrubServedSecrets` is the wrong tool.** It redacts *known* secret values — the operator's
`TEST_USERNAME` / `TEST_PASSWORD` pair. A CSRF token comes from the site under test and is on no
list to redact against, so no amount of extending its file coverage would catch this class. The
value has to be dropped where it is captured, not where it is served.

**Remediation, in preference order.**

1. **Do not record hidden field values at all.** `domExtract.ts` populates `DomForm.fields[].value`.
   A hidden field's value is never useful downstream — nothing grounds against it, no step fills
   it, and `promptFormFields` now strips the whole field before any prompt. Recording `value: ""`
   for `inputType === "hidden"` closes every channel at once: artifacts, both caches, both prompts.
   This is the durable fix and it is small.
2. Failing that, strip hidden field values in `runStore`/the event sink before writing, which
   closes the artifact channel only.

**Fixed at capture, in two places, because it arrived by two routes.**

| Route | Fix |
|---|---|
| `forms[].fields[].value` (`domExtract.ts:238`) | `inputType === "hidden" ? "" : attr($in, "value")` |
| `elements[].name` — the accname chain fell through to `attr($el, "value")` | that fallback is skipped for `type=hidden` |

The second route is the one that is easy to miss: the element was *named after its own token*, and
one such element was recorded `visible: true`, so no visibility check would have caught it either.
A `type=hidden` input is not in the accessibility tree, so it has no accessible name to derive —
the fallback was wrong independently of this leak.

**Verified before changing it that nothing reads a hidden field's value.** `credentials.ts` reads
`inputType` / `name` / `placeholder` / `label` / `id`; `ir.ts`'s `formIndicesForName` reads
`label` / `name` / `placeholder`. No consumer anywhere reads `.value`. The field's *name* is still
recorded, since it identifies the form and carries nothing sensitive.

#### The affected run directory was DELETED

`runs/2026-08-14T07-13-38-280Z-9ac0738e` (amazon.in, 4.3 MB) is **gone**, removed deliberately on
2026-08-27 because `02-appmodel.json` and `events.ndjson` both carried a live
`anti-csrftoken-a2z` value and `runs/` is served publicly (TD-14). The token was session-scoped and
long expired, so this was hygiene rather than an incident.

**It is recorded here so its absence is not a mystery later.** That run was the densest AppModel in
the corpus — 5 pages, 474 elements, 133.5 chars/element — and it is cited throughout TD-56 to TD-63
as the source of the 80.7% reduction figure, the 11 wasted cap slots, and the §6 case-quality
comparison. Those numbers were measured before deletion and are not reproducible from `runs/` any
more. The §6 output survives verbatim in `docs/phases/PHASE0_CASE_QUALITY_RUNB.txt`.

After deletion: `grep -rl "anti-csrftoken\|hEj/Wh8642\|hLJv+ZAi" runs/` returns **nothing**.

### TD-65. `cleanedHtml` persists every page's raw HTML into a publicly-served artifact, and nothing reads it — Medium / Strategic

**The route TD-64's field-level fix cannot reach.** `PageModel.cleanedHtml` is the sanitised source
of the whole page, so it contains `value="..."` verbatim — every hidden input, and anything else the
page happened to embed. No field-level filter can touch it.

**It has zero readers.** Written at `domDiscovery.ts:199`, declared at `appModel.ts:180`, and never
read anywhere in `src/` or `public/`. It is not sent to any prompt: neither `toLiteModel` nor
`toMicroModel` emits it.

**It is most of the artifact.** On the amazon run it was **1,791 KB of a 2,139 KB
`02-appmodel.json`** — 84%. `runs/` is served publicly (TD-14), and `RUN_RETENTION_DAYS` is the only
thing that ever removes it.

So it is simultaneously the largest thing on disk, the last uncovered exposure route, and unused.

**Why it is Strategic rather than a bug.** It was presumably kept as debugging evidence, and
`CLAUDE.md` is explicit that `runs/` is "the primary evidence source this project's own debugging
relies on". Removing it is a judgement about what evidence is worth keeping, not a defect to fix —
which is why it is filed rather than deleted.

**Remediation, if taken.** Stop persisting `cleanedHtml` into `02-appmodel.json`. Artifacts shrink
by roughly 84%, the last raw-value route closes, and nothing loses a reader. If the raw HTML is
genuinely wanted for debugging, write it to a separate file that the run-artifact route does not
serve, rather than embedding it in the model.

**Pinned:** `tests/hiddenFieldCapture.test.ts` asserts that `cleaned_html` **does** still contain
the token — deliberately inverted, the same device used for TD-63. It fails when TD-65 lands, which
is the signal to flip it.

---

## Where the code lives

**`main` is the branch of record. `frontend` is the working branch. Everything else is noise.**

| Branch | What it is |
|---|---|
| `main` | The source of truth. Carries everything below. |
| `frontend` | Where work lands day to day, merged into `main` the same day. |
| `appmodel-projection` | The ONE branch deliberately held. See TD-56 — the projection is measured and tested but waiting on real runs before merging. |

Written after a real confusion: nine branches were created — one per request, so each could be
reviewed on its own merit — and then not merged. The result was that a delivered fix looked
broken because the checkout predated it. Splitting is fine; splitting *and leaving it* is not.

**The rule that follows from it:** a branch only survives overnight if it is genuinely being
held for a decision. Everything else merges the day it is finished.

**A stale held branch is worse than no branch.** `appmodel-projection` sat for long enough that
merging it would have *reverted* TD-63, TD-64, the project-count fix and the stacked phase
cards, and deleted three test files — silently, with a clean merge, because those files simply
did not exist on it. It has been rebased onto `main`; if it sits again, rebase it again before
going near a merge, and check `git diff --stat main..appmodel-projection` shows only additions.

---

## Where the Site Store / View work ended — read this before picking it up

Written 2026-08-27, at the point the work was deliberately stopped. `SITE_STORE_VIEW_SPEC_v2.md`
planned 18–19 days across seven phases after a measurement spike. **The spike's gate fired on day
two and most of the plan was cancelled.** What follows is what shipped, what is parked, and the
conditions under which each parked thing should be looked at again.

Nothing here is a to-do list. It is a map, so that the next person — including whoever wrote the
spec — does not re-derive the reasoning or re-litigate a decision that already has evidence behind
it.

### What merged into `frontend`

| Merged | What it is |
|---|---|
| `ir.ts` page pick (TD-57) | An Authentication case was compiled with the login page absent from the prompt. Two silent fallbacks landing on the same wrong page. Misses 9 → 1 across the corpus. |
| `isUsableElement` (TD-62) | Hidden inputs and skip-links were reaching the model as ordinary controls. On one run, 11 of `toMicroModel`'s 30 slots were spent on things no test can act on; eleven real category links took their place. |
| `promptFormFields` (TD-63) | The `forms` block carried every hidden field's name **and value** into both prompts, including a live CSRF token. 1 → 0 and 2 → 0 leaking runs. |
| capture-time fix (TD-64) | A hidden input's value is no longer recorded at all — not in `fields[].value`, not as an element's accessible name. |
| `scripts/measureView.ts` | The offline harness. Replays every saved run: no browser, no LLM, no cost. |

Every one of those bugs was found **by the measurement, not by the feature it was measuring.**

### What is parked on a branch, and why

**`appmodel-projection`** — the one piece of the spec worth building. `appModelBlock()` projects the
test-case prompt to text above 70 chars/element: measured **78.1% fewer tokens across 30 of 38
runs**, byte-identical baseline below the threshold, no run regressing.

It is **held, not abandoned**, for one reason: the evidence that it does not degrade case quality is
**a single comparison** (§6 — 10 cases vs 11 on the densest run, with auth and form flows surviving
in both). At n=1, with generation variance visibly present, that says *"did not produce thinner
cases on the run with the most structure to lose."* It does not say *"is safe."*

**Merge it when:** a handful of real runs have gone through the merged fixes and nothing looks off,
or a second §6 comparison on a different dense site agrees with the first.

### The cancelled phases, and what would revive them

| Phase | Status | Revive when |
|---|---|---|
| 1 — Store, identity, structural fields | Not started | Only if TD-61's measurement says id-addressing prevents real grounding failures |
| 2 — View builder | **Partially retained** as the projection above | — |
| 2.5 — Retrieval | Not started, **blocked on corpus** | **≥10 saved runs have ≥4 crawled pages.** 34 of 38 are single-page, so `retrieveSubgraph` had nothing to choose between and its value is unmeasured, not disproved |
| 3 — Resolver, `elementId?` on `Target` | Not started | With Phase 1 |
| 4 — Assertion-text grounding | **Untouched by any of this** | Its own hypothesis, never tested: *do live text-assertion corrections drop measurably?* |
| 5 — Wire into the IR prompt | **Dead** | Never. The IR prompt is already 56.6% smaller than the View would be |
| 6 — Failure modes | Not applicable | — |

### The re-check triggers, in one place

- **Retrieval (Phase 2.5):** re-measure when ≥10 saved runs have ≥4 crawled pages.
- **The 70 ch/el threshold (TD-56):** re-fit when **15 saved runs postdate its selection**. It was
  fitted to this corpus and sits inside an empty band (56.4–72.6). As runs land inside that band it
  acquires a shape, and the threshold should be re-fitted against it rather than defended as a
  constant. A run above the threshold that regresses means **the threshold is wrong**, not that the
  per-run test is too strict.
- **TD-58 (cap evicting a grounded element):** promote from Low when the dropped element is
  load-bearing — a form field or a submit control — rather than a decorative anchor.
- **TD-60 (grounding scope):** promote when any run grounds a target absent from **all three**
  prompt blocks. `measureView.ts` §3.0 computes exactly this; a non-`live-extended` miss on a form
  or submit control is the signal.

### Two inverted assertions are deliberately in the test suite

`tests/hiddenFieldCapture.test.ts` asserts that `cleaned_html` **does** still contain a token
(TD-65). It is not a claim that the junk belongs there — it records that TD-65 is unfixed, and it
**fails when TD-65 lands**, which is the signal to flip it. TD-63's equivalent already did this job
and has been flipped.

If one of these fails, do not "repair" it by widening whatever filter is nearby. Read the TD.

### The harness is load-bearing, and it lied five times

Every decision above came out of `scripts/measureView.ts`. It shipped **five** bugs before producing
a number worth trusting, and **not one of them threw** — each produced a confident, wrong table:

1. `04-ir.json` is `{ir, updatedAppModel}`; reading `.steps` off the wrapper gave zero references,
   and `coverage()` returned `1` for zero references. "irCoverage 100% on 38/38" measured nothing.
2. Keys joined on `\u0000` in some functions and a space in others — every comparison said
   "missing". Reported 29/29 runs truncating and 0/0 covered. Both artefacts.
3. Live-extended elements scored as truncations, blaming `toMicroModel` for elements that did not
   exist when it ran.
4. Coverage counted `elements[]` only, while the prompt also carries a `navigation` tree and a
   `forms` block.
5. Junk slots counted on the *emitted* elements, where `toMicroModel` has already stripped
   `visible`.

Bugs 2, 4 and 5 are one failure class: **a structure modelled incompletely, then compared
confidently.** `tests/measureView.test.ts` now guards it — `coverage()` throws on zero references
rather than returning a figure, and the source is scanned for hand-rolled `(role, name)` keys.

**Treat a number from this harness as provisional until a test pins it.** That is not pessimism;
it is the observed base rate.

### The one thing that is still open and costs nothing to answer

**TD-61 — the identity hypothesis.** The spec bundled two independent arguments and only one was
ever tested. Tokens: tested, and mostly wrong. Identity — id-addressing instead of the model
authoring names, `nth` from the Store, group discriminators against TD-05's ambiguous
`(role, name)` pairs — was **never a token argument and has never been measured.**

The measurement is free, because `runs/` already holds the evidence:

> Across saved runs, in what fraction of grounded targets is `(role, name)` ambiguous within the
> page the step is on — and in what fraction of those did `targetResolver` resolve to a **different
> element than the IR intended**?

The second half is the real question. Ambiguity that always resolves correctly is not a bug. If it
is ambiguous 30% of the time and wrong 0% of the time, TD-61 closes and the Store idea is finished
for good. If it is wrong even occasionally, that is a correctness bug no amount of prompt
compression would have fixed — and it is the strongest remaining reason to revisit Phase 1.

**State the hypothesis before touching the data.**

### What this cost, and what it bought

Two days of measurement prevented roughly seventeen days of building the wrong thing, and turned up
five real defects — one of which was compiling authentication tests that could not see the login
form, and three of which were sending a live CSRF token to a third-party API and writing it to a
publicly-served directory.

The gate worked. Record it as a method that worked, not a project that failed.

---

### TD-66. A replay never collected credentials, so every saved login case failed at the login — High / Accidental — Fixed

**What it was.** `runReplay` has always accepted a `creds` argument and always passed it to
`credentialEnvVars`, but its only caller — the `/api/replay` route — never supplied one.
`credentialEnvVars(undefined)` returns `{}`, so `TEST_USERNAME` / `TEST_PASSWORD` never reached the
spec's environment, and the generated `process.env.TEST_USERNAME ?? ""` typed an **empty string**
into the login form. The sign-in silently failed and the case died several steps later on whichever
assertion first noticed it was still logged out.

**Why it was hard to see.** The symptom lands far from the cause. On run
`2026-08-31T06-30-26-597Z-1c2a719e` the reported failure was
`expect(getByRole('button', {name:'Sign In'})).toBeHidden()` timing out — step 5 — while the user's
actual edit sat three steps further down and never ran. The representative screenshot is the login
page with empty fields, which reads as "step 1 broke". It also looked like editing had caused it:
the same case had just been edited, and a fresh run of the same site worked, because the
orchestrator asks for credentials and a replay never did. Diagnosed by artifact replay: the
replay's `events.ndjson` has no `credentials` stage at all.

**Fix.** `/api/replay` now resolves credentials before running — env first, prompt second — through
the same `askCredentials` waiter a run uses, and passes them to `runReplay`'s existing parameter.
The policy lives in one place (`src/server/resolveCredentials.ts`) shared with the case editor's
re-ground walk, so the two cannot drift. A replay whose cases contain no `${env:...}` prompts for
nothing and behaves exactly as before. No frontend change was needed: `showCredentialPrompt`
already defaults its post URL to `/api/runs/<runId>/credentials`, and a replay's runId is a real
run id. Pinned by `tests/replayCredentials.test.ts`.

### TD-67. The library can store a literal credential, and nothing on the save path stops it — High / Strategic — OPEN, security

**What it is.** `DECISIONS.md` D-09 ("secrets never reach disk") was designed around the run
pipeline: a user-supplied credential becomes an `${env:...}` reference in the IR and the generated
spec, and the real value is injected only into the Playwright child process. The **library is a
newer persistent store and that rule was never extended to it.**

The step editor renders a fill step's value as editable text. When that value is an `${env:...}`
reference, nothing prevents a person replacing it with a real credential, and nothing on the save
path notices: `parseIrStep` faithfully stores what was typed, `parseIr` validates shape only, and
`updateCase` writes it to `test_cases.ir` **and** to an immutable `test_case_versions` row. From
there it also reaches any generated spec produced from that version under `runs/`.

**Confirmed to have happened.** A database audit on 2026-09-01 found one case whose login steps
went from `${env:...}` at v1 to literal values at v2 and v3, both with the change note
`Edited steps`. Values were never printed: the audit classified them in SQL
(`value LIKE '$%{env:%}'`) rather than selecting them. A query for the same
reference-became-literal transition across every case and version returned only that one case, so
this is contained rather than systemic — every other literal found was legitimate test data
(SQL-injection payloads, deliberate wrong-password cases).

**Remediation, in order.** (1) Rotate the affected credential — scrubbing the store does not
un-leak a value. (2) Overwrite the live row and the affected version rows with the reference,
recording in the change note that the value was *scrubbed*, not edited. (3) Delete the affected
`runs/` directories rather than scrubbing them in place. (4) Close the gap: refuse a save where a
step's stored value matches `${env:...}` and the submitted value does not. That is a structural
check on IR values, not a regex over prose. **None of (1)-(4) is done as of this entry.**

**The general lesson, which outlives this instance.** D-09's invariant is "no secret reaches any
persistent store", and each store has to name its own enforcement point. Run artifacts have
`scrubServedSecrets`; generated specs have the `${env:...}` indirection; the database has
**nothing**. `scrubServedSecrets` cannot help here by construction — it redacts values it is *told*
are credentials via `secretEnv`, and a literal typed into an editor was never registered as one.

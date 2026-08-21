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
| TD-24 | `PLAYWRIGHT_TIMEOUT` env var is set but never read; comment implies otherwise | Low | Accidental | Lakshya |
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
(`playwright.config.ts:5`, currently 50s — TD-24 documents that the env var meant to keep these in
sync is dead), or give the child a bounded grace period after Playwright's own timeout fires before
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

**What it is.** `app.use("/runs", express.static("runs"))` with no authentication (TD-14) serves
every screenshot, trace, generated spec, and `results.json` ever produced. `runStore` caps the
*history list* shown in the UI at 20 but never prunes the underlying files. Measured at 344MB
across 27 run directories at time of writing — a moving number; don't trust this doc's figure
without re-measuring, that's exactly the drift `DECISIONS.md` D-01 exists to prevent.

**Why it hurts.** Disk usage and exposure both grow forever, unbounded by the same 20-run cap that
governs what the UI even shows a user.

**Remediation.** Prune on write — keep only the N newest run directories on disk, not just in the
history list.

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

**What it is.** 301 tests across 27 files exist (a moving number — re-check with `npx vitest run`
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

### TD-24. `PLAYWRIGHT_TIMEOUT` env var is set but never read; comment implies otherwise — Low / Accidental

**What it is.** `executor.ts` injects `PLAYWRIGHT_TIMEOUT: String(CONFIG.TIMEOUTS.TEST_RUN)` into
the child's env. No code anywhere reads `process.env.PLAYWRIGHT_TIMEOUT` —
`playwright.config.ts:5` hardcodes `timeout: 50_000` instead. The env var's own comment ("Increased
from 30s to 60s") reads as if it controls Playwright's per-test timeout; it only controls the
*parent* process's kill timer (TD-02).

**Why it hurts.** Today 60s (parent kill) > 50s (Playwright's real timeout) by coincidence, so
Playwright always reports before the parent kills it — except when it doesn't (TD-02). Someone
editing `CONFIG.TIMEOUTS.TEST_RUN` down, reasonably trusting the env var's name, could invert that
relationship and make a legitimately-slow-but-passing test get killed and silently retried instead
of correctly reported.

**Remediation.** Either have `playwright.config.ts` actually read `process.env.PLAYWRIGHT_TIMEOUT`,
or delete the env var and the misleading comment. Resolve together with TD-02.

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

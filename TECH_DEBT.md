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

## Status of fixes landed in the 2026-08-14 session

**This is a dated historical note, not a running status board.** It records one session's fixes and
has not been extended since; the document now runs to TD-67 with updates as recent as 2026-09-05.
Do not read it as "the latest state" — read the individual entries, and note that an entry's
authority is its own heading, not this list.

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
| TD-01 | `missingActions` can hard-fail a run over a *correct* IR — **symptom fixed** (structural coverage count), **class still open**: it still regexes LLM-authored prose (`CASE_ACTION_LINE`, `ir.ts`) and is cited across the docs as the reference example of that failure mode | Critical | Accidental | Lakshya |
| TD-02 | Executor's SIGKILL destroys the report needed to diagnose the failure it just caused — **fixed** (`TEST_RUN` raised 60s → 100s, a backstop above Playwright's own 50s per-test timeout) | Critical | Accidental | Lakshya |
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
| TD-20 | No CI runs the test suite — **fixed** (`.github/workflows/test.yml` runs `npm ci`, `tsc --noEmit`, `npm test` on push and PR). Still open: CI is **not a merge gate**, so a red run can land | High | Strategic | Lakshya |
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
| TD-52 | `replayAndSnapshot`'s cache key omits the credentials it was given | Medium | Accidental | ? |
| TD-53 | A malformed case id returns 500 with raw Postgres text | Low | Accidental | ? |
| TD-54 | `/api/runs` capped the list BEFORE access-filtering it, so history shrank toward empty — **fixed** | High | Accidental | ? |
| TD-55 | The test suite leaked two real run directories into `runs/` on every invocation — **fixed** | Medium | Accidental | ? |
| TD-56 | The token premise is half stale, and the half that holds is narrower than it looked | High | Strategic | ? |
| TD-57 | A bare-origin entry URL sent the IR prompt the wrong page — an Authentication case never saw the login form — **fixed** | High | Accidental | ? |
| TD-58 | `toMicroModel`'s 30-element cap dropped one grounded element — filed, not fixed | Low | Accidental | ? |
| TD-59 | `toMicroModel` sends one page, so a case spanning two pages cannot see both | Medium | Strategic | ? |
| TD-60 | Grounding validates against the full model while the prompt shows a subset — theoretical, with a trigger | Medium | Strategic | ? |
| TD-61 | The identity hypothesis was never a token argument, and has never been measured | Medium | Strategic | ? |
| TD-62 | Hidden form inputs and a live CSRF token reach the model as if they were controls — **fixed** | High | Accidental | ? |
| TD-63 | The `forms` block sent every hidden field's name AND value to the model, including CSRF tokens — **fixed** | High | Accidental | ? |
| TD-64 | Hidden field values were recorded into publicly-served run artifacts — **fixed at capture**; `cleanedHtml` remains (TD-65) | High | Accidental | ? |
| TD-65 | `cleanedHtml` persists every page's raw HTML into a publicly-served artifact, and nothing reads it | Medium | Strategic | ? |
| TD-66 | A replay never collected credentials, so every saved login case failed at the login — **fixed**; see the 2026-09-06 follow-up: the fix shipped with a persistence gap that meant the prompt could never render, now also fixed | High | Accidental | ? |
| TD-67 | The library could store a literal credential typed into the step editor — **fixed on the editor save path** (`restoreCredentialRefs` puts it back behind `${env:...}`); the save-from-run path was never affected | High | Strategic | ? |
| TD-68 | A saved case lost its script when the run it came from was deleted — the Script tab said "No script yet" beside "Passed v1" — **fixed** (spec stored per version + `GET /api/cases/:id/script`, regenerating from the IR when no stored copy exists) | High | Strategic (root) / Accidental (in effect) | ? |
| TD-69 | `detectBlocked` compared origins by string prefix, so an http→https or `www.` redirect reported every case as having left for an external provider — **fixed** (`isSameSite` compares hosts) | High | Accidental | ? |
| TD-70 | A `select` step emitted `selectOption()` unconditionally, so a React combobox (an `<input>` with `role="combobox"`) failed with "Element is not a `<select>` element"; the `:near()` fallback also offered plain inputs for an action that can never act on one — **fixed** (`choose()` branches on the real tag; the fallback is narrowed for `select`) | High | Accidental | ? |
| TD-71 | A missing Playwright ffmpeg stopped `browserContext.newPage()` outright, so a valid case was reported as a test failure with a blank screenshot instead of simply losing its video — **fixed** (probe + `PLAYWRIGHT_VIDEO=off` + a stated reason in the result) | Medium | Accidental | ? |
| TD-72 | `:near()` returning several controls resolved via `.first()` (**DOM order, not proximity**), so a modal's `fill "Email"` landed on the Full Name box above it — **fixed** (label→next-control in DOM order, dialog scoping; TD-72 promoted from filed to fixed by run `db2c0b4c`) | High | Accidental | ? |
| TD-73 | One `discovery` call sent **514,427 prompt tokens** — 40% of all prompt tokens on disk — because an element's accessible name was an inlined 648,107-char stylesheet and the concept-labeling prompt inlines names verbatim — **fixed** (per-name + per-list caps, an ARIA-snapshot cap, and a hard ceiling in `gemini.ts`) | Critical | Accidental | ? |
| TD-74 | IR grounding retried a rejection the model cannot fix, spending the full 4-attempt budget re-deriving the same refusal — **fixed** (a repeated target signature stops the retries) | High | Accidental | ? |
| TD-75 | An element's accessible name can be an entire inlined stylesheet, because `<style>` text is read as element text at capture — **the root cause behind TD-73, still open** | High | Accidental | ? |
| TD-76 | `selectOption()` matches an option EXACTLY, so a step value cased differently from the `<option>` text retried for the full timeout reporting only "did not find some options" — **fixed** (trimmed, case-insensitive, then containment) | Medium | Accidental | ? |
| TD-77 | Steps inside content revealed by a click (modal, tab, wizard) are never grounded, because discovery never saw it — **mitigated** (better resolution, TD-72) and **optionally fixed** behind `REPLAY_REGROUND`, which grounds them against the live page before a replay | High | Strategic | ? |
| TD-78 | `Locator.evaluate()` given a function as a STRING evaluates it as an expression and never calls it, returning `undefined` — so TD-72's DOM-order rung reported "no match" on every lookup and silently fell through to geometry. It never ran once, in either implementation — **fixed** | High | Accidental | ? |
| TD-79 | `choose()` resolved to whatever the step's locator returned and matched options once, immediately: a wrapper/label/custom shell was never walked to the real control, a server-populated list was read before it arrived, and a miss failed with Playwright's "did not find some options", naming neither the wanted value nor the available ones — **fixed** | High | Accidental | ? |
| TD-80 | A failed case showed a red X and NO text whenever no LLM diagnosis existed — which is every replay, by design. The failing step and the Playwright error sat unread in `05-result.json` — **fixed** (surfaced deterministically, no model call) | High | Strategic | ? |
| TD-81 | `resolveScope` cannot find a modal that sets no `role="dialog"`, no `aria-modal` and no dialog/modal class — the LMS's New User modal sets none of the three, so every lookup inside it is scoped to `body` and competes with the whole page behind it | Medium | Strategic | ? |

> **The table above stops being a reliable index if it is not extended.** TD-52 … TD-67 were written
> as detail sections with no table row for some time, which hid an **open security item (TD-67)**
> from anyone reading only the summary. If you add an entry, add a row.
>
> **Numbering:** IDs run TD-01 … TD-67 with **no TD-35** — it does not exist in the table or as a
> detail section, and the string appears nowhere in this file. That is a genuine gap of unknown
> cause, not a retired entry. **66 entries, highest id 67** — do not use the highest id as a count,
> and do not reuse 35.

---

## Pipeline correctness

### TD-01. `missingActions` can hard-fail a run over a *correct* IR — Critical / Accidental — **Symptom fixed, class still open**

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

### TD-02. Executor's SIGKILL destroys the report needed to diagnose the failure it just caused — Critical / Accidental — **Fixed**

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

**The drift runs BOTH ways — re-verified 2026-09-05.** This entry originally recorded only the
missing rung on the generator's side. The reverse is also true: `generator.ts` carries a
three-selector CSS fallback (`a:text-is()`, `button:text-is()`, `[role="menuitem"]:text-is()`) that
`resolveRoleWithFallback` does **not** have — `:text-is` appears nowhere in `targetResolver.ts`.
So each implementation now has a rung the other lacks, in opposite directions. Any remediation must
reconcile both, not just add `ROLE_SWAP` to the generator.

**Why it hurts.** An element can ground successfully during IR generation and then fail to resolve
in the *executed* spec — or resolve in the spec having failed during grounding. The two
implementations have already drifted apart in both directions; this isn't a theoretical risk. Nothing pins them equal, so the next divergence will also go unnoticed until a
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

**What it is.** `public/app.js`'s `connectToRun` checks `generation === pollGeneration` only at the
top of each loop iteration — never re-checked after the `await fetch`/`await res.json()`, before
`applyEvent(event, runId)` runs with the OLD `runId` closed over in that iteration.

> Cite the **function**, not a line number. This entry read "~line 1079" for a long time while the
> function sat past 2600; `app.js` has roughly doubled since. It is the only line-number citation
> into `public/*` anywhere in this document — keep it that way.

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

### TD-20. No CI runs the test suite — High / Strategic — **Fixed**

**What it was.** The tests existed and nothing executed them automatically. The only GitHub Actions
workflow was `.github/workflows/directory-tree.yml`, which regenerates a directory tree and pushes
to `main`.

**Why it hurt.** Every deterministic guard this project has built — grounding, credential policy,
scope filtering — was unenforced on any change. It was the highest leverage-per-effort item in this
register: one workflow file protects every other fix listed here.

**Fix, verified 2026-09-05.** `.github/workflows/test.yml` exists, is git-tracked, and is exactly
the remediation this entry proposed. It runs `on: push` and `on: pull_request`, Node 22 with npm
cache, then three steps: `npm ci`, `npx tsc --noEmit`, `npm test` (which `package.json` defines as
`vitest run`). TD-21 — the flake that would have made this intermittently red — was fixed first, as
this entry required.

> **This entry read "no CI" for longer than it was true, and the claim propagated.** It was repeated
> in `docs/team-guide/` Vol 5 and in conversation before anyone opened `.github/workflows/`. If you
> are about to state that this project has no CI, check the directory first. Two workflows live
> there, not one.
>
> What remains true, and is the thing people probably meant: **CI is not a merge gate.** Nothing in
> the repo enforces that the workflow passed before a branch merges, so a red run can still land.
> That is a repository-settings change (branch protection), not a code change, and it is the only
> part of this entry still open.

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

### TD-25. Deleting the currently-viewed run leaves its polling loop running forever — Low / Accidental — **Fixed**

**What it was.** The history delete button's handler called `DELETE /api/runs/:runId` and
`loadHistory()` but never touched `pollGeneration`.

**Why it hurt.** Deleting the run currently on screen left `connectToRun`'s poll loop hitting the
now-deleted run's `/state` endpoint forever.

**Fix, verified 2026-09-05.** The handler now bumps the generation counter, which is exactly the
remediation this entry proposed — orphaning the old loop so it cannot touch the DOM again:

```js
await fetch(`/api/runs/${runId}`, { method: "DELETE" });
if (currentRunId === runId) {
  pollGeneration++;
}
loadHistory();
```

**One untested neighbour, deliberately not claimed as fixed.** A Delete control now also exists on
*project* rows, which is a different path. Whether deleting a project that contains the
currently-viewed run should likewise bump `pollGeneration` has not been checked. It is a plausible
new instance of this entry's class rather than a known defect — verify before filing it as one.

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

### TD-31. A not-yet-hydrated page (0 extracted elements) is accepted as a valid AppModel with no retry — High / Strategic (root) / Accidental (in effect) — Fixed

> Heading corrected 2026-09-05. It previously read "…cacheable AppModel with **no vision
> fallback**", which describes a different remediation from the one that shipped and from the one
> the summary row claims. The fix in the code is **polling before accepting zero**
> (`domDiscovery.ts`, `DISCOVERY_HYDRATION_POLL_MS`, default 6000) — not a vision fallback.

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

**Fix.** `/api/replay` now resolves credentials before running — prompt first, with the
environment as the fallback when the person supplies nothing (`DECISIONS.md` D-30) — through
the same `askCredentials` waiter a run uses, and passes them to `runReplay`'s existing parameter.
The policy lives in one place (`src/server/resolveCredentials.ts`) shared with the case editor's
re-ground walk, so the two cannot drift. A replay whose cases contain no `${env:...}` prompts for
nothing and behaves exactly as before. No frontend change was needed: `showCredentialPrompt`
already defaults its post URL to `/api/runs/<runId>/credentials`, and a replay's runId is a real
run id. Pinned by `tests/replayCredentials.test.ts`.

#### Follow-up 2026-09-06 — the fix above shipped with a gap, and a later failure had TWO causes

Run `2026-09-04T10-44-48-583Z-a388c88e` ("Search with no results") failed at
`expect(input[placeholder="*********"]).toBeHidden()` — the password box was still on screen, so
the login never happened — with **no `credentials` event in its `events.ndjson`** at all. Both of
the following were true, and only the first was suspected:

**1. That server predated this fix.** Its event log runs `input` → `execute started` in **33 ms**.
A prompt-first replay parks on `askCredentials` for up to `CREDENTIAL_WAIT_MS`, so 33 ms is proof
the prompt was never attempted. `tsx` has no watch/reload — the process was simply older than the
code. This is the `CLAUDE.md` sharp edge, hit again.

**2. The credential events were never persisted, so no browser could ever have shown the prompt.**
The route emitted them through its `onEvent`, which calls `record()` — and `record()` is **live SSE
fan-out only**; durability is the caller's job via `store.append`, which `orchestrator.ts` and
`replay.ts` both do and this call site did not. Since **no client consumes the SSE route** (the UI
polls `/api/runs/:runId/state`, which reads the store), the prompt would never have rendered even
on a current server: the run would park for the full five minutes and then fall back to the
environment — which on a machine with `TEST_USERNAME` unset means empty credentials, i.e. exactly
the original symptom.

So the "stale server" explanation was correct **and** insufficient. Fixed by appending to the store
before fanning out, mirroring the two other emit sites.

**Pinned by `tests/replayCredentialPrompt.test.ts`**, which asserts the ordering rather than mere
presence: `credentials started` (with `fields: ["username","password"]`) must appear **before**
`execute started`, and the typed values — not empty strings — must reach the Playwright child via
`credentialEnvVars`. A test that only asserted "a credentials event exists somewhere" would pass
against a server that asked *after* executing, which is the same bug wearing a different shape.

Two notes for whoever reads this next. `credentialKindsNeeded` inspects `step.value` and never
looks at `step.action`, so an env reference on a `press` or `click` is seen exactly like one on a
`fill` — which matters because the LMS login submits with a button. And while writing the test its
first version read `/state` as `{ events: [...] }` when the route returns the array itself; every
poll silently returned `[]`, and the test that did not assert ordering still went green. That is
`CLAUDE.md`'s "don't assume a passing test proves a fix" in miniature.

### TD-67. The library can store a literal credential, and nothing on the save path stops it — High / Strategic — Fixed (editor save path); rotation and scrub still owed

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

**Fixed on 2026-09-06 — remediation step (4), the structural gap.** `restoreCredentialRefs` in
`credentials.ts` now runs on the editor save path, before anything is validated or written. It
converts a typed credential back to `${env:TEST_USERNAME}` / `${env:TEST_PASSWORD}` and tells the
person in one line what happened.

It reuses the existing classifier rather than adding a second regex over prose (`CLAUDE.md`, the
central design rule). Three signals, in confidence order:

1. **The step's own history** — the value being replaced was already an `${env:...}` reference, so
   this system has already classified that field, during the run that produced the case, from the
   live DOM. This is the primary signal and the only one that catches the reported case: the two
   fields are named `you@thinkvibes.com` and `*********` (placeholder text), which match neither
   `/pass/i` nor `/user|email|login|account/i`. **A guard built on naming would have missed the
   exact leak that prompted this.**
2. **The DOM's own `inputType`**, via `credentialFieldMap` — strongest where available, needs no
   naming at all.
3. **A bare name**, and then **only for a password**. `credentialKindForTarget` calls any field
   named "Email" an identifier, which is right inside a login form and wrong on a newsletter,
   contact or search form. Rewriting one of those to `${env:TEST_USERNAME}` would break a working
   test to protect something that is not a secret — caught by `tests/library.test.ts` while this
   was being built, and now pinned by two tests of its own.

**The typed value is used for THIS save's re-ground and then discarded** (platform rule 5). The walk
has to actually sign in, so it cannot be dropped on the spot: `restoreCredentialRefs` hands the
literals back on a *separate* object (`live`, `creds`) that the request handler uses and lets fall
out of scope. The two IRs are kept apart deliberately — `validated` (references) is what gets
written, `liveIr` (literals) is what the browser sees. `writeIt` then re-applies the reference
per-step from `validated`, because the grounded result the walk returns is derived from `liveIr` and
would otherwise carry the literal into the row one line later. That was a real hole in the first
wiring of this fix, found by tracing the job path.

12 tests in `tests/credentialLiteralGuard.test.ts` cover the function, including the assertion
that matters: the literal appears nowhere in what would be stored, and nowhere in the generated
spec. Two more in `tests/library.test.ts` drive the actual save **route** and read the stored row —
one per save path, because they write from different objects. Both were mutation-checked: removing
the `prepareEdit` wiring reddens both, and swapping `writeIt(safeIr)` back to `writeIt(grounded.ir)`
reddens the job-path one with `expected 'leaked.user@example.com' to be
'${env:TEST_USERNAME}'` — the exact leak, caught by the test rather than by reading the code.

**Still owed:** steps (1) rotate, (2) scrub the affected row and version rows, (3) delete the
affected `runs/` directories. Those are operational, not code, and are the user's to run.

### TD-68. A saved case lost its script when its originating run was deleted — High / Strategic (root) / Accidental (in effect) — Fixed

**What it was.** The Playwright `.spec.ts` for a saved case existed in exactly one place on earth:
the artifact folder of the run it was saved from. `paintScriptTab()` in `public/app.js` asked
`/api/cases/:caseId/runs` for the newest `run_cases` row and fetched
`/runs/<runId>/cases/case-N/generated.spec.ts` off disk. A 404 rendered *"No script yet — the spec
is written when this case runs."*

Run folders are deleted routinely and by design: `DELETE /api/runs/:runId` does an `rmSync`,
`retention.ts` does the same on a timer once `RUN_RETENTION_DAYS` is set, and `runs/` is gitignored
so a fresh clone or a second machine has none at all. The database stored **only the IR**, never
the spec.

So a case could truthfully report **"Passed v1"** in one tab and **"No script yet"** in the next.
The message was also actively misleading — it told the reader to run the case to produce a script,
when the script had already been produced and then deleted.

**Evidence.** Case *"Navigate to the FAQ page"* (project "Salesforce Website") had a single
`run_cases` row pointing at run `2026-09-01T09-43-27-050Z-e900b8d9`, whose directory no longer
exists. Its source run `2026-09-01T07-29-30-238Z-a031b900` **does** still exist on disk and does
contain `cases/case-3/generated.spec.ts` — but nothing ever consulted `source_run_id`, so the tab
went straight from one missing folder to "No script yet" without trying the copy it had.

**Why it hurt more than a blank tab.** The spec is the artifact a user hands to a colleague, pastes
into a PR, or reads to understand what a case actually does. Losing it on a schedule made the
library untrustworthy for its stated purpose — a saved case is supposed to be the durable thing.

**The fix, three parts.**

1. **Schema.** Migration `add_spec_to_test_case_versions` on Supabase project
   `tvujslcqkykxwenloimg` adds a nullable `spec text` column to `test_case_versions`. Existing
   rows were **deliberately not backfilled** — a backfill would write today's generator's output
   onto versions authored by an older one, quietly replacing history with a re-derivation. Row
   count before and after: 34, unchanged.
2. **Write.** All three `test_case_versions` insert sites in `src/server/library.ts`
   (`saveCaseFromRun`, `updateCase`, `duplicateCase`) now also store
   `generateSpec(ir, LIBRARY_SHOT_DIR)`. The screenshot dir is a named constant precisely so the
   stored and regenerated specs cannot drift apart.
3. **Read.** New route `GET /api/cases/:caseId/script` (optional `?version=N`) returning
   `{ spec, source: "stored" | "generated", version }`, backed by `getCaseScript` in `library.ts`.
   A stored spec wins; otherwise the IR is re-rendered on the spot.

**Regeneration is not a degraded mode.** `generateSpec` is pure code with no LLM and no I/O
(`DECISIONS.md` D-06), so the same IR yields the same bytes every time. `tests/caseScript.test.ts`
asserts exactly that — byte-identity between what a null column regenerates and
`generateSpec(storedIr, "artifacts")` — with the real generator, not a mock. `source` is returned
so the UI can be honest about which copy is on screen, not because either is suspect.

**The route cannot leave a case scriptless.** Every failure on the stored-spec path — a column that
does not exist yet, an unreadable row, a database that has not been migrated — falls through to
regeneration. The only errors it raises are the access errors every sibling function raises.

**The WRITE path is coupled to the column, and is not symmetrically forgiving. Know this before
rolling the migration back.** All three insert sites now name `spec`, and the three handle a
rejected insert differently: `saveCaseFromRun` and `duplicateCase` do not check the insert error
(pre-existing behaviour) and would silently lose the version row, while `updateCase` *does* check
it and would fail the user's edit with a 500. That last one is a failure mode this change
introduced. It is not reachable today — the column exists, and PostgREST resolves it (verified by
selecting `spec` through the real client, not through raw SQL: reads and writes share one schema
cache, so a raw-SQL check would have proved nothing about the insert path). It becomes reachable
only if the column is dropped while the code still names it. **The unit tests cannot catch this
class at all**: the Supabase mock's `insert` ignores column names entirely, so it accepts a payload
naming a column that does not exist. A real save against a real database is the only check that
exercises it.

**What is still true and was not changed.** The run's own `generated.spec.ts` remains the exact
bytes that executed, and a re-render is not a substitute for that. It is now offered as a secondary
link ("open the spec from the last run") which simply disappears when the folder does, rather than
being the tab's only content. The fallback chain is: newest `run_cases` row whose file responds
200, then the case's `source_run_id`. **`source_run_id` has no stored case index**, so that last
hop can only offer the run-level spec — correct when the case came from a single-case run, the
run's primary case otherwise. That is why it is labelled as a link to a run rather than silently
rendered as this case's script; storing the case index at save time would close it properly.

### TD-69. `detectBlocked` judged "same site" by origin string prefix, so an http→https redirect marked every case blocked — High / Accidental — Fixed

**What it was.** `detectBlocked(artifactsDir, appOrigin)` in `src/stages/executor.ts` decided a run
had left the application with `!finalUrl.startsWith(appOrigin)`. `appOrigin` comes from `originOf()`
— `new URL(url).origin` — which includes the scheme.

So any redirect that changes the scheme, adds or drops `www.`, or changes the port reads as leaving
the site, and the case is reported `blocked` rather than passed or failed.

**Evidence.** Run `2026-09-01T07-17-37-947Z-35c773cf`. The user entered
`http://veterans.my.site.com/s/`; the site did the ordinary thing and redirected to `https://…`.
All **3 of 3** cases came back with
*"the flow left the application for veterans.my.site.com, an external sign-in provider the test
can't complete"* — naming the application's own host as the external provider it had supposedly
left for. The message is self-refuting on its face, which is what made it findable.

**Why it hurt.** `blocked` is the one verdict that means "this is not about your site" — it
suppresses the failure analysis and tells the user nothing was learned. Applying it to correct runs
against any http-entered or `www.`-redirecting site discards real results and, worse, teaches the
reader to distrust the verdict that exists to be trustworthy.

**The fix.** A small exported helper, `isSameSite(a, b)` in `executor.ts`, comparing **hostnames**
after stripping a leading `www.`, case-insensitively, ignoring scheme, port and path.
`detectBlocked` is its only caller. The three `originOf()` helpers in `orchestrator.ts`,
`suiteRunner.ts` and `replay.ts` were left exactly as they are — they still return an origin, the
comparison is what changed, and fixing it in one place is what stops the three copies drifting
(the `TECH_DEBT.md` TD-07 pattern).

**Unreadable input returns `true` (same site), on purpose.** The failure mode being fixed is a
false positive; "I cannot parse this" must therefore fall to the side that reports nothing. The
caller's own pre-existing comment already called an unparseable URL "not a reliable signal" — this
makes that explicit instead of leaving it to an inner `try/catch`.

**A subdomain is still a different site.** `evil.x.com` vs `x.com` is `false`. That is deliberate,
not an oversight: an OAuth provider on `accounts.<something>` is exactly the case this guard exists
to catch, so the conservative direction here is to keep reporting it. `tests/isSameSite.test.ts`
pins both directions, including that a suffix match (`notx.com` ends with `x.com`) is not a match.

### TD-70. A `select` step emitted `selectOption()` even when the element was not a `<select>` — High / Accidental — Fixed

**What it was.** Grounding matches on **role**. A React combobox has `role="combobox"` and is an
`<input>` with a popup list — no `<option>` children and no `selectOption()` support. But
`generator.ts` emitted `selectOption()` unconditionally for the `select` action, so a correctly
grounded step could not execute.

Run `2026-09-04T10-38-19-619Z-bf20906d`, case *"Admin creates a new user via management
interface"*, `cases/case-0/05-result.json`:

```
locator.selectOption: Error: Element is not a <select> element
waiting for locator('input:near(:text("Manager"), 120), textarea:near(...), select:near(...)').first()
- locator resolved to <input require…
```

The saved IR steps were `{"action":"select","target":{"role":"combobox","name":"Manager"},
"value":"prashant mishra"}` and the same for `"Role"`. Both are correct descriptions of the page.

**Two independent mistakes on that one line, and the error text shows both.**

1. **The action was wrong for the element.** `selectOption()` can only ever act on a `<select>`.
2. **The fallback offered an element that could never satisfy the action.** `nearFieldSelector`
   returned `input, textarea, select` for *every* field action, so the positional rung handed back
   a plain `<input>` for a `select`. The `locator resolved to <input` in the log is that.

**The fix.**

- **`choose(page, target, value)`**, a new injected helper, branches on the element's real
  `tagName` at run time: `SELECT` goes to `selectOption(value)`; anything else is clicked, then
  `getByRole('option', { name: value })` is clicked, falling back to an exact text match **scoped
  to the visible popup**. Pure code, no model call — the generator stays deterministic (D-06).
- **`nearFieldSelector(hint, action)`** returns `select, [role="combobox"]` for a `select` and is
  unchanged for everything else. Role, not tag, is what says an element can take a choice — which
  is why a custom combobox's `<input>` is still reachable, and a bare one is not.
- The action is threaded through `resolveCode` into the generated `field(page, hint, action)`, and
  through `resolveLive` into `resolveField`, so the live replay path and the generated path narrow
  identically.

**Verified in a real browser, not against the emitted string** (D-19, and the
`.filter({ visible: true })` precedent). `tests/selectAction.test.ts` **extracts the helpers from
the generated spec text and executes them** against a synthetic page carrying all three shapes: a
native `<select>`, a combobox with `role="option"` items, and a dropdown whose items carry only
text. A string assertion could not have distinguished any of them.

**That real run caught a bug in the fix itself, which is the point of running it.** The popup was
first scoped with `page.locator('[role="listbox"], …').first()`. On a form with more than one
dropdown that is the first listbox in **DOM order** — a *closed* one — so the text fallback waited
10 s and timed out. It now scopes to `:visible`. Nothing about reading the code would have shown
this.

**Also pinned:** `tests/selectAction.test.ts` asserts the generated `nearField()` and
`targetResolver.ts`'s `nearFieldSelector()` return identical strings for `select` / `fill` /
`check` / undefined. TD-07 says these two implementations have already drifted once; this stops
them drifting on the axis that decides whether a select can land on an `<input>`.

### TD-71. A missing ffmpeg failed the whole run instead of just the video — Medium / Accidental — Fixed

**What it was.** `playwright.config.ts` sets `video: "retain-on-failure"`, and Playwright starts
the recorder when the **context** is created. So a missing ffmpeg does not degrade to "no video" —
it stops the context opening at all:

```
browserContext.newPage: Executable doesn't exist at …\ms-playwright\ffmpeg-1010\ffmpeg-win64.exe
```

Every case in run `2026-08-31T06-56-52-852Z-7943ebb2` died that way about **960 ms** in, before a
single `page.goto`. `screenshot: "on"` then photographed a page that had never navigated, so the UI
showed a blank white 4,331-byte PNG **and called it a test failure**. Nothing about the site under
test was wrong, and nothing on screen said so.

**Why it is worse than a missing video.** The verdict was wrong in the direction that costs the
most: a person looks at a failing test and goes to investigate their own website.

**The fix.**

- `ffmpegAvailable()` in `executor.ts` probes the browsers directory for an `ffmpeg-*` folder
  containing a file whose name starts with `ffmpeg`, honouring `PLAYWRIGHT_BROWSERS_PATH`.
  Memoized — one glob per process, not one per case.
- When it is absent, `runSpec` sets `PLAYWRIGHT_VIDEO=off` in the child's environment, and
  `playwright.config.ts` reads it. **Screenshots and traces are untouched** — they are what the UI
  actually shows.
- `ExecResult` gains an optional `videoUnavailable` string, carried into the `done` event and
  rendered by `public/app.js` in a `#videoUnavailable` note (reusing `.tree-empty`, no new class).
  So the UI says *why* there is no player rather than leaving a silent gap.
- `warnIfNoVideo()` logs once at server startup, naming `npx playwright install`.

**Deliberately permissive.** An unreadable or absent browsers directory returns "available". A
false negative costs a run its video; a false positive costs nothing, because the run then behaves
exactly as it does today.

**Why probing the filesystem rather than asking Playwright.** The registry that owns this path is
`playwright-core` internals. Coupling a shipped code path to a private module across version bumps
is a worse bet than a glob over a layout (`<browsers>/ffmpeg-<rev>/ffmpeg*`) that has been stable
for years.

### TD-72. `:near()` ties are broken by DOM order, not by distance — High / Accidental — Fixed

**What it is.** `nearFieldSelector` builds `<tag>:near(:text("Hint"), 120)`. When more than one
control falls inside that 120px radius the locator matches them all, and both `resolveField` and
the generated `field()` fall through to **`.first()`** — which is **document order**, not nearest.
So the control bound to a step can be one the anchor text does not label.

**Measured while fixing TD-70**, on a synthetic page with three controls inside one radius:

```
selector: select:near(:text("Manager"), 120), [role="combobox"]:near(:text("Manager"), 120)
count:    3
matches:  [ 'role-native:SELECT', 'mgr:INPUT', 'own:INPUT' ]   <- DOM order
.first():   role-native:SELECT                                  <- the WRONG control
```

The step wanted `mgr`. It got a `<select>` belonging to a different field, and `selectOption()`
then waited 10 s for an option that field does not have.

**Why it is filed rather than fixed.** It is a pre-existing property of the positional rung, not
something TD-70 introduced — and TD-70's narrowing *reduces* the candidate set for `select`. It is
also not yet known to have caused a real failure: it was reproduced on a deliberately cramped
synthetic page, and real form rows are usually further apart than 120px. Filing it with the
measurement is worth more than a speculative fix.

**Remediation when it earns one.** Rank multiple `:near()` matches by actual distance to the anchor
(a `boundingBox()` comparison in the live path, and the same arithmetic inlined in the generated
helper) instead of taking `.first()`. Note that would need doing **twice**, in both implementations
— TD-07.

**It earned one.** The trigger above fired on run `2026-09-06T13-05-36-248Z-db2c0b4c`, case
`Admin creates a new user`. The New User modal stacks Full Name and Email about 20px apart, and
`step-11.png` shows the result: **Full Name holds `test@thinkvibes.com`** and Email is empty. The
`fill "Email"` step resolved onto the input above the one it named — the exact shape predicted here,
found on a real page rather than a cramped synthetic one. Filed Medium on the assumption real forms
are further apart than 120px; they are not, inside a dialog.

**Fixed on 2026-09-06 — resolution is now ordered, and geometry is the last rung, not the first
fallback.** `resolveField` and the generated `field()` try, in order:

1. `getByLabel(name, { exact: true })` — a real `<label for>` / `aria-label` association
2. `getByPlaceholder(name, { exact: true })`
3. `getByRole("textbox" | "combobox" | "checkbox", { name, exact: true })`
4. **the first form control FOLLOWING the label text in document order** — a `<label for>` target
   first, otherwise the next visible control after the element whose whole text is the name
5. only then `:near()`, and even there it prefers the control the anchor sits **above or to the
   left of** rather than taking `.first()`

Rung 4 is what actually fixes the reported failure, and it is the general form of "the label is
above the box" without knowing anything about this app: it reads the live DOM's own order.

**Every lookup is scoped to the open dialog** — `[role="dialog"]`, `[aria-modal="true"]`, or, last
resort, a visible element with `dialog`/`modal` in its class. The background page behind that modal
had its own Email field and its own Save button; without scoping, rungs 1-3 would confidently
resolve to the wrong page. `safeClick` scopes the same way, so Save and Cancel hit the dialog's
buttons.

**No site-specific logic.** Accessibility semantics and document order only — nothing about this
app's markup, class names or layout appears anywhere in the fix.

**One source of truth for the DOM-order logic, for this part of TD-07.** The callback is authored
once as `DOM_ORDER_FIELD_JS` in `targetResolver.ts` and interpolated into the emitted spec, so the
live resolver and the standalone spec run the *same characters* rather than two copies kept in step
by discipline. It returns an **index** into the field list rather than an element, so both callers
rebuild a real `Locator` — no `ElementHandle` leak, no page mutation. It is written with `for` loops
and nothing named inside, per TD-40. **The rest of `FIELD_HELPER` is still a restatement**, so
TD-07 as a whole remains open; `CLAUDE.md`'s sharp-edge note about it still holds.

**Correction, 2026-09-06 — the fills below were real, but rung 4 never ran.** Sharing the source
worked. *Invoking* it did not: both copies passed the function to `evaluate()` as a **string**,
which is evaluated as an expression and never called, so the DOM-order rung returned `undefined`
and every lookup fell through to geometry. See **TD-78**. The improvement this entry claims is
genuine and visible in `step-11.png` of run `2026-09-06T14-19-13-154Z-fed833e5` — Full Name and
Email are both correct there, where the earlier run had them swapped — but it came from the
geometry rung's above/left preference and the dialog scoping, **not** from the rung described
above. The two copies were identical and identically dead, which is the more useful lesson than
either "shared" or "drifted".

**Verified in a real browser** (`DECISIONS.md` D-19) — `tests/dialogFieldResolution.test.ts`, 9
tests on a synthetic page matching the failure exactly: a `role=dialog` with two stacked label+input
pairs 20px apart, one native `<select>`, one input-based combobox, over a background page carrying
its own "Email" field and its own "Save" button. The last test replays that run's saved IR steps
against it and asserts each value lands in its own field. Note what this did **not** catch: on a
page this simple the geometry rung returns the right answer too, so a dead rung 4 is invisible
end-to-end. `tests/selectResolution.test.ts` now asserts the rung's return value directly.


### TD-73. One discovery call sent 514,427 prompt tokens, because an element's name was a stylesheet — Critical / Accidental — Fixed

**The measurement.** Run `2026-09-03T11-49-04-132Z-f568ba48` (amazon.in),
`08-llm-usage.json`: `discovery: 1 call, 514,427 prompt tokens`. Across the 27 runs on disk that
carry a usage file, total prompt tokens are 1,264,848 — so **that one call is 40% of every prompt
token this project has ever sent**. Every other discovery call in the corpus is 316–3,699 prompt
tokens. The run's artifacts are correspondingly bloated: `02-appmodel.json` 5.5 MB,
`04-ir.json` 5.6 MB, `events.ndjson` 10.7 MB.

**It was not the call anyone expected.** The obvious suspect is `modelFromAria`, which
interpolated an uncapped `${aria}` snapshot. But every page in that run has
`discoveryMethod: "dom"` — the vision fallback never ran. The cost came from
`labelConceptsWithDOM`, whose element list is built one line per element with the element's
accessible NAME inlined verbatim, and which had no cap of any kind.

**The root cause is a single element.** Measured directly from that run's saved AppModel:

| page 0 (amazon.in homepage) | |
|---|---|
| elements | 229 |
| `elementsList` produced | **797,356 chars** |
| longest element name | **648,107 chars** — `main`, beginning `.gwm-window-tile:nth-child(9n+1) {background-…` |
| next two | `listitem` 65,488 and 63,692 chars, also CSS |
| **median** name length | **15** |
| names over 1,000 chars | 4 |

Four elements were 99% of the payload. The bound that matters is per-NAME, not per-element-count —
which is why none of the existing `MAX_LITE_*` element-count caps caught it. The names themselves
are inlined stylesheets read as element text: filed separately as **TD-75**, because fixing capture
changes what grounding matches against and deserves its own change.

**The fix, in four layers.** Each is independently sufficient for a different failure shape, which
is the point — the reason this got through is that every existing cap bounded a dimension this
input did not use.

1. **Per-name cap** (`LABEL_ELEMENT_NAME_MAX_CHARS`, default 200) — a runaway name is truncated
   with an explicit `[+N chars omitted]` marker rather than silently, so the model does not quote a
   half-stylesheet back as an element name.
2. **Per-list cap** (`LABEL_ELEMENTS_MAX_CHARS`, default 40,000) — a page with thousands of
   ordinary elements cannot leak either. Drops from the END, like every other prompt-fitting helper
   here, so a page's chrome and primary navigation survive.
3. **ARIA-snapshot cap** (`DISCOVERY_SNAPSHOT_MAX_CHARS`, default 40,000) in `modelFromAria`. Not
   this run's cause but a real, unbounded path. 40,000 chars is ~9,600 tokens at this corpus's
   measured ~4.15 chars/token, against a largest-observed legitimate discovery call of **3,699**
   prompt tokens — ~2.6x headroom over anything real, and the same order as `ir.ts`'s existing
   30,000-char prompt budget.
4. **A hard ceiling in `gemini.ts`** (`LLM_MAX_PROMPT_CHARS`, default 200,000), refusing before
   sending with a typed `PromptTooLargeError`. This is the layer that would have caught the
   original incident, and it catches every stage — including ones not yet written. It is a
   tripwire, not a tuning knob.

**Two details that are load-bearing, both found by measuring rather than reading.**

- **The interactive-elements section is never truncated.** `formatInteractiveElements` appends
  "Interactive elements found on page:" AFTER the snapshot, so a naive end-truncation deletes
  exactly the JS-detected controls the accessibility tree missed — the only reason that section
  exists. It is split off on a shared marker constant, preserved whole, and re-attached. Within the
  snapshot, non-interactive nodes (static text, generic containers) are dropped before anything a
  test could act on.
- **Element names are whitespace-collapsed before being listed.** The format is one line per
  element and the model maps its answer back by the `[index]` at the start of each line. A name
  containing a newline split one element across several lines, so every index after it described
  the tail of the previous name. Measured: that homepage produced **273 lines from 229 elements**
  before the collapse. This was a silent mislabeling bug, found only because a test asserted line
  count equals element count.

**Measured result**, replaying the real AppModel through the new code (no live call):

| | before | after |
|---|---|---|
| homepage `elementsList` | 797,356 chars / 427,457 tok | 17,075 chars / **6,170 tok** |
| all 5 pages, prompt tokens | 467,733 | **28,383** |
| reduction | | **93.9%** |

The homepage needed only the per-name cap — all 229 elements survive, none dropped. Only the
577-element browse page hit the list cap (404 of 577 kept).

**Also fixed: `events.ndjson` no longer carries a second copy of the AppModel.** The `discovery`
completed event embedded the entire model, which is why that run's event log was 10.7 MB — and the
log is replayed in full on every `/state` poll, once a second. `orchestrator.ts`'s `step()` gained
an optional projector (identity by default, so every other stage is byte-for-byte unchanged) and
discovery now emits `{ baseUrl, pages: [{ url, title, concepts, elementCount }], auth: { status,
loginUrl } }`.

**The `/state` response shape is unchanged**, which was checked before changing anything rather
than asserted afterwards: `public/app.js` reads only `data.pages.length` and `data.pages[].concepts`
from this event; nothing in `src/` reads its `data` at all; `library.test.ts` asserts only that the
stage completed; and `public/preview.js`'s own fixture for this event is *already*
`{ pages: [{ url, concepts }] }` — the trimmed shape. The full model is untouched in
`02-appmodel.json`, where it always lived. `runStore.ts`'s legacy-reconstruction path emits the
same narrowed shape so a rebuilt run and a live one look identical.

### TD-74. IR grounding retried a rejection that could never succeed — High / Accidental — Fixed

**What it was.** `server.log` lines 107 / 124 / 141: grounding rejected
`Step s6 targets role="button" name="Add User", which is not present…` **three times with identical
feedback**, then rejected the same target again as `s8`. That element is genuinely absent from the
page — it sits behind an admin role the test does not hold — so no amount of regeneration could
ground it. The retry budget (`MAX_IR_ATTEMPTS`, 4) was spent re-deriving the same refusal.

**What it cost.** `ir` is 12–24 calls and 70–85% of a run's spend. Per-call prompt size is
strikingly consistent across the whole corpus — **~3,800 prompt tokens** — because `toMicroModel`
already scopes the IR prompt to one page and 30 elements:

```
2026-08-22T07-04   26 calls   99040p  => 3809 tok/call
2026-08-23T15-48   16 calls   61236p  => 3827 tok/call
2026-09-01T07-29   14 calls   60062p  => 4290 tok/call
```

So the waste is call COUNT, not call size, and two dead attempts is ~7,600 prompt tokens per stuck
case, every time that case runs.

**The fix.** The retry loop now keeps a set of grounding-rejection signatures. On the second
appearance of the same signature it stops retrying and falls through to the existing truncation
path, which ships the grounded prefix and records `truncationNote` — so the UI already shows *why*
and **no new status was added**.

**The signature is structural, and the index is deliberately excluded.** It is built from the IR
target's own fields — `kind`, `role`, `name`, `text`, `url` — never from the message string
(`CLAUDE.md`'s central design rule). Here that is not merely principle: the evidence is `s6` then
`s8`, so the message differs between two rejections of the *same* absent element. Keying on the
message, or including the step index, would miss the repeat entirely.

**Measured:** `tests/irRetryDedup.test.ts` counts model calls for a permanently-absent target and
asserts **2, not 4** — including a case where the target moves to a different step id between
attempts. Outcome quality is unchanged: `bestPartial` still keeps the longest grounded prefix
across attempts, so stopping early drops the attempts that were re-deriving a refusal, not the ones
making progress.

**Not changed, having been checked:** the retry does NOT resend an oversized prompt. `buildUser`
already rebuilds from `toMicroModel(filtered, { currentPageUrl })` — one page, at most 30 elements —
which is exactly why per-call size is flat at ~3,800 tokens across every run. There was nothing to
trim, and trimming further would have cost grounding accuracy for no measurable saving.

### TD-75. An element's accessible name can be an entire inlined stylesheet — High / Accidental — Open

**What it is.** On the amazon.in homepage, discovery recorded a `main` element whose `name` is
**648,107 characters** of CSS beginning
`.gwm-window-tile:nth-child(9n+1) .theming-card-background.enableColorSequence {background-…`, plus
two `listitem`s carrying 65,488 and 63,692 chars of the same. The median name on that page is 15
characters. These are `<style>` contents being read as element text and promoted to an accessible
name.

**Why it matters beyond the token cost.** TD-73 bounded every place these names reach a *prompt*,
and that stops the spending. But the names are still wrong in `02-appmodel.json` itself, and that
file is the input to grounding. An element whose name is a stylesheet is:

- **unmatchable** — `getByRole(role, { name })` can never find it, so any step targeting it is
  rejected and truncates the case (the TD-74 shape);
- **bloat** — it is why `02-appmodel.json` is 5.5 MB and `04-ir.json` 5.6 MB on that run, which
  costs disk and cache-key hashing on every read;
- **noise in the element budget** — it occupies a slot in `toLiteModel` / `toMicroModel` caps that
  a real control could have used.

**Why it is filed rather than fixed here.** The fix belongs at capture, in `domExtract.ts`'s text
extraction — almost certainly excluding `<style>` and `<script>` contents from an element's own
text, the same way `ownText` is already suppressed for form controls. But name capture is what
grounding matches against, so changing it changes which elements resolve, and that deserves its own
change with its own before/after over the saved corpus rather than being folded into a
prompt-size fix. TD-73's caps mean nothing is on fire in the meantime.

**Remediation.** Exclude `style`/`script`/`noscript` subtree text when deriving an element's text
in `domExtract.ts`, then re-derive `02-appmodel.json` for a saved run and diff the element list —
the count should be unchanged and the pathological names should collapse to their real values or to
empty. Add a capture-time assertion that no element name exceeds a sane bound, so this cannot
silently return.

**Trigger — promote to a bug when:** a run's `02-appmodel.json` contains any element whose `name`
exceeds ~1,000 characters. `scripts/measureView.ts` already walks every saved AppModel and is the
natural place to report it.

### TD-76. `selectOption()` is an exact match, so different casing looked like a missing option — Medium / Accidental — Fixed

**What it was.** Run `2026-09-06T13-05-36-248Z-db2c0b4c`, `cases/case-0/05-result.json`:

```
TimeoutError: locator.selectOption: Timeout 10000ms exceeded.
  - waiting for locator('select:near(:text("Manager"), 120), [role="combobox"]:near(…)')
    - locator resolved to <select>…</select>
  - attempting select option action
    2 × waiting for element to be visible and enabled
      - did not find some options
```

This answers the question the task asked: **`choose()` did run and did reach the right element.**
It resolved a native `<select>` and then spent the full ten seconds retrying, because
`selectOption("prashant mishra")` matches an option's value or label EXACTLY and the option reads
`Prashant Mishra`. The reported symptom — Manager showing "No manager" in the final screenshot —
is simply the untouched default.

The error text is also actively unhelpful: *"did not find some options"* names neither the option
that was wanted nor the ones that exist.

**The fix.** `choose()` now resolves the index itself before delegating: trimmed and
case-insensitive **exact** on either the option's label or its value, then **containment** in
either direction, then `selectOption({ index })`. Only if nothing matches at all does it hand the
raw value to Playwright, so a genuinely absent option still produces Playwright's own error rather
than a silent no-op.

Case-insensitive is right here rather than lax: a `<select>` with two options differing only in
case is not a real UI, whereas a step value typed by a person or produced by a model differing in
case from the rendered text is routine.

**Verified in a real browser** — `tests/dialogFieldResolution.test.ts` selects `prashant mishra`
against `<option value="u1">Prashant Mishra</option>` and asserts the select's value becomes `u1`.

**Correction, 2026-09-06 — the diagnosis above was right about the mechanism and wrong about this
run.** The casing bug is real and the fix stands. But the *reason* the next replay
(`2026-09-06T14-19-13-154Z-fed833e5`) still failed at the same step was not casing: a live probe of
the modal found the option spelled `prashant mishra`, lowercase, matching the step exactly. The
step was resolving to the **Role** dropdown, which genuinely has no such option — so this entry's
own index resolution correctly returned -1 and handed the raw value to Playwright, producing an
identical-looking error from an entirely different cause. See **TD-79**.

The lesson worth keeping: *"did not find some options" looks the same whether the option is
missing or the control is wrong.* That ambiguity is exactly why TD-79 makes the error name the
options that were actually available — which would have made this second failure self-evident
instead of costing a live probe to diagnose.

Two further defects in this entry's own emitted code, both found later: the matcher shipped as
`/s+/g` rather than `/\s+/g` (a template literal ate the backslash, so it replaced the letter *s*
— harmless only because both sides were mangled identically), and it read the option list **once,
immediately**, which fails on any server-populated dropdown. Both fixed under TD-79.

### TD-77. Steps revealed by a click are never grounded — High / Strategic — Mitigated, and optionally fixed behind a flag

**What it is.** Grounding writes `css`/`testId` onto a target by matching it against the model
discovery built. Discovery crawls links; it does not click through the UI. So anything a click
REVEALS — a modal, a tab panel, an accordion body, the next page of a wizard — is never in that
model, and every step inside it ships with a role and a name and nothing else.

At run time those steps fall back to name matching and then to geometry, which is where TD-72's
failure came from: the New User modal's `fill "Email"` resolved onto the Full Name input.

**This is the deeper cause behind TD-72, and the two fixes are complementary.** TD-72 makes the
fallback *correct* (label → next control in DOM order, scoped to the open dialog) and needs no
extra work at run time. TD-77 removes the need to fall back at all.

**What shipped, behind `REPLAY_REGROUND` (default OFF, platform rule 2).** Before a replay
executes a case, `ungroundedStepIndexes` finds the steps whose target has no `css`/`testId`, and
`regroundEditedIr` — the case editor's existing walk — replays the prefix in a real browser,
snapshots what is actually on screen, and grounds those targets against it.

- **Zero LLM calls.** It is the same deterministic role/name matching `groundingError` already
  does. A replay's whole economic claim survives intact.
- **Existing machinery, not a second implementation.** `refreshPageModel` + `groundingError`, which
  is what the editor's re-ground already uses. A parallel implementation here would be TD-07 a
  third time.
- **It never writes back to the library** (`CLAUDE.md` rule 6, `DECISIONS.md` D-27). Targets it
  grounds are used for THIS execution and recorded in the run's own `cases/case-N/04-ir.json` with
  `groundedAt: "replay"`, so a person can see what it found and choose to save it. The stored case
  is untouched.
- **It can never make a replay worse.** Every failure path — the walk not reaching a step, a
  timeout, a target that still will not ground — logs and returns the saved steps unchanged. A
  re-ground is an improvement, never a precondition.

`groundedAt` is an additive optional field on `Target` (`z.literal("replay").optional()`), declared
in the schema rather than smuggled through, because Zod strips unknown keys and the marker would
otherwise vanish on the next parse. Nothing branches on it — `tests/replayReground.test.ts` asserts
the generated spec is byte-identical with and without it.

**Why the flag, and why OFF.** The walk costs a browser launch and up to `MAX_LIVE_EXTENSIONS`
snapshots before the run starts. A replay whose steps are all grounded — the common case — should
not pay for it, and with the flag unset this code returns its input untouched.

**Still open, and the reason this is "mitigated" rather than closed.** The same gap exists on a
FRESH run: `ir.ts` has post-click-reveal handling, but a case whose reveal happens after the
grounded prefix ends still ships ungrounded steps. The replay pre-pass does not help there. Closing
it properly means discovery clicking reveal-shaped controls during the crawl, which is a much
larger change with its own cost and its own risk of unbounded crawling.

### TD-78. A function passed to `evaluate()` as a STRING is never called — High / Accidental — Fixed

**What it was.** TD-72's fix added a DOM-order rung to `resolveField` and to the generated
`field()`, and shared the in-page callback between them by authoring it once as a string
(`DOM_ORDER_FIELD_JS`). The live resolver then did:

```ts
const idx = await scope.evaluate(DOM_ORDER_FIELD_JS, hint);
```

`Locator.evaluate()` accepts `function | string`, so this type-checks and never throws. But a
string is evaluated as an **expression**. The expression here is a function literal, so the page
constructs a function, returns it, and a function cannot cross the CDP boundary — the call
resolves to `undefined`. `undefined >= 0` is false, so **the rung reported "no match" on every
lookup and every field fell through to geometry.** It had never executed once.

The generated spec had the same bug by a different route: `${JSON.stringify(DOM_ORDER_FIELD_JS)}`
emitted a string *literal*, so the spec called `scope.evaluate("...")` and got `undefined` too.

Measured directly, on a page with a Role select followed by a Manager select:

```
string form, 2 args : undefined      <- what shipped
string form, simple : undefined      <- even "(root, w) => String(w)"
real function form  : hello
new Function form   : 1              <- the correct index (#mgr)
```

**Why nothing caught it.** It type-checks. It does not throw. And the existing real-browser tests
exercise `field()` end-to-end, where **geometry silently returns the right answer** on any page
simple enough to write as a fixture. `DECISIONS.md` D-19 says a generated Playwright expression is
not verified until it is run once; this is the sharper form of the same lesson — *it is not
verified until it is run against a page where the wrong answer differs from the right one.*

**The fix.** `domOrderFieldFn`, built once with `new Function`, is what the live path passes; the
generator interpolates the source **bare**, so the emitted file contains a real arrow-function
literal. The string remains the single source of truth both are built from, so TD-07 still holds —
what changed is that both now actually run it. `tests/selectResolution.test.ts` asserts the string
form returns `undefined` and the function form returns a correct index, so the trap cannot be
re-entered silently, and asserts the emitted spec matches `scope.evaluate((root, arg) =>` rather
than `scope.evaluate("`.

**Two further defects fell out of reviving the rung**, both invisible while it was dead:

1. **It re-introduced TD-70.** The rung searched `input, textarea, select, [role=combobox]`
   regardless of action, so a `select` step was handed the `<input>` after its label —
   the exact thing `nearFieldSelector` narrows for. Fixed with `fieldSelectorFor(action)`, passed
   in so the index and the Locator rebuilt from it index the same list. Caught by
   `selectAction.test.ts`'s existing "does NOT resolve a select step onto a plain input".

2. **First-match-wins picked the wrong label.** See TD-79.

### TD-79. The Manager dropdown: wrong control, read too early, and a useless error — High / Accidental — Fixed

**What it was.** Run `2026-09-06T14-19-13-154Z-fed833e5`, step 12:

```
TimeoutError: locator.selectOption: Timeout 10000ms exceeded.
  - waiting for locator('body').locator('select:near(:text("Manager"), 120), [role="combobox"]:near(…)').first()
    - locator resolved to <select>…</select>
  - attempting select option action
    2 × waiting for element to be visible and enabled
      - did not find some options
  at choose (…/generated/test.spec.ts:233:18)
```

**Diagnosed against the live page, not inferred.** A read-only probe opened the modal and dumped
the Manager control at 0 ms, 500 ms and 2000 ms. The option `prashant mishra` **exists, spelled
exactly as the step asks, present from the first paint** — so it was neither a late-loading list
nor an absent option. The probe's last line gave it away:

```
step-12 locator → count: 2
  0  SELECT  opts=Select...|Learner|Trainer|Manager|Admin      ← .first() picks THIS
  1  SELECT  opts=No manager|prashant mishra|udit goyal|…      ← the real Manager control
```

**The step was selecting into the Role dropdown.** `:near(:text("Manager"), 120)` matched both
sibling selects and `.first()` is document order. The Role select even contains an
`<option>Manager</option>`, so the anchor text is not unique either. Line 233 is the raw-value
fallback, which means TD-76's index resolution had already returned -1 — correctly, since that
select really has no such option.

**Why it reached geometry at all** is TD-78: the rung that should have answered "which control
does the Manager label describe" was dead.

**And why reviving it was not enough.** With the rung live, the word "Manager" appears **six times**
inside the resolution scope: five role badges on the user rows *behind* the modal, and the field's
own `<label>`. The badges come first in document order, and because a badge sits far above the
form, *every* control follows it — so first-match-wins returned the first select on the page,
confidently and wrongly. Two rules fix it, and the split between them matters:

- **a `<label>` beats a generic leaf.** A `<label>` is a statement that this text names a control;
  a `<span>` with the same text is a guess. A badge is a span.
- **within generic leaves, the LAST candidate wins; within labels, the first still does.**
  Scanning backwards is what "nearest" means when the DOM gives no distance, and decoys are
  overwhelmingly generic — badges, chips and table cells repeat a word many times above a form.
  Labels keep document order deliberately: **two legitimately identical `<label>`s is a far more
  common page than a decoy `<label>`** — a login form's "Email" and a footer newsletter's — and
  the first is the one the flow means. Reversing labels too would have silently rebound every
  such case to the footer, which is the most common flow this project runs.

Both rules are pinned by mutation-checked tests: lumping labels into the reverse-scanned group
reddens the two-form test, and the badge tests fail without the reverse scan.

Scoping cannot help here: this modal sets **no `role="dialog"`, no `aria-modal` and no
dialog/modal class**, so `resolveScope` correctly falls back to `body` (TD-81).

**The other two fixes the brief asked for**, neither of which this run needed but both of which are
ordinary in the wild:

- **Wait for options.** Server-populated dropdowns are the norm. `choose()` and `chooseLive` poll
  up to the step timeout — but exit **the moment the control is populated and still has no match**.
  That distinction matters: an unconditional wait would let a wrong-control resolution spend the
  full timeout looking like a slow network, which is precisely how this bug hid. Pinned by a test
  asserting the no-match case fails in under 3 s.
- **Walk to the real control.** If the resolved node is not selectable, `SELECTABLE_JS` tries a
  `<select>` inside it, the control its `for=` names, a `[role=combobox]` descendant, then a
  `<select>` in a nearby ancestor (bounded to three levels). That last step reaches the
  visually-hidden native select behind a custom shell — the headless-UI pattern — and prefers it,
  because `selectOption()` on it sets the value the form actually submits. The ancestor step uses
  `querySelectorAll` and prefers a select that **follows** the element, not `querySelector`, which
  is first-in-subtree: climbing out of a deeply-nested shell into a container holding both fields'
  selects would otherwise return the neighbouring field's — the same mistake as the rung above,
  one level up. Mutation-checked.

**And the error is now useful.** "did not find some options" named neither the wanted value nor the
available ones, so the only way to learn an option was spelled differently was to re-run the case
and watch the video. It now reads:

```
select: no option matching "prashant mishra". Available: "No manager", "udit goyal", …
```

which is what the case card renders under TD-80.

**A third escaping bug found while fixing this.** The emitted `choose()` contained `/s+/g`, not
`/\s+/g` — a template literal ate the backslash, so every matcher replaced the letter *s* with a
space. Both sides of every comparison were mangled identically, so exact matching still worked by
luck and nothing failed. Now `\\s` in the template, and asserted on the emitted text.

**Verified in a real browser** (`DECISIONS.md` D-19) — `tests/selectResolution.test.ts`, 20 tests
covering all four shapes the brief names, plus the badges-behind-the-modal shape, plus the TD-70
guard. **And verified against the live site**: the four steps that failed now land

```
inputs = ["", "test lakshay", "test@thinkvibes.com"]   selects = ["Learner", "prashant mishra"]
```

`liveExtend.ts`'s `select` case was a bare `selectOption()` with all the same defects; it now calls
`chooseLive`, which shares its matching, its waiting and its message with the generated spec
through the `*_JS` constants rather than restating them (TD-07).

### TD-80. A failed case showed a red X and nothing else — High / Strategic — Fixed

**What it was.** The UI rendered a failure reason only when a `06-diagnosis.json` existed. That
file is written by `analyzeFailure`, which is a **Gemini call** — and a replay makes zero LLM calls
by design (`DECISIONS.md`), so a replay never has one. The result: a failing replay's card showed a
red X and no text whatsoever, while the actual cause sat unread in `05-result.json`:

```
TimeoutError: locator.selectOption: Timeout 10000ms exceeded.
```

Nothing was missing from the artifacts. Nothing was even hard to find. The pipeline simply had no
path from Playwright's own report to the screen that did not go through a model.

**The fix — a deterministic floor, not a cheaper diagnosis.** `extractFailureDetail` (executor.ts)
reads Playwright's JSON and returns the failing step's **number** and **title**, the first line of
the error, and the full message. `generateSpec` emits exactly one `test.step()` per IR step in
order, so the position of the failing step *is* the step number.

- `buildSuiteSummary` reads it **from disk**, beside the screenshot and video probes it already
  does, so every producer of a summary — full run, suite, replay — gets it without each having to
  remember to pass it. That is the failure mode that function's own docstring records:
  `whyItMatters` went missing because three `results.push()` sites did not copy it.
- The fields are **additive and optional** on the existing case shape (`CLAUDE.md` rule 1), absent
  on a passing case, so no existing consumer changes. No new route was needed.
- `renderCaseErrorBlock` in `app.js` renders it **from the summary**, so it appears with the card
  instead of waiting on the per-case fetch the diagnosis block needs. A diagnosis, when one
  exists, renders **below** it rather than instead of it.
- It mints no CSS class names (rule 3) — reuses `diag-card`, `diag-item`, `diag-text`,
  `diag-tech-details`. A test asserts every class it emits already exists in `style.css`.
- "Test timeout of 50000ms exceeded" is the *consequence* of the first error, so it is never shown
  in place of the real cause.

21 tests in `tests/failureDetail.test.ts`, including the extractor against this run's real report
shape, the summary wiring, and the card renderer lifted out of `app.js` itself.

**One thing to be aware of.** A step title embeds that step's value — `Fill '*********' with
'leaked-pw'` in this very run. `scrubServedSecrets` redacts values it is *told* are credentials via
`secretEnv`; a literal typed into the editor was never registered as one, which is TD-67's
outstanding data-scrub half. The card therefore inherits whatever the report holds. This surfaces
no value that was not already in `generated.spec.ts` and `05-result.json` under `runs/` (both
served over HTTP, TD-14) — but it is one more reason the TD-67 scrub is still owed.

### TD-81. A modal with no accessible markup cannot be scoped to — Medium / Strategic — Open

**What it is.** `resolveScope` finds the open dialog by `[role="dialog"]`, `[aria-modal="true"]`,
or — last resort — a visible element with `dialog`/`modal` in its class. The LMS's New User modal
sets **none of the three**. A live probe returned `"dialogs": []` while the modal was plainly open
on screen; its container is an unmarked `<div>` whose only distinguishing class is
`admin-form-grid`.

So every lookup inside that modal is scoped to `body` and competes with the entire page behind it —
which is how five role badges on the user rows became candidates for the Manager field (TD-79).

**Why it is filed rather than fixed.** TD-79's fix makes resolution correct *without* scoping, on
this shape and generally, so nothing is currently broken by it. Closing this properly means
detecting a modal by behaviour rather than markup — a fixed/absolute-positioned visible container
with a high stacking order that overlays the document — and that is a heuristic with real
false-positive risk (sticky headers, toasts, drawers) which would silently narrow scope on pages
that work today. Not worth it until something needs it.

**Trigger — promote to a bug when:** a step resolves to a control on the page behind an open modal
*after* TD-79's label/ordering rules have been applied — i.e. when being right without scoping is
no longer enough.

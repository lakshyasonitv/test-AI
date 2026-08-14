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

## Summary

| ID | Item | Severity | Type | Owner |
|---|---|---|---|---|
| TD-01 | `missingActions` can hard-fail a run over a *correct* IR | Critical | Accidental | Lakshya |
| TD-02 | Executor's SIGKILL destroys the report needed to diagnose the failure it just caused | Critical | Accidental | Lakshya |
| TD-03 | Groq 429 handling burns IR-attempt budget instead of backing off | High | Accidental | Lakshya |
| TD-04 | No general mechanism for a blocking interstitial (CAPTCHA, cookie wall, OTP, age gate) | High | Strategic | ? |
| TD-05 | Duplicate element names in a merged multi-page AppModel produce ambiguous locators | High | Accidental | Lakshya |
| TD-06 | IR assertion vocabulary has no title assertion | Medium | Accidental | Lakshya |
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
| TD-21 | `tests/strategy.test.ts` flakes ~1 run in 6 under parallel load | Medium | Accidental | Lakshya |
| TD-22 | LLM disk cache never expires; a key missing an input dimension serves stale results forever | Medium | Strategic | Lakshya |
| TD-23 | Case-selection-gate progress events briefly corrupt the phase summary text | Low | Accidental | Lakshya |
| TD-24 | `PLAYWRIGHT_TIMEOUT` env var is set but never read; comment implies otherwise | Low | Accidental | Lakshya |
| TD-25 | Deleting the currently-viewed run leaves its polling loop running forever | Low | Accidental | Lakshya |
| TD-26 | Credential prompt fires even when no case in the suite has a login step | Low | Accidental | ? |
| TD-27 | `caseAccumulator.appendAcceptedCases` doesn't dedup near-duplicate titles within one batch | Low | Accidental | Lakshya |
| TD-28 | `wantsRealCredentials` — dead code, or the policy entry point that was never wired in? | Low | ? | ? |
| TD-29 | A username was once observed reaching disk unreferenced — never root-caused | Low | ? | ? |

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

### TD-03. Groq 429 handling burns IR-attempt budget instead of backing off — High / Accidental

**What it is.** `groq.ts:64` passes `maxRetries: 2` to `callWithPool` on the grounds that
`ir.ts`'s own `MAX_ATTEMPTS` loop is the outer retry (comment at `groq.ts:22-26`). But
`backoff.ts`'s `parseRetryDelay` (`backoff.ts:28-37`) only matches the literal string
`retry in Ns` — Groq's actual 429 body says `"Please try again in 495ms"`, which the regex
doesn't match, so the server's own hint is discarded and a generic exponential backoff is used
instead. When retries are exhausted, `ir.ts:1106-1111` catches, burns one of `MAX_IR_ATTEMPTS`,
and immediately re-sends the same multi-thousand-token prompt — adding load to the very
per-minute-token budget that just rejected it.

**Why it hurts.** Reproduced directly: run `2026-08-14T13-29-09…a1677304` died after a **495ms**
rate-limit wait turned into a dead run within 18 seconds, at `TPM: Limit 12000` against measured
per-run spend of 11.6k-46.5k tokens (`08-groq-usage.json` across the last 5 runs) — this isn't
edge-case token usage, it's routine.

**Remediation.** Extend `parseRetryDelay` to also match a millisecond form (`retry in Nms`), or
just switch to `Math.max` against the server-suggested wait when it's shorter than the computed
backoff — the server's number is more accurate than a guess either way. Separately: `ir.ts`
shouldn't treat a rate-limit failure identically to a genuine schema-validation failure for the
purpose of spending an attempt — a 429 backoff succeeding should not cost one of `MAX_ATTEMPTS`.

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

### TD-06. IR assertion vocabulary has no title assertion — Medium / Accidental

**What it is.** `src/schema/ir.ts`'s assertion enum is
`visible | hidden | text_equals | text_contains | url_contains | enabled | disabled`. There is no
page-title assertion; `url_contains` is the only page-level (non-locator) assertion available.
When a test case says "verify the page title is X," the IR degrades it to a `text_contains`
against a `{text: X}` target, which `generator.ts`'s `emitAssert` compiles to
`expect(page.getByText(X).first()).toContainText(X)` — a body-text search for a string that, on
most sites, only ever exists in `<title>`.

**Why it hurts.** Reproduced directly against `2026-08-14T10-46-05…667f7f76`: the string
"Online Shopping site in India" occurs **0** times in the case's own captured `final-page.txt`,
guaranteeing a 10-second timeout. `README.md` previously claimed a prompt-level guard existed for
exactly this ("the model is told the page's `title` field is `<title>`-tag metadata, never visible
body text") — the guard is prompt-only, and this run is direct proof it doesn't hold when the model
doesn't follow it. Consistent with this project's own established pattern (`DECISIONS.md` D-04):
prompt rules without a structural backstop eventually get ignored.

**Remediation.** Add `title_contains`/`title_equals` to the IR assertion enum; compile it in
`generator.ts` to `await expect(page).toHaveTitle(...)`; ground it in `ir.ts` against the
AppModel's own `title` field per page, the same way `url_contains` is grounded today. Removes the
failure mode by construction instead of by prompt instruction.

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

**What it is.** 288 tests across 27 files exist and nothing executes them automatically. The only
GitHub Actions workflow, `.github/workflows/directory-tree.yml`, regenerates a directory tree and
pushes to `main`.

**Why it hurts.** Every deterministic guard this project has built — grounding, credential policy,
scope filtering — is unenforced on any change. Highest leverage-per-effort item in this whole
register: one workflow file protects every other fix listed here.

**Remediation.** One workflow: `npm ci`, `npx tsc --noEmit`, `npx vitest run`. Fix TD-21 first or
in the same change — landing CI on top of a test that fails 1 run in 6 just teaches everyone to
ignore red.

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

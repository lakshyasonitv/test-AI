# Run failure post-mortem — 2026-08-18

> **What this file is.** A point-in-time forensic accounting of why runs have failed or not
> completed, built by reading all 28 run directories under `runs/` and the pipeline code.
> It is **not** a second defect register — `TECH_DEBT.md` remains the canonical, maintained
> owner of "what's broken" (see `CLAUDE.md`). This is analysis: run-history statistics and
> root-cause ranking that don't fit that file's per-defect format. If an item here becomes
> something to *fix*, it belongs in `TECH_DEBT.md`, not here.
>
> Every claim below cites a real run id and a verbatim error string, so any line can be
> re-checked against the artifact still on disk.

---

## Scope note — excluded runs

**`acadtracker.vercel.app` (run `2a68910d`) is excluded from all counts.** That site was itself
down during the run — its own diagnoses record `"Network failure: Unable to reach server"` and
`"Failed to log in. Please check your credentials"`. Its 4 cases measure the target's outage, not
a pipeline defect.

Two *code* defects were first observed on that run and are kept below, because they reproduce
independently of whether the site was up: the `orchestrator.ts:245-246` URL-comparison bug, and
`credentialFieldsNeeded` returning `[]` for a login-gated SPA.

**`allen.in` (4 runs) is still included but needs the same judgement call from you** — see RC-M.

---

## Headline numbers

| Metric | Value |
|---|---|
| Run directories on disk | 28 (27 after excluding acadtracker) |
| Reached execution | 18 |
| Aborted mid-suite (process killed) | 3 |
| Never reached execution | 6 |
| Cases attempted | 72 |
| Passed | 26 |
| Failed | 35 |
| Blocked | 7 |
| Truncated / truncated-no-assertion | 4 |
| **Overall pass rate** | **36.1%** |
| Runs with zero passes | 4 of 18 (22.2%) |
| Self-heal success rate | **0 of 5 invocations** |

Date range: 2026-08-14 → 2026-08-18 (4 days).

**Target-site clustering:** thinkvibes.com ×11, amazon.in ×9, allen.in ×4,
assettrack-web.onrender.com ×2, flipkart.com ×1. The clustering is diagnostic — all 4 `allen.in`
runs died before execution, all 9 `amazon.in` runs failed their case-0, and both authenticated-app
runs produced zero passes.

**The trend is worsening, not improving.** The two most recent runs (2026-08-18, both
`assettrack`, both login-gated) are both zero-pass.

---

## Part 1 — Ranked root causes

Every one of the 35 failures is assigned to exactly one bucket.
Sum check: 14 + 6 + 5 + 2 + 2 + 2 + 1 + 2 + 1 = **35**.

### RC-A — Hallucinated expected text · 14 failures (40%) · 10 runs · **OPEN (partly fixed)**

The single dominant failure mode. The model invents the exact string it then asserts on, and that
string exists nowhere in the DOM.

**Signature:** `expect(locator).toBeVisible()` / `toHaveText` / `toBeEnabled` times out after
10 000 ms → `Received: <element(s) not found>`. Diagnosed as `element_missing` or
`assertion_failed`.

**Exemplars:** `0b385264` (3 cases), `a6747fb8` (2), `086eb33b` (2), `3475cc6e`, `afb840d3`,
`27f85ee1`, `261d4022`, `0413c4c8`, `4a2261b4`.

**Worst instance** — two separate runs (`a6747fb8/case-0`, `28929d2f/case-0`) assert on the
literal placeholder phrase, never a real page string:
```
Locator: getByText('success confirmation message').and(locator(':visible')).first()
```

**The part that should worry you most: at least 3 of these are false negatives — the application
worked correctly and the test was simply wrong.**

| Run | App actually rendered | Test demanded |
|---|---|---|
| `261d4022/case-0` | "Thanks for contacting us! We will be in touch with you shortly." | "Message sent successfully" |
| `0b385264/case-3` | "Please enter a valid email address." | "Invalid email address" |
| `d5ea77ad/case-0` | navigated to `/thank-you/` | URL matching `#contact` |

A tool that reports working software as broken is worse than one that reports nothing — it trains
you to distrust its output. This is the highest-value thing to fix.

**Partly addressed (uncommitted):** the cross-form subset (clicking the newsletter button instead
of the contact form's submit) by `crossFormBleedError`, and the wrong-expected-text subset by
TD-39's structural diff fallback in `groundTerminalTextAssertion`. Roughly half the bucket —
freely invented text on a page the corrector can't reach — remains open.

### RC-B — `toBeHidden` used as a proxy for "the action worked" · 6 failures · 4 runs · **HALF FIXED (3 of 6)**

Asserts that a button disappears after being clicked. The button doesn't disappear.

**Signature:** `Timed out 10000ms waiting for expect(locator).toBeHidden() | Expected: hidden |
Received: visible`. Targets: `getByRole('button', {name:'Sign In'})` ×3,
`{name:'Subscribe'}` ×2, `getByText('Join our Newsletter')` ×1.

**Exemplars:** `086eb33b` (3), `0b385264`, `2539fb07`, `257363f4`.

The codebase already knew this was invalid — its own truncation note reads *"Whether that control
disappears is incidental and proves nothing"* — but the rule was applied in only one code path.
TD-37 addressed this: `clickedElementHiddenAssertion` now requires a structural authentication
signal (a discovered password field, or an auth-worded case) before allowing the pattern.

**But it only closes half the bucket, and the split matters:**

| Sub-case | Cases | Status |
|---|---|---|
| **Non-auth forms** — Subscribe / Join our Newsletter (`0b385264`, `2539fb07`, `257363f4`) | 3 | **Fixed.** TD-37 now rejects these at IR generation. |
| **Real login forms** — Sign In (`086eb33b` cases 2, 3, 4) | 3 | **Still open — TD-37 allows these by design.** |

Verified directly: `086eb33b/case-2`'s IR is
`navigate /login → fill Email → fill Password → click "Sign In" → assert "Sign In" hidden`.
A genuine password fill precedes the click, so TD-37 permits the assertion — correctly, per its
own rule, since this *is* an authentication form and the pattern is what `ir.ts`'s prompt
recommends for exactly this shape.

**It still failed 3 times.** So the recommended pattern is itself unreliable on a real login: the
button did not disappear within 10 s, whether because the login didn't complete, the SPA re-rendered
slowly, or the app kept the control mounted. That is an open problem TD-37 does not touch, and it's
entangled with Cross-cutting #6 — within this same run, case-0's diagnosis claims the login
*succeeded* while cases 2-4 claim it *failed*.

### RC-C — Selector ambiguity on DOM-dense sites · 5 failures · 4 runs · **OPEN**

All Amazon. Two sub-forms:

**(a) Matches a hidden element instead of the visible one:**
```
Expected: visible | Received: hidden
Locator: getByText('Amazon').first()          → grabbed a hidden <option> in the search dropdown
Locator: locator('button:has-text("All")')     → grabbed a hidden video-player button
```

**(b) Strict-mode violation:**
```
locator.click: Error: strict mode violation: getByRole('button', { name: 'All' }) resolved to 4 elements:
  1) <a role="button" id="nav-hamburger-menu" aria-label="Open All Categories Menu">
  2) <div role="button" tabindex="-1" data-id="TileTitle">COOLCOLD USB …
```

**Exemplars:** `70279845` (2), `2b2858b9`, `803cf6f3`, `667f7f76`.

This is `TECH_DEBT.md` TD-05 (duplicate element names in a merged multi-page AppModel) showing up
in production. Note the fix landed for `visible` assertions (TD-34) doesn't help `click`.

### RC-D — Groq API infrastructure · 2 cases + 1 whole run · **RESOLVED**

```
IR failed schema validation after retry: Groq 401: {"message":"Invalid API Key","code":"invalid_api_key"}
IR failed schema validation after retry: Groq 404: {"message":"The model `llama-3.3-70b-versatile`
  does not exist or you do not have access to it.","code":"model_not_found"}
```

**Exemplars:** `7bcbf4de` (cases 2 & 3, the 401), `4f582417` (whole run dead, the 404 — 4 calls,
0 tokens, every one rejected).

**Verified resolved:** `.env` now reads `GROQ_MODEL=openai/gpt-oss-120b`, and the two most recent
runs made 15 and 16 successful Groq calls (69 340 / 70 304 tokens). The stale `llama-3.3-70b`
id and the bad key are both historical.

**But the way it failed is still open** — see Cross-cutting #1. The user saw "2 tests failed", not
"your API key is invalid."

### RC-E — Generator throws on a role with no accessible name · 2 cases + 1 whole run · **OPEN**

```
No semantic locator for target: {"role":"textbox","name":""}
No semantic locator for target: {"role":"textbox"}
No semantic locator for target: {"role":"heading"}
```

**Exemplars:** `0413c4c8/case-3`, `2b2858b9/case-3` (both left an IR-only case dir),
`901f5358` (whole run died at the `generate` stage).

Groq emits a bare role; `generator.ts` throws rather than degrading. A hard throw here kills the
whole run (`901f5358`) rather than just skipping one case. Related to `TECH_DEBT.md` TD-30, which
covers the grounding side — this is the codegen side of the same gap.

### RC-F — Exact `toHaveTitle` against a long real title · 2 failures · 1 run · **OPEN**

```
Timed out 10000ms … toHaveTitle(expected) | Locator: locator(':root')
Expected string: "Amazon.in"
Received string: "Online Shopping site in India: Shop Online for Mobiles, Books, Watches, Shoes and More - Amazon.in"
```

`3475cc6e` cases 0 and 3 — **the identical wrong assertion generated twice in one run.** The
expected value is a substring of the real title; `title_contains` would have passed. Note this is
the exact failure mode TD-06's `PAGE_LEVEL_ASSERTIONS` work was meant to address.

### RC-G — Positional `:near()` fallback selector never resolves · 1 failure + 1 blocked · 2 runs · **OPEN**

```
TimeoutError: locator.fill: Timeout 10000ms exceeded. Call log:
  - waiting for locator('input:near(:text("Type characters"), 120), textarea:near(…), select:near(…)').first()
```

**Exemplars:** `3475cc6e/case-1`, `afb840d3/case-1`.

Diagnosed only as generic `timeout` — *"The step exceeded its timeout without a more specific,
recognizable error signature."* The diagnoser can't see that the locator strategy itself was the
problem, so this failure teaches nobody anything.

### RC-H — `toHaveURL` pattern mismatch, assertion wrong / app right · 2 failures · 2 runs · **OPEN**

```
Expected pattern: /#contact/            | Received: "https://thinkvibes.com/thank-you/"
Expected pattern: /list-manage\.com/    | Received: "https://thinkvibes.com/"
```

**Exemplars:** `d5ea77ad` (cases 0 and 3). Same class as RC-A's false negatives — the form
submitted successfully and the test called it a failure.

### RC-I — The pipeline's own IR validator rejects Groq's output · 1 failure · 1 run · **OPEN**

```
IR failed schema validation after retry: This IR does not carry out the test case: the case
describes entering values, but the IR has no "fill" step. Emit a step for EVERY action the case
describes, in order, before the assertion.
```

`261d4022/case-3`. The guard is *correct* — it caught a genuinely empty test. The problem is the
outcome: after 2 attempts it gives up, leaves an empty case dir, and reports `failed`. A
correctly-rejected bad IR is indistinguishable from a real product bug in the summary.

### RC-J — Blocked: flow leaves the app for an external sign-in provider · 5 cases · 5 runs · **WORKING AS INTENDED**

```
blockedBy: "the flow left the application for www.linkedin.com, an external sign-in provider
            the test can't complete"        (×4, all thinkvibes social-icon tests)
blockedBy: "…for corporate.flipkart.net…"   (×1)
```
`exitCode: 0` on the LinkedIn ones — clean detection. **This is the system behaving correctly.**
The open question is upstream: why does the case generator keep producing social-media-link cases
it can structurally never complete? Four runs wasted a case slot on this.

### RC-K — Blocked: OTP / inbox verification wall · 2 cases · 1 run · **WORKING AS INTENDED**

```
blockedBy: "the flow reached a verification step that needs a code sent to a real inbox or phone,
            which an automated test can't read"
```
`afb840d3` (Flipkart). The login modal covers the homepage, so even the plain "does the homepage
load" case is blocked. Correct detection of a genuinely untestable situation.

### RC-L — Authenticated app: post-login DOM absent → IR truncated · 4 cases · 1 run · **OPEN**

```
truncationNote: "Step s6 targets role=\"link\" name=\"Dashboard\", which is not present under any
compatible role on page \"https://assettrack-web.onrender.com\". If this element loads dynamically,
verify that the page completed hydration/API rendering; if it requires role-based access (e.g.
Admin), verify that valid authorized credentials were provided."
```
`cb02b048` — all 4 cases. Same note for `"Assets"` and `"Asset Details"`. Full analysis in Part 3.

### RC-M — `no_cases_selected`: 14 minutes of work, zero tests · 3 whole runs · **NEEDS YOUR INPUT**

```
testcases/completed {"finalCases":[],"action":"case_selection_finalized","noCasesSelected":true}
done/completed {"passed":false,"status":"no_cases_selected","groqUsage":{"calls":0,…}}
```
`2eb9ae50` (875.8 s), `e14f78cd` (873.8 s), `e6dece98` (872.5 s) — all `allen.in`. Gemini
*did* generate full, plausible case batches ("Initial Homepage Load and Structural Check", "Lead
Generation Form – Mandatory Fields Validation", …). Selection then discarded every one.

Together with `4f582417` (the Groq 404), **`allen.in` is a total dead zone: 4 runs, 4
non-executions, ~52 minutes of wall clock, 0 tests ever run.**

**This needs the same call you made on acadtracker.** If `allen.in` was an unsuitable target,
these runs should be excluded like acadtracker's. If it's a legitimate target, then a selection
stage that silently throws away a complete generated batch — and burns 14 minutes doing it — is a
serious defect in its own right.

### RC-N — Aborted mid-suite · 3 whole runs · **NOT A PIPELINE BUG**

`events.ndjson` ends on a bare `suite/started {"caseId":"case-N"}` with no error event; the
in-flight case dir is empty or missing `05-result.json`. `a4e22668`, `9cf1056d`, `28929d2f`.

These are process kills (Ctrl-C / dev-server restart), not pipeline failures. **But two of the
three stall on the identical case** — "Newsletter subscription with valid email" — and the very
next run of that same input failed that case with a Groq 401. That pattern suggests you were
killing runs that appeared hung inside the Groq retry loop. Worth knowing: a hung retry looks
identical to a hung pipeline from the outside.

### RC-O — Silent hang in the IR stage · 1 whole run · **OPEN**

`fba07da0`. `events.ndjson` ends on `ir/started {}` with **no terminating event of any kind** — no
completion, no error — immediately after `credentials/completed {"provided":false}`. 209.9 s of
wall clock, then nothing. No timeout fired, no error surfaced. This is the worst failure shape in
the corpus because it leaves no evidence at all.

---

## Part 2 — Cross-cutting defects

These matter more than any single bucket, because they corrupt the feedback loop you use to judge
everything else.

### 1. Infrastructure outages are reported to you as product test failures

Five cases — `0413c4c8/case-3`, `2b2858b9/case-3`, `7bcbf4de/case-2`, `7bcbf4de/case-3`,
`261d4022/case-3` — show `status: "failed"` in `07-suite-summary.json` with **completely empty
case directories**. They were never executed. Two of them were an Invalid API Key.

The real error exists only in a `suite/failed` event's top-level `error` field, which
`07-suite-summary.json` does not carry and the UI therefore never shows. **You were told your
website has failing tests when the truth was that your API key was invalid.** This single defect
probably accounts for more wasted debugging time than any test bug in this document.

### 2. A truncated test can report green

`cb02b048/case-0` finished with Playwright reporting `stats: {"expected":1,"unexpected":0}` and
`05-result.json` showing `passed: true, exitCode: 0` — on a test whose IR was cut short before it
reached any meaningful assertion. Mechanically successful, verifying nothing. The whole run
reported no Playwright errors while confirming nothing about the application.

### 3. Evidence gap on the case that fails most often

`667f7f76/case-0`, `0413c4c8/case-0`, `4a2261b4/case-2` all have `05-result.json` with
`"raw": null` and no `results.json`. The `reused: true` primary-case path in `suiteRunner.ts`
drops the raw Playwright report. Case-0 is the most frequently failing slot in the entire corpus,
and it is the one whose evidence is discarded.

### 4. Every failure costs a full 50 seconds

The 10 s locator timeout fires, then Playwright's 50 s test timeout fires on top of it, so every
failing case emits a spurious second error (`Test timeout of 50000ms exceeded.`) and consumes the
full 50 s. With 35 failures that is ~29 minutes of pure waiting across the corpus.

### 5. Self-heal has never once worked

Five runs invoked it — `0413c4c8`, `4a2261b4`, `28929d2f`, `a6747fb8`, `086eb33b` — and all five
logged `heal/completed {"healed":false}`. **0/5.**

Worse, `heal.ts` deliberately refuses to touch a truncated IR (correct in isolation — a truncated
heal would be a false positive) but truncation is now a leading failure mode, so heal is
structurally excluded from exactly the cases that need it most.

### 6. The test suite has a permanent, normalised red

`npx vitest run` sits at **329/331**, and has for the whole period. Both failures are
`tests/irPostClickReveal.test.ts` reading fixture data from run directories that no longer exist:

```
ENOENT: no such file or directory, open '…\runs\2026-08-10T11-15-46-262Z-1279794e\04-ir.json'
ENOENT: no such file or directory, open '…\runs\2026-08-10T10-18-49-077Z-a5d729b1\cases\case-1\04-ir.json'
```

The tests replay against real saved runs — good practice, and how most findings in `TECH_DEBT.md`
were confirmed — but `runs/` is gitignored and deletable from the UI, so the fixtures evaporated.
The cost isn't the two tests: it's that "2 failures are normal, ignore them" is now the working
assumption, which is precisely how a third, real regression slips through unnoticed. (A third
failure did appear intermittently during this analysis and did not reproduce — with a permanently
red baseline there is no clean signal to distinguish that from a genuine break.)

Either commit the fixtures the tests need, or have them skip with a clear message when the run
directory is absent. A green baseline is worth more than these two assertions.

### 7. Mutually contradictory diagnoses inside a single run

In `086eb33b`, case-0's diagnosis states login **succeeded** and redirected away from `/login`;
cases 2, 3 and 4's diagnoses state login **failed** because "Sign In" stayed visible. Both cannot
be true of the same run against the same site with the same credentials. The diagnoser rationalises
each case in isolation with no cross-case consistency check, so it will confidently narrate a
false story rather than report uncertainty.

---

## Part 3 — The login-gated discovery gap

**Your hypothesis is correct. The fix you proposed is not sufficient.**

### What you asked

> If I give it a site that redirects straight to a login page, with a dashboard behind it
> (lessons, calendar, tracker…), I think it only generates login test cases because that's all it
> can see. Should I ask for credentials before test-case generation, or before DOM extraction?

### What the code actually does

Pipeline order in `src/orchestrator.ts`:

| Line | Stage |
|---|---|
| 96 | `plan(...)` |
| **98-100** | **discovery** |
| **108-115** | **test-case generation** |
| **151-162** | **credentials** |
| 165 | `toIR(...)` — first consumer of credentials |

Discovery runs **first**, and it cannot authenticate:

```ts
export async function discoverSiteHybrid(url: string): Promise<AppModel>   // no credentials param
export async function discoverPagesHybrid(urls: string[]): Promise<AppModel>
```

It launches a bare anonymous browser per page (`hybridDiscovery.ts:390-392`). **`storageState`
appears nowhere in the repository** — no logged-in session is ever persisted or reused. Protected
routes redirect to `/login`, are recognised as already-visited, and are silently dropped
(`hybridDiscovery.ts:451`).

The module's own comment concedes the outcome:
> *"Behavior is unchanged for a site whose entry page exposes no crawlable internal links (auth
> walls, single-page apps): the result is a one-page model"*

### The causal chain

AppModel = 1 page → `concepts = ["Authentication"]` → `strategyFor()` selects the **login
checklist** (`testStrategy.ts:64-70`) → Gemini receives the login checklist and one page.

### The evidence

Two runs against a working login-gated app, **both zero-pass, 9 cases total**:

| Run | Site | AppModel pages | Outcome |
|---|---|---|---|
| `cb02b048` | assettrack-web.onrender.com | **1** (`/login`) | 0 passed, 4 truncated |
| `086eb33b` | assettrack-web.onrender.com | **1** (`/login`) | 0 passed, 5 failed |

Recovering the *round-1* generated batch from `events.ndjson` (note `03-cases.json` is overwritten
later at `orchestrator.ts:276`, so the on-disk file is not what was first produced):

- `cb02b048` — **7 of 8** cases pure login (incl. "SQL injection attempt in login email", "XSS
  script injection attempt in email field")
- `086eb33b` — **5 of 6** cases pure login

…on a prompt that said, verbatim: *"i want you to login to this website and do basic testing on
the website regarding the dashboard and other pages **and i dont want any login testing**."*

**This is your hypothesis, confirmed exactly, on a prompt explicitly asking for the opposite.**

The dashboard-themed cases that appear in the *final* `03-cases.json` only exist because these
runs had the **opt-in** case-selection gate enabled (`ENABLE_CASE_SELECTION_GATE=true`; the
default is `false`), letting a human reject round 1 and force regeneration. **In the default
configuration there is no round 2 and no recovery.** And those round-2 cases were then
*hallucinated from your prompt text* — every one carries `generatedFrom: "upfront"` and
`targetUrl: ".../login"`, so "Verify ticket list filtering functionality" was invented from your
wording, not discovered, and could never ground.

### Why "before test-case generation" isn't enough

If credentials were collected one stage earlier, the AppModel would still contain one page,
`concepts` would still be `["Authentication"]`, `strategyFor` would still select the login
checklist, and Gemini would still see one page. **You'd get the same login suite.**

The proof is already in the code: `extractCredentialsFromPrompt(prompt)` runs at line 151 as the
*first thing* in that block, so runs already exist where credentials are known at t=0 — and
discovery still cannot use them, because it takes no credentials parameter at all.

**It has to be before DOM extraction, and that is a new capability, not a reordering:**
authenticate, persist a Playwright `storageState`, and crawl with that session.

### The most actionable finding in this document

**The machinery partly exists, and its output was thrown away.**

In `086eb33b`, live-extend *did* get behind the login. The AppModel grew from 1 page to 4:
```
/login, /, /tickets, /employees
```
and `generateCasesForNewPages` produced **6 genuinely grounded, genuinely post-login cases**:
```
Submit Add Employee form with empty fields   {reactive}
Initiate ticket creation process             {reactive}
Global asset search with no results          {reactive}
Filter employee directory by department      {reactive}
Toggle application visual theme              {reactive}
Sidebar collapse functionality               {reactive}
```
**All six were discarded** — the completion event reads `{"generated":5,"reactive":0,"selected":5}`.
`runReactiveCaseRound` (`orchestrator.ts:261`) accepted zero of them.

The one time this system saw behind a login and generated exactly the cases you wanted, it dropped
them on the floor. Fixing that acceptance path is far cheaper than building authenticated crawling
from scratch, and would have salvaged this run.

### Three secondary gaps

1. **`credentialFieldsNeeded` can return `[]`** (`credentials.ts:155-175`), so a login-gated SPA
   whose entry snapshot isn't recognisably login-shaped gets **no credential prompt at all**.
2. **CLI runs never prompt** — line 152 requires an `askCredentials` callback the CLI doesn't pass.
3. **`orchestrator.ts:245-246` compares URLs by exact string:**
   ```ts
   const originalUrlsSet = new Set(resolvedUrls);
   const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));
   ```
   For any site that redirects on entry (`https://host` → `https://host/login`), **the login page
   itself is classified as newly-discovered**, burning a full reactive generation round
   re-generating cases for the page it already had.

---

## Part 4 — What's already fixed

All of the following are **committed and present in `HEAD`** (verified by `git grep` against
`HEAD`, not assumed from the working tree — the tree is clean apart from this file). They landed
in commit `4fdac46`.

| Item | Addresses | Actually closes it? |
|---|---|---|
| TD-37 — `clickedElementHiddenAssertion` requires a structural auth signal | RC-B | **Half.** Fixes the 3 non-auth-form cases; the 3 real-login cases are allowed by design and still fail. |
| `crossFormBleedError` — click target must belong to the same form as preceding fills | RC-A, cross-form subset | Partly — covers wrong-button-on-a-two-form-page only. |
| TD-39 — structural diff fallback in `groundTerminalTextAssertion` | RC-A, wrong-text subset | Partly — only corrects text on a page the replay can actually reach. |
| `attemptHeal` extracted and wired into suite cases | Heal never ran for non-primary cases | Makes heal *reachable*; heal's 0/5 success rate is a separate, open problem. |
| `Diagnosis.verifiedText` + `verifyDiagnosisText` | TD-38 | Half by design — the verification exists but is deliberately not yet wired into `toIR` or heal eligibility. |
| Failed-case video surfaced in the UI | Diagnosis evidence | Yes. |

**Two caveats before you read any of these as "done":**

1. **Per `CLAUDE.md`, `npm run serve` has no watch/reload** — a running server keeps executing
   whatever code was in memory when it started. Runs recorded after a fix landed can still show
   pre-fix behavior if the server predates it. Check the process start time before concluding a
   fix didn't work.
2. **Landing ≠ closing.** As RC-B shows concretely, a fix can be correct, committed, active, and
   still leave most of the observed failures standing, because it targeted a narrower sub-case
   than the bucket. Only the video row above is unambiguously complete.

**Still fully open:** RC-A's remaining half, RC-B's login-form half, RC-C, RC-E, RC-F, RC-G, RC-H,
RC-I, RC-L, RC-O, every cross-cutting defect in Part 2, and the entire login-gated gap in Part 3.

---

## Part 5 — Suggested order of work

Ranked by value recovered per unit of effort. No implementation implied — this is for you to
choose from.

### Tier 1 — Cheap, high leverage (hours)

1. **Stop reporting infrastructure errors as test failures** (Cross-cutting #1). Carry the
   `suite/failed` error into `07-suite-summary.json` and give the UI a distinct "couldn't run"
   state. Five cases in this corpus were mislabeled; two of those were an API key problem you had
   to find by hand. Highest trust-per-hour fix in the document.
2. **Never report a truncated test as passed** (Cross-cutting #2). A test that didn't reach its
   assertion is "inconclusive", not green.
3. **Persist the raw Playwright report on the reused primary-case path** (Cross-cutting #3). One
   line; restores evidence on the most-failing case slot.
3b. **Get the test suite back to green** (Cross-cutting #6). Either commit the two fixtures or
   skip cleanly when the run dir is missing. Cheap, and it restores your ability to trust a red.
4. **Accept the reactive post-login cases that already get generated** (Part 3). `086eb33b`
   produced exactly the 6 cases you wanted and threw them away.
5. **Fix the exact-string URL comparison** (`orchestrator.ts:245-246`). Normalise before comparing.

### Tier 2 — Real work, clear payoff (days)

6. **Authenticated discovery** (Part 3). Log in before crawling, persist `storageState`, crawl
   with it. This is the fix for the whole login-gated class, and the only one that makes
   dashboard-app testing work at all. Everything else in Part 3 is a workaround.
7. **Finish RC-A.** The corrector can only fix text on a page it can reach; it needs to also
   refuse to *emit* an unverifiable exact-text assertion in the first place, preferring URL or
   structural assertions when it has no grounded string.
8. **RC-E — degrade instead of throwing** on a nameless role, so one bad target skips one case
   instead of killing the run.

### Tier 3 — Known, bounded, lower frequency

9. RC-C (selector ambiguity on dense sites) — this is `TECH_DEBT.md` TD-05; the `visible`-assertion
   fix (TD-34) doesn't cover `click`.
10. RC-F (`toHaveTitle` exact) — prefer `title_contains` when the expected value is a substring.
11. RC-G — make the `:near()` fallback's failure legible to the diagnoser instead of a generic
    timeout.
12. RC-O — add a timeout/heartbeat to the IR stage so a hang produces an error instead of silence.

### Needs a decision from you first

- **`allen.in` (RC-M)** — real target, or exclude like acadtracker? If real, the selection stage
  discarding a complete generated batch is a Tier-1 bug.
- **RC-J** — should the case generator stop producing external-social-link cases it can never
  complete? Four runs each burned a case slot on a correctly-detected dead end.

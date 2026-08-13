# Status, Weak Points, and What To Solve Next

> **This file is the single source of truth for what is broken and what happens next.**
> The other docs deliberately do not repeat it — they link here instead. That's on purpose: this
> list used to live in six places at once, and every one of them drifted out of date.
>
> | You want to know… | Read |
> |---|---|
> | What is this, how do I run it | [README.md](README.md) |
> | How it works internally, file by file | [ARCHITECTURE.md](ARCHITECTURE.md) |
> | **What's broken, what's next** | **this file** |
> | The evidence behind a known defect | [TECH_DEBT.md](TECH_DEBT.md) |
> | What changed and when | [SESSION_SUMMARY.md](SESSION_SUMMARY.md) |

**Contents**

1. [The three reported problems — status](#1-the-three-reported-problems--status)
2. [Project weak points, ranked](#2-project-weak-points-ranked)
3. [What to solve next](#3-what-to-solve-next)
4. [Detailed analysis of the three problems](#4-detailed-analysis-of-the-three-problems)
5. [Methodology — how these conclusions were reached](#5-methodology--how-these-conclusions-were-reached)

---

## 1. The three reported problems — status

| # | Problem | Status |
|---|---|---|
| 1 | Dynamic in-page modal forms (e.g. "Raise a Ticket") don't get filled | ⬜ **Diagnosed, not fixed.** Mechanism pinned and reproduced against real runs. Fix designed — see [§3](#3-what-to-solve-next) |
| 2 | Hardcoded security examples leak into functional-only test prompts | ✅ **Fixed** (predates this analysis; verified still in place) |
| 3 | `AppModel` context explosion (17,000+ line JSON → `413`) | ✅ **Fixed**, commit `fb2ea96` |

Full write-ups for each are in [§4](#4-detailed-analysis-of-the-three-problems).

---

## 2. Project weak points, ranked

Beyond the three reported problems. Each was verified against the actual code or a real run — none
are inherited from a doc claim.

### Tier 1 — actively misleading or unprotected

**W1. No CI runs the test suite.**
274 tests across 26 files exist, and **nothing executes them automatically**. The only workflow,
`.github/workflows/directory-tree.yml`, regenerates a directory tree and pushes to `main`. Every
deterministic guard this project has built — grounding, credential policy, scope filtering — is
unenforced on any change. *Highest leverage-per-effort item in the repo: one workflow file.*

**W2. Documentation drifted into being wrong** *(being fixed in this pass)*.
The docs are the project's interface, and they had begun to actively mislead:
- `README.md` documented `Dockerfile`/`render.yaml`/`.dockerignore` — all deleted in `fbf44c0`.
  Following the README meant `docker build` against a file that doesn't exist.
- `README.md` still listed the `AppModel` ceiling as an open limitation after `fb2ea96` fixed it.
- Every compound-login row across three files said "diagnosed, not yet fixed" — `c456de9` landed
  the fix and touched **zero** `.md` files.
- `TECH_DEBT.md`'s verification baseline said 253 tests / 24 files; actual was 274 / 26.

  **Root cause:** "what is broken" was duplicated across six documents with no single owner. No one
  can keep six lists in sync. That's why this file exists.

### Tier 2 — correctness bugs, confirmed not theoretical

**W3. The generated spec's locator helpers have already diverged from the real resolver.**
(`TECH_DEBT.md` A7 + D10.) `targetResolver.ts` defines `ROLE_SWAP` (`button`↔`link`) so a styled
`<a>` acting as a button still resolves. `generator.ts`'s embedded `LOCATE_HELPER` — which is what
actually runs in the generated spec — has **no equivalent fallback** (confirmed by grep). An
element can therefore ground successfully during IR generation and then fail to resolve at
execution time. The duplication is deliberate (the spec must be standalone), but nothing pins the
two implementations equal, and they are already out of sync.

**W4. A stale poll response can misdirect a credential submission to the wrong run.**
(`TECH_DEBT.md` D5.) `public/app.js`'s `connectToRun` checks its generation guard only at the top of
each loop iteration, never after the `await fetch`. Switch from run A to run B while A's poll is in
flight, and A's stale events still apply — including a credential prompt. The user then types
credentials into a modal they believe belongs to run B, and they post to run A. Ranked above the
rest of Part D because it's the only one that can send the wrong site's credentials somewhere.

**W5. `safeClick` follows non-navigating hrefs as if they were navigation.**
(`TECH_DEBT.md` D2, reproduced.) The generated spec's `safeClick` checks only `href !== "#" && href
!== ""`. Three other places in this codebase share the full `NON_NAVIGATING_HREF` set
(`javascript:`, `mailto:`, `tel:`); `safeClick` alone omits it. An `<a href="javascript:void(0)"
onclick="openModal()">` gets `page.goto("javascript:void(0)")` instead of a click — the handler
never fires, no error is raised, and every later step runs against an unchanged page.

**W6. Failure diagnosis can attribute a failure to the wrong step.**
`analyzeFailure` reported a different `failingStepId` than the raw Playwright trace showed,
confirmed against a real run. Never investigated further.

### Tier 3 — operational and security

**W7. No server authentication.** Anyone with the URL can start runs and browse every artifact. The
entry-URL allow-list (`isAllowedEntryUrl`) narrows what an unauthenticated request can *reach*, but
nothing gates who can submit one. The README actively recommends exposing the server via a
Cloudflare tunnel, which compounds it.

**W8. `runs/` grows without bound and is served publicly.** (`TECH_DEBT.md` A6.) 184 MB across 28
runs at audit time. `runStore` caps the *history list* at 20 but never prunes files. Disk usage and
exposure both grow forever.

**W9. One bad or deleted run can 500 the shared run-history endpoint.** (`TECH_DEBT.md` D4.)
`store.read()` parses NDJSON with no try/catch and `listRuns()` maps over runs with no per-entry
isolation, so a torn write — or a run deleted between `readdirSync` and `statSync` — fails the whole
`/api/runs` response that every client polls, not just the one bad entry.

### Tier 4 — structural limits (design direction, not defects)

**W10. The user's literal instructions are paraphrased by an LLM before any deterministic stage
sees them.** "Click on Admin" becomes "Navigate to the Admin section"; explicit waits get dropped.
The damage is contained downstream now (guessed routes are rejected deterministically), but nothing
carries verbatim intent through the pipeline as structured data. `promptSelectors.ts` does exactly
this for CSS selectors and is the model worth generalizing.

**W11. Blocking-form handling is login-shaped only.** Cookie walls, OTP/2FA, age gates, region
selectors — none have any equivalent to the credential pause/ask flow. This is the structural reason
the pipeline is tuned to auth-shaped sites.

**W12. Visibility is only accurate for selector-bearing elements.** `domExtract.ts` is a static
parser with no CSS engine. Elements carrying a stable selector are re-checked live; anything without
an `id`/`data-test`/`css` keeps the assumed `visible: true`.

The full audited list, with reproductions and evidence, lives in [TECH_DEBT.md](TECH_DEBT.md).

---

## 3. What to solve next

### Next up — the modal-form bug (Problem 1)

Two findings turn this from a speculative heuristic into a validated design.

**Finding 1 — the trigger shape is empirically precise.** Scanning all 43 IRs on disk for *"a
`fill`/`select`/`check` whose nearest preceding non-`wait` step is a `click`, with no intervening
`navigate`"* fires on 13, and **all 13 are genuine post-click-revealed forms**:

```
runs\...a5d729b1        click[5] button 'Raise Ticket'    -> fill[6] textbox 'Search assets by serial or name...'
runs\...a5d729b1\case-1 click[5] button 'Raise Ticket'    -> fill[6] textbox 'E.g., Laptop screen flickering'
runs\...374c3253\case-1 click[1] button "Let's Connect"   -> fill[3] textbox 'Email *'
                                                             ... 13 total
```

It fires on **zero** login flows — in a login the fills come *before* the click, so the shape never
matches. (Honest framing: 12 of the 13 are one site's modal across 6 runs × primary + cases; the
independent second site is thinkvibes' "Let's Connect". Two distinct sites, corpus concentrated.)

**Finding 2 — a same-run A/B pair proves the capture mechanism already works.** In run
`2026-08-10T10-18-49-077Z-a5d729b1`:

| | `case-0` | `case-1` |
|---|---|---|
| Targeted | `'Search assets by serial or name...'` (header chrome) | `'E.g., Laptop screen flickering'`, `'Provide more details...'`, `'Submit Ticket'` — **the real modal fields** |
| What grounding did | Name coincidentally matched real chrome → **falsely succeeded** | Name **missed** the model → reported ungrounded |
| So capture… | never ran | fired, discovered the modal, re-grounded correctly |

Same run, same site, same modal. The one that guessed *wrong enough to miss* got a correct test; the
one that guessed *wrong but coincidentally matching* shipped a broken one.

**Conclusion: the capture mechanism is not broken — its trigger is.** `extendAppModel` is
reactive-on-miss only.

#### The fix

**Verified design point:** a forced refresh alone is *not* enough. `refreshPageModel` replaces the
page with a full live snapshot that **still contains the header chrome** — page furniture doesn't
disappear when a modal opens — so re-grounding the same IR would still pass the bad target. The fix
must **reject and re-generate**, which means it belongs on the
`lastContradiction`/`correction`/`continue` path (spending one `MAX_IR_ATTEMPTS`), *not* the
attempt-free `while (ungrounded && ...)` re-ground loop.

In `src/stages/ir.ts`, reusing the existing `trackPages()` helper:

- **`postClickRevealIndex(ir)`** — the first `fill`/`select`/`check` whose nearest preceding
  non-`wait` step is a `click` on a non-`link` role, with no intervening `navigate`.
- Wire into `toIR`'s no-live-extend branch (beside `vacuousAssertion`/`urlAssertionError`), and only
  when the step **did** ground — a miss already routes to the existing extend path, which is exactly
  what made `case-1` work:
  1. Force one `refreshPageModel(...)` through the triggering click. Costs one
     `MAX_LIVE_EXTENSIONS` slot; the failing run used only 2 of 5, so there is headroom.
  2. Diff the refreshed page's elements against the pre-refresh set. **The delta is the provenance
     signal** — no schema change required.
  3. Refresh added nothing → accept. No modal opened; identical to today's behavior, no regression.
  4. Refresh added elements but the target still matches only a **pre-existing** one → reject with a
     correction naming the newly-revealed fields, and `continue` so the model re-generates with the
     modal actually in context.
- Fire at most once per `toIR` call, so a stubborn model can't loop on it.

**Out of scope for v1:** populating `pageSection`/`containerRole`/`containerName` in
`domDiscovery.ts`. They exist in the `AppModel` schema for exactly this purpose (`pageSection` even
names `"dialog"`) but are never written. They'd make the correction message better; the element
delta already supplies the signal, so v1 stays minimal.

#### How to verify it without spending API credit

This repo already has precedent for replaying a guard against a failing run's own saved artifacts
(the navigate-URL guard was verified that way):

1. **Unit** (`tests/grounding.test.ts`): `postClickRevealIndex` returns the right index for
   `case-0`'s step list, and **none** for a login-shaped IR.
2. **Artifact replay, zero cost:** flag `s10` in `runs/2026-08-10T11-15-46-262Z-1279794e`'s saved
   `04-ir.json` + `updatedAppModel`; do **not** reject `a5d729b1` `case-1`'s known-good IR.
3. **Regression discipline** (repo standard): disable the fix, confirm the test fails with the real
   error shape, restore, confirm it passes.
4. `npx tsc --noEmit` clean; all 274 existing tests still green.
5. **Live run — final confirmation only.** Real Groq/Gemini + browser spend against
   `assettrack-web.onrender.com`'s ticketing prompt.

### Then — CI (W1)

One workflow: `npm ci`, `npx tsc --noEmit`, `npx vitest run`. Permanently protects every fix in the
repo, including the modal fix above. Cheapest high-value change available.

### Then — the ranked backlog

| Order | Item | Rationale |
|---|---|---|
| 1 | **W4** — stale poll misdirects credentials (`app.js`, D5) | Only bug that can send one site's credentials to the wrong run |
| 2 | **W3** — locator helpers already diverged (A7 + D10) | Confirmed diverged, affects every generated spec; needs one test pinning the two equal |
| 3 | **W5** — `safeClick` non-navigating hrefs (D2) | Reproduced, isolated, and the correct regex already exists in three other files |
| 4 | **W8** — prune `runs/` (A6) | Disk and exposure both grow forever |
| 5 | **W9** — per-entry error isolation in `listRuns()` (D4) | One bad run shouldn't 500 everyone's history |
| 6 | **W7** — server authentication | Biggest security gap, but a product decision (local-only vs shared) — scope it before building |

---

## 4. Detailed analysis of the three problems

### Problem 1 — Dynamic in-page modal forms not filled

**The report.** An app's "Raise a Ticket" modal, with Title/Description/Department fields, opened by
a button click with no URL change. Asked to "fill title with test", the pipeline could not.

**Finding the real run.** Six real runs against `https://assettrack-web.onrender.com` exist under
`runs/`, all with prompts like *"login in to this website and click on Tickets button on the
sidepanel then click on Raise Tickets button then test the form."* The most recent,
`2026-08-10T11-15-46-262Z-1279794e`, is the trail below.

**What actually happened.** `04-ir.json` — the IR the pipeline generated and considered fully
grounded (`hasTerminalAssertion: true`, no `truncated` flag):

```
s1  navigate   /login
s2  fill       textbox "Email"
s3  fill       textbox "Password"
s4  click      button  "Sign In"
s5  wait       3000
s6  click      link    "TicketsTickets"
s7  wait       3000
s8  click      button  "Raise Ticket"
s9  wait       3000
s10 fill       textbox "Search assets by serial or name..."   value: "test data"
s11 click      button  "open"
s12 assert     text "ticket submission confirmation" visible
```

s10 and s11 are supposed to be the modal's Title/Description fields. They aren't. `05-result.json`
shows the test hanging on `Click 'open'` for 32.8 s before the browser context died and Playwright
reported a 50 s timeout.

**Why grounding accepted an obviously wrong step.** `groundingError()` validates each step's
`{role, name}` against the known `AppModel`. It asks only *"does an element with this role and name
exist"* — never whether the matched element is semantically appropriate. Dumping the `/tickets`
page from that IR's own `updatedAppModel`:

```python
{'role': 'textbox', 'name': 'Search assets by serial or name...', 'id': 'textbox_6', ...}
{'role': 'button',  'name': 'open', 'order': 26}
```

Both are real — as pre-existing page chrome. The first is the global header's asset-search box
(present on every authenticated page). The second is a status badge on an *already-existing* ticket
in the list ("Need audio and headset" … **"open"**). Neither belongs to the modal. The model, asked
to fill a form whose real fields it had never seen, invented plausible names — and both happened to
collide with real elements elsewhere on the same page.

**Why the safety net never fired.** `extendAppModel()` is the mechanism for exactly this — it
launches a browser, replays the prefix, and re-snapshots, including a vision fallback for dialogs
whose fields aren't semantic HTML. But it is called from one place in `ir.ts`, inside:

```ts
while (ungrounded && extensions < MAX_EXTENSIONS) { ... }
```

**Reactive-on-miss only.** Since s10 and s11 both grounded (against the wrong elements),
`ungrounded` was `null` and the loop never entered. Not a budget problem: 2 of 5 extensions were
used, both spent reaching `/` and `/tickets` past the login wall (`02-appmodel.json` confirms
pre-auth discovery saw only `/login`). Three slots sat unused.

**The A/B proof.** See [§3](#next-up--the-modal-form-bug-problem-1) — `case-1` of run `a5d729b1`
targets the modal's real fields because its guess *missed*, triggering the capture that `case-0`
never got. Same run, same modal, opposite outcomes, and the difference is entirely whether the
hallucinated name happened to collide with real chrome.

**The compounding gap.** Even when capture succeeds, merged elements carry no marker separating
"only present while a dialog is open" from "always-present chrome". `src/schema/appModel.ts` already
declares the fields for this:

```ts
containerRole: z.string().optional(),
containerName: z.string().optional(),
pageSection: z.string().optional(), // "main", "nav", "header", "footer", "dialog"
```

Grepping `src/stages/domDiscovery.ts` — the live extraction path `liveExtend.ts` actually uses — for
any of the three returns **zero matches**. The schema anticipated modal-awareness; the extraction
code to fill it was never written.

**Fix status:** designed, not implemented. See [§3](#the-fix).

---

### Problem 2 — Hardcoded security examples leaking into functional prompts

**The report.** `src/kb/testStrategy.ts` (lines 70, 83) hardcodes security-flavored checklist
entries — SQL injection under "login", XSS/special-characters under "search" — reported as leaking
into runs asking for purely functional coverage.

**Status: fixed**, and fixed before this analysis began — `git diff src/kb/testStrategy.ts` returns
empty, i.e. it matches `HEAD`.

The two security rows are still in the table, correctly: they're real checklist entries a human
tester would include *when security scope is in play*. What changed is that they're no longer
unconditionally injected:

1. Every entry carries `scope: "functional" | "security"`, derived from a closed `CategoryId`
   taxonomy — only `security-injection` and `security-xss` resolve to `"security"`.
2. `classifyScope(prompt)` reads the user's own prompt with stem-matched regexes (`\bsecurit`,
   `\binject`, `\bxss\b`, `\bvulnerab`, `\bexploit`, `\bpenetrat` vs `\bfunctional`, `does .+ work`,
   `\bsmoke\b`, `\bhappy path`). No signal either way returns both scopes — full taxonomy, unchanged
   behavior for an unopinionated prompt.
3. `filterByScope(cases, scope)`, wired into `testCases.ts`, drops any case whose category resolves
   to an unrequested scope. The `fromPrompt: true` case is always kept — if a user explicitly asks
   for a security test, filtering it out would be wrong.

So *"Verify homepage navigation and header links"* classifies as `["functional"]`, and any
injection/XSS case the model writes anyway is filtered before the case list returns.

**Verification:** `git diff` empty; covered by `tests/strategy.test.ts`.

---

### Problem 3 — `AppModel` context explosion on complex sites

**The report.** On a rich application (large tables, deep menus, hundreds of DOM nodes), the
generated `AppModel` reaches 17,000+ lines; passing it to `testCases.ts`/`ir.ts` trips
`413 Payload Too Large` / a context-limit error.

**Root cause.** `toLiteModel()` (`src/schema/appModel.ts`) already dropped most per-element detail,
but kept every page's **entire** `forms`, `navigation`, `buttons`, `headings`, and `breadcrumbs`
arrays, for every crawled page, unbounded. A 200-row table or a mega-menu contributed all of it.

**The fix** (commit `fb2ea96`). Every unbounded array now has a cap, all read per-call from env (not
cached at module load, so tests can override without `vi.resetModules()`):

| Cap | Env var | Default |
|---|---|---|
| Elements/page | `MAX_LITE_ELEMENTS_PER_PAGE` | 150 |
| Forms/page | `MAX_LITE_FORMS_PER_PAGE` | 5 |
| Fields/form | `MAX_LITE_FORM_FIELDS` | 20 |
| Nav nodes/page | `MAX_LITE_NAV_NODES_PER_PAGE` | 60 |
| Nav depth | `MAX_LITE_NAV_DEPTH` | 3 |
| Buttons/page | `MAX_LITE_BUTTONS_PER_PAGE` | 40 |
| Headings/page | `MAX_LITE_HEADINGS_PER_PAGE` | 40 |

Two choices worth calling out:

- **`capElements()` is priority-aware, not a blind slice.** It keeps every *named, interactive-role*
  element first, then fills the remaining budget with anonymous ones. A naive `.slice(0, 150)` can
  silently drop the one login form a case needs, if a large table sits above it in DOM order.
- **`capNavTree()` caps breadth and depth off one shared budget.** A per-level breadth cap doesn't
  bound a tree that's both wide *and* deep — 20 nodes per level still explodes three levels down.
  Threading one shared `{ remaining }` counter through the recursive walk bounds the total node
  count regardless of shape.

Defaults sit above the largest values observed across this project's own sampled runs (87
elements/page, 2 forms/page, 9 fields/form, 18 nav nodes, 3 buttons/page, 28 headings/page), so an
ordinary site is untouched — the caps only engage on a genuinely richer one.

**Verification:** `tests/appModel.test.ts` (`describe("toLiteModel — caps")`) covers each cap and the
named-over-anonymous priority rule; `npx tsc --noEmit` clean; full suite 274/274 across 26 files.

---

## 5. Methodology — how these conclusions were reached

Every claim above traces to one of three kinds of evidence, and each finding states which:

- **Static code reading** — the function that actually runs, read directly, never inferred from
  naming, comments, or an existing doc claim.
- **Real run artifacts** — this project writes every stage's output to `runs/<run-id>/*.json` and
  `events.ndjson`. Where a claim says "confirmed against run `X`", that JSON was inspected.
- **Reproduction** — for Problem 1, the matching logic that produced the wrong result was re-run by
  hand against the real data, and the candidate fix's trigger was scanned across all 43 IRs on disk
  before being proposed.

Two conclusions were **reversed** by this discipline, and both are worth recording because the first
instinct was wrong in each case:

1. *"A post-click re-snapshot heuristic would fire on every login."* False — measured, not assumed.
   In a login the fills precede the click, so the trigger shape never matches. 13/43 fired, all
   genuine.
2. *"Forcing a refresh is enough to fix it."* False — the refreshed page still contains the header
   chrome the bad target matched, so re-grounding would still pass. The fix has to reject and
   re-generate.

No code was written for Problem 1: the investigation deliberately stopped at "pinned, reproduced,
and designed" rather than shipping a fix whose cost profile hadn't been validated against a live
run — in a project whose most recent crisis was runaway API spend.

---

## Summary

| # | Problem | Root cause | Fix | Verified how |
|---|---|---|---|---|
| 1 | Modal forms not filled | `extendAppModel` triggers only on a grounding **miss**; a hallucinated name that coincidentally matches real chrome makes grounding falsely succeed, so the modal is never captured | **Designed, not implemented** — see [§3](#the-fix) | Static code reading + real artifacts + hand-reproduction + a 43-IR trigger scan + a same-run A/B pair |
| 2 | Security cases in functional runs | Checklist mixed scopes with no way to filter by request | `CategoryId`/`scope` taxonomy + `classifyScope()` + `filterByScope()` | `git diff` empty; `tests/strategy.test.ts` |
| 3 | AppModel context explosion | `toLiteModel()` had no size ceiling | `capElements()`/`capNavTree()` + per-page caps, env-configurable | `tests/appModel.test.ts`, `tsc --noEmit`, 274/274, commit `fb2ea96` |

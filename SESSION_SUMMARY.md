# Session Summary

**An append-only log of what changed and when.** Entries record what was true at the time they were
written and are not retroactively corrected — for the *current* state of anything, see
[PROBLEM_ANALYSIS.md](PROBLEM_ANALYSIS.md) (what's broken / what's next),
[PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) (narrative), or
[ARCHITECTURE.md](ARCHITECTURE.md) (technical detail).

## 1. Compound-login-case investigation (diagnosed, not fixed)

Investigated a real failure where a case combining a deliberately-wrong login attempt and a real
one in a single browser session substituted the real credential into the wrong leg roughly half
the time, depending on step ordering the model happened to choose. Root-caused to
`CredentialPolicy` being decided once per whole case rather than per state-transition within it.
A replacement design (stop generating that compound case shape; rely on a separate case for the
negative leg) was approved but **not implemented** — it remains open, documented in
`PROJECT_SUMMARY.md`'s "Five Steps" and `ARCHITECTURE.md`'s gaps table.

## 2. Documentation overhaul (first pass)

Rewrote `README.md` and `ARCHITECTURE.md` to remove references to already-deleted code (the old
Python discovery service, the full-site BFS crawler) and fix stale numbers. Wrote
`PROJECT_SUMMARY.md` from scratch: project statement, detailed architecture diagram, "what works"
bullets, and a "Five Steps to Make the Backend Genuinely General-Purpose" section scoped
specifically to backend/pipeline structure rather than generic feature requests.

## 3. Three general-purpose pipeline fixes — planned, approved, then not implemented

Diagnosed a real saucedemo run that failed after previously passing. Root-caused three issues
and got a plan approved for all three:
- sanitize `sourcePrompt`/`feature` before interpolating into `//` comments in `generator.ts`
  (an embedded newline breaks the comment and produces a syntax error)
- decouple `toIR`'s live-extend retries from its `MAX_IR_ATTEMPTS` budget
- stop a case's IR generation from absorbing scope from the run's overall `sourcePrompt`

**Only the first was ever actually implemented — later, and by a different route** (see §5,
`cutAtBoundary` + `oneLine`). The other two were approved but the session moved directly to a
different task before implementation. **Both remain open** — see `ARCHITECTURE.md`'s Current Gaps
table (`toIR`'s retry-budget coupling, and the `sourcePrompt` scope-bleed issue).

## 4. Ported 9 items from a colleague's `Gunwant` branch onto `lakshya`

`Gunwant` was an orphan commit with no shared git history, containing genuinely good work mixed
with some real problems (committed API keys, a broken CI path, a couple of bugs). Diffed it
against `lakshya`, wrote `GUNWANT_PORT_NOTES.md` cataloging what was worth taking, then switched
to `lakshya` and ported, fixing known issues along the way rather than copying them verbatim:

1. **`extractDomModelFromPage`** (`domDiscovery.ts`) — snapshot an already-open Playwright page
   instead of launching a fresh, session-less browser to re-discover it. The old path
   (`discoverUsingCrawler`) hit the login redirect on any authenticated URL and cached the wrong
   page permanently. Used by live-extend's replay and the new site crawl (item 2).
2. **`discoverSiteHybrid`** (`hybridDiscovery.ts`) — follows the entry page's own same-origin
   internal links (bounded, `MAX_DISCOVERY_PAGES`). Fixed two bugs while porting: a cache-key
   collision with the existing single-page `discoverHybrid` (gave the site-crawl result its own
   `site:` cache namespace), and a missing cache-write for a zero-element entry page.
3. **`cutAtBoundary`** (new `src/text.ts`) — boundary-safe text truncation, applied to
   `liveExtend.ts`, `failureAnalysis.ts`, `hybridDiscovery.ts`. Also used this as the occasion to
   fix the `generator.ts` comment-injection bug from §3 — with a dedicated whitespace-collapsing
   `oneLine` helper, not `cutAtBoundary` itself, since a `//` comment needs newlines *collapsed*,
   not just length-capped (`cutAtBoundary` deliberately preserves internal newlines for multi-line
   text — the wrong tool for a single-line comment, caught before implementing it wrong).
4. **`classify.ts`** — split "resolved to 0 elements" (genuinely missing) from "resolved to N,
   condition never true" (found but wrong state). The old combined regex made the
   `element_missing` category, and its self-heal trigger, unreachable.
5. **`domExtract.ts`** — stopped double-emitting an element that carries both a real interactive
   tag and an explicit `role` attribute, which produced duplicate AppModel elements and
   Playwright strict-mode failures.
6. **`scrubServedSecrets`** (`executor.ts`) — redacts credentials from `results.json`,
   `final-page.txt`, and error-context attachments, closing a gap where a logged-in page's own
   echoed text could leak the identifier even though fill values were already env-referenced.
7. **`runStore.ts`** orphaned-run detection — a run whose id predates the current server process
   and has no terminal event gets closed with a synthetic error instead of polling forever.
8. **Case-selection gate** — the largest piece: full human-in-the-loop review of generated case
   batches (accept/reject/regenerate), feature-flagged behind `ENABLE_CASE_SELECTION_GATE` (off
   by default, module not even imported when off). New files: `caseSelectionGate.ts`,
   `caseAccumulator.ts`, `caseHistoryLedger.ts`, `pendingCaseSelection.ts`,
   `schema/caseSelection.ts`, 3 new server endpoints, `filterNovelCases` in `testCases.ts` (a hard
   code-level filter, not just a prompt instruction, against ever re-showing an
   accepted/rejected title), and the case-selection UI panel. Added the missing
   `ENABLE_CASE_SELECTION_GATE` documentation to `.env.example` — its absence there is exactly
   what caused the panel to silently not appear the first time it was tried.
9. **`credentialsFor` demo-account removal** (`credentials.ts`) — deleted the hardcoded
   saucedemo/the-internet.herokuapp.com registry. A deliberate behavior change, confirmed with
   the user: every site now goes through the same `askCredentials` prompt uniformly, trading
   silent per-site convenience for general-purpose consistency.

Also fixed, while touching the same files anyway: an `app.js` bug where a phase could render
visually "completed" while its own text said "Interrupted" (status class and status text were
driven by two different signals that could disagree).

One process note: a `git stash` used to check a regression reverted every file touched that
session, not just the one file being checked — recovered immediately with `git stash pop`, no
work lost, but every later regression check used a narrower revert-and-restore-in-place pattern
instead.

## 5. Independent code-review claims — verified, not trusted blindly

A colleague's review of the scope-leak behavior (functional-only runs still producing security
cases) was checked against the actual current code rather than acted on directly:
- **Confirmed and fixed:** the coverage checklist shown to the LLM wasn't filtered by `scope`
  before being embedded in the prompt, so a functional-only run's system prompt said "do NOT
  write security cases" while its own checklist still listed `[critical] SQL injection in
  login`. Fixed in `testCases.ts` by filtering `strategyFor(concepts)` by scope before building
  the checklist string.
- **Investigated, found to be intended behavior, left unchanged:** the claim that
  `classifyScope` defaulting to both scopes when neither is named is a bug. `tests/strategy.test.ts`
  already asserted this as deliberate ("stays open when neither is named"). Confirmed with the
  user: kept as-is.
- **A separate bug the review didn't catch**, found by reading the actual last real run: the
  model was grounding a visible-text assertion on a page's `<title>` tag content — metadata that
  is never rendered in the page body, so the assertion could never pass. Not the encoding
  corruption it first looked like (raw bytes were checked and were correct throughout — the `�`
  visible in this terminal was a rendering artifact of the terminal itself, not the file). Fixed
  with one system-prompt rule in `ir.ts`.

## 6. Screenshot selection, nav-toggle grounding, case-selection UI redesign

Diagnosed the newest run at the time (3/4 passed) end to end:
- **Wrong screenshot shown per case** — `findScreenshot` (`executor.ts`) returned the first
  `.png` a directory walk found, which was always `step-1.png` (the pre-action frame) for any
  multi-step case, regardless of what the case tested. Fixed by sorting `step-N.png` numerically
  and taking the last one — reusing a pattern that already existed a few lines away in the same
  file (`detectBlocked`'s screenshot selection) but had never been applied to `findScreenshot`
  itself.
- **A vague "header is visible" case grounded on a mobile hamburger toggle** — hidden by a CSS
  media query at desktop width that `domExtract.ts` (a static HTML parser, no CSS engine) can't
  detect, so discovery recorded it `visible: true` regardless. Fixed with a system-prompt rule
  steering IR-generation away from a menu-toggle-shaped control as the sole representative of a
  general header/nav visibility check.
- **Case-selection panel redesign** — checkbox misalignment traced to a hardcoded
  `margin-top: 4px` guess that drifted once labels wrapped to multiple lines; replaced with a CSS
  grid layout that can't drift regardless of label length. Panel given a visibly stronger
  treatment (glow ring, "Action needed" pill, card-hover states) than the passive progress
  timeline above it, and now calls `scrollIntoView` when it renders instead of relying on being
  noticed further down the page.

Every fix in §4–6 followed the same verification discipline: write a regression test, confirm it
fails against the un-fixed code with the actual real error shape, restore the fix, confirm it
passes — not just "add a test that happens to pass."

## 7. Light/dark theme toggle

Added a toggle switch (bottom of the sidebar) between the app's original dark theme and a new
light theme inspired by medium.com's palette (warm white surfaces, near-black body text, hairline
gray borders, Medium's signature green as the accent in place of the dark theme's blue). Consolidated
several hardcoded hex colors that would have silently broken in a light theme (hover-state borders,
an accent-blue `rgba()` used directly instead of through a variable) into proper CSS custom
properties first, so the `[data-theme="light"]` override block is a complete, single source of
truth rather than a partial one with gaps. Persisted via `localStorage`, applied before first
paint via a small inline script in `index.html`'s `<head>` to avoid a flash of the wrong theme on
load. Dark stays the default for anyone who hasn't opted in.

## 8. Documentation overhaul (second pass) + this file

Updated `README.md`, `ARCHITECTURE.md`, and `PROJECT_SUMMARY.md` again to reflect everything in
§4–7: the case-selection gate, site-wide discovery, the theme toggle, updated file/line-count
tables, new environment variables, and — importantly — the two fixes from §3 that were approved
but never implemented, which the first draft of this update accidentally omitted from the gaps
tables until caught during review.

## 9. Case-selection correctness: "select 1, run 4"

Selecting a single case still ran four. Three separate causes, all fixed: `selectCases` re-applied
its own coverage budget *after* the gate had already decided, silently topping the selection back
up; reactive (live-extend-discovered) cases were merged in without passing through a gate round;
and a timeout during selection crashed the run instead of resolving to a clean outcome.
`finalizeCaseSelection` is now the single decision point — when the gate ran, its decision is
final and only scope filtering applies.

## 10. Two approved-but-never-implemented `ir.ts` fixes, finally closed

Both carried from §3. The `sourcePrompt` scope-bleed guard (a narrow case's IR absorbing steps
from the run's overall prompt), and the live-extend retry-budget decoupling — a hop now re-grounds
the same parsed IR without spending one of `MAX_IR_ATTEMPTS`, so a multi-hop flow no longer burns
its whole LLM budget just reaching the right page. The latter was verified by swapping in the
pre-fix `ir.ts` from git and confirming the new test reproduced the exact original log line.

## 11. Discovery: non-semantic clickables

`detectGenericClickables` finds `div`/`span`/`li`/`p` elements that are clickable in practice
(`cursor:pointer`, `onclick`, or a non-negative `tabindex`) but invisible to tag/role extraction —
the shape a component library produces for a styled "button" with no semantic tag. Added at
`extractDomModelFromPage`, the one function every discovery path already shares.

## 12. Credentials typed directly into the prompt

A prompt carrying real credentials (`email: … and password is "…"`) was *detected* but never
*extracted* — the detector was a bare boolean used only to skip the credential-ask dialog, so the
run proceeded with nothing to substitute and shipped the model's invented placeholder. Three
fixes: `extractCredentialsFromPrompt` pulls the actual values (always `secret`, same env-reference
path as UI-entered credentials); `credentialPolicyFor` now always substitutes for a
prompt-derived case rather than trusting the model copied the value faithfully; and the
orchestrator wires extraction in as the credential source. Caught two real regex bugs while
building it — one in the external proposal's own suggested pattern (a non-greedy capture followed
by an optional closing quote matches after one character), one of my own ("login" as a
username trigger word matches the verb in "login to the website", and regex alternation is
leftmost-match, not best-match).

## 13. Four grounding guards — every target kind now has a deterministic check

Each came from a specific failed production run, and each replaced (or backed) a prompt nudge that
had already failed to hold:

- **Viewport-hidden elements.** A mobile-only hamburger toggle (`display:none` at desktop width)
  was grounded as a `visible` assertion target and timed out. Discovery had hardcoded
  `visible: true` on every element — the static HTML parser has no CSS engine. Now every
  selector-bearing element is re-checked against real computed style in the live page, and a
  hidden element can't be asserted visible (asserting it *hidden* stays legal — that direction is
  load-bearing elsewhere).
- **Role mismatch.** A dashboard sidebar item built as `<button onClick=router.push(...)>` was
  reported "not present in the application model" because the IR guessed `role: "link"` — the
  element was right there under a different role. Grounding was stricter than the runtime code it
  protects (`safeClick`'s own fallback chain would likely have found it). Now falls back across a
  narrow clickable role group and writes the real role back onto the target.
- **Guessed navigate routes.** The last unguarded target kind: `navigate` steps were skipped by
  grounding entirely. A case step reworded as "Navigate to the Admin section via the sidebar"
  became `navigate "/admin"` → `navigate "/admin/users"`, both invented, both landing on a blank
  page — screenshots confirmed a stuck spinner then an empty black page. Now checked against every
  discovered page URL and link href, with allowances for the entry URL, off-origin targets, and
  any path the user typed themselves. Marked `kind: "navigate-url"` so `toIR` doesn't also spend
  live-extend hops on an error replaying can never fix.

Test suite grew from 209 to 229 across this work. Every fix went through the same cycle: write the
regression test, disable the fix, confirm the test fails with the *real* error shape, restore,
confirm byte-exact. The navigate-URL guard was additionally replayed against the failing run's own
saved artifacts, where it now flags the true first bad step (s5) instead of the misleading
downstream one (s7).

## 14. Documentation overhaul (third pass)

Updated `README.md`, `ARCHITECTURE.md`, and `PROJECT_SUMMARY.md` for §9–13: new capability rows,
refreshed file/line-count tables, the grounding-authority and prompt-nudges-are-never-enough
design decisions, and a rewritten gaps table — several entries moved from "open, planned" to
closed, and the stale ones removed rather than left to rot.

## 15. `TECH_DEBT.md` audit, then closing the highest-value items

Asked to list, not fix, everything wrong with the codebase and generalize every LLM system prompt
away from site-specific wording. Produced `TECH_DEBT.md` (new file) — Part A (defects, ranked),
Part B (provably dead code), Part C (prompt generalization). **Prerequisite discovered first:** no
LLM cache key included its system prompt or model name, and the disk half of the cache never
expires — so a prompt edit had zero effect on any input already cached, ever. Fixed across all five
LLM-calling stages before touching any prompt wording, or every later fix would have looked like a
no-op against a stale cache hit.

Then closed, in order: real user credentials removed from `testCases.ts`'s few-shot example (the
project owner's own live email/password had been baked into every test-case generation — the
likely reason the model kept inventing placeholder credentials instead of using the ones actually
supplied); demo-site credentials and one school site's navigation names generalized out of
`ir.ts`'s prompt; layout-assuming rules (header-nav `nth` positions, hardcoded "Menu"/"Toggle"
names) rewritten to reason from the application model instead of one site's shape; a grounding
rejection now gets real retries instead of truncating immediately (`toIR`'s in-loop early return
was intercepting the retry path `bestPartial` was supposed to own); a truncated IR no longer
poisons the disk cache permanently; the results panel renders the IR steps that actually ran,
not the LLM's case-text prose (which showed `Fill 'Password' with 'ValidAdminPassword123'` while
the real, correct execution had substituted `${env:TEST_PASSWORD}` — a correct run that *looked*
wrong at a glance); `missingActions` became a real coverage check (see PROJECT_SUMMARY.md); six
items of confirmed-dead code deleted (`filterByConcepts`, `discoverInteractiveElements`, the
`credentialsFor` demo-registry stub, a backward-compat alias layer in `hybridDiscovery.ts`, the
planner asking the model for two fields it immediately overwrites, `findAuthBoundary` — superseded
by `lastFillIndexByKind`, never called).

## 16. Second audit prompted by a real user-reported bug, and closing the entry-URL security hole

User report: "if i provide two emails and passwords then only the last one is considered." Root
cause reproduced directly against the exact failing prompt: `extractCredentialsFromPrompt`'s
value-extraction regex tried a quoted-value pattern before a bare-value one, so a prompt whose real
login email appeared unquoted early and an unrelated email appeared quoted later matched the
*decoy* — the quoted pattern skipped straight past the real, unquoted credential. Fixed by merging
both patterns into one regex with a quoted/bare alternation, so a single match always finds the
true leftmost occurrence regardless of which mention happens to be quoted.

That fix prompted a second, broader read-only audit (two parallel sweeps: orchestration/server
layer, and other instances of the same "sequential-pattern-match" failure shape + a frontend pass).
Ten new findings recorded as `TECH_DEBT.md` Part D, every one independently re-verified against the
actual code (and for the regex-shaped ones, by direct reproduction) before being written down —
not relayed from the audit agents unchecked. Highest-severity, closed same day: `POST /api/runs`
accepted any URL that didn't fail `new URL()` — which a `file://` path satisfies (`new
URL("file:///...").origin` doesn't throw) — so a crafted request could make the server read a
local file or reach an internal-network address (`169.254.169.254`, `127.x.x.x`, `localhost`),
with the result landing in a run directory served with no authentication. Fixed with a shared
`isAllowedEntryUrl`/`isPrivateOrLoopbackHost` (`hybridDiscovery.ts`), enforced at the API boundary
and again inside discovery. Caught and fixed in a follow-up pass the same day: the first version of
the private-host check only blocked the exact string `127.0.0.1`, not the whole `127.0.0.0/8`
loopback range, and compared against `"::1"` when Node's `URL.hostname` actually returns `"[::1]"`
for IPv6 — both reproduced directly, both closed. The other nine findings (D2–D9, plus one folded
into the already-open locator-duplication gap) are documented, not yet fixed.

## 17. Docker/Render deployment support, and a live lesson in dependency pinning

Added `Dockerfile` (`mcr.microsoft.com/playwright:v1.49.0-jammy` base), `.dockerignore`, and
`render.yaml` (a Render Blueprint) for a one-command container build / one-click free-tier deploy.
Caught and fixed before it shipped: `package.json`'s `serve`/`generate` scripts used
`--env-file=.env`, which throws if the file doesn't exist — fine locally, fatal in a container,
since `.dockerignore` correctly excludes `.env` and Render injects secrets as real process env vars
instead. Switched to `--env-file-if-exists=.env` (verified the distinction directly: `--env-file`
exits non-zero on a missing file, `--env-file-if-exists` continues). Playwright's npm package was
pinned to an exact version (`1.49.0`, no `^`) matching the base image's bundled Chromium build —
a caret range lets `npm install` resolve a newer Playwright than the image's pre-installed browser,
which then fails to launch (`browserType.launch: Executable doesn't exist`).

That last point became a real, lengthy debugging episode: `package.json` acquired **uncommitted
local edits** (likely manual, while trying different things) that silently reverted three fixes at
once — the `--env-file-if-exists` change, the exact version pins (back to `^1.49.0`), and deleted
the `postinstall: "playwright install chromium"` script entirely. With the pin gone, `npm install`
resolved a much newer Playwright wanting a completely different Chromium build than the one already
cached — and because a separate `npm run serve` kept getting restarted independently while browser
installs were in progress, two different dependency states ended up racing to install two different
browser builds into the same shared global cache, each one's "prune what's unused" step deleting
the other's in-progress download. What looked like a flaky/hanging installer was actually two valid
processes working correctly against two different, silently-diverged sources of truth. Fixed by
restoring `package.json`'s committed (correct) state rather than continuing to chase the symptom.
**Lesson for next time this shape recurs:** if a dependency install keeps alternating between two
different target versions/builds across repeated attempts, check for a second process (or
uncommitted local edit) working from a different `package.json` state before assuming the installer
itself is broken.

Also added this session: `GET /api/health` (reports which critical env vars are set — name and
length only, never the value — for confirming a deploy's secrets actually landed); `poolFromEnv`
accepts a singular `_KEY` env var as a fallback when the plural `_KEYS` var isn't set, for a
single-key deploy. And a live lesson in not trusting a model name from memory: an earlier pass in
this session "fixed" the Gemini model config by reverting it to `gemini-1.5-flash`, assuming it was
the safe/known-good choice — verified empirically against the real API afterward and found that
model now 404s ("not found for API version v1beta"), while `gemini-3-flash-preview` and
`gemini-3.1-flash-lite` (what the config had been reverted *away* from) both return 200. Restored.
Model names are worth a real API call to confirm, not an assumption from training data.

---

# Session — 2026-08-12 → 13

## 18. Groq cost drain: root-caused and fixed

Investigated why Groq credits were draining unexpectedly. Four compounding causes, all fixed:
`GROQ_MODEL` was `llama-3.3-70b-versatile` (deprecated 2026-06-17, shutdown 2026-08-16) — migrated
to `openai/gpt-oss-120b`, Groq's own recommended replacement and cheaper on both input and output;
added `reasoning_effort: "low"` for GPT-OSS models; capped `callWithPool`'s retries at 2; made
`MAX_IR_ATTEMPTS` env-configurable (was a hardcoded 8, which stacked with per-call retries to make
one case's worst case 48 real requests); and added `GroqBudget` — a per-run hard ceiling
(`MAX_GROQ_CALLS_PER_RUN`, default 60) threaded explicitly through `toIR`/`runSuite` rather than
kept as a module singleton, since `MAX_CONCURRENT_RUNS` shares one process across runs. Real usage
is now recorded to `runs/<id>/08-groq-usage.json` and reported on both the success and error paths.

Verified in production: the next real run used exactly 9 Groq calls / 23,579 tokens, matching the
expected `1 (primary) + 2 + 2 + 4` per-case breakdown.

One process note worth keeping: a general-prompt `WebFetch` of Groq's deprecation page reported the
model as *not* deprecated, contradicting `WebSearch`. Re-fetching with a precise extraction prompt
("list every row in the deprecation table verbatim") produced the real table and resolved it. A
planning agent also proposed `gpt-oss-20b` as the replacement, conflating it with a different
model's deprecation row — caught by checking Groq's actual pricing/deprecation pages rather than
trusting the recommendation.

## 19. Two bugs found by analyzing the last three runs

- **A pipeline could hang forever.** One run stopped dead at `"stage":"ir","status":"started"` with
  zero further events for 50+ minutes. Both LLM clients called `fetch()` with no timeout, and
  `callWithPool`'s retry logic only reacts to a promise that *settles* — a hung fetch never
  triggers a retry, a budget check, or anything else. `callWithPool` now races every attempt
  against an `AbortController` (`LLM_TIMEOUT_MS`, default 45 s), classifying a timeout as
  retryable the same way a network error already was. The signal is a locally-owned `timedOut`
  flag, not `err.name` sniffing — an aborted fetch surfaces as `TypeError: terminated` rather than
  a clean `AbortError` if the abort lands mid-body-read.
- **IR grounding validated against the whole app model, not the current page.** New `trackPages()`
  walks the IR once and tracks which discovered page the flow is actually on, using `navigate`
  steps and resolved `domLinks[].href` from clicked links. `groundingError` now scopes to that
  page, and a new `urlAssertionError` catches a hallucinated `url_contains` value (a run asserted
  `/signup` after clicking a link whose real destination was `/register`). Both fall back to
  today's behavior whenever the cursor can't be confidently resolved, so no new false negatives.

## 20. The three reported problems, and a documentation restructure

Investigated three user-reported limitations. **Security-example leakage** was already fixed
(`CategoryId`/`scope` taxonomy + `classifyScope`/`filterByScope`). **`AppModel` context explosion**
was fixed here (`fb2ea96`): `capElements()`/`capNavTree()` bound every previously-unbounded per-page
array, with seven `MAX_LITE_*` env knobs defaulted above every page size in this project's own
sampled runs.

**Dynamic modal forms** was diagnosed but deliberately left unfixed. The mechanism is now pinned:
`extendAppModel` is reactive-on-miss only, and a hallucinated field name that coincidentally matches
real page chrome makes grounding *falsely succeed*, so the capture never runs. Proven by a same-run
A/B pair — one case guessed a name that missed and got the modal discovered correctly; its sibling
guessed a name that collided with the header search box and shipped a broken test. A candidate fix
was designed and its trigger validated by scanning all 43 IRs on disk (13 fire, all genuine
post-click-revealed forms, zero logins), but not implemented: validating its cost profile needs a
live run, and two of my own first instincts about it were measurably wrong (see
`PROBLEM_ANALYSIS.md` §5).

Also fixed here: the compound-login case shape, closed by avoidance rather than by solving the
underlying limitation — `testCases.ts` now forbids it and `dropCompoundLoginCases` enforces that
deterministically, splitting the two legs into separate cases with separate sessions (`c456de9`).
Same commit closed `TECH_DEBT.md` D3 (the credential-veto regex bridging unrelated fields).

**Documentation restructure.** "What is broken" had been duplicated across six documents, which is
why they drifted — `c456de9` fixed the compound-login bug and touched zero `.md` files, leaving all
six describing it as open. Each document now has one job, `PROBLEM_ANALYSIS.md` is the single owner
of open-issue status, and the other five link to it instead of restating. Corrected along the way:
a README section instructing readers to `docker build` files deleted in `fbf44c0`, a fixed
limitation still listed as open, and a stale test-count baseline (253/24 → 274/26).

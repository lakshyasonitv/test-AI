# Session Summary

What happened in this working session, in chronological order. For current project state see
[PROJECT_SUMMARY.md](PROJECT_SUMMARY.md); for full technical detail see
[ARCHITECTURE.md](ARCHITECTURE.md).

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

## What's still open

Carried over, unaddressed (see `ARCHITECTURE.md`'s Current Gaps table for the full list with
impact/status):
- Compound-login-case credential handling (§1) — still the largest known correctness gap
- Case-generation reword drift: the LLM paraphrases the user's literal instructions ("click on
  Admin" → "Navigate to the Admin section", explicit waits dropped) before any deterministic
  stage sees them. Contained downstream now, not fixed at the source
- No server authentication
- Failure-diagnosis step attribution can point at the wrong step
- No end-to-end self-heal test against a real drifted site
- Visibility for elements with no stable selector still falls back to an assumed `visible: true`

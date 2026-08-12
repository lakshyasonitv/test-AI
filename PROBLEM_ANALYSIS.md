# Three reported limitations — analysis, methodology, and status

This document covers the three problems reported against the pipeline, in the order they were
raised:

1. Dynamic in-page modal forms (e.g. "Raise a Ticket") don't get filled
2. Hardcoded security examples leak into purely-functional test prompts
3. `AppModel` context explosion (17,000+ line JSON) on complex sites

**Status up front, so nothing below is ambiguous:**

| # | Problem | Status |
|---|---|---|
| 1 | Modal forms | ⬜ **Diagnosed only.** Mechanism pinned and reproduced against a real run. No code fix has been written or landed. |
| 2 | Security leakage | ✅ **Fixed, already committed** (predates this session — verified still in place). |
| 3 | Context explosion | ✅ **Fixed, committed this session** (commit `fb2ea96`). |

Everything past this point is the evidence and reasoning behind those three lines — read as much
or as little as you need.

---

## Methodology

Every claim below traces to one of three kinds of evidence, and each finding says which:

- **Static code reading** — the function that runs, read directly, not inferred from naming or
  comments.
- **Real run artifacts** — this project writes every pipeline stage's output to
  `runs/<run-id>/*.json` and `events.ndjson`. Where a claim says "confirmed against run `X`," the
  actual JSON produced by a real execution was inspected, not a hypothesis about what it might
  contain.
- **Reproduction** — for Problem 1, the exact matching logic that produced the wrong result was
  re-run by hand against the real data to confirm the failure, not just theorized.

No code was changed for Problem 1 in this pass — the investigation deliberately stopped at
"pinned and reproduced" rather than shipping an unvalidated fix. Why, below.

---

## Problem 1 — Dynamic in-page modal forms not filled

### The report

Screenshot: an app's "Raise a Ticket" modal, with Title/Description/Department fields, opened by
clicking a button — no URL change. The pipeline was asked to "fill title with test" and could not.

### Finding the real run

Six real runs against `https://assettrack-web.onrender.com` (an asset-tracking app with exactly
this ticketing flow) exist under `runs/`, all using prompts like *"login in to this website and
click on Tickets button on the sidepanel then click on Raise Tickets button then test the
form."* The most recent, `2026-08-10T11-15-46-262Z-1279794e`, is the evidence trail below.

### What actually happened, step by step

`04-ir.json` for that run — the IR the pipeline generated and considered fully grounded
(`hasTerminalAssertion: true`, no `truncated` flag):

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

s10 and s11 are supposed to be the modal's Title/Description fields. They aren't. Running the
actual Playwright spec confirms it's not just mislabeled — it's a materially different action:
`05-result.json` shows the test hanging on `Click 'open'` for 32.8 seconds before the browser
context died and Playwright reported a 50-second timeout. `06-diagnosis.json` reads: *"failed due
to the browser context being closed, which typically happens when an action triggers a page
reload, navigation, or a sudden crash."*

### Why grounding accepted a step that was obviously wrong

`groundingError()` (`src/stages/ir.ts`) validates each step's `{role, name}` target against the
known `AppModel` — if nothing matches, the step is rejected and the model gets a correction. It
does **not** check whether the matched element is *semantically appropriate* for what the step
claims to do. It only asks "does an element with this role and this name exist."

Dumping the `/tickets` page from the same IR's `updatedAppModel`:

```python
{'role': 'textbox', 'name': 'Search assets by serial or name...', 'id': 'textbox_6', ...}
{'role': 'button',  'name': 'open', 'id': ..., 'order': 26}
```

Both exist, for real, on the `/tickets` page — as pre-existing page chrome. The first is the
global header's asset-search box (present on every authenticated page in this app). The second is
a status badge/button on an *already-existing* support ticket in the tickets list ("Need audio
and headset" / "I need audio and headset for my meetings" / **"open"**). Neither has anything to
do with the "Raise Ticket" modal.

The LLM, asked to "fill Title" and "test the form" for a modal it never saw the real fields of,
produced plausible-sounding but invented target names. By coincidence, both invented names
happened to exactly match real elements elsewhere on the same page. `groundingError` doesn't know
the difference between "the right element" and "an element that happens to share this name" — it
matched, declared the step grounded, and moved on.

### Why the safety net that exists for exactly this case never fired

`liveExtend.ts`'s `extendAppModel()` is the pipeline's actual mechanism for discovering content
that only exists after an interaction (a modal, a page reached after login, etc.) — it launches a
real browser, replays the step prefix, and re-snapshots whatever state that produces, including a
vision-model fallback specifically for a dialog whose fields aren't real semantic HTML
(`liveExtend.ts` lines ~119–203, with a comment citing this exact "modal fields absent" failure
mode from an earlier real bug).

But `extendAppModel` is called from exactly one place in `src/stages/ir.ts`, and only inside this
condition:

```ts
while (ungrounded && extensions < MAX_EXTENSIONS) {
  ...
  currentModel = await extendAppModel(currentModel, prefix, creds, credPolicy);
  ...
  ungrounded = groundingError(parsed.data, currentModel);
}
```

It is **reactive-on-miss only.** It runs when `groundingError` finds *nothing* matching — never
when `groundingError` finds something, even if that something is wrong. Since s10 and s11 both
grounded successfully (against the wrong elements), `ungrounded` was `null` for both, the `while`
loop never entered for that part of the flow, and `extendAppModel` was never invoked to actually
open the modal and see what's really inside it.

This is not a budget problem: the run's extension counter shows exactly 2 of the available 5
extensions were used (`MAX_LIVE_EXTENSIONS` default) — spent reaching `/` and `/tickets` after the
login wall, both genuine grounding misses in the initial one-page (`/login`-only) discovery
snapshot (`02-appmodel.json` confirms discovery could only crawl the login page pre-auth). Three
extension slots sat unused. The mechanism works — it simply was never asked to run for the one
step that actually needed it.

### The second, compounding gap

Even when `extendAppModel` *does* successfully capture a modal (as it demonstrably can — the
vision-fallback merge code exists and is exercised by `tests/liveExtend.test.ts`), the resulting
elements are merged into the page's element list with no marker distinguishing "only present while
a dialog is open" from "always-present chrome." `src/schema/appModel.ts`'s `Element` schema
already has fields built for exactly this distinction:

```ts
containerRole: z.string().optional(),
containerName: z.string().optional(),
pageSection: z.string().optional(), // "main", "nav", "header", "footer", "dialog"
```

`pageSection` even names `"dialog"` as a literal value in its own comment. But grepping
`src/stages/domDiscovery.ts` — the live-page extraction path `liveExtend.ts` actually calls via
`extractDomModelFromPage` — for any of these three field names returns **zero matches**. They are
never populated. The schema was built with modal-awareness in mind; the extraction code that would
fill it in was not written. So even a correctly-captured modal's fields are indistinguishable from
the rest of the page once merged, which would limit any future fix that tries to use them.

### Why no fix shipped in this pass

The natural-looking fix — "after any button click, proactively re-snapshot the page before
trusting existing grounding" — was considered and rejected for a concrete reason: this project's
most common step shape is `fill → fill → click "Sign In" (a button, not a link)`, i.e. every login
in the whole system. `trackPages()` (added earlier in this project to scope grounding to the
current page) can tell when a `navigate` step or a resolvable link click changes pages, but it has
no way to know whether an arbitrary **button** click caused a navigation, opened a modal, or did
nothing — that information doesn't exist in the `AppModel` today. A heuristic that can't
distinguish those three cases would add a real Chromium launch to the single most common step
shape in the project, for a cost/accuracy tradeoff that hasn't been validated against a live run.

Landing a fix that changes runtime cost and behavior without running it against the real
`assettrack-web.onrender.com` case first would mean shipping something *unverified* into a
pipeline whose whole opening complaint this project session was **unexpected API cost** — trading
one silent cost problem for another isn't a fix. That live run needs real Groq + Gemini calls plus
a genuine browser session against the target site, i.e. real spend, so it's called out here rather
than run unilaterally.

### What an actual fix needs to do, for whoever picks this up

1. Give `groundingError`/`toIR` a way to treat "matched, but suspiciously" as equivalent to "not
   matched" for a bounded, specific pattern — e.g., a fill/click step immediately following a
   non-navigating **button** click, where the matched element already existed *before* that
   click (i.e., in a snapshot taken prior to the click). That specific shape is what happened here
   and is comparatively rare outside dialog-opening interactions.
2. Populate `pageSection`/`containerRole`/`containerName` in `domDiscovery.ts`, tagging elements
   found inside `[role="dialog"]`/`[aria-modal="true"]` ancestors as `pageSection: "dialog"`. This
   makes a captured modal's fields identifiable after the fact, not just during capture.
3. Validate end-to-end against `assettrack-web.onrender.com`'s real ticketing flow — the exact
   reproduction case above — before considering it done. A change that isn't run against the case
   that motivated it isn't verified.

---

## Problem 2 — Hardcoded security examples leaking into functional prompts

### The report

`src/kb/testStrategy.ts` (lines 70 and 83) hardcodes security-flavored checklist entries — a SQL
injection case under "login," an XSS/special-characters case under "search." These were reported
as leaking into runs where the user asked for purely functional coverage.

### What the code actually does today

This one is fixed, and was fixed before this session started — verified by `git diff` returning
nothing for `src/kb/testStrategy.ts` (it matches `HEAD` exactly, i.e. whatever fixed it is already
committed to this branch's history).

The two security rows are still in the table — correctly, they're real QA checklist entries a
human tester would include when security scope is in play. What changed is that they're no longer
unconditionally injected into every prompt's context:

1. Every checklist entry now carries a `scope: "functional" | "security"` field
   (`testStrategy.ts`), computed from a closed `CategoryId` taxonomy — `security-injection` and
   `security-xss` are the only two categories that resolve to `"security"` scope; everything else
   resolves to `"functional"`.
2. `classifyScope(prompt)` reads the user's own prompt with stem-matched keyword regexes
   (`\bsecurit`, `\binject`, `\bxss\b`, `\bvulnerab`, `\bexploit`, `\bpenetrat` for security intent
   vs. `\bfunctional`, `does .+ work`, `\bsmoke\b`, `\bhappy path` for functional intent) and
   returns which scope(s) the user actually wants. No signal either way returns both scopes — full
   taxonomy, not filtered — matching today's behavior for an unopinionated prompt.
3. `filterByScope(cases, scope)`, wired into `testCases.ts`'s generation pipeline, drops any
   generated case whose category resolves to a scope the user didn't ask for. The one exception:
   the case tagged `fromPrompt: true` (the literal translation of what the user typed) is always
   kept — if a user explicitly asks for a security case, filtering it back out would be wrong.

So a prompt like "Verify homepage navigation and header links" now classifies as
`["functional"]`, and any SQL-injection/XSS case the model generates anyway (the checklist rows
are still visible to it as *available* categories) gets filtered out before the case list is
returned — never reaching the run.

### Verification

- `git diff src/kb/testStrategy.ts` → empty (already on `HEAD`).
- Existing test coverage: `tests/strategy.test.ts` (referenced directly in
  `testStrategy.ts`'s own trailing comment).

Nothing further needed here — this is closed.

---

## Problem 3 — `AppModel` context explosion on complex sites

### The report

On a rich application (large data tables, deep nested menus, hundreds of DOM nodes), the generated
`AppModel` JSON can reach 17,000+ lines. Passing that whole payload to `testCases.ts`/`ir.ts`'s LLM
calls trips a `413 Payload Too Large` / context-limit error.

### Root cause

`toLiteModel()` (`src/schema/appModel.ts`) is what strips a full `AppModel` down to the compact
form actually sent to the LLM — it already dropped most per-element detail (role/name/concept
only), but it kept every page's **entire** `forms`, `navigation`, `buttons`, `headings`, and
`breadcrumbs` arrays, for every crawled page, with no upper bound. A page with a 200-row data table
or a mega-menu with hundreds of nodes contributed all of it, and there was nothing to stop a
sufficiently rich site from producing a payload the LLM's API would flatly reject.

### The fix (this session, commit `fb2ea96`)

Every one of those unbounded arrays now has a cap, all read from env vars per-call (not cached at
module load, so tests can override them without `vi.resetModules()`):

| Cap | Env var | Default | What it protects |
|---|---|---|---|
| Elements/page | `MAX_LITE_ELEMENTS_PER_PAGE` | 150 | Total elements kept per page |
| Forms/page | `MAX_LITE_FORMS_PER_PAGE` | 5 | `<form>`s kept per page |
| Fields/form | `MAX_LITE_FORM_FIELDS` | 20 | Fields kept per form |
| Nav nodes/page | `MAX_LITE_NAV_NODES_PER_PAGE` | 60 | Total nav-tree nodes, all levels combined |
| Nav depth | `MAX_LITE_NAV_DEPTH` | 3 | Nav-tree levels kept before pruning to a leaf |
| Buttons/page | `MAX_LITE_BUTTONS_PER_PAGE` | 40 | Buttons kept per page |
| Headings/page | `MAX_LITE_HEADINGS_PER_PAGE` | 40 | Headings kept per page |

Two design choices worth calling out:

- **`capElements()` is priority-aware, not a blind slice.** It keeps every *named, interactive-role*
  element first (link/button/textbox/checkbox/etc. with a real accessible name), and only fills
  whatever budget remains with anonymous/positional elements. A naive `.slice(0, 150)` risks
  silently dropping the one login form or search box a test case actually needs, if a large table
  happens to sit above it in raw DOM order.
- **`capNavTree()` caps breadth and depth together, off one shared budget.** A per-level breadth
  cap alone doesn't bound a tree that's both wide *and* deep — capping each level to, say, 20 nodes
  still allows exponential blowup three levels down. Threading one shared `{ remaining }` counter
  through the recursive walk means the total node count across the whole tree is bounded,
  regardless of its shape.

Defaults were set above the largest values actually observed across this project's own sampled
runs (max 87 elements/page, 2 forms/page, 9 fields/form, 18 nav nodes, 3 buttons/page, 28
headings/page) — so an ordinary site's `AppModel` is untouched; the caps only engage on a
genuinely richer one.

### Verification

- `tests/appModel.test.ts` (`describe("toLiteModel — caps")`) — new, covers each cap independently
  and the "named elements survive over anonymous ones" priority rule.
- `npx tsc --noEmit` — clean.
- `npx vitest run` — full suite passing (274/274 across 26 files, including the new tests).
- Landed in commit `fb2ea96`; `.env.example` and `ARCHITECTURE.md`/`PROJECT_SUMMARY.md` updated
  alongside it.

---

## Summary table

| # | Problem | Root cause | Fix | Verified how |
|---|---|---|---|---|
| 1 | Modal forms not filled | `extendAppModel` only triggers on a grounding **miss**; a hallucinated field name that coincidentally matches a real chrome element elsewhere on the page makes grounding falsely succeed, so the modal is never (re-)discovered. Compounded by `pageSection`/`containerRole` existing in the schema but never being populated. | **Not implemented.** Diagnosed and reproduced against real run `2026-08-10T11-15-46-262Z-1279794e`. | Static reading of `ir.ts`/`liveExtend.ts`/`domDiscovery.ts` + real run artifact inspection + hand-reproduction of the exact match |
| 2 | Security cases in functional runs | Checklist table mixed functional and security entries with no way to filter by requested scope. | `CategoryId`/`scope` taxonomy + `classifyScope()` + `filterByScope()`, already on `HEAD`. | `git diff` (empty) + existing `tests/strategy.test.ts` |
| 3 | AppModel context explosion | `toLiteModel()` had no size ceiling on per-page forms/nav/buttons/headings. | `capElements()`/`capNavTree()` + per-page slicing, all env-configurable. | New `tests/appModel.test.ts`, `tsc --noEmit`, full `vitest run` (274/274), commit `fb2ea96` |

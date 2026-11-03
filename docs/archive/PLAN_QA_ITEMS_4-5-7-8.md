# Remediation plan — QA items 7, 4, 5, 8

**Status:** proposed, not started. **Written:** 2026-09-25. **Author:** drafted by an agent session,
for human approval before any code lands.

**What this doc owns:** the *plan* for four specific QA items — sequence, justification, blast
radius, verification, rollback, timeline. It is a plan, not a topic owner, and it is disposable.
`ARCHITECTURE.md` owns the file map and schema, `DECISIONS.md` owns why a choice was made,
`TECH_DEBT.md` owns what is broken, `docs/phases/` owns what a shipped phase changed. Where this
doc and those disagree, **they win**.

**On landing:** each item's defect moves to `TECH_DEBT.md` (next free IDs are **TD-95** onward), each
non-obvious choice to `DECISIONS.md` (next free is **D-33**), and the shipped work to a
`docs/phases/` report. Then **delete this file.** It must not become a sixth what's-broken list —
that is the duplication `DECISIONS.md` D-01 exists to prevent, and `CLAUDE.md` forbids it outright.

---

## 0. Read this first — the two constraints that shape everything below

### 0.1 "No other functionality changes without a good, hard reason"

Taken literally and enforced per item. Every change below is classified:

| Class | Meaning | Approval needed |
|---|---|---|
| **A — additive** | New optional field, new env var, new helper. All existing paths byte-identical when the new input is absent. | None beyond this plan |
| **B — behaviour change, default-on** | Existing behaviour genuinely changes with no opt-in. | Explicit sign-off, with the reason recorded in `DECISIONS.md` |
| **C — behaviour change, flag-gated** | New behaviour behind an env flag defaulting to OFF, per `CLAUDE.md` platform rule 2. | None |

Only **one** change in this plan is class B (item 7's locale default), and §1.5 argues the hard
reason. Everything else is A or C.

### 0.2 The repo's central design rule, and the trap it sets for items 4, 5 and 8

`CLAUDE.md`: *an LLM instruction is a preference, not a constraint* — every prompt-level rule needs
a deterministic check behind it. And the recorded failure mode: **a "deterministic" check written as
a regex over LLM-authored prose is not deterministic.** `missingActions` rejecting a correct IR
because a page heading contained the word "Click" is TD-01, still open as a class.

Items 4, 5 and 8 all invite exactly that mistake:

- Item 8's tempting fix is to keyword-match "voice search" or "settings" against the prompt. **Do
  not.** That is TD-01 with new words.
- Item 5's tempting fix is to detect "independent link check" from the step's English text. **Do
  not.**
- Item 4's tempting fix is to trust the model's own claim that a target is visible. **Do not.**

Every guard below checks **structure** — a schema field, a discovered element, a resolved locator,
a live DOM read — never prose. Where a plan step cannot be made structural, it is called out as an
open question rather than papered over.

### 0.3 A tracking gap worth fixing alongside this

The item numbers (1, 4, 5, 6, 7, 8, 20…) exist **only in git commit subjects**. No numbered list
lives in the repo — `grep` finds none, and `Observations.docx` is an unnumbered QA narrative, not
the register. `project-brain/`, which `CLAUDE.md:201` says holds the task list, has never been
committed (`git log --all -- '*project-brain*'` is empty).

So the authoritative statement of items 4/5/7/8 is the requester's message, reproduced verbatim in
each section below. **Recommendation:** commit the item register before starting, so the acceptance
criteria for this work are reviewable by someone other than its author. Cheap, and it removes the
need to trust a paraphrase.

---

## 1. Item 7 — pin locale, timezone and Accept-Language (DO THIS FIRST)

> *"Pin locale: 'en-US', timezone and Accept-Language on the Playwright context, and expose locale
> as a per-run setting — this is what produced the Korean test cases (item 7). Do this first; it's
> an afternoon's work and removes a whole class of nonsense output."*

### 1.1 Confirmed diagnosis

`grep -rni "locale|timezoneId|Accept-Language|extraHTTPHeaders" src/` returns **zero** browser
configuration hits — every match is `toLocaleString`/`localeCompare` on unrelated code paths. No
browser this project opens pins locale. Five consumers, all unpinned:

| # | Site | How the page is made | Can take context options today? |
|---|---|---|---|
| 1 | `src/stages/domDiscovery.ts:538` | `chromium.launch()` → `browser.newPage()` | yes, `newPage(opts)` |
| 2 | `src/stages/hybridDiscovery.ts:280` | `chromium.launch()` → `browser.newPage()` | yes |
| 3 | `src/stages/hybridDiscovery.ts:895` | `chromium.launch()` → `browser.newContext()` | yes, already a context |
| 4 | `src/stages/liveExtend.ts:169` | `chromium.launch()` → `browser.newPage()` | yes |
| 5 | `playwright.config.ts` `use:` | the generated spec's runner | yes, `use.locale` |

Every one inherits the **host's** locale. In a container, that is whatever the base image sets; on a
site that content-negotiates on `Accept-Language`, it is whatever Chromium happened to send.

**Why this produced Korean test cases — the causal chain, and why it is item 7 not a UI bug:**

1. Discovery (sites 1–3) loads the target with an unpinned `Accept-Language`.
2. The site serves Korean. Cheerio extracts Korean accessible names into `AppModel.pages[].elements`.
3. Gemini receives an AppModel full of Korean strings and writes Korean test cases. **It is behaving
   correctly** — it is describing the page it was shown.
4. Every downstream stage inherits the Korean: case titles, IR targets, generated locators.

So the poison enters at **discovery**, not at generation. A prompt telling Gemini "write in English"
would be a preference over a constraint — the exact anti-pattern §0.2 warns about — and would leave
the AppModel, the locators and the executed spec still Korean. **The fix must be at the browser, and
it must cover sites 1–3 or it does not work at all.** Site 5 matters for execution fidelity: a spec
generated against en-US must run against en-US or locators drift.

### 1.2 The change

**Class A for the plumbing, class B for the default value** (see §1.5).

1. **New helper in `src/browserLaunch.ts`** — the file that already exists to stop exactly this kind
   of five-way inconsistency, and whose header comment already enumerates the same five consumers:

   ```ts
   export function browserContextOptions(locale?: string):
     { locale: string; timezoneId: string; extraHTTPHeaders: Record<string, string> } | {}
   ```

   Resolution order: explicit per-run `locale` argument → `process.env.RUN_LOCALE` → `"en-US"`.
   Timezone from `RUN_TIMEZONE`, default `"UTC"`. `Accept-Language` derived from the resolved locale
   (`"en-US,en;q=0.9"`), not configured separately — two independent knobs that must agree are a
   misconfiguration waiting to happen, same reasoning as the existing helper's own docblock.
   `RUN_LOCALE=""` (explicit empty) returns `{}` — the exact pre-change behaviour, host-inherited.
   That is the rollback switch, and it is why this is safe to default on.

2. **Pass it at all five sites.** Sites 1, 2, 4: `browser.newPage()` → `browser.newPage(browserContextOptions(locale))`.
   Playwright's `browser.newPage(options)` accepts the full context option set, so **no context
   restructuring is needed.** This matters: converting these to `newContext()` + `context.newPage()`
   would walk straight into TD-41 / D-23 (`sessionStorage` is tab-scoped, a second page is logged
   out) — `CLAUDE.md` calls this out explicitly. Site 3 already has `newContext()`; pass the options
   in. Site 5: add `locale`, `timezoneId`, `extraHTTPHeaders` to the `use:` block.

3. **Per-run setting, additive.** `src/server/index.ts:242` already forwards run options through an
   explicit allow-list — *"Only the two known booleans are forwarded — the body is untrusted
   input"*. Add a third entry, validated as a string against a small allow-list of BCP-47 tags
   rather than passed through raw. This satisfies platform rule 1 (an existing route may gain
   **optional** fields only): `POST /api/runs` keeps its shape, `options` gains an optional key, and
   a client that never sends it is unaffected. `public/app.js:5119` ("Run options — the Settings
   popover") is where the control goes; `app.js:3174` documents the body shape and its comment must
   be updated in the same commit.

4. **Thread `locale` from run options to the three discovery/liveExtend call sites.** This is the
   only non-trivial plumbing — it crosses the pipeline boundary. Budget most of the item's time here.

5. **Document in `.env.example`** alongside the existing `MAX_*` block (lines 82–134 establish the
   comment style).

### 1.3 Effect on the project

| Area | Effect |
|---|---|
| Discovery output | AppModel element names become stable across machines and containers. **This is the point.** |
| LLM cache | **Breaking, and must be handled.** `RUN_LOCALE` is a new real input dimension. `CLAUDE.md`: *"Cache keys must include every real input dimension. The LLM disk cache never expires; a key missing a dimension serves a wrong answer forever"* — TD-22, D-10, and TD-94 is the same bug having already shipped once. **Add locale to the cache key in the same commit.** Not a follow-up. If this is missed, every existing cached Korean answer is served forever and the fix appears not to work. |
| Existing `runs/` artifacts | Untouched. Replay of a saved AppModel is unaffected. |
| Generated specs | Gain locale in config, so a spec re-run later reproduces its original conditions. |
| Test suite | Additive tests only. `tests/browserLaunch.test.ts` already asserts the five-consumer contract and is the natural place to extend. |
| CI / deploy | None. No new dependency. |

### 1.4 Pros and cons

**Pros.** Removes a whole class of nonsense output at its source, not downstream. Makes runs
reproducible across dev/CI/container, which is a precondition for trusting any other fix in this
plan. Cheap and localised — one new helper, five one-line call sites, one allow-list entry.
Reversible by one env var. Fixes the executed spec too, not just the visible symptom.

**Cons.** A site that legitimately serves a non-English locale now needs the per-run setting set
explicitly; previously it "worked" by accident on a host with a matching locale. Invalidates cached
LLM answers, so the next run after deploy is slower and costs tokens. `timezoneId: "UTC"` will
change any date the target site renders — a test asserting a rendered date may need its expectation
regenerated. **Flag this to QA before deploy**; it is the one place this change can break a
currently-passing test.

### 1.5 The hard reason this defaults ON, against platform rule 2

Platform rule 2 says every new capability ships behind a flag defaulting to OFF, and flag-off must
mean identical prior behaviour. **This change should still default to `en-US`.** The reason:

Rule 2 protects a *known, intended* baseline. The current behaviour is not one — it is
**host-dependent and non-deterministic**, producing different AppModels on the same site from
different machines. There is no baseline to preserve; there is only an unspecified variable. A flag
defaulting to OFF would mean the documented default of this tool is "inherit an arbitrary locale and
sometimes emit Korean test cases", which is not a behaviour anyone chose.

Rule 2's *intent* — reversibility, and no surprise — is met by `RUN_LOCALE=""` restoring the old
path exactly, and by the per-run override. This is the rule-7 pattern (`AUTH_ENABLED=false`
substitutes a synthetic owner rather than skipping the checks): the code path is the same in both
modes, only the value differs. **Record this as `DECISIONS.md` D-33** — it is a deliberate, narrow
exception and must not become licence to default other capabilities on.

### 1.6 Verification — must include a real browser

`CLAUDE.md` D-19 is explicit: a generated Playwright expression that looks right is not verified
until it is run once. `.filter({ visible: true })` passed `tsc` and a unit test and was a silent
no-op. `browser.newPage(options)` and `use.locale` are exactly that class of API-surface claim.

1. `npx tsc --noEmit` clean.
2. `npx vitest run` — **record the pass count before starting.** Do not trust the 1456 figure in the
   commit log for `3a9c41c`; `CLAUDE.md` says never treat a number in these docs as current.
3. Unit: `browserContextOptions()` returns `{}` for `RUN_LOCALE=""`, `en-US` by default, honours the
   per-run argument over the env var.
4. **Real-browser check, mandatory.** Serve synthetic HTML locally that echoes
   `navigator.language`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, and the request's
   `Accept-Language` header. Assert all three through a real `chromium.launch()` + `newPage(opts)`.
   No live target site, no Gemini, no cost. `tests/safeClickBrowser.test.ts` (landed in `b5c5cc5`)
   is the existing precedent for a real-browser test in this suite — copy its shape.
5. Route: `POST /api/runs` with no `options.locale` behaves exactly as before; with an invalid value,
   rejected by the allow-list, not forwarded.
6. **One live end-to-end run against the site that produced the Korean output.** This costs Gemini
   tokens and real browser time — say so before running it. Confirm English in
   `runs/<id>/02-appmodel.json` **and** `03-cases*`.
7. **Before judging step 6, confirm the server process started after the edit.** `npm run serve` has
   no watch; a TD-02 fix was once "verified" against a server that predated it by an hour.

### 1.7 Rollback

`RUN_LOCALE=""` in the environment, no redeploy of code. If the cache-key change needs undoing too,
revert the commit — it is self-contained.

### 1.8 Estimate

**0.5 day (one afternoon)** — matches the requester's estimate. Helper 30 min; five call sites 30 min;
threading run options through the pipeline 1–2 h (the real cost); cache key 30 min; UI control 45 min;
real-browser test 1 h. Live confirmation next day.

---

## 2. Item 4 — re-check visibility before an element may become an assertion

> *"Re-check discovered elements for visibility before they're allowed to become assertions
> (item 4)."*

### 2.1 What exists, and what the gap actually is

More is in place than the item implies, which **reduces** scope:

- `AppModel.Element.visible` exists — `src/schema/appModel.ts:22` (optional) and `:130` (defaults
  **true**).
- `isHiddenInput` (`:343`) and `isUsableElement` (`:348`) are shared helpers, and `ir.ts:1444-1450`
  already filters the prompt projection through `isUsableElement` — with a comment saying it lives
  in `appModel.ts` *"so this filter and the projection cannot disagree"*.
- TD-34 (a `visible` assertion resolving to a hidden same-named candidate) is recorded **Fixed**.
- TD-13 remains open: *visibility accuracy only guaranteed for selector-bearing elements*.

So the gap is not "visibility is unknown". It is that **`visible` is a crawl-time snapshot treated as
a current fact**, and it defaults to `true` when absent. Two distinct failure modes:

- **Staleness.** Discovery saw the element visible; by the time the assertion runs — behind a
  collapsed menu, after a route change, post-hydration — it is not. The assertion fails and looks
  like a product bug.
- **Default-true.** An element whose visibility was never determined (TD-13's non-selector-bearing
  case) is indistinguishable from one confirmed visible. A `visible` assertion on it is a guess.

### 2.2 The change

**Class C — flag-gated, default OFF.** This one genuinely can regress a passing suite, so it earns a
flag: `ASSERT_VISIBILITY_RECHECK` (default off).

Two layers, cheapest first:

1. **Structural, free, do this regardless.** Distinguish "confirmed visible" from "unknown" instead
   of collapsing both to `true`. Grounding for an `assert` step whose assertion is visibility-shaped
   requires **confirmed** visibility; unknown is a `groundingError()`, which the existing machinery
   already handles by regenerating the IR. `groundingError()` at `src/stages/ir.ts:446` is the
   reference verifier the project's own design rule points at, and this is one more target kind
   getting its own check — exactly the pattern D-02/D-03 describe. **Schema first:** `CLAUDE.md`
   says extend the Zod contract before behaviour depending on a new field, so a tri-state
   (`true` / `false` / absent-means-unknown, read through a helper, never inline) lands in
   `appModel.ts` before `ir.ts` reads it.

2. **Live re-check, flag-gated.** For an assertion target that survives layer 1, confirm visibility
   against the **live** page before the assertion is allowed into the final IR. `liveExtend.ts` is
   the existing precedent — it already replays a step prefix in a real browser and is already
   auth-aware and credential-aware. Reuse it; do not write a second live-replay path.

**Two hard constraints on the implementation:**

- **Cost.** A live re-check per assertion costs a browser replay. `MAX_LIVE_EXTENSIONS` (default 5)
  already exists to bound exactly this. Re-checks must draw from a bounded budget and degrade to
  layer 1 when exhausted — never unbounded. TD-36 is the recorded precedent: an unbounded ladder in
  `safeClick` reached ~113 s and blew the executor's kill timer.
- **No `page.evaluate` helper functions.** Any new evaluate callback must inline everything, no
  inner named or `const`-assigned functions — `tsx`/esbuild injects a `__name()` wrapper that does
  not exist in the browser. This passes every unit test and throws only on a real `npm run serve`
  run (TD-40). Duplicate code across branches and comment why.

### 2.3 Effect, pros and cons

**Effect.** Some assertions that previously shipped and failed at execution now cause an IR
regeneration instead — the run costs more LLM attempts but produces a suite that passes for real.
Layer 1 alone may increase `groundingError()` rejections; watch `MAX_IR_ATTEMPTS` (default 4) for
runs that now exhaust it. **This is the main risk of item 4** and the reason for the flag.

**Pros.** Removes a class of false failures that currently read as product bugs. Narrows TD-13.
Reuses `groundingError()` and `liveExtend` rather than adding a path. Layer 1 is free at runtime.

**Cons.** Layer 2 costs real browser time per case. Risk of over-rejection — a correct assertion
refused because visibility could not be *confirmed*, which is a new way to fail. Touches `ir.ts`,
the most load-bearing and most-regressed file in the repo.

### 2.4 Verification

`tsc`; full suite against the recorded baseline; **artifact replay against saved
`runs/<id>/04-ir.json` and `02-appmodel.json` before any live run** — `CLAUDE.md` says this is how
most `TECH_DEBT.md` findings were actually confirmed, and it is free. Specifically: find a saved run
whose assertion failed on a hidden element and prove layer 1 rejects it. Then a real-browser test
for layer 2 (synthetic HTML, element hidden after load). Then one live run with the flag on.

**Do not accept a green suite as proof.** `CLAUDE.md`: a coverage check confirming that *some* action
happened rather than the *right* one is TD-01's class. The test must assert the specific assertion
was rejected for the specific reason.

### 2.5 Estimate

**1.5–2 days.** Layer 1 with schema and tests, 0.5 day. Layer 2 with budget integration and a real
browser test, 1 day. Replay validation across saved runs, 0.5 day.

---

## 3. Item 5 — cap steps per case, and return to the start URL between independent checks

> *"Cap steps per case and require a return to the start URL between independent link checks, so a
> 17-step nav sweep can't be emitted (item 5)."*

### 3.1 Why this is the lowest-risk item

The machinery already exists. `src/schema/ir.ts:84-86` defines `meta.truncated` and
`hasTerminalAssertion`; `ir.ts:1967-1974` already builds a truncated IR from a step prefix and
records a `truncationNote`. There is **no** `MAX_STEPS_PER_CASE`, but `.env.example:82-134` is a
well-established `MAX_*` convention with a documented comment block, and `steps: z.array(Step).min(1)`
(`schema/ir.ts:105`) has no upper bound.

So the cap is a new env var plus a reuse of the existing truncation path. Little new code.

### 3.2 The change

**Cap — class C, flag-gated by being unset-means-unlimited.**

`MAX_STEPS_PER_CASE`, unset = no cap (today's behaviour exactly, so flag-off is genuinely
byte-identical). Set, an over-long IR is truncated through the **existing** path so it inherits
`meta.truncated`, `truncationNote` and the `hasTerminalAssertion` handling already built and tested.
A truncated-without-assertion result already cannot report "passed" — that guarantee comes free.
Suggested starting value **8**, from the requester's "17-step nav sweep" as the thing to prevent;
treat it as a number to tune against real runs, not a fact.

**Return-to-start — the part needing care.**

Enforce the *structural* form, not the English. A step's `target` and the IR's `navigate` steps are
schema fields; "independent link check" is a semantic judgement the model makes. So:

- Prompt-level: instruct Gemini to emit an explicit `navigate` back to the start URL between
  independent checks. This is a **preference** and cannot be the guarantee (§0.2).
- Deterministic check: for an IR whose steps visit more than one distinct page **without an
  intervening `navigate`**, reject via `groundingError()`. Page identity from the same `pageKey()`
  comparison `testCases.ts:171` and `ir.ts` already share — one definition, so they cannot disagree
  about what "the same page" means. `ir.ts:99-110` already special-cases `url_contains` and
  page-level assertions and is the precedent for reading page identity during grounding.
- **Do not** infer independence from step text. If the structural signal cannot distinguish a
  legitimate multi-page flow (login → dashboard → settings, which *must* not return to start) from
  a nav sweep, **stop and raise it** rather than guessing. A wrong guard here breaks real compound
  flows, and `TECH_DEBT.md` TD-37 is precisely that mistake: an assertion generalised from login to
  any form with a preceding fill.

**Open question for sign-off:** is the intended rule "return to start between independent checks" or
"one page per case unless the flow is inherently multi-page"? These produce different guards. The
second is simpler and more structural. **Decide before implementing.**

### 3.3 Effect, pros and cons

**Effect.** Long nav sweeps become several shorter cases or one truncated case. Execution time per
case drops. Item 6's step-count-aware timeouts (`52c05ea`) interact directly — a capped case gets a
smaller budget, which is consistent, but re-read that commit before touching timeouts.

**Pros.** Cheap; reuses tested truncation. `meta.truncated` makes the cap **visible** rather than
silent. Cap is one env var, instantly tunable, unset = old behaviour. Shorter cases are easier for a
human to review in the gate, which compounds with item 8.

**Cons.** A cap set too low truncates legitimate flows — the requester's own words say a 17-step
sweep is nonsense, but a real checkout may need 10+. The return-to-start guard is the single riskiest
change in this plan for false rejections. Extra `navigate` steps add small real execution time.

### 3.4 Verification

Unit tests over IR fixtures for the cap boundary (n, n+1). Replay against saved `04-ir.json`
including a known long one — confirm truncation lands where expected and `hasTerminalAssertion`
behaves. For the return-to-start guard, **explicitly test a legitimate multi-page flow is NOT
rejected**; that negative test is the point, not the positive one. Then a live run.

### 3.5 Estimate

**1 day** for the cap plus tests. **+0.5–1 day** for return-to-start, *after* §3.2's open question is
answered. If it is not answered, ship the cap alone — it stands on its own.

---

## 4. Item 8 — stop incidental features crowding out what was asked

> *"Tighten case selection so incidental features (voice search, settings menus) don't crowd out
> what was asked (item 8)."*

### 4.1 Root cause, located precisely

`selectCases` (`src/stages/testCases.ts:160`). The cause is **not** a bug — it is a deliberate design
choice whose comment states it plainly (`:198-201`):

> *"Diversity before depth. Filling the budget by raw priority produces five flavours of the same
> check; a capped suite is only defensible if the few cases in it cover different ground."*

The pass takes **one case per distinct `category`**, then fills leftover slots by priority. And the
prompt anchor is **singular** — `:203`, `const primary = kept.find(c => c.fromPrompt)` — one case.

So: exactly one prompt-derived case is protected. Every remaining slot is awarded for *category
novelty*. A "voice search" case in an unseen category **outranks a second highly relevant case in an
already-seen category.** That is the reported symptom, produced by the code working as designed.

### 4.2 The change

**Class C — flag-gated, default OFF.** This changes which tests a user gets, so it must be
observable side-by-side before becoming the default.

The fix is to make relevance a **first-class, structurally-verified** dimension that outranks
category diversity — without regressing why diversity exists.

1. **Let more than one case be prompt-anchored.** `fromPrompt` is already a schema field and already
   trusted as the anchor; the limitation is that only one is read. Order all `fromPrompt` cases ahead
   of the diversity pass, then run diversity over the remainder for the leftover slots. This is a
   handful of lines at `:203-212` and keeps the diversity rationale intact for genuinely spare slots.

2. **Verify `fromPrompt` deterministically, because the model sets it.** Today it is a model
   self-report, and the central design rule says a model's self-report is a preference. The
   structural check: a case claiming `fromPrompt` must target a page the prompt's own resolved entry
   URLs reach, compared with the shared `pageKey()`. `filterByScope`/`ScopeFilter` already exists as
   *"a defensive floor, not a count constraint"* (`:227`) and is the right place. **Do not keyword-match
   the prompt against case titles** — that is TD-01 restated, and `titleOverlap` is already doing
   prose comparison for dedup, which is as far as that should go.

3. **Leave `finalizeCaseSelection` alone for the gated flow.** Its docblock (`:218-231`) explains
   that when the human gate was used, the case list is *already the human's explicit decision*, and
   re-applying budget logic *"silently overrides it in either direction"*. Item 8 must change only
   the **ungated** path. Touching the gated path would override a human decision — a direct
   violation of platform rule 6, *a model proposes, it never writes*.

### 4.3 Effect, pros and cons

**Effect.** The ungated flow returns more cases about what was asked and fewer incidental ones.
Category coverage narrows — **accepted, and the explicit trade**. `MAX_ACCUMULATED_CASES` (5) and
`budgetFor(coverage)` are unchanged; only ordering within the budget changes. The gated flow is
untouched.

**Pros.** Small, surgical diff in one function. Uses existing schema fields and the existing shared
`pageKey()`; no new prose heuristic. Reversible by a flag. Directly addresses the symptom at the one
place that causes it.

**Cons.** Partially reverses a deliberate, documented decision, so the original reasoning must be
re-argued in `DECISIONS.md`, not quietly dropped. Genuine risk of the *opposite* failure the
diversity pass was built to stop: five flavours of the same check. **Mitigation: keep the diversity
pass for all non-`fromPrompt` slots** — do not delete it. Quality is judged by human reading of real
output, so this is the hardest item to verify objectively.

### 4.4 Verification

Unit tests over synthetic `TestCase[]` are the bulk: multiple `fromPrompt` cases all survive; an
unverifiable `fromPrompt` claim is stripped; the diversity pass still applies to remaining slots;
**the gated path is provably unchanged** (assert `finalizeCaseSelection` with `gateUsed: true`
returns the same list as before). Then replay saved `03-cases*` artifacts through old and new
`selectCases` and **diff the selections** — free, and it shows the real effect on real model output
better than any synthetic fixture. Then a live run on the site that produced the voice-search noise,
flag on, and a **human reads both suites side by side.** There is no automated proxy for "the cases
are about what I asked"; do not invent one and do not claim the item is done without that read.

### 4.5 Estimate

**1.5–2 days.** Reordering plus tests, 0.5 day. Deterministic `fromPrompt` verification, 0.5 day.
Replay-diff across saved runs, 0.5 day. Live run and human review, 0.5 day.

---

## 5. Sequence, and why this order

```
Item 7  (locale)      ── must be first
   │  every later item is judged against discovery output; until that output is
   │  deterministic, an item-4/5/8 result cannot be told from locale noise.
   ▼
Item 5  (step cap)    ── second: lowest risk, reuses tested truncation,
   │                     and shorter cases make item 8's human review tractable.
   ▼
Item 4  (visibility)  ── third: touches ir.ts; wants a stable AppModel under it.
   ▼
Item 8  (selection)   ── last: judged by human reading, so everything else
                         should be quiet before changing what a suite contains.
```

Item 5's return-to-start sub-part may slip behind item 4 without disturbing anything; the cap should
not.

### Timeline

| Day | Work | Gate to pass before moving on |
|---|---|---|
| 1 AM | Record test baseline. Commit the item register (§0.3). Item 7: helper, five call sites, cache key. | `tsc` clean, baseline reproduced |
| 1 PM | Item 7: run option, UI control, real-browser locale test | real-browser test green |
| 2 AM | Item 7: live e2e on the Korean site. **Verify the server restarted after the edit.** | English in `02-appmodel.json` and `03-cases*` |
| 2 PM – 3 | Item 5: `MAX_STEPS_PER_CASE` + truncation reuse + tests + replay | legitimate long flow not broken |
| 4 | Item 5: return-to-start — **only if §3.2's open question is answered** | multi-page-flow negative test green |
| 5–6 | Item 4: layer 1 (schema + grounding), layer 2 (live re-check, budgeted) | replay proves the specific rejection |
| 7–8 | Item 8: reordering, `fromPrompt` verification, replay-diff | gated path provably unchanged |
| 9 | Item 8 live run + **human side-by-side review** | a person says the suite is better |
| 10 | Docs: `TECH_DEBT.md` TD-95+, `DECISIONS.md` D-33+, `docs/phases/` report. Delete this file. | `tsc` + full suite + CI green |

**~10 working days / 2 calendar weeks**, assuming one developer, no blocking unknowns, and same-day
answers on the two open questions. Items 4 and 8 are the estimates most likely to grow: item 4
because `ir.ts` regressions surface only on real runs, item 8 because "better" needs a human.

Item 7 alone is **day 1–2** and delivers most of the value in this plan. If time is short, ship item 7,
stop, and re-plan the rest against clean data.

---

## 6. Blanket rules for every commit in this plan

1. `npx tsc --noEmit` clean; `npx vitest run` at or above the recorded baseline. CI runs both but is
   **not** a merge gate (TD-20) — run them locally.
2. No existing route's request or response shape changes. Optional additive fields only (rule 1).
3. No `public/style.css` class names touched; no `.hidden` toggled outside `showView()` (rules 3, 4).
4. No credential reaches disk. Anything new that could land in an artifact gets scrubbed in
   `scrubServedSecrets` (rule 5).
5. No LLM call added to `generator.ts` or `executor.ts` (D-06).
6. Every new env var documented in `.env.example` **and** `README.md`.
7. Any new cache-affecting input goes into the cache key **in the same commit** (TD-22, D-10, TD-94).
8. If `public/app.js`'s copy of `formatIrStep` is touched, change the server's too —
   `tests/stepText.test.ts` checks them identical.
9. No named or `const` function inside a `page.evaluate` callback; inline everything, comment why
   (TD-40).
10. Anything touching the generated spec's Playwright API surface is **run for real** once, not just
    `tsc`-checked (D-19).
11. One item per branch. These are independently revertable and should stay that way.

## 7. Open questions needing a human answer

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q1 | Locale defaults to `en-US` (class B), accepting the §1.5 exception to platform rule 2? | item 7 | **Yes.** Non-determinism is not a baseline worth preserving. |
| Q2 | Default timezone `UTC`, or the host's? | item 7 | `UTC`. Reproducible; flag the rendered-date effect to QA. |
| Q3 | Item 5: "return to start between independent checks", or "one page per case unless inherently multi-page"? | item 5's second half | The second. More structural, fewer false rejections. |
| Q4 | Starting value for `MAX_STEPS_PER_CASE`? | item 5 | 8, then tune against real runs. |
| Q5 | Commit `project-brain/` and the item register first (§0.3)? | nothing, but improves everything | Yes. Acceptance criteria should be reviewable. |

Q1 and Q3 are genuinely blocking. Q2, Q4, Q5 have safe defaults and should not hold up day 1.

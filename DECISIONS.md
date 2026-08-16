# Decisions

A record of choices that shaped this codebase, why they were made, and what was rejected instead —
so the *reasoning* survives even when the code around it changes. `ARCHITECTURE.md` says what the
system does; this file says why it does it that way. `TECH_DEBT.md` is the place a decision goes
once its tradeoff turns out to have cost more than expected.

Ordered roughly by how foundational each decision is, not by date.

---

## D-01. Documentation gets exactly one owner per topic

**Context.** This project's docs used to carry the "what's broken" list in up to six places at
once — README, an architecture doc, a project summary, a session log, a tech-debt doc, and a
problem-analysis doc. Every copy drifted independently: one doc said a bug was "diagnosed, not yet
fixed" after the fix had already landed and touched zero `.md` files; another cited a test count
that was 21 tests stale; a README documented Docker files that had been deleted.

**Decision.** Five documents, each with exactly one job, cross-linked instead of duplicated:
`README.md` (what/how to run), `CLAUDE.md` (agent working guidance), `ARCHITECTURE.md` (how it
works internally), `TECH_DEBT.md` (what's broken, ranked, with remediation), `DECISIONS.md` (why —
this file). No doc repeats another's content; each links to the owner instead.

**Consequences.** A doc that needs "what's broken" content links to `TECH_DEBT.md` rather than
restating any of it. Keeping this discipline is now itself part of `CLAUDE.md`'s guidance, because
the failure mode (six copies, all stale) is exactly what this structure exists to prevent.

## D-02. `groundingError` is the single deterministic authority over every target kind

**Context.** An LLM generating a test step can invent a role+name that doesn't exist, a CSS
selector nothing discovered, a navigate URL guessed from a feature's name, or a visibility
assertion against an element that's actually hidden. Each is a different way for the model to be
wrong, and each needed its own check.

**Decision.** One function, `groundingError()` in `ir.ts`, is the sole authority: a **role+name**
must match a real discovered element (with a narrow `link`/`button`/`menuitem`/`tab` fallback,
since SPA navigation is routinely built from the "wrong" tag); a **css selector** must be one
discovery actually captured; a **navigate URL** must be a discovered page or a discovered link's
resolved href, never a guessed route; an element recorded **hidden** can't be the target of a
`visible` assertion. Every rejection returns the same `{index, message}` shape and rides the
existing correction-feedback retry loop, so adding a new check never adds new control flow.

**Consequences.** Adding a new kind of check is cheap and consistent. The failure mode this
decision doesn't cover — a check written as a regex over LLM-authored *prose* rather than against
discovered *structure* — is exactly what produced `TECH_DEBT.md` TD-01; the decision was right,
one of its implementations (`missingActions`) didn't follow it faithfully.

## D-03. Prompt nudges are never the only guard

**Context.** Three separate bugs recurred *after* being "fixed" with a system-prompt instruction
alone: a menu-toggle assertion, a guessed route, a role mismatch. An LLM instruction is a
preference the model can ignore on any given run, not a constraint.

**Decision.** Every prompt rule stays as cheap first-line steering, but each now has a
deterministic check behind it in code (see D-02). The prompt rule alone is never trusted to hold.

**Consequences.** This is the project's most-repeated lesson and the reason `CLAUDE.md` states it
as the central rule for anyone extending the pipeline. It has one recorded failure mode: a
deterministic check that itself only inspects LLM-authored prose (case text, page text) rather
than model *structure* is not actually deterministic — see D-02's consequences and `TECH_DEBT.md`
TD-01/TD-04/TD-11, which are all instances of this same gap one layer down.

## D-04. Title metadata is explained to the model, not enforced against it

**Context.** A terminal assertion checking "the page title contains X" was grounded as a
visible-body-text assertion, because `<title>` content is metadata, never rendered body text, and
the model didn't reliably know that.

**Decision (as shipped).** A system-prompt rule was added telling the model the `title` field is
`<title>`-tag metadata that can never render as visible body text.

**Consequences — this one didn't hold, and it's on record for it.** A later run
(`2026-08-14T10-46-05…667f7f76`) shows the model asserting the title string as body text anyway,
timing out because the string occurs zero times on the page. This is D-03's stated failure mode
happening to its own example case: the fix here was prompt-only from the start, with no structural
backstop, and `TECH_DEBT.md` TD-06 is the follow-up — add an actual `title_contains` assertion kind
so the check is enforced by the schema rather than requested in prose.

## D-05. Reject-and-regenerate, not refresh-and-retry, for a dynamic in-page modal

**Context.** A modal opened by a button click (no URL change) has fields absent from the
`AppModel`. A hallucinated field name can coincidentally collide with real page chrome elsewhere on
the page, so `groundingError` reports the step as grounded and the live re-snapshot mechanism
(`extendAppModel`, which only triggers on a grounding *miss*) never fires — a same-run A/B pair
proved the capture mechanism itself worked fine; only its miss-only trigger was the problem.

**Decision.** A structural trigger — `postClickRevealIndex(ir)` — spots a `fill`/`select`/`check`
whose nearest preceding non-`wait` step is a non-link `click`, deliberately *not* a wording-based
detector (see D-03). When it fires, force one re-snapshot through the triggering click, diff the
revealed elements against what was known before, and if anything fillable was revealed that the
target doesn't match, **reject the step and regenerate** — a plain refresh alone was verified
insufficient, since the refreshed page still contains the same header chrome the bad target
matched, so re-grounding the same IR would still pass it.

**Rejected alternative.** An "accept if the target matches a revealed field" escape hatch was
written and then deleted before shipping: `groundingError` rewrites a target's name to the matched
element's literal (pre-refresh) name by the time this check would run, so the guard could never
actually fire — the case it was meant to protect is handled one layer up, structurally, by the
live-extend path itself.

**Consequences.** Bounded to fire at most once per IR generation, which doubles as the mitigation
for its only real false-positive risk (a click that reveals new fields while the step legitimately
targets a pre-existing one) — a wrong rejection costs one wasted attempt, not a wrong test.

## D-06. The generated Playwright spec is standalone — no shared imports from the pipeline

**Context.** The generator could either import locator/resolution logic from `targetResolver.ts`
or restate it inline in the emitted spec.

**Decision.** The spec restates it (`LOCATE_HELPER`/`SAFE_CLICK_HELPER`/`FIELD_HELPER` in
`generator.ts`), deliberately, so a generated `.spec.ts` file is runnable standalone — copyable out
of this repo, reviewable without pulling in the rest of the pipeline.

**Consequences.** The cost is real and already realized: the two implementations have measurably
diverged (`TECH_DEBT.md` TD-07, TD-08) with nothing pinning them equal. Accepted as the tradeoff
for standalone output; the mitigation is a test that catches divergence, not eliminating the
duplication.

## D-07. `extractDomModelFromPage` over a fresh browser for replay-time snapshots

**Context.** Re-discovering a page during live-extend or a site crawl needs a live snapshot. A
fresh, session-less browser launch is simpler to reason about in isolation.

**Decision.** Snapshot the *already-open* Playwright `Page` the calling code has, via
`extractDomModelFromPage` — never launch a new, session-less browser for this
(`discoverUsingCrawler` remains, but only for the true entry-page case).

**Consequences.** A fresh browser hitting an authenticated URL lands on the login redirect and
models the wrong page — worse, it would cache that wrong snapshot under the real URL's key
permanently. `extractDomModelFromPage` can only ever see what the calling code's own session sees,
which structurally rules that failure mode out rather than just handling it well.

## D-08. No built-in demo-credential registry

**Context.** An earlier version silently auto-filled known demo sites (saucedemo,
the-internet.herokuapp.com) from a hardcoded registry.

**Decision.** Removed. Credentials now come from exactly two general sources: extracted from the
prompt when the user typed them there, otherwise the `askCredentials` UI pause/ask flow — uniform
for every site, no special-casing.

**Consequences.** Confirmed with the user at the time as a deliberate behavior change, trading
silent per-site convenience for a pipeline that never special-cases a specific host. Also removed
the risk class where a hardcoded registry entry goes stale against a site that changed its demo
account.

## D-09. Secrets never reach disk

**Context.** `runs/` is served as static files with no authentication (`TECH_DEBT.md` TD-14) — any
artifact written to it is effectively public.

**Decision.** A user-supplied credential becomes an `${env:...}` reference in the IR and the
generated spec, never the literal value; the real value is injected only into the Playwright child
process's environment at execution time. Extended to also scrub `results.json`, `final-page.txt`,
and error-context attachments (`scrubServedSecrets`, `executor.ts`) — a logged-in page routinely
echoes the identifier back into visible text even when the fill value itself was never a literal.

**Consequences.** A hard requirement given D-14 (no auth) exists, not a nicety. Any new artifact
type that might echo a credential back needs to be added to the scrub list — this is a standing
obligation on future changes, not a one-time fix.

## D-10. Cache keys hash the actual prompt text, not a version constant

**Context.** The LLM cache (`llmCache.ts`) is two-tier — in-memory (30-min TTL) + disk (no
expiry) — and every stage's cache key needs to include every input dimension that changes its
output, or a result is served stale forever.

**Decision.** Each stage hashes its own system-prompt *text* plus model name into the cache key,
rather than maintaining a hand-written `PROMPT_VERSION` constant that would need to be bumped
manually on every prompt edit.

**Consequences.** A version constant is something a future edit can forget to bump, and the
failure mode when forgotten is invisible — a hashed prompt can't be forgotten to update, because
the hash changes automatically the moment the text does. The disk tier's lack of expiry is still a
live risk for any dimension that isn't yet part of the hash — `TECH_DEBT.md` TD-22 tracks this as
ongoing discipline, not a closed problem.

## D-11. The case-selection gate is additive, feature-flagged, and off by default

**Context.** Adding a human-in-the-loop review step over generated test cases risked changing
default pipeline behavior for every existing user of the straight-through path.

**Decision.** `ENABLE_CASE_SELECTION_GATE` gates the entire feature; when off, `caseSelectionGate.ts`
is never even imported, so the default path is provably byte-for-byte unchanged from before the
gate existed.

**Consequences.** Two enforcement details make the review loop actually reliable rather than just
prompt-requested: `filterNovelCases` hard-drops any regenerated case whose title overlaps an
already-accepted-or-rejected one, even if the model or its cache hands one back anyway; and the
regeneration's extra context (rejected titles, a "not satisfied" refinement prompt) is folded into
the cache key, so a "not satisfied, focus on X" reply actually steers the next batch instead of
being silently ignored by a cache hit from round one.

## D-12. Isolated per-case execution — one Playwright `test()` per case

**Context.** Running every case in one shared browser context is faster but risks one case's login
session or page state leaking into the next case's assumptions.

**Decision.** Every selected case runs in its own Playwright `test()` — a fresh browser context,
no shared cookies or session.

**Consequences.** Slower than a shared-session run, chosen deliberately so a suite's pass/fail
result reflects each case in isolation rather than depending on run order.

## D-13. A case's representative screenshot is its last completed step, not its first

**Context.** `findScreenshot` originally returned the first `.png` a directory walk found, which
was always `step-1.png` — the pre-action frame — regardless of what the case actually tested.

**Decision.** Sort `step-N.png` numerically and take the last one.

**Consequences.** This choice doubles as this project's primary forensic tool for diagnosing a
run after the fact: the highest-numbered screenshot present identifies the last step that actually
completed, independent of whatever the (possibly wrong, see `TECH_DEBT.md` TD-02) failure
diagnosis claims. Used directly to prove TD-02's wrong-step diagnoses wrong.

## D-14. Presence checks are not coverage checks

**Context.** `missingActions` originally asked only "does *any* `fill` exist, does *any* `click`
exist anywhere in the IR" — an IR that logged in and then stopped could still report a case with
nine named steps as fully covered.

**Decision.** Count the case's own action-bearing step lines against what the IR actually carries
out, and reject when the gap is more than the slack of one legitimate consolidation (e.g. "fill the
login form" becoming two IR fills).

**Consequences.** Correct in spirit and still the right idea — an IR that silently stops partway
through a case is worse than an honest failure. Its implementation now has its own entry in
`TECH_DEBT.md` (TD-01): counting action-bearing *prose lines* rather than action-bearing *page
structure* means a page whose own visible text contains an action verb can trigger a false
rejection with no fallback. The decision to check coverage, not just presence, stands; the
prose-matching mechanism doing the checking needs to change.

## D-15. Scope ambiguity defaults to both scopes, not neither

**Context.** `classifyScope(prompt)` decides whether a run's coverage should include security-shaped
cases. A prompt naming neither "functional" nor "security" language is genuinely ambiguous.

**Decision.** When no signal points either way, `classifyScope` returns both scopes — the full
taxonomy — rather than defaulting to functional-only.

**Consequences.** Confirmed as deliberate, not a bug, when a code review raised it. The tradeoff:
a functional-sounding prompt with no explicit scope language can still produce a security case (see
a real instance in a recent run, generating a SQL-injection case from a plain homepage-visibility
prompt) — expected behavior under this decision, worth knowing before treating it as a defect.

## D-16. `trace`/`video` retained on failure only, not on every run

**Context.** A full Playwright trace costs roughly 0.5MB even for a passing test and made up
~80% of `runs/`'s disk footprint when captured unconditionally.

**Decision.** `trace: "retain-on-failure"`, `video: "retain-on-failure"`; `screenshot: "on"` stays
unconditional (tiny, and the UI shows one per case regardless of outcome).

**Consequences.** A passing case doesn't accumulate debugging artifacts it doesn't need. The cost
shows up in `TECH_DEBT.md` TD-02: a *failing* case's trace/video finalization is plausibly part of
why some failing runs take long enough to hit the executor's kill timer — cheaper trace settings
(e.g. `"on-first-retry"`) are one of that item's candidate mitigations.

## D-17. A zero-element DOM extraction is accepted as a valid, cacheable result

**Context.** `domExtract`/`extractDomModelFromPage` sometimes returns a page with zero elements —
most commonly an auth wall that redirected before anything meaningful loaded. Treating that as a
hard failure would re-run discovery (a fresh browser launch) every time the same auth-walled URL
is requested again.

**Decision.** A zero-element extraction is accepted as a legitimate, cacheable `AppModel` entry
(`hybridDiscovery.ts`, both the single-page and site-crawl paths) rather than triggering the
Gemini Vision fallback or a retry. The comment recording this explicitly names two cases it's
meant to cover: *"auth wall, not-yet-hydrated."*

**Consequences — the second named case doesn't actually get the outcome the comment implies.** An
auth wall genuinely has nothing to extract, so caching "zero elements" for it is correct and
cheap. A **not-yet-hydrated** JS-rendered page is a different situation entirely: elements exist,
the extraction just ran before they were rendered (`domDiscovery.ts` navigates with
`waitUntil: "domcontentloaded"`, which fires before deferred/async hydration scripts necessarily
finish, with no settle wait before `page.content()` is called). The decision as shipped can't tell
these two cases apart, and it resolves the ambiguity the same way for both — accept and cache —
which is right for the first case and silently wrong for the second. Reproduced directly
(`TECH_DEBT.md` TD-31): a real run's entry page had 32.8KB of real `<head>` content and **no
`<body>` at all**, cached as a valid zero-element `AppModel`, which forced test-case generation to
invent untestable generic assertions with a guaranteed failure — and, in a later run, crashed spec
generation entirely (`TECH_DEBT.md` TD-30) and took down the whole run with zero cases produced.

**Fixed, superseding the "accept immediately" half of this decision, not the caching half.**
`extractDomModelFromPage` now polls briefly (measured against the real site: 0 elements at
+800ms, 347 by +2.8s — the fixed wait was nowhere near enough) before accepting zero as final.
The auth-wall case this decision was originally protecting is unaffected — it still resolves to
zero, correctly, just after the poll window instead of immediately — and the cache-to-avoid-
re-crawl-cost tradeoff this record describes is untouched; only *when* a zero-element result is
trusted enough to cache changed.

## D-18. Live locator resolution requires an exact name match; grounding's own name matching stays fuzzy

**Context.** Two different layers of this pipeline match an element by name, for two different
reasons. `groundingError` (`ir.ts`) matches a *model-proposed* name against the AppModel to decide
whether a step is real at all — here, fuzzy/tiered matching (exact → glyph-stripped → prefix/
suffix → substring) is deliberate and load-bearing: it's what lets "Continue" ground against a
real "Continue Shopping" button, or tolerates the model dropping a decorative `+`. Separately,
`locate()` (`generator.ts`) and `resolveRoleWithFallback` (`targetResolver.ts`) resolve an
*already-grounded, already-verified* name against the **live page** at execution/replay time —
here, `getByRole`'s default (case-insensitive substring) and the CSS `:has-text()` fallback used
to be just as loose.

**Decision.** Keep grounding's matching fuzzy (unchanged); make live resolution exact
(`{ name, exact: true }`, `:text-is()` instead of `:has-text()`) everywhere a role+name target is
resolved against the real DOM. By the time a name reaches this layer, `groundingError` has already
rewritten it to a specific real element's literal accessible name — it is never a guess at this
point, so exactness costs nothing for a correctly-grounded target.

**Consequences.** Reproduced directly (`TECH_DEBT.md` TD-32) before this decision: a discovered,
correctly-grounded `{role: "button", name: "All"}` target — Amazon's own "All Categories" control
— matched an embedded video player's unrelated "restore all settings" button (loose `getByRole`)
and, on the click path, a 4-way strict-mode violation including a "Open All Categories Menu"
hamburger (loose `:has-text()`) — none of which discovery ever modeled, so grounding had no way to
rule any of them out. Exact matching closes that class of false-positive entirely. The tradeoff:
a target whose live accessible name has drifted even slightly from what was grounded (trailing
whitespace, a dynamic suffix) now fails closed — an honest "not found" — rather than loosely
matching something plausible. Judged the right direction: a confident wrong match (TD-32's actual
failure mode) is worse than a clear miss that at least reports honestly.

## D-19. A `visible` assertion narrows to visible candidates before any locator narrows to one

**Context.** D-18 makes name matching exact, which stops an *unrelated* element from winning a
lookup — but it does nothing when two elements genuinely share the same exact accessible name and
role, one visible and one not (a page's real brand text vs. a hidden `<option>` inside a collapsed
dropdown, both legitimately "Amazon"). `toBeVisible()` on a locator that could resolve to either
has no way to prefer the visible one.

**Decision, corrected once already.** `emitAssert`'s `"visible"` case narrows the locator to
visible-only candidates before applying it. The first version of this decision used
`.filter({ visible: true })` — plausible-looking, confirmed via a passing test suite and a
string-level replay, and **wrong**: `Locator.filter()` has no `visible` option in this project's
pinned Playwright (1.49.0), so the call silently no-oped. Both verifications had checked the
*generated source text*, never actually run it; a second live run against the real site
reproduced the identical failure before this was caught, then confirmed directly by reading
Playwright's own type declarations and running a real headless-browser check. The corrected
mechanism is `.and(page.locator(':visible'))` — Playwright's real `:visible` pseudo-class,
intersected via the real `Locator.and()` method — verified the same way the bug was found: a
real browser run, not just a string check.

Order is still the entire *shape* of this decision, and was re-verified with the corrected
mechanism too: `resolveCode()`'s own output already carries a trailing `.first()`/`.nth(N)` for
two of its three shapes, and narrowing to visible-only candidates AFTER that trailing modifier
doesn't exclude a hidden candidate in favor of a visible one — it just empties the locator if the
one candidate DOM order picked first happens to be hidden. Narrowing the full candidate set down
to only-visible ones, then applying `.first()`/`.nth()`, is the only order that does what the fix
is for.

**Consequences.** Scoped deliberately narrow — `"visible"` only. `hidden`/`enabled`/`disabled` and
the click/fill paths all need to act on the *same* element the step resolved (asserting hidden
requires seeing the specific hidden element, not filtering it away); only `"visible"` has a
legitimate reason to prefer a different candidate than whichever one resolution found first. Not
yet extended to `text_equals`/`text_contains` — those already scope to the resolved locator's own
text content rather than picking among candidates, so the same failure mode doesn't apply there
today, but worth re-checking if a similar false match is ever reported against them.

**The lesson worth generalizing beyond this one fix:** a generated Playwright expression that
*looks* right and passes `tsc`/a unit test that only inspects the emitted string is not verified
— it's untested. Anything touching the generated spec's actual Playwright API surface needs at
least one real execution (a synthetic-HTML browser check is enough; it doesn't need to be the
live target site) before being called done.

## D-20. Self-heal is one shared function, called by both the primary case and suite cases

**Context.** `orchestrator.ts` has always retried a failed primary case once — re-snapshot the
live page, regenerate IR fresh, accept only if the retry both still covers the whole case and
actually passes — gated to `selector_changed`/`element_missing` diagnoses. `suiteRunner.ts`'s
non-primary cases had no equivalent at all: a suite case got exactly one attempt, even for the
identical, already-solved category of failure. Two real failures in one saved run
(`2026-08-15T17-57-40-434Z-0b385264`, cases 1 and 2) were both `element_missing` — the exact
category heal already exists for — but neither got a retry, purely because neither happened to
be the case orchestrator.ts executes directly.

**Decision.** Extract the heal sequence into `src/stages/heal.ts` as `attemptHeal()`, unchanged
in logic, called by both `orchestrator.ts` and `suiteRunner.ts` — one implementation, not a
second one restated for the suite path. This codebase has already paid for that mistake once
(`TECH_DEBT.md` TD-07, `generator.ts`/`targetResolver.ts` restating the same locator logic and
drifting apart); extracting a shared function was cheaper than repeating it a second time.
`attemptHeal` is deliberately **emit-agnostic** — it takes no `onEvent`/`emit` callback and does
none of its own progress reporting. Each caller emits in its own stage idiom instead:
`orchestrator.ts` keeps emitting its `"heal"` `StageName`, which drives `public/app.js`'s
primary-case-only phase-4 progress tracker (`STAGE_TO_PHASE`); `suiteRunner.ts` folds
`healed: true` into the `"suite"`-stage event data it already emits per case, alongside the
existing `reused` convention. The two must never emit the same `"heal"` `StageName` — a suite
case doing so would corrupt a tracker built to represent exactly one case's progress.

**Consequences.** Capped per suite via `MAX_SUITE_HEALS` (default 3, env-overridable) — a suite
with several `element_missing` cases in one pass would otherwise spend an uncapped number of
extra Groq calls and Playwright runs. A suite case's original (pre-heal) files are kept in
place under `caseDir/`, with the healed IR/spec additionally written to `caseDir/healed/` — but
unlike the primary case, whose "done" event carries the healed IR/spec directly, a suite case's
*only* channel to the frontend is fetching `04-ir.json`/`generated.spec.ts` from `caseDir/`
itself (`loadCaseDetails` in `public/app.js`). Left un-overwritten, a healed-and-passing suite
card would show a spec that doesn't match its own reported status, so `caseDir/04-ir.json` and
`caseDir/generated.spec.ts` are deliberately overwritten with the healed version once a heal
succeeds — a documented divergence from the primary case's convention, not an inconsistency.
`buildSuiteSummary`'s screenshot resolution checks `caseDir/healed/artifacts` before
`caseDir/artifacts` when `healed` is set, for the same reason: the original directory still
holds the failure frame, not the passing one.

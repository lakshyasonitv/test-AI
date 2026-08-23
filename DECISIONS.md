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
extra LLM calls and Playwright runs. A suite case's original (pre-heal) files are kept in
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

## D-21. Single LLM provider (Gemini) — Groq removed, no rationale for it was ever on record

**Context.** Every stage but one already ran on Gemini (plan, discovery, test cases,
failure-analysis, heal's re-snapshot). IR compilation alone ran on Groq — and nothing in this
project's docs or commit history recorded *why* that one stage used a different provider than
everything around it. Investigating it turned up three independent problems, not one:

1. **Groq's rate limit is per-org, not per-key.** Teammates adding their own Groq keys to the
   pool added zero extra quota — `keyPool.ts` rotates keys for *failover*, but Groq enforces the
   TPM ceiling account-wide, so every key still drew from the same shared budget. Gemini keys, by
   contrast, DO stack quota when each comes from a distinct Google Cloud project — four
   teammates' own-account keys is a legitimate ~4x, not a Groq-ToS violation waiting to happen.
2. **Groq was already sitting at that TPM ceiling in practice**, not just in theory — the
   original motivation for even asking "should Groq stay" was recurring 429s on real runs.
3. **The Gemini model id this project WAS using elsewhere (`gemini-3-flash-preview`) was itself
   a preview id, per Google's own model-deprecation docs (checked in the plan-mode session that
   proposed this change, not re-verified against a live "deprecated" field here — the metadata
   endpoint doesn't expose one; a direct GET returned 200 with no such flag either before or
   after the switch)** — a separate defect, but one that made "just point IR at Gemini too"
   require picking a new, correct id rather than reusing what was already configured. Fixed
   alongside this decision: `GEMINI_MODEL` moved to `gemini-3.6-flash` — confirmed live, this
   session, via a direct model-metadata probe (`generateContent` present in
   `supportedGenerationMethods`) and one real `gemini()` call before the switch was relied on.
   `GEMINI_MODEL_LITE` (`gemini-3.1-flash-lite`) was left alone — per the same deprecation-docs
   check, stable until 2027-05-07 as of when that check was made; re-verify the date before
   trusting it, per this file's own `.env.example` comment.

A fourth problem was structural rather than a provider defect: `GroqBudget` (now `LlmBudget`,
`src/llm/llmBudget.ts`) was the only per-run cost-tracking mechanism in the codebase, and it only
existed because IR happened to be the one stage on Groq. Every other stage's real Gemini spend
was invisible — `runs/<id>/08-groq-usage.json` reported one-fifth of a run's actual LLM cost and
nobody had cause to notice, because nothing else was ever instrumented.

**Decision.** Consolidate on Gemini for every stage, and delete `src/llm/groq.ts` outright rather
than keep it as a second, unused code path. Concretely:

- IR generation now calls `gemini()` with the FULL `GEMINI_MODEL` (not `_LITE` — IR is the
  hardest structured-output task in the pipeline, DOM + test case combined into strict JSON, the
  same reason it needed Groq's larger context window before) and an explicit `temperature: 0.2`,
  matching the value this call ran at under Groq — `GeminiOpts` has no built-in provider default
  the way `groq.ts` did, so it has to be set at the call site or IR would silently move to
  whatever Gemini's own default temperature is.
- `gemini()` itself was given a usage-bearing return shape (`{content, usage}`, reading
  `usageMetadata.promptTokenCount`/`candidatesTokenCount`/`totalTokenCount` — NOT prompt+
  completion summed, since Gemini's total separately includes `thoughtsTokenCount` reasoning
  tokens a naive sum would silently drop) so cost tracking has real numbers to record.
- `GroqBudget` generalized to `LlmBudget`, recording spend from every LLM-calling stage, not just
  IR. Two propagation paths, chosen per call depth: IR threads an explicit `budget?: LlmBudget`
  parameter (its call site is shallow — `orchestrator.ts` -> `ir.ts` -> `gemini()`); every other
  stage records via `AsyncLocalStorage` (`enterWithBudget()`/`recordAmbient()`), because their
  `gemini()` calls sit several layers inside internal helpers (e.g. discovery's
  `labelConceptsWithDOM`) that would otherwise need a budget parameter threaded through every
  intermediate function just to reach one call site. `AsyncLocalStorage.enterWith()` (not `.run()`)
  was used specifically so `orchestrator.ts`'s existing 300+ line `runPipeline` didn't need
  re-indenting into a callback. Verified concurrency-safe across `MAX_CONCURRENT_RUNS` — two
  simultaneous runs each get their own isolated budget — via a dedicated interleaved-async test
  (`tests/llmBudget.test.ts`), confirmed load-bearing by neutering `AsyncLocalStorage` down to a
  shared module-level variable and watching that exact test fail.
- The deterministic grounding gate an IR must pass to be accepted — `groundingError`,
  `crossFormBleedError`, `clickedElementHiddenAssertion`, `missingActions`, all in `ir.ts` — is
  pure code with no provider dependency, and was not touched by this migration. Confirmed, at
  zero API cost, by replaying two real Groq-era accepted IRs (saved before this migration, copied
  into `tests/fixtures/irGroqToGeminiReplay/` since `runs/` itself is gitignored and ages off
  disk) through the current versions of those four functions
  (`tests/irGroqToGeminiReplay.test.ts`) — both still ground clean. This proves the acceptance
  gate didn't regress; it does not, and cannot, prove a *freshly Gemini-generated* IR for the same
  case would be equally good — that needs a live model call regenerating IR for those specific
  cases, which was not spent as part of this change. (A separate, smaller live call WAS made: one
  real `gemini()` round-trip confirming the new model id, the rewritten `{content, usage}` return
  shape, and `temperature` all work end-to-end — not a Groq-vs-Gemini IR quality comparison.)

Fixed as an adjacent bug found while doing this work, not a planned part of it: a 401/403/404
from the LLM provider (bad key, decommissioned/mistyped model) was previously retried through
`toIR`'s entire `MAX_IR_ATTEMPTS` budget and then reported as "IR failed schema validation after
retry" — indistinguishable from the site under test actually being broken. Two real runs paid for
this before it was caught: `7bcbf4de` burned 8 calls on a 401, `4f582417` burned 4 on a 404, both
with zero usable tokens. Such an error now fails fast on the first attempt and is marked
structurally (`err.isInfrastructureError = true`, `err.status`) rather than by matching its
message text — the class of check this project's own CLAUDE.md central rule asks for. TD-03's
originally-unimplemented clause — a 429 surviving `callWithPool`'s own backoff shouldn't cost one
of `MAX_IR_ATTEMPTS` either, since it isn't the same kind of failure as a genuine schema error —
was implemented alongside it: up to 3 separately-bounded free retries
(`isRateLimitError`, exported from `backoff.ts` for exactly this cross-module use) before falling
through to the normal attempt-costing retry path.

**Consequences.** One provider to reason about, one rate limit to manage, one place cost is
recorded (`runs/<id>/08-llm-usage.json`, broken down per stage instead of IR-only). Teammates'
own Gemini keys now legitimately add quota project-for-project, which Groq's org-level limit
structurally could not offer no matter how many keys were added. The real tradeoff: no more
cross-provider redundancy — if Gemini itself is ever fully rate-limited or down, there is no
second provider to fail over to, where before a Groq outage/limit at least left the rest of the
pipeline running on a different vendor. Nothing in this decision required migrating faster than
one stage at a time or kept Groq around as a silent fallback path; `src/llm/groq.ts` is gone,
not dormant.

## D-22. Login detection and replay happen against the live DOM, never the extracted PageModel

**Context.** The first version of auth-aware discovery found the password field via
`credentialFieldMap`, which is built only from `PageModel.forms[]` (`domExtract.ts`'s
`extractForms` requires a literal `<form>` tag). It worked on the first real site tried
(learnvibes.vercel.app) and failed on the second (assettrack-web.onrender.com): a React login
with no `<form>` wrapper yields `forms: []`, the map is empty, and the fallback matches the
element's accessible *name* against `/pass/i` — which on that site was the placeholder
`"••••••••"`. No password field found, no login attempted, no error surfaced. The same lossiness
almost repeated on learnvibes itself: its real inputs carry no `id`/`name`/`data-*` at all, only a
placeholder, so an early selector-building draft that tried attributes first and gave up found
nothing for the identifier box.

**Decision.** `loginOnPage` (`hybridDiscovery.ts`) locates the password box as the first
**visible, enabled** `input[type="password"]` in the live page, walks outward from there for the
identifier and submit control, and builds a CSS selector for each with an escalating ladder (id ->
data-test/data-testid/data-cy/name/placeholder/aria-label -> type -> a positional `tag >> nth=N`
last resort that is unique by construction). `input[type="password"]` cannot be faked away by a
missing `<form>`, a missing label, or a placeholder-as-name — it is the one universal signal every
ordinary login has, and reading it live is also less code than maintaining the model-derived path
it replaced.

**Consequences.** Login detection and the AppModel's element extraction are now two independently
correct readings of the same page, not one derived from the other — a page with a lossy structural
extraction (rare markup, no accessible names) can still be logged into. The cost: `loginOnPage`'s
`page.evaluate` callback duplicates some of what `domExtract.ts` already does (visibility
computation, proximity walking) rather than reusing it, because the callback runs inside the
browser with no access to project code. It also must be written with **no inner named or
const-assigned functions** — esbuild (what `tsx` uses, i.e. how the server actually runs) wraps
named functions in a `__name(...)` call to preserve `.name`, and that helper does not exist inside
the serialized function `page.evaluate` ships to the browser. This broke silently under `vitest`
(whose transform doesn't inject the helper) and only surfaced as `ReferenceError: __name is not
defined` on a real `npm run serve` run — see `CLAUDE.md`'s sharp-edges list.

## D-23. The crawl runs on one shared `Page`, not one `Page` per hop under a shared `BrowserContext`

**Context.** The original fix for "discovery can't get past a login" was a shared
`BrowserContext` (cookies persist across `context.newPage()` calls). It worked on
learnvibes — until assettrack-web.onrender.com, whose auth lives entirely in **sessionStorage**
(`token`, `user` keys, zero cookies), verified directly: a second page opened on the *same*
context came back with empty `sessionStorage` and the login form. `sessionStorage` is scoped to a
browsing-context tab, not to the `BrowserContext` object Playwright exposes — a mainstream
React/Vite pattern this project had no prior exposure to.

**Decision.** `discoverSiteHybrid` opens exactly one `Page` (`sharedPage()`) and navigates it from
URL to URL for the entire crawl, login included, rather than closing and reopening one per hop.
Each hop still begins with its own `goto`, so page-local state (a stale toast, an open modal) does
not leak between snapshots — only the session does, which is the entire point.

**Consequences.** This is strictly simpler than what it replaced (no per-hop
open/navigate/snapshot/close bookkeeping) and it is the one design that covers every auth
mechanism this project has seen — cookie, localStorage, and sessionStorage all persist on a page
that never closes. The tradeoff: nothing in the crawl can parallelize across pages anymore, since
they all share the one tab. `MAX_DISCOVERY_PAGES`'s default of 5 keeps this cheap in practice;
revisit if a much larger crawl is ever needed. **Rejected:** capturing Playwright's
`storageState()` once and reusing it — its documented shape excludes `sessionStorage`, so it would
silently drop exactly the mechanism this decision exists to support, and it would additionally
write a live session token into `runs/`, which is served publicly (`TECH_DEBT.md` TD-14).

## D-24. The captured login is replayed by injecting it into the IR, once — not duplicated into the generator or the executor

**Context.** Once discovery signs in, the generated Playwright spec and `liveExtend`'s grounding
replay both need to reproduce that same login in a **fresh, session-less browser** — the
executor's real starting condition. Implementing that twice (once as generated Playwright code,
once as a replay routine) is exactly the shape `TECH_DEBT.md` TD-07 already warns about: the
generated spec's locator logic has already drifted from `targetResolver.ts` once, from being
maintained as a second copy of the same behaviour.

**Decision.** `buildLoginPrefix` (`ir.ts`) turns `AppModel.auth.loginSteps` — the exact fill/
click/press sequence `loginOnPage` performed, each carrying the live-verified CSS selector it
used — into ordinary IR `Step`s, prepended to a case's own steps **before grounding**. Both
consumers, the generated spec and the grounding replay, read the IR; write the login once there
and both inherit it for free. Credential values are the `${env:...}` sentinel
(`envValueRef`), never the literal, so the existing "secrets never touch disk" path
(`generator.ts`'s `valueCode`, `executor.ts`'s env injection) needed no change at all.

The prefix ends with a settle assertion — the password field's own selector, asserted `hidden` —
appended after whatever step submits the form. Without it the very next step could fire while the
login request was still in flight: caught directly on a real run, a screenshot showed the "Sign
In" button still spinning while the following `navigate` had already fired, bouncing the whole
case back to the login page. An `expect(...).toBeHidden({timeout:10000})` auto-waits, so it costs
nothing when the login is fast and still covers a slow one (a cold serverless start) that a fixed
`waitForTimeout` could not — the two failure modes of a static sleep (too short to be safe, or a
tax on every run) don't apply to a condition-based wait.

Whether a given case receives the prefix is decided by comparing its `targetUrl` to
`AppModel.auth.loginUrl` (same-page comparison, `pageKey`) — not by
`credentialPolicyFor(testCase)`, which was tried first and was answering a different question
(see D-26).

**Consequences.** One place defines "how to log into this site" for the whole pipeline. The
tradeoff is that the login page must stay **in** the AppModel (not be replaced by the
authenticated pages, which an earlier version did) purely so the prefix's steps have something to
ground against — this is why `hybridDiscovery.ts` keeps both the pre- and post-login page models
rather than discarding the login page once it's served its purpose.

## D-25. Redaction is a value-level DOM-keyword guard, not a key-aware object walk

**Context.** `redactCredentials` JSON-stringifies its input and blind-replaces every occurrence of
a secret credential value. A real run's password was the literal string `"password"`, and blind
replacement turned `inputType: "password"` into `"[redacted]"`, `id: "password"` into
`"[redacted]"`, and `css: "#password"` into `"#[redacted]"` — eight structural fields destroyed,
after which `credentialFieldMap` could no longer find a password field at all and the generator
emitted a selector matching nothing. A first fix drafted here was a key-aware walk (only replace
inside content-shaped keys: `name`, `text`, `placeholder`, ...). It was rejected before shipping:
`redactCredentials` is also called on **raw strings** — `executor.ts` passes
`readFileSync(finalPageTxt, "utf8")` straight through it to scrub a served artifact — and a
key-aware object walk finds no keys in a bare string, so it would have silently stopped redacting
that file. A credential leak into a publicly served path (`TECH_DEBT.md` TD-14) is a worse outcome
than the corruption bug being fixed.

**Decision.** Refuse to redact a secret value that is itself an ordinary DOM/HTML keyword
(`password`, `email`, `user`, `username`, `login`, `submit`, `button`, `search`, `form`, `hidden`,
`admin`, `input`, `name`, `value`, `checkbox`, ...). Such a value was never concealed by redacting
it — the token is already all over ordinary markup — so skipping it trades zero confidentiality
for keeping the model intact. Every existing call site, string and object alike, is untouched.

**Consequences.** A password that happens to be a common DOM keyword is not redacted from artifacts
in the rare case it does appear verbatim in captured text — an accepted, explicit tradeoff, not an
oversight, and orthogonal to whether the login itself succeeds.

## D-26. Whether a case needs a login prefix is decided from its target page, not from `credentialPolicyFor`

**Context.** `credentialPolicyFor(testCase, ...)` answers "should this case's own field values be
replaced with real credentials?" — a question about a case's **content** — and returns `"full"`
only for `valid`/`fromPrompt` cases. The first version of the login-prefix gate reused that same
check to decide a completely different question: "does this case need a session before it starts
at all?" — a question about its **precondition**. Every other category (`invalid-input`,
`state-change`, ...) never received a prefix and ran logged out. Verified directly against a real
5-case suite: the two categories denied a prefix (an `invalid-input` search and a `state-change`
sign-out) both failed on the login page; the one case that correctly received no prefix (a
deliberate wrong-password login test) did so for the wrong reason — its category, not its target.

**Decision.** `needsLoginPrefix(testCase, auth)` — true whenever discovery authenticated and the
case's `targetUrl` is not the login page itself (`pageKey` comparison, the same one
`testCases.ts`'s login-case cap already uses, so the two can't disagree about what counts as a
login case). `credentialPolicyFor` goes back to deciding only what it was built for: field-value
substitution.

**Consequences.** Every case except ones genuinely about the login page now starts authenticated,
which is correct for an app that is entirely behind a login. A case with no `targetUrl` at all
defaults to receiving the prefix — a spurious login costs a few seconds; a missing one fails the
whole case, so the safer default is to sign in.

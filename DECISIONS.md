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

---

## D-27. A model proposes step TEXT and never writes — for both the rewrite and the translation

**Context.** Two features let a model touch a saved test's steps: "ask for a change" (describe an
edit in a sentence) and "write it for me" (a step line typed in loose English that the parser
cannot read). Either could have been built the obvious way — the model emits IR, the server stores
it. Both would then have been a *second way into the library*: a path where a test is authored by
something that has not looked at the site since the case was created, with no re-grounding, no
version diff, and no person in between.

The translation case makes the risk concrete. `parseIrStep` defines exactly eleven sentence shapes.
A model asked to produce IR directly is a model that can produce **any** shape — including one the
save path would accept structurally and then fail on at run time, weeks later, blaming an innocent
step.

**Decision.** Both features return **step text**, never IR, and **never save**.

1. The model is shown `STEP_VOCABULARY` — the one exported list, owned by `stepText.ts` next to
   the parser that defines it, never re-typed into a prompt file.
2. Every line the model returns is run back through **`parseIrStep`** on the server, before the
   proposal is shown. A sentence the parser cannot read never reaches a person.
3. The proposal renders as a diff. Approving it only **fills the editor** — the person still
   presses Save, still sees the estimate, still gets the re-ground and the new version.
4. Translation is **line-for-line**: a differing line count is a hard failure, and lines that
   already parsed are restored from the user's draft rather than taken from the model.

**Rejected: letting the model emit IR and validating it with Zod.** Zod proves the shape is
well-formed, not that the target exists on the page — that is what grounding is for, and grounding
happens on the save path the model would have skipped.

**Rejected: trusting the prompt's "keep the other lines identical" instruction.** A reworded
untouched line parses perfectly, so no gate catches it, and it silently converts a free save into a
browser walk the person never asked for. Rebuilding the list from the drafts makes the instruction
unnecessary to trust — which is D-03 ("prompt nudges are never the only guard") applied again.

**Consequences.** There is one parser, one grounder, one version history, and one approval step,
regardless of who wrote the sentences. The worst a misbehaving model can do is fail, and a failure
costs one call and no writes. It also means neither feature can ever restructure a test on its own:
translation fixes *wording*, and anything that adds or removes a step goes through the rewrite
card, where the person sees the inserted line in the diff before approving it.

## D-28

**Editing a generated case is applied to the batch, not to the accumulator or the ledger.**

`caseSelectionGate.ts` resolves a round and then calls `appendAcceptedCases` and
`appendRoundToHistory`, both of which address cases by position in `batch`. Folding the reviewer's
edits into that array between the decision and those two calls makes all of it correct at once:
the accumulator persists the edited case because that is what is at `batch[i]`, the pool cap counts
user-written cases because they are real members of the batch, and the ledger records final titles.
`caseAccumulator.ts` and `caseHistoryLedger.ts` were not modified.

**Rejected: an `origin` field on `TestCase`.** Any stage that needed to know whether a case was
model-written or hand-written would be a stage behaving differently for the same input, which is
the thing the gate exists to prevent. A written case is built through the real `TestCase` schema
and carries exactly the keys a generated one does; `tests/caseSelectionGate.test.ts` asserts the
key sets are equal so this stays true.

**Rejected: splicing a removed case out of the batch.** `selectedIndexes` means positions, so
deleting one would renumber everything after it and silently change what an index refers to.
Removal is "not selected" plus a client-side hide, which also gets the right ledger outcome:
the case is recorded as rejected, and rejection is what stops a later round proposing it again.

**The ledger records the EDITED case, as one record.** `getAllAcceptedCases` already returns edited
titles, so a second record for the original wording would let the pool and the ledger describe the
same case differently. The price, recorded rather than hidden: renaming a case unblocks the model's
original title, which a later round may then re-propose.

## D-29

**A model-proposed edit at the gate is not run through `parseIrStep`, and this does not weaken
D-27.**

`proposeRewrite` edits a saved case: an IR exists, its steps are grounded, and every proposed line
is re-checked by the real parser before a person sees it. A case at the selection gate has none of
those — it is plain English written minutes earlier, with nothing compiled and no page opened.
Constraining it to `STEP_VOCABULARY` would reject the model's own output, and parsing it would mean
parsing onto an IR that does not exist.

The vocabulary check is not skipped, only deferred to the stage that owns it: whatever survives
review is compiled by `toIR` and grounded against the live page exactly as an unedited case is.
`proposeGateRewrite` therefore cannot widen what the pipeline accepts, because it sits upstream of
every check in it. What it keeps from D-27 is what matters — it proposes, it returns sentences not
IR, and a person approves the round before anything is persisted.

## D-30. One credential waiter, but the resolution ORDER is per-caller

**Context.** Three callers need the same answer to the same question — "this is about to sign in;
where does the password come from?" A fresh run asks it in the orchestrator, the case editor's
re-ground walk asks it before walking, and a replay asks it before executing saved cases. The
replay path was built without asking at all, which is `TECH_DEBT.md` TD-66: every saved login case
failed at the login, with the reported error several steps away from the cause.

**Decision, part one — one waiter.** `resolveCredentialsVia`
(`src/server/resolveCredentials.ts`) owns parking: every caller reaches `askCredentials` through
it, so there is one waiter table, one `CREDENTIAL_WAIT_MS`, and one way to settle. A second parking
mechanism would mean a second timeout and a second way to leak a wedged promise. The emit is inside
the helper rather than left to each caller for the same reason: `askCredentials` only parks a
promise server-side, so without the event the UI never draws the form and the caller waits out the
full timeout against a screen that offered nowhere to type.

**Decision, part two — the order is a parameter, named at each call site.** The first version of
this file asserted a single policy ("env first, prompt second") for all callers. That was wrong,
and the two callers want opposite things for good reasons:

- **Replay uses `"prompt-first"`.** A replay is started deliberately by a person, on a server whose
  `TEST_USERNAME` / `TEST_PASSWORD` may be someone else's account entirely. **A credential someone
  types must beat one the server happens to be holding.** The environment is the fallback for a
  skipped or timed-out prompt.
- **The re-ground walk uses `"env-first"`.** It runs inside a save the person already asked for, so
  a prompt there is an interruption they did not initiate. An operator who has configured the
  environment gets a silent save.

Both are passed explicitly. A hidden default that silently suits one caller is exactly how the
first version went wrong.

**The cost of `"prompt-first"`, recorded rather than discovered later.** A replay of a login case
now always prompts, even when the environment could have answered, and an unanswered prompt parks
for the full `CREDENTIAL_WAIT_MS` **while holding one of the `MAX_CONCURRENT_RUNS` slots**. That is
a direct amplifier of the saturation described on `/api/health`'s `concurrency` block: three
ignored replay prompts wedge the default cap of three. The trade was made knowingly — correctness
about *whose* credential is used beats convenience — but if replays start queueing, this is the
first thing to look at.

**Rejected: reading the environment inside `runReplay`.** Fewer lines, but it drops the prompt half
entirely: an operator with nothing set gets the same empty-string failure, just later. The prompt
is what makes a saved login case usable by someone who is not the person who configured the server.

**Rejected: prompting unconditionally on replay.** A replay whose cases contain no `${env:...}` has
nothing to ask about. `credentialKindsNeeded` over every case's steps decides, so a replay that
does not sign in emits no event and behaves byte-for-byte as it did before D-30.

**Consequences.** No frontend change was required: `showCredentialPrompt` already defaults its post
URL to `/api/runs/<runId>/credentials`, and a replay's runId is a real run id that the existing
route settles. Any future execution path that runs stored steps inherits this obligation — if it
can reach a login, it must resolve credentials through this helper, not around it.

## D-31. Deterministic structural healing comes before the LLM heal

**Context.** `attemptHeal` (D-20) was the only self-heal, and it is expensive: it re-snapshots the
page in a real browser and regenerates a fresh IR through `toIR` (an LLM call) before re-running.
But the most common healable failure — a `selector_changed` / `element_missing` on an element that
still exists, just under a slightly different name or role — needs none of that. The AppModel
`groundingError` already has is the same structure heal would re-snapshot; if the element is still
there under a renamed accessible name, the fix is a structural re-match, not a model call.

**Decision.** Add a pure-code, feature-flagged pass ahead of the LLM path: `DETERMINISTIC_HEAL`
(default off). `attemptHeal` first tries `deterministicHeal.ts`'s `healStepTarget`, which re-matches
the failing step's role/name against the existing AppModel using the same tiered name matching as
`ir.ts`'s `bestNameMatch` (exact → glyph-stripped → prefix/suffix → substring), then regenerates the
spec and re-runs. Only when no structural match is found — or a deterministic re-run still fails —
does it fall through to the existing LLM re-snapshot path.

**Why this is the right order.** It follows CLAUDE.md's central rule: a deterministic guard over
AppModel *structure* (role, name, discovered css/testId) beats a text-based heuristic. It is also
cheap — zero LLM tokens, zero extra browser launch on the common path — so the heal becomes a
free fast-path instead of a budget-costing last resort. The returned `HealResult.deterministic`
flag lets the UI and `08`-style logs distinguish "healed for free" from "healed with a model call".

**Rejected: skipping the re-run entirely on a deterministic match.** Confidence in a structural
match (especially a weak substring match, tier 3) is not proof the healed spec passes. Re-running
with the corrected locator is what makes the heal honest — a heal only "counts" once its retry
passes, same rule as D-20.

**Consequences.** The flag is off by default, so flag-off runs behave byte-for-byte as before.
`deterministicHeal.ts` shares its name-matching shape with `ir.ts`'s `bestNameMatch` — a deliberate
TD-07-style duplication pinned by `tests/deterministicHeal.test.ts`, since extracting a shared
helper out of `ir.ts`'s closure is disproportionate for the size of the function.

## D-32. Containerization: Playwright Docker image, single-replica, tsx at runtime

**Context.** The app has never shipped in a container — `npm run serve` is the only way to run it,
and `runs/` plus caches live on the local filesystem. The containerization goal is a
`docker compose up` that is byte-identical to bare metal, plus a clear path to Azure Container
Apps hosting. Three main decisions clustered here: which base image, whether to compile TS or keep
tsx, and how to handle `/dev/shm` in ACA's constrained container runtime.

**Decision — base image: `mcr.microsoft.com/playwright:v1.49.0-noble`.** Pins the pre-installed
browser to the exact `1.49.0` the lockfile resolves (`package-lock.json: node_modules/playwright`).
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` is already set; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
makes the root `postinstall` a no-op so `npm ci` never re-downloads or mutates the pre-installed
browsers. The base image installs browsers with `--with-deps` so system libraries are present
without further Dockerfile steps.

**Decision — tsx at runtime, no compilation step.** The server runs TypeScript directly via
`tsx --import`. `tsx` and `@playwright/test` are therefore runtime dependencies; a container
built with `--omit=dev` breaks both the server and the executor. Docker layer caching makes
the `npm ci` layer fast after the first build, which justifies skipping a `tsc` pipeline: source
changes rebuild in seconds and the deployment is a single-layer-authentic copy of what the
developer runs locally.

**Decision — `CHROMIUM_EXTRA_ARGS` over a hardcoded flag.** Azure Container Apps cannot resize
`/dev/shm` (64 MB default; Chromium needs `--disable-dev-shm-usage` to avoid crashes on busy
pages). Rather than hardcoding the flag in the Dockerfile — which diverges bare-metal from the
container — a new env var is read by `src/browserLaunch.ts` and propagated to all five
browser-launching consumers identically. Unset locally, the container is byte-identical to
bare metal; set it in ACA, and every browser receives the flag including the generated spec's
Playwright runner.

**Decision — volume mount at `/app/runs`, no `RUNS_DIR` refactor.** All code resolves `runs/`
relative to `process.cwd()`. The Dockerfile sets `WORKDIR /app`; mounting `./runs:/app/runs` makes
the local and container filesystems identical without touching path resolution logic. A `RUNS_DIR`
env var would be cleaner but carries real regression risk — deferred to a separate change.

**Decision — single replica.** The credential prompt and case-selection gate both park a promise
in process memory (`pendingCredentials.ts`, `pendingCaseSelection.ts`). A restart or reschedule
drops the promise and wedges the slot for the full timeout. Horizontal scaling requires an
external scheduling layer — a distinct phase.

**Rejected: EmptyDir mount for /dev/shm.** `CHROMIUM_EXTRA_ARGS` achieves the same effect
portably. ACA does not support EmptyDir-style tmpfs mounts.

**Rejected: non-root `pwuser`.** The Playwright base image bakes in a `pwuser` account. ACA
volume permissions (Azure Files) require uid-based mount options and careful ownership alignment.
Root is retained with no current security downside — the container exposes one local HTTP port.

**Rejected: `npm run serve` as CMD.** `--env-file-if-exists=.env` is Node-version-dependent and
no `.env` exists in the image (`docker-compose.yml` supplies env vars via `env_file`).

**Consequences.** No health-check probe was added: `/api/health` returns 200 with
variable-presence metadata only and never returns non-200, so it is liveness-only. A meaningful
readiness check (Gemini key present, DB reachable) is deferred. `docs/phases/PHASE_CONTAINERIZATION_REPORT.md`
documents verification, rollback, and deferred items.

## D-29

**Azure OpenAI is a second LLM provider, selected per-role at the call site, with no fallback.**

The build's nine LLM call sites across seven files used to import `gemini()` directly. They now
go through `src/llm/client.ts`, which resolves a role (`'main' | 'lite'`) to a provider from
`LLM_PROVIDER` / `LLM_PROVIDER_LITE` (both defaulting to `"gemini"`) and calls either `gemini()`
(the existing function, unchanged) or `azureOpenAI()` (a mirror with the same `{content, usage}`
contract and the same ambient spend recording). An unset selector is byte-identical to the
pre-phase behaviour — the resolved model string is the one `gemini()` would have used anyway.

The stage-to-role map (all of planner/discovery/discovery-label/failure-analysis are cheap-model
stages except ir/testcases/rewrite/translate) lives only at the ten call sites — they say `role:`
and nothing about models, so a future provider needs no new routing.

**Rejected: automatic fallback from Azure to Gemini.** D-21's reason for one provider was
determinism and identical cost-reliability behaviour. A fallback quietly mixes billing, tenancy
(Azure credentials going to Google) and model pan-position, and every retry cost lands twice.
Two operators who disagreed about which "failed" run a run on would produce two different
answers — the inverse of D-02. A role is bound to one provider; a failure surfaces as the
failing provider's own error in the same backoff loop (`callWithPool` is shared, unchanged —
a one-key `KeyPool` on the Azure side).

**Rejected: per-run or per-organisation provider selection.** D-21 stands: an `orgLlmConfig`
cannot carry an Azure key, and a per-run provider would multiply the feature surface (request
shape, cache keys, validation) without a customer. `LLM_PROVIDER` is a cold environment switch,
read once per request. The per-org config remains Gemini-only: when a role's provider is Azure it
is ignored at the resolution point (comment on `LlmConfig` in `llmContext.ts`).

**Rejected: a separate retry loop for Azure.** The provider must reproduce gemini's one-key
behaviour exactly. It reuses `callWithPool` + `KeyPool` unchanged, sets `e.status`/`e.retryAfter`
the way gemini.ts does, and marks a content_filter refusal (`code: "content_filter"` in a 400
body) with a distinct error and NO `.status`, so `backoff.ts` sees "not a rate limit" and throws
it straight through — retrying a refusal would just re-bill the same blocked prompt.

**Cache keys carry the provider dimension.** `cacheModelDimension(role)` replaced the
`resolvedModel()/resolvedModelLite()` fragment of every key. Under gemini it still yields exactly
`gemini:<same model>`, so the only cost is a one-time cache miss (TD-22 / D-10: the non-expiring
disk cache must never serve one provider's answer to the other, and did before this — the key
did not know which provider ran). The `record()`/`recordAmbient()` spend lines in
08-llm-usage.json now carry a required `provider` field for the same reason: non-expiring cost
lines must name who billed them.

**Consequences.** Provider choice is a cold switch: an operator is either 100% Gemini or 100%
Azure (per role), which is what makes the cache-key and cost-line questions tractable. A
malformed `LLM_PROVIDER` value is a startup error, not a silent fallback, and `/api/health`
reports the four Azure variables' presence. The one-time gemini cache-key change is the price of
not disambiguating later, recorded here because D-10/TD-22 make the alternative unaffordable.

**Deployments and request shape (phase 2).** `AZURE_OPENAI_DEPLOYMENT`/`_LITE` name the "main"
and "lite" roles' deployments, expected on the org's subscription to be gpt-5-mini (main) and
gpt-4.1-mini (lite) — at the time of writing the only image-capable OpenAI models with non-zero
quota on the subscription. Main needs vision (screenshot grounding), which is why image capability
is the hard requirement; gpt-4.1-mini often lacks it entirely, and lite rarely sees images anyway.

Three request-shape rules follow from the model family:

- **`temperature` is NEVER sent**, on either deployment. The gpt-5 family rejects the parameter
  outright (callers — notably `ir.ts` — still pass `temperature: 0.2` on a shared opts type; the
  azure body simply never maps it, so IR's 0.2 becomes a no-op rather than a 400).
- An output cap maps to **`max_completion_tokens`**, never `max_tokens` — the two count
  differently on gpt-5, and `max_tokens` is not a supported alias there.
- **`reasoning_effort`** is sent per role: `AZURE_OPENAI_REASONING_EFFORT` (default `"low"`, the
  pipeline's one knob over completion cost on a reasoning model) — always on main; lite sends the
  parameter only when `AZURE_OPENAI_REASONING_EFFORT_LITE` is set, and never falls back to the
  main variable, because gpt-4.1-mini rejects the key (it is not a reasoning model). undefined in
  code means "omit the key from the body".

`usage.completion_tokens_details.reasoning_tokens` is read when present so a stage's
08-llm-usage.json line can say how much of its completion spend was internal reasoning; gemini's
thoughts tokens are not separately reported, so the field is 0 on that provider. The azure cache
fingerprint is ALWAYS `"env"` — the lockstep org config is Gemini-only, so splitting the azure
cache per tenant would serve identical env credentials different answers by tenant, the inverse of
TD-22.

### D-31. The lockstep LLM cache is hardened by refusing negatives and by a version salt (LLM cache hardening)

`TECH_DEBT.md` TD-94 records run `2026-09-16T07-10-56-871Z-2a364a79`: a cached **zero-case** answer
was served forever, so later runs made zero LLM calls and reported no test cases. Two decisions
closed it, and both are worth recording because they resolve latent tensions with D-10/TD-22:

- **"No answer" is never a cacheable answer.** Every LLM stage had already moved its cache write
  AFTER schema/structural validation (that was a fact of the code, not this phase's work); what was
  missing was rejecting validation *output* whose case count is zero. `isCacheableResult` now
  refuses empty/whitespace, unparseable-requested-JSON, and parsed-empty structures, and
  `llmCacheSet` independently refuses the same negatives as a belt. Coupled with the typed
  `NoTestCasesError` (a zero-case generation is a **stage failure** — raw response saved, run ends
  blocked — never a clean empty success, and never a `no_cases_selected` round), the cache cannot
  hold what D-10 says must never be shared: an answer that contains none.
- **The version salt is a second knob beside the key dimensions.** D-10's dimensions keep tenants
  and providers apart; `LLM_CACHE_VERSION` is the *time* dimension — one variable, audited inside
  every `makeCacheKey`, defaulting to `"1"`. Because the key includes it, bumping it discards every
  cached LLM answer in one move. It is deliberately **not** an off-by-default feature flag: its
  default IS its value ("cache-version 1"), and being present in the key is what guarantees a bump
  is observable. The one cost recorded in TD-94: the salt also covers the walk/replay cache (all
  six key sites share the shape), so a bump re-walks live pages once — deterministic browser work,
  not model spend, and a price paid knowingly so there is a single, kitchen-sink "clear the whole
  store" control.
- **A truncated or refused Azure answer is an error, not a result — and the two silent
  "nothing was generated" causes are separated structurally, not by re-reading the raw dump.**
  The delta evidence run (Azure gpt-5-mini, ~26 visible tokens parsed to `[]`) could have been
  either hypothesis A (the output cap cut the answer off mid-object) or hypothesis B (the model
  wrapped the array in an envelope a strict `Array.isArray` missed) — indistinguishable from
  `03-cases-raw.txt` alone. Prompt wording forbidding envelopes would be the D-02/D-03 failure in
  another suit, so the code tells them apart deterministically: `finish_reason === "length"` and a
  non-empty `message.refusal` throw (plain `Error`, no `.status`, so `backoff.ts` — which keys on
  `.status`/429/503 — throws them through unretried), and the finish reason rides out of the stage
  in `NoTestCasesError`. Envelope-wrapped answers are recovered by `unwrapArray`, applied **only**
  where a top-level array is expected (testCases) rather than bolted onto object-expecting stages
  where it would silently sidestep their schema checks.
- **A prompt may not demand what the provider's JSON mode cannot produce.** The truncation delta
  was followed by run `2026-09-16T10-14-09-905Z-0bb5a291`, where Azure gpt-5-mini answered the
  bare-array testCases prompt with `{"error":"Assistant must output only a JSON array. Please
  retry."}`. OpenAI's `json_object` mode requires a top-level OBJECT; Gemini's JSON mode accepts a
  bare array. The same prompt therefore worked on gemini and failed on azure — a provider-shaped
  defect, invisible to any gemini-only test. The fix is `jsonEnvelope`: the stage states its
  expectation ("array"), azure is instructed to return it wrapped as `{"<key>": [ ... ]}` (one
  added system line, `response_format` unchanged), and `unwrapArray` recovers it deterministically
  — the acceptance check is still structure + zod, not prompt prose. The option is deliberately
  **never forwarded to gemini**, whose prompt stays byte-for-byte the bare-array ask, and
  `tests/llmClient.test.ts` pins that. Rationale for choosing this over OpenAI `json_schema`
  structured outputs: the case schema is large and evolving, the deterministic check already
  exists on the array shape, an instruction line is provider-agnostic where a second schema would
  be azure-specific, and it keeps the bare-array ask identical under gemini. General rule this
  records: *any* stage whose prompt asks for a top-level array must pass `jsonEnvelope`.

## D-33. Recovering a run view after a poll failure means replaying the whole event stream

**A dropped connection is repaired by re-deriving the view from the event log, not by resuming
forward from where the client stopped.**

`connectToRun` keeps a one-directional `seen` cursor and applies `events.slice(seen)`. That is the
right shape for the steady state and the wrong shape for recovery: the stage cards are written *as
each event is applied*, so an event that never arrived left its card on a stale value with nothing
left to move it. On the first good read after a failure the loop now calls `resetRunUI()`, sets
`seen = 0`, and re-applies the full stream.

**This is the reload path, not a new mechanism, and that is the whole argument.** `applyEvent` is
already required to be re-appliable from the start, because loading `#/run/<id>` after a reload does
exactly this. So the fix adds no new rendering concept, no second render function, and no state
machine to keep in sync with the first one — it reuses the one path that was already correct.
Everything `applyEvent` accumulates is reset by `resetRunUI()` first: `phaseStageStatus` through
`renderPhases`, and the heal counters through `hideSuiteResults`. The latter is not tidiness — the
primary-heal counter is a `+= 1`, so an unreset replay would double-count heals.

**Rejected: a snapshot endpoint** (`GET /api/runs/:id/state` returning current derived state
alongside the log). Strictly better on paper — no replay flicker, no re-run of side effects, and it
would also have removed the stale-response window behind TD-15. Rejected on cost and shape: it adds
a route, a second state representation that can drift from the event log, and a decision about who
owns the derivation — three new places for this class of bug to live, to fix a client that already
has a working re-derivation path. If the flicker below ever proves genuinely costly, this is the
entry to revisit, and it should be revisited deliberately rather than by accident.

**Rejected: hold the last-known stage per phase and patch forward.** Cheaper than a replay, and it
keeps the live view stable. Rejected because it re-implements a *second*, partial derivation of the
view that has to stay consistent with `applyEvent` forever — the precise anti-pattern the structural
rule in `AGENTS.md` warns about, in a different costume.

**The cost, stated rather than discovered.** A full replay re-runs every `applyEvent` side effect,
so credential prompts and case-selection panels visibly replay on recovery. That is precisely the
behaviour of a manual reload, and it is still better than a view frozen forever — but it is a
visible artifact of this decision, not an invisible one.

**The guard that keeps this from becoming a regression.** The replay is conditional on `fails > 0`,
not unconditional. Replaying on *every* poll would rebuild the run view once a second and make a
live run flicker instead of update — a fix that passes its own test and makes the product worse. It
is pinned from both sides: one test asserts the pre-outage event is applied a second time, another
asserts a healthy poll rebuilds nothing.

## D-34. `401` is an expired session; `403` and `404` are an unavailable run, and the run poll must never conflate them

**The run poll branches on the HTTP status, and the branch is drawn by whether signing in again
could possibly help.**

- **401** — stop, say the session expired, clear the session, route to sign-in, and **preserve the
  run id** so signing back in lands on that run rather than the home screen. Re-authenticating is
  precisely the remedy, and the run is still there.
- **403 / 404** — stop and say the run is no longer available. **No route to sign-in.** Re-signing-in
  cannot grant access to a run that has been deleted or belongs to another organisation, so the
  login screen is a dead end: the user authenticates successfully and arrives at the same 403.
- **Everything else** — network errors, 5xx, a non-array payload — stays transient and keeps
  retrying. That is the case the retry exists for, and a fix that swallowed it would be a new bug.

**Why this distinction is the whole entry.** The old loop never looked at the status at all, so all
three landed in one `catch`. The waste is minor. The misclassification was not: `requireRunRole` in
`src/server/authz.ts` raises 403 when a run has no provable ownership record, which is exactly what
retention pruning leaves behind — so a 403 reads as "session expired" and sends a legitimate user
into a sign-in loop with no exit and no message explaining it.

**Status is inspected before `res.json()`.** An error body is `{error: "..."}`, not an event
array; parsing first and checking the parsed shape conflates "the server said no" with "the server
sent something malformed", and the two want opposite handling.

**404 is defensive, and is labelled as such in both the code and `TECH_DEBT.md`.** `/state` returns
`getEvents()` straight from the run store, which yields `[]` for a missing directory, so it does not
404 today — verified against `src/server/index.ts` and `src/runStore.ts`. The branch is kept so a
future route change cannot drop a missing run into the transient path and poll it at 1Hz forever. It
is written as a defensive branch rather than dressed up as a live one, because a comment claiming a
behaviour the server does not have is worse than no comment.

**Rejected: treat 403 as 401 and let the user discover the problem after signing in.** Cheaper, and
it is what a single "not authorised → re-authenticate" rule would produce. Rejected because it
sends the user through a pointless round trip to reach an error they could have been told
immediately, and because it is the more plausible-looking of the two rules — which is exactly why it
needed writing down.

**Also decided here, for the same reason (it is the same "can re-authenticating help?" question):**
signing out **stops the poll** by bumping `pollGeneration` before clearing any state, and asks for
confirmation **only** when `(currentRunId && !currentRunFinished) || runInFlight`. Both halves are
client-side, so neither costs a server round trip — notably, the confirmation must not depend on a
request that fails precisely when the connection is bad. Native `confirm()` is retained because all
six other destructive asks in `public/app.js` are native, and a styled modal would mean minting a
CSS class (platform rule 3).


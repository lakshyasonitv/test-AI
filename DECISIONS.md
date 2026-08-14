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

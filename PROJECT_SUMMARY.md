# AI Test Platform — Project Summary

## What This Is

Give it a URL and a plain-English testing request (e.g. *"check the login page and
functionality"*) — it discovers the app's real UI, writes a full QA coverage suite (valid path,
invalid input, boundaries, security), converts each case into a strict, schema-validated
execution plan, generates real Playwright specs from that plan, runs them in real browsers, and
reports per-case pass/fail with screenshots, traces, and plain-English failure diagnosis. The
difference from writing Playwright tests by hand isn't just speed — every generated assertion is
checked against what the live page actually contains before it's allowed to ship, so a wrong
guess about site wording gets caught and corrected rather than silently producing a flaky test.

## Architecture

```
                              prompt + url
                                   |
                                   v
                        ┌─────────────────────┐
                        │   Planner (Gemini)   │  NL request -> structured Plan (scope, steps)
                        └──────────┬───────────┘
                                   v
                        ┌─────────────────────┐
                        │      Discovery       │
                        │  DOM extract (Node,  │  domExtract.ts — cheerio over page.content(),
                        │    NO LLM) --------- │  zero tokens, tried first for every page
                        │  Gemini Vision       │  fallback only: canvas/captcha/image-heavy,
                        │    (fallback)        │  or no accessible name/text to key off
                        └──────────┬───────────┘
                                   v
                            AppModel (elements as
                            accessibility role+name,
                            per page, cached by URL)
                                   |
                                   v
                        ┌─────────────────────┐
                        │  Test Cases (Gemini) │  Plan + AppModel + coverage taxonomy (floor,
                        │                      │  not ceiling) -> full suite: valid /
                        │                      │  invalid-input / empty-boundary / security-* /
                        │                      │  functional-other, capped by coverage budget
                        └──────────┬───────────┘
                                   v
                     Primary-case selection: the case
                     tagged fromPrompt (literal ask),
                     else highest priority
                                   |
                                   v
                        ┌───────────────────────────────────────────────┐
                        │            IR Generation (Groq)                │
                        │                                                 │
                        │  TestCase + AppModel + sourcePrompt             │
                        │       |                                        │
                        │       v                                        │
                        │  credentialPolicyFor(case) --> full /           │
                        │       identifier-only / none                   │  <- decided from case
                        │       |                                        │     wording BEFORE any
                        │       v                                        │     substitution happens
                        │  generate strict JSON IR (steps: navigate/      │
                        │  fill/click/assert, each grounded against       │
                        │  the AppModel)                                 │
                        │       |                                        │
                        │  ungrounded step? ──> live-extend: replay the   │
                        │       ^               grounded prefix in a REAL │
                        │       |               browser (policy-aware —   │
                        │       |               only the case's FINAL     │
                        │       |               credential attempt gets   │
                        │       |               substituted), discover +  │
                        │       └───────────────model the new page, retry │
                        │                       (capped, MAX_LIVE_EXTENSIONS)
                        │       |                                        │
                        │  terminal step is pure text? ──> replay once    │
                        │       more, read the REAL page text, correct    │
                        │       the guess instead of trusting it          │
                        │       (groundTerminalTextAssertion)             │
                        │       |                                        │
                        │  applyCredentials: substitute real values       │
                        │  (or an env-var reference for secrets — never   │
                        │  the literal, since runs/ is served publicly)   │
                        └──────────────────────┬──────────────────────────┘
                                   v
                        ┌─────────────────────┐
                        │  Generator (no LLM)  │  IR -> *.spec.ts, one test.step() per IR step
                        └──────────┬───────────┘
                                   v
                        ┌─────────────────────┐
                        │  Suite Runner        │  every selected case gets its OWN Playwright
                        │  (no LLM)            │  test() -> fresh browser context, no shared
                        │                      │  session/cookies between cases
                        └──────────┬───────────┘
                                   v
                     failed? ──────────────────────────────┐
                        |                                   v
                        |                        ┌─────────────────────┐
                        |                        │ Deterministic        │  pattern-matches the
                        |                        │ classifier (no LLM)  │  Playwright error first,
                        |                        └──────────┬───────────┘  free and instant
                        |                                   v
                        |                        Gemini diagnosis (ambiguous
                        |                        cases only) -> plain-English
                        |                        explanation + suggested fix
                        |                                   v
                        |                        selector/element drift? ──> bounded self-heal
                        |                        (<=1 attempt): re-snapshot the live page
                        |                        (policy-aware), regenerate IR, re-run once
                        v
              per-case artifacts: screenshots, trace, generated spec, IR, diagnosis
                                   |
                                   v
                     07-suite-summary.json (X/N passed) served to the live UI
```

## What Works Beautifully and Correctly

- **DOM-first discovery at zero LLM cost.** `domExtract.ts` reads the real page structure via
  cheerio — no tokens spent — and vision is only consulted when DOM extraction genuinely has
  nothing to work with.
- **Deterministic grounding against the live app**, not LLM self-report. Every generated step's
  target is checked against a real AppModel; a terminal pure-text assertion is replayed in an
  actual browser and corrected against what the page really says, rather than trusting the
  model's first guess.
- **Credential-policy-aware substitution for the standard case.** `credentialPolicyFor` correctly
  distinguishes full / identifier-only / none per case from its own wording (a negative
  "invalid password" case keeps its deliberately-wrong value; a real login gets the real one) —
  solid for the common single-login-attempt case. (A case that embeds *two* login attempts in one
  browser session is a known open edge — see next steps.)
- **Self-healing locators**, bounded to one attempt: a drifted selector triggers a fresh page
  snapshot and IR regeneration rather than a hard failure.
- **Isolated per-case execution.** Every case in a suite runs in its own Playwright `test()` —
  its own browser context, no leftover session state from a case that ran before it.
- **Deterministic failure triage before spending an LLM call** — pattern-matching on the actual
  Playwright error classifies most failures for free; Gemini is only consulted when the pattern
  match is ambiguous.
- **Secrets never touch disk.** User-supplied credentials become `${env:...}` references in the
  generated spec, not literals — `runs/` is served publicly by the app, and the real value is
  injected only into the test process's environment at execution time.

## Five Next Steps for Enterprise Readiness

1. **Add server authentication and per-request authorization.** Right now anyone with the URL can
   start a run or browse another run's artifacts (screenshots, generated specs, diagnosis) — fine
   for a trusted audience, a blocker for anything shared more broadly.
2. **Fix cross-leg credential handling for multi-attempt cases**, and while there, correct the
   diagnosis tool's step-ID attribution — confirmed against a real run where `analyzeFailure`
   reported a different `failingStepId` than the raw Playwright trace actually showed. Both are
   trust issues: a user reading a wrong diagnosis (or a case failing for a reason the report
   doesn't explain) has no way to tell the pipeline is right without re-deriving it themselves.
3. **Move persistence off local disk.** `runs/` is a plain directory and the run cap is an
   in-process semaphore — both are fine for one box, neither survives a restart cleanly or scales
   past it. The seam is already partly there (`RunStore` in `src/runStore.ts` is an interface,
   not a hardcoded filesystem call) — it needs an actual second implementation (S3/Postgres-backed)
   to go further.
4. **Add multi-user isolation** — per-user runs, quotas, and history, instead of one shared,
   globally-visible run list.
5. **Extend deterministic assertion validation beyond the terminal step.** Grounding currently
   covers role+name targets and the case's *final* pure-text assertion; a mid-case free-text
   assertion (which the reorder-based compound-case work surfaced as a real gap) has no
   equivalent check yet.

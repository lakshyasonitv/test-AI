# AI Test Platform — Project Summary

## What This Is

Give it a URL and a plain-English testing request (e.g. *"check the login page and
functionality"*) — it discovers the app's real UI (following the site's own internal links, not
just the one page you typed), writes a full QA coverage suite (valid path, invalid input,
boundaries, security), optionally pauses for you to review and refine that suite before anything
runs, converts each case into a strict, schema-validated execution plan, generates real
Playwright specs from that plan, runs them in real browsers, and reports per-case pass/fail with
screenshots, traces, and plain-English failure diagnosis. The difference from writing Playwright
tests by hand isn't just speed — every generated assertion is checked against what the live page
actually contains before it's allowed to ship, so a wrong guess about site wording gets caught
and corrected rather than silently producing a flaky test.

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
                        │  Site crawl -------- │  follows the entry page's own same-origin
                        │    (same-origin)     │  links too, bounded (MAX_DISCOVERY_PAGES)
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
                        │                      │  functional-other, capped by coverage budget,
                        │                      │  checklist itself filtered by scope first
                        └──────────┬───────────┘
                                   v
                     Case-selection gate (OPTIONAL,
                     ENABLE_CASE_SELECTION_GATE): pause,
                     let a human accept/reject/refine the
                     batch before anything executes. Off
                     by default -> straight through.
                                   |
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

- **DOM-first discovery at zero LLM cost, now site-wide.** `domExtract.ts` reads the real page
  structure via cheerio — no tokens spent — and now also follows the entry page's own
  same-origin links (bounded, `MAX_DISCOVERY_PAGES`) instead of modeling only the one URL you
  typed. Vision is only consulted when DOM extraction genuinely has nothing to work with.
- **Deterministic grounding against the live app**, not LLM self-report. Every generated step's
  target is checked against a real AppModel; a terminal pure-text assertion is replayed in an
  actual browser and corrected against what the page really says, rather than trusting the
  model's first guess. The model is also told a page's `title` field is `<title>`-tag metadata,
  not visible content, and steered away from grounding a general visibility check on a
  mobile-menu toggle — both root-caused from real failed runs, not hypothetical.
- **A human can sit in the loop, opt-in.** The case-selection gate pauses a run after generating
  a batch so cases can be reviewed and a "not satisfied" refinement regenerated against the full
  history of what's already been accepted or rejected — enforced in code (`filterNovelCases`),
  not just requested in the prompt, so a repeat can't slip through.
- **Credential-policy-aware substitution for the standard case.** `credentialPolicyFor` correctly
  distinguishes full / identifier-only / none per case from its own wording (a negative
  "invalid password" case keeps its deliberately-wrong value; a real login gets the real one) —
  solid for the common single-login-attempt case. (A case that embeds *two* login attempts in one
  browser session is a known open edge — see next steps.) No site gets special-cased with
  built-in demo credentials anymore — every login gate goes through the same general prompt flow.
- **Self-healing locators**, bounded to one attempt: a drifted selector triggers a fresh page
  snapshot and IR regeneration rather than a hard failure.
- **Isolated per-case execution.** Every case in a suite runs in its own Playwright `test()` —
  its own browser context, no leftover session state from a case that ran before it.
- **Deterministic failure triage before spending an LLM call** — pattern-matching on the actual
  Playwright error classifies most failures for free; Gemini is only consulted when the pattern
  match is ambiguous.
- **Secrets never touch disk.** User-supplied credentials become `${env:...}` references in the
  generated spec, not literals, and are also scrubbed from every artifact a page might echo them
  into (`results.json`, `final-page.txt`, error-context) — `runs/` is served publicly by the app,
  and the real value is injected only into the test process's environment at execution time.
- **A case's screenshot actually shows what it tested.** The representative image per case is
  the LAST step captured, not the first — a "navigate to Services" case shows Services, not the
  homepage it started from.

## Five Steps to Make the Backend Genuinely General-Purpose

Not future features — structural gaps in the pipeline today that limit it to sites shaped like
the ones it's been tuned against (login/e-commerce), rather than truly arbitrary sites.

1. **The only "handle a blocking form" mechanism is login-shaped, not general.**
   `credentials.ts` + `pendingCredentials.ts` + the server's pause/ask flow exist ONLY for
   username/password. A cookie-consent wall, an OTP/2FA step, an age gate, a region-select modal,
   or a popup covering the real target — none of these have any equivalent handling. Discovery and
   IR generation have no general concept of "a form is blocking the target element"; they either
   silently miss the real element or produce an IR that never gets past the gate. This is the
   direct, structural reason the pipeline is currently tuned to auth-shaped sites specifically.
2. **Wording-based detection, not structural, is used beyond login fields.** `credentials.ts`
   guesses field purpose from English regexes (`PASSWORD_NAME`, `AUTH_WORDING`,
   `REGISTRATION_URL`); `credentialFieldMap` proved a better pattern — read the DOM's own
   `inputType` instead of guessing from wording — but only for login fields. `executor.ts`'s
   `detectBlocked` has the same fragility: it recognizes an OTP/CAPTCHA gate purely by matching
   English phrases ("verification code", "captcha") against page text, can only detect and report
   the block, not resolve it, and won't recognize a non-English or unconventionally-worded gate
   at all.
3. **The coverage taxonomy's deterministic guarantee only covers six named concepts**
   (`testStrategy.ts`: login/signup/search/checkout/cart/contact). `testCases.ts` does instruct
   the model to reason from first principles about concepts the taxonomy misses, with extra weight
   on the gap (`unmatchedConcepts`) — not a silent fallback — but that's a prompt instruction, not
   a guaranteed floor. A booking system, a wizard, or a file-upload flow gets coverage quality that
   depends entirely on the model's reasoning about an unfamiliar shape, with no guaranteed minimum
   the way the six named concepts get.
4. **The IR/credential-policy system has no first-class notion of state within one flow.** A test
   case gets exactly one `CredentialPolicy` for its entire step list; `applyCredentials` decides
   per-step only by pattern (registration-leg URL, last-occurrence-of-a-kind). This is why a
   compound flow (real login, then a second attempt) is fragile — the pipeline doesn't model "this
   flow transitions between states," only "this whole case gets one policy." Concretely open right
   now, not just theoretical: a compound-login case shape currently fails roughly half the time in
   production depending on whether the model happens to order its own steps favorably, and the
   same class of bug will recur for any other stateful flow (an invalid coupon then a valid one, a
   failed validation then a correction, a multi-step checkout).
5. **Pausing for a human is still purpose-built per case, not a general primitive.** Two
   pause-and-resume mechanisms exist now — `askCredentials`/`pendingCredentials.ts` for login
   details, and `pendingCaseSelection.ts` for reviewing/refining the generated case batch — and
   they don't share an abstraction; a third need would mean a third bespoke implementation. More
   importantly, there is still no way to pause for any OTHER required input discovery cannot
   infer — a real API key, a specific coupon code, a phone-number format a site validates
   strictly, a required file upload. On any site whose critical flow needs a real, human-supplied
   non-login value mid-flow, the pipeline's only fallback is inventing a placeholder that fails
   validation.

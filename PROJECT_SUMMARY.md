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
- **Deterministic grounding against the live app**, not LLM self-report — and it now covers
  *every* kind of target the model can invent, not just some of them. A **role+name** must match a
  real discovered element (with a narrow `link`/`button`/`menuitem`/`tab` fallback, because SPA
  navigation is routinely built from the "wrong" tag — a sidebar item as `<button onClick=...>`
  rather than `<a href>` — with the real role written back onto the target). A **css selector**
  must be one discovery actually captured. A **navigate URL** must be a discovered page or a
  discovered link's href, never a route guessed from a feature's name ("go to the Admin section"
  → `/admin`, which on a client-routed app quietly loads a blank page and takes every later step
  down with it). An element recorded as **hidden** can't be the target of a `visible` assertion,
  and element visibility is itself re-checked against real computed style in the live page rather
  than assumed. A terminal pure-text assertion is replayed in an actual browser and corrected
  against what the page really says. Every one of these was root-caused from a specific failed
  run, not designed speculatively.
- **Prompt instructions are never the only guard.** Three of these bugs recurred *after* being
  "fixed" with a system-prompt rule alone. The prompt rules remain as cheap first-line steering,
  but each now has a deterministic check behind it — an LLM instruction is a preference, not a
  constraint, and the difference only shows up on the run where the model ignores it.
- **A human can sit in the loop, opt-in.** The case-selection gate pauses a run after generating
  a batch so cases can be reviewed and a "not satisfied" refinement regenerated against the full
  history of what's already been accepted or rejected — enforced in code (`filterNovelCases`),
  not just requested in the prompt, so a repeat can't slip through.
- **Credential-policy-aware substitution for the standard case.** `credentialPolicyFor` correctly
  distinguishes full / identifier-only / none per case from its own wording (a negative
  "invalid password" case keeps its deliberately-wrong value; a real login gets the real one) —
  solid for the common single-login-attempt case. (A case that embeds *two* login attempts in one
  browser session is a known open edge — see next steps.) No site gets special-cased with
  built-in demo credentials anymore — credentials come from exactly two general sources: pulled
  out of the prompt when the user typed them there, otherwise the same `askCredentials` UI flow
  every login gate goes through. A prompt-derived case now always gets the verified real value
  substituted rather than trusting the model copied it into the case text faithfully — it
  routinely hadn't, inventing a placeholder instead.
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
- **An IR that stops early is caught, not just one that's badly formed.** `missingActions` used to
  only check that *some* `fill` and *some* `click` existed anywhere in the IR — an IR that logged
  in and then stopped could still report a 5-step case "passed" with nothing after login ever
  checked. It now counts the case's own named actions against what the IR actually carries out and
  rejects when the IR falls meaningfully short.
- **A prompt naming credentials twice no longer silently substitutes the wrong one.** The
  extraction that pulls a real username/password out of prompt text used to prefer whichever
  mention happened to be quoted — so a prompt whose real (unquoted) login email came before an
  unrelated (quoted) email later in the same sentence would substitute the *wrong* one into the
  login form, break authentication for the whole run, and surface only as a confusing downstream
  "element not found" failure. Fixed to always take the earliest mention regardless of quoting.
- **The entry URL is validated before anything touches it.** Discovery used to accept any string
  that didn't fail `new URL()` — which a `file://` path or an internal-network address both
  satisfy — so a crafted URL could make the server read a local file or reach an internal service,
  with the result landing in a publicly-served run directory. Now allow-listed to `http`/`https`
  with loopback/link-local/RFC1918 hosts rejected, at the API boundary and again in discovery.

## Six Steps to Make the Backend Genuinely General-Purpose

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
6. **The user's own instructions are paraphrased by an LLM before any deterministic stage sees
   them.** The prompt goes through `planner.ts` and `testCases.ts`, both of which rewrite it as
   free prose, and only then reaches IR generation. That paraphrase is lossy in ways that change
   behavior: an explicit "click on Admin" came back as "Navigate to the Admin section via the
   sidebar" — which the IR stage read literally and turned into a guessed URL — and explicit
   "wait 3 sec" instructions were dropped entirely. The guessed-route case is now caught
   deterministically downstream, but that's containment, not a fix: nothing carries the user's
   *literal, verbatim* intent (a named control, an explicit wait, an exact value) through the
   pipeline as structured data that later stages must honor. `promptSelectors.ts` does exactly
   this for CSS selectors the user writes, and is the model worth generalizing — the same idea
   applied to named controls, waits, and literal values would make every downstream stage
   accountable to what was actually asked for rather than to a model's retelling of it.

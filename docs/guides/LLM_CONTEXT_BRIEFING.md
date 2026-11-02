# Testbench — self-contained briefing for an LLM with no repo access

**Snapshot date: 2026-09-05**, describing commit `eca7dee` on `main`. Everything below was true of
the codebase on that date. Regenerate this file rather than patching it — it is a copy by design.

**Read this first, and say it back to the user if it matters:** this file is a *copy* of facts that
live elsewhere, written for a model that cannot open the repository. It will drift. If you can read
the repo, close this file and read `CLAUDE.md`, `ARCHITECTURE.md`, `TECH_DEBT.md`, `DECISIONS.md`
and `README.md` instead — those are the authority, this is not. Never let this file win an argument
against the actual code. Numbers here (test counts, file counts, TD/D numbers) are the most
perishable part; treat them as "roughly this, as of the date above".

---

## 1. What the product is

A pipeline that turns **a natural-language testing request + a URL** into **executed Playwright
tests**. Not generated tests you then run — tests it actually runs, against the real site, and
reports on with screenshots and video.

A person types something like *"Test the login functionality with valid credentials and check the
admin panel is reachable"* plus `https://example.com`, and the system plans, explores the live
site, writes a suite of test cases, compiles the chosen ones into a strict intermediate format,
generates real Playwright code, runs it in a browser, and diagnoses whatever failed.

It is a web app (Express + a vanilla-JS frontend), not a library or a CLI-first tool, though a CLI
entry point exists.

## 2. The pipeline, end to end

```
prompt + url
  → Planner (Gemini)              → a structured test plan
  → Discovery                     → "AppModel": every page's elements as accessibility role + name
       ├ DOM extraction (primary) → cheerio over page.content(). No LLM, no tokens, common path
       ├ generic clickables       → div/span/li that behave as controls but carry no role
       ├ visibility recheck       → real computed style, replacing the parser's assumed visible
       ├ auth-aware login         → detects a live password field, signs in, verifies the session,
       │                            and RECORDS the steps it took
       ├ same-origin crawl        → follows the entry page's internal links, bounded; also probes
       │                            JS-only nav when the href pass finds nothing
       └ Gemini Vision (fallback) → only when DOM extraction finds nothing usable
  → Test cases (Gemini)           → a coverage suite: valid / invalid / boundary / security
       ├ case-selection gate      → OPTIONAL, flag-gated: pauses for human review + regeneration
       └ login-case cap           → at most one case targets the login page itself
  → Primary-case selection        → the `fromPrompt` case, else highest priority
  → IR generation (Gemini) + grounding
       ├ login prefix             → discovery's recorded login replayed as ordinary steps, so the
       │                            spec starts authenticated in its own fresh browser
       ├ groundingError(ir, model)→ THE deterministic authority over every target kind
       ├ credential policy        → full / identifier-only / none, decided before substitution
       ├ live-extend              → reaches pages beyond the entry page, from the SAME session
       └ truncation (fallback)    → a real partial test rather than a hard failure
  → Playwright generator (NO AI)  → a standalone *.spec.ts, one test.step() per IR step
  → Suite runner (NO AI)          → each case in its own Playwright test() and browser context
  → Failure analysis (only on failure)
       ├ auth-bounce check        → deterministic: ended back on the login page? say so first
       ├ deterministic classifier → pattern-matches Playwright errors (free)
       ├ Gemini vision fallback   → only for genuinely ambiguous failures
       └ bounded self-heal (≤1×)  → re-snapshot, regenerate, re-run once
```

## 3. The central design rule — the thing to understand before anything else

> **An LLM instruction is a preference, not a constraint.**

Every prompt-level rule given to the model is expected to have a **deterministic check behind it in
code**. The reference example is `groundingError()`: every kind of target a model can invent — a
role+name, a CSS selector, a navigation URL — has its own verifier against the *real discovered
page*, not against the model's own claim that it did the right thing.

**The recorded failure mode of this rule**, which has bitten the project repeatedly: a
"deterministic" check written as a **regex over LLM-authored prose** (case titles, step text, page
copy) is *not* deterministic — it inherits whatever the model or the page happened to say. The
canonical example is a guard that rejected a perfectly correct test because the page's own heading
contained the word "Click".

**So: when writing a new guard, check structure — a role, a schema field, a discovered element —
never wording.** If you find yourself proposing a regex over English that a model or a website
wrote, that is the smell this codebase is most allergic to.

## 4. Rules that must not be broken

These are enforced by convention and review, and violating them is how this project has broken
itself before:

1. **Never change an existing route's request or response shape.** The frontend reads these shapes
   in dozens of places. New functionality gets a NEW route; an existing route may gain **optional**
   fields only — never renamed, removed or reordered ones.
2. **Every new capability ships behind an env flag defaulting to OFF.** With all flags off, the
   tool behaves exactly as it did before the feature existed.
3. **Never touch CSS class names.** The frontend drives the entire UI by toggling documented class
   contracts. Reuse an existing class rather than minting one.
4. **Real credentials never touch disk or the database.** They live in process memory for the
   length of one run. Stored steps keep `${env:...}` references, never literals. `runs/` is served
   over HTTP, so anything written there is effectively public.
5. **A model proposes, it never writes.** Every model-authored change to a saved test comes back as
   step *text*, is re-checked by the real parser, is shown as a diff, and is approved by a person
   before it enters the ordinary save path.
6. **Flag-off must still run flag-on's code path.** Auth-disabled substitutes a synthetic local
   owner rather than skipping permission checks, so the checks execute in both modes. A bypass
   would mean they are only ever exercised in production.
7. **No LLM in the generator or the executor.** Those are pure code by design — deterministic,
   reviewable, reproducible.

## 5. The two data contracts that matter

**AppModel** — what discovery produces. Per page: `url`, `title`, `concepts`, and `elements[]`,
where an element is `{ role, name, css?, id?, testId?, visible?, ... }`. Also structured `forms[]`
(with per-field `inputType`, `label`, `value`), navigation, buttons, headings. Elements are
addressed the way a *tester* would describe them — by accessibility role and visible name — not by
brittle CSS paths.

**IR** — the execution contract, strict JSON, the single thing the generator compiles:

```
IR
  meta:  { feature, title, priority, sourcePrompt, baseUrl,
           truncated?, truncationNote?, hasTerminalAssertion? }
  steps: Step[]
    id, action: navigate | click | fill | select | check | press | wait | assert
    target?:    { url?, role?, name?, nth?, label?, text?, placeholder?, testId?, css? }
    value?:     string          (credentials appear here only as "${env:TEST_USERNAME}")
    assertion?: visible | hidden | text_equals | text_contains | url_contains |
                title_contains | title_equals | enabled | disabled
    preAction?: { action: hover | click, target }
```

`css` is written **by code during grounding**, copied from a verified AppModel element — never
produced by the model directly. `truncated` / `hasTerminalAssertion` are what let a partially
grounded IR ship as an honest partial test instead of a hard failure.

**Zod is the contract.** The schemas are runtime-validated, not just TypeScript types. Extend the
schema before extending behaviour that depends on a new field.

## 6. Stack and layout

- **TypeScript, strict.** `tsc --noEmit` must stay clean.
- **Runtime deps are deliberately few:** `express`, `zod`, `cheerio`, `@supabase/supabase-js`.
  Playwright for execution. Gemini is the only LLM provider.
- **Frontend is a classic script** — `public/app.js`, no bundler, no modules, no framework. It
  therefore **cannot import anything from `src/`**, which is why a couple of small functions are
  deliberately duplicated between server and browser, each with a test asserting the two agree.
- **Nine views exist and all nine are built:** `home`, `run`, `suite`, `case`, `compare`, `history`,
  `team`, `login`, `signup`. Older docs in this repo call three of them unbuilt stubs; that is wrong.
- **The UI polls, it does not stream.** `connectToRun` loops on `GET /api/runs/:id/state` once a
  second. `EventSource` appears nowhere in `public/` as code — an SSE route exists server-side and
  no client has ever consumed it, because a Cloudflare tunnel buffers `text/event-stream`.
- **The composer has no coverage selector any more.** The Minimal/Standard/Full control was removed;
  `coverage` is pinned to `"standard"` in `app.js` and is **still sent** in the `POST /api/runs`
  body, because dropping the field would change an existing route's request shape. If you are asked
  to tidy up what looks like a dead constant there, do not — that is the constant.
- Topbar actions live behind a header hamburger menu; role restrictions are negative body classes
  (`role-no-edit`, `role-no-admin`); suites are managed from the sidebar; project rows have a Delete.
- **Tests: vitest.** As of this snapshot: **816 passing across 52 files.** CI
  (`.github/workflows/test.yml`) runs `tsc --noEmit` and `npm test` on every push and pull request;
  it is not a merge gate, so a red run can still land.
- **Sizes:** `src/` is 56 `.ts` files / 17,033 lines. `public/app.js` is 5,611 lines, `index.html`
  348, `style.css` 1,915.
- **Run it:** `npm run serve` (starts on port 3000). `npm test`, `npm run typecheck`.
- **`runs/<runId>/`** holds every artifact of a run — the plan, the AppModel, the IR, the generated
  spec, screenshots, video, and an `events.ndjson` event log. This directory is the project's
  primary debugging evidence, and most findings in its tech-debt log were confirmed by reading it
  rather than by re-running anything.

## 7. Where the LLM sits, and where it deliberately does not

Gemini is used in exactly four places: planning, test-case generation, IR compilation, and failure
diagnosis (plus vision as a discovery fallback). It is **not** used in discovery's common path
(cheerio does that for zero tokens), **not** in the generator, and **not** in the executor.

There is a disk cache for LLM calls. **Its keys must include every real input dimension** — a key
missing one (the model name, the system prompt, the credential policy) serves a wrong answer
forever, because the cache never expires. This has caused real bugs more than once.

## 8. Known sharp edges (ask about these before proposing changes)

- **`npm run serve` has no watch or reload.** It runs once. A running server keeps executing the
  code it loaded at startup; editing source does nothing until it is restarted. This has repeatedly
  made a real fix look like it did nothing.
- **The browser keeps the `app.js` it already loaded.** An open tab does not re-fetch on its own.
  A frontend change needs a hard refresh, or the user is testing old code. Combined with the point
  above, a change can appear absent for days and then arrive all at once at a restart — making an
  old bug look brand new.
- **`sessionStorage` does not survive a new tab/page**, even inside one Playwright browser context.
  A site whose session lives only in `sessionStorage` is logged out again on every new page, so
  flows that must stay authenticated are kept on the same page.
- **A `page.evaluate` callback must not contain inner named functions.** The dev runtime's
  transform injects a helper that does not exist inside the browser, and it throws only in a real
  run — unit tests do not reproduce it.
- **A generated Playwright expression that looks right is not verified until it has been run once.**
  A fix once shipped that passed typechecking and a unit test and was a silent no-op, because both
  checks only inspected the emitted *string* and neither executed it.
- **Roughly 45 of 66 recorded tech-debt items are still open** (IDs run TD-01…TD-67 with TD-35
  absent, so the highest number is not the count; the summary table only covers TD-01…TD-51, so the
  open figure is easy to understate). Notable open ones: `runs/` grows unbounded unless `RUN_RETENTION_DAYS` is set; the generated spec's
  locator helpers have already drifted from the resolver they were copied from; wording-based
  detection is used in more places than it should be; and a literal credential can be stored in the
  case library, because the "secrets never reach disk" rule was written for the run pipeline and
  never extended to the database.
- **`runs/` is no longer an unauthenticated static mount**, despite what older notes say: it is a
  guarded route now. With `AUTH_ENABLED=true` an unauthenticated caller gets 403. With the flag off
  (the default) the guard resolves a synthetic local owner and allows everything, so the default
  posture is still open.

## 9. How to be useful in a conversation about this project

**What you cannot know from this file:** the current contents of any source file, whether a
specific function still exists or is still named that, what the user's `.env` contains, what any
particular run actually did, or anything changed after the snapshot date. Say so rather than
guessing — a confident wrong answer about this codebase is expensive, because its failures are
usually silent.

**Useful things to ask the user for**, because they are cheap for them to obtain and decisive:

- the contents of `runs/<runId>/events.ndjson` (what the pipeline actually did, with timings)
- `runs/<runId>/04-ir.json` (what was actually compiled and grounded)
- `runs/<runId>/02-appmodel.json` (what the site actually looked like to the system)
- the terminal output of `npm run serve`
- the browser console, for anything involving the UI
- **when the server process started**, versus when the file was last edited

**Reasoning habits that fit this codebase:**

- Prefer evidence from `runs/` over re-running anything: it is free, and it is how most of this
  project's real findings were made.
- Before believing a change works, ask what would prove it *doesn't*. A passing test that would
  pass either way is worse than no test — this project has shipped several.
- When something behaves as though a change never happened, suspect a stale server process or a
  stale browser tab before suspecting the change.
- Prefer additive changes: a new route over a modified one, an optional field over a renamed one.
- If a proposed guard inspects English that a model or a website wrote, stop — see section 3.

## 10. Refreshing this file

It is a snapshot and it decays. Ask the person you are talking to for a fresh export whenever the
conversation turns on a specific number, filename, or function signature. In the repo, the durable
sources are `CLAUDE.md` (working rules), `ARCHITECTURE.md` (every file and schema), `TECH_DEBT.md`
(what is broken, ranked), `DECISIONS.md` (why a choice was made and what was rejected), and
`docs/phases/` (one report per shipped phase, each ending with what it deliberately did not fix).

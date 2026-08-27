# CLAUDE.md

Working guidance for an agent (Claude Code or otherwise) in this repo. Read this first; it points
to the other four docs instead of repeating them. Keep this file itself under 200 lines — if
something needs more room, it belongs in `ARCHITECTURE.md`, `TECH_DEBT.md`, or `DECISIONS.md`, not
here.

## What this is

A pipeline that turns a natural-language testing request + URL into **executed** Playwright tests:
Gemini plans -> DOM-first discovery (cheerio, zero LLM tokens on the common path, same-origin site
crawl) -> Gemini generates a coverage suite -> Gemini compiles the chosen case into a strict JSON IR,
deterministically grounded against the live app -> a pure-code generator emits a Playwright spec ->
the spec runs for real, per-case, in its own browser context -> on failure, a deterministic
classifier tries first, Gemini vision second.

## Documentation map — one owner per topic, don't duplicate

| Question | File |
|---|---|
| What is this, how do I run it | `README.md` |
| How it works internally — every file, schema | `ARCHITECTURE.md` |
| What's broken, ranked, with remediation | `TECH_DEBT.md` |
| Why a design choice was made, what was rejected | `DECISIONS.md` |
| Working guidance for an agent (this file) | `CLAUDE.md` |
| What each shipped phase changed, and how to roll it back | `docs/phases/` |

**Before adding a "what's broken" note anywhere, put it in `TECH_DEBT.md` instead.** This doc set
used to be six files that each kept their own copy of that list, and every copy drifted out of
sync — that's why it's five files with one job each now, not six with overlap
(`DECISIONS.md` D-01). Don't recreate the overlap.

`docs/phases/` is a build log, not a sixth topic owner: one report per shipped phase, each ending
with what it deliberately did **not** fix. Read the report for the area you are about to touch
before touching it — several of them record a constraint that is not visible in the code.

## The platform layer's own rules

Everything under `docs/phases/` was built to a standing set of rules. They still apply:

1. **Never change an existing route's request or response shape.** `public/app.js` reads these
   shapes in dozens of places. New functionality gets a NEW route; an existing route may gain
   **optional** fields only — never renamed, removed or reordered ones.
2. **Every new capability ships behind an env flag defaulting to OFF.** With every flag off, the
   tool behaves exactly as it did before any of this existed.
3. **Never touch `public/style.css` class names.** `app.js` drives the entire UI by toggling
   documented class contracts (`.hidden`, `li.completed`, `.phase-badge.running`,
   `.case-card.open`). Reuse an existing class rather than minting one.
4. **Never switch views by toggling `.hidden` directly.** `showView()` is the only function
   allowed to do that, and its comment documents a real bug this caused.
5. **Real credentials never touch disk or the database.** They stay in process memory for the
   length of one walk. Stored steps keep `${env:...}` references. Do not weaken
   `scrubServedSecrets` or `redactCredentials`.
6. **A model proposes, it never writes** (`DECISIONS.md` D-27). Every model-authored change to a
   saved test comes back as step *text*, is re-checked by the real parser, is shown as a diff, and
   is approved by a person before it enters the ordinary save path.
7. **Flag-off must still mean flag-on's code path.** `AUTH_ENABLED=false` substitutes a synthetic
   local **owner** rather than skipping the checks, so the permission code runs and passes in both
   modes. A bypass would mean the checks are only ever exercised in production.

## The project's central design rule

**An LLM instruction is a preference, not a constraint.** Every prompt-level rule given to Gemini
or Groq is expected to have a deterministic check behind it in code — `groundingError()` in
`src/stages/ir.ts` is the reference example (`DECISIONS.md` D-02/D-03): every kind of target the
model can invent has its own verifier against the real discovered page, not the model's
self-report.

**The failure mode of this rule, seen repeatedly:** a "deterministic" check written as a regex
over LLM-*authored prose* (case titles, step text, page text) is not actually deterministic — it
inherits whatever the model or the page happened to say. `missingActions` (`ir.ts`) rejecting a
correct IR because the page's own heading contained the word "Click" is the clearest example on
record (`TECH_DEBT.md` TD-01). **When writing a new guard, check IR/AppModel *structure* — a role,
a discovered element, a schema field — over checking prompt/page *text*.**

## Before touching grounding, credentials, or the executor

Read the relevant `TECH_DEBT.md` entry and, if one exists, the matching `DECISIONS.md` record
first. Several real bugs in this codebase were "fixed" by a prompt-wording change alone and came
back later; the fix that stuck was always the structural one.

## Conventions

- **TypeScript, strict.** `npx tsc --noEmit` must stay clean.
- **Zod is the contract.** `src/schema/*.ts` — `AppModel`, `IR`, `CaseSelection` — are what every
  stage reads and writes. Extend the schema before extending behavior that depends on a new field.
- **No LLM in the generator or executor.** `generator.ts` and `executor.ts` are pure code by
  design (`DECISIONS.md` D-06) — a deterministic, reviewable, reproducible spec. Don't add a model
  call there.
- **Secrets never touch disk.** Credentials become `${env:...}` references in generated specs, not
  literals — `runs/` is served publicly (`TECH_DEBT.md` TD-14). If you add a new place a
  credential could leak into an artifact, scrub it in `scrubServedSecrets` (`executor.ts`).
- **Cache keys must include every real input dimension.** The LLM disk cache never expires; a key
  missing a dimension (credential policy, system prompt, model name) serves a wrong answer forever.
  This has bitten the project more than once — `TECH_DEBT.md` TD-22, `DECISIONS.md` D-10.
- **A generated Playwright expression that looks right isn't verified until it's run once.**
  `.filter({ visible: true })` shipped as a fix, passed `tsc`, passed a unit test — and was a
  silent no-op, because `Locator.filter()` has no `visible` option in this project's pinned
  Playwright version. Both checks only inspected the *emitted string*; neither executed it. If a
  change touches the generated spec's actual Playwright API surface, run it for real (a
  synthetic-HTML headless-browser check is enough, doesn't need the live target site) before
  calling it done — see `DECISIONS.md` D-19.

## Verification

```bash
npx tsc --noEmit          # must be clean
npx vitest run            # note the pass count/file count if it changes from the last known baseline
```

No CI runs these automatically yet (`TECH_DEBT.md` TD-20) — run them yourself before calling
something done. Where a fix touches IR generation or grounding, prefer **artifact replay** against
a saved `runs/<id>/04-ir.json` / `02-appmodel.json` over a live run — it's free, and it's how most
findings in `TECH_DEBT.md` were actually confirmed (screenshot-count forensics, event-log timing,
direct grep against a saved page capture). Spend real Groq/Gemini/browser cost only for a final
end-to-end confirmation, and say so before doing it, since it costs the user money.

## Known sharp edges worth knowing before you start

- `runs/` is gitignored but real — artifacts from actual runs, inspectable directly, and the
  primary evidence source this project's own debugging relies on.
- The generated Playwright spec **restates** locator logic from `targetResolver.ts` as a string in
  `generator.ts`, deliberately (`DECISIONS.md` D-06) — but nothing pins the two equal, and they
  have already drifted (`TECH_DEBT.md` TD-07).
- Most tunables are env vars with defaults documented in `.env.example` and `README.md` — check
  there before assuming a constant is hardcoded.
- Windows dev environment: this session's tools include both a POSIX-style Bash tool and a native
  PowerShell tool — they take different syntax; don't mix them in one command.
- **`npm run serve` has no watch/reload — it runs `tsx` directly, once.** A running server keeps
  executing whatever code was in memory when it started; editing `src/` does nothing to it until
  it's restarted. Caught directly: a `TECH_DEBT.md` fix (TD-02) was verified offline, then a real
  run afterward still showed the exact pre-fix timing signature, because the server process
  predated the fix by over an hour. Before judging any source change against a live run, check
  whether the server process actually started after the edit.
- **A `page.evaluate` callback must not contain inner named or `const`-assigned functions.**
  `tsx` (how the server actually runs) uses esbuild, which wraps every named function in a
  `__name(...)` call to preserve `.name` — a helper that does not exist inside the code
  `page.evaluate` serializes and runs in the browser. `vitest`'s own transform does not inject
  that helper, so this passes every unit test and throws `ReferenceError: __name is not defined`
  only on a real `npm run serve` run (`TECH_DEBT.md` TD-40). Write evaluate callbacks with
  everything inlined, duplicated across branches if needed, and say why in a comment.
- **`sessionStorage` does not survive `context.newPage()`.** It's scoped to the tab, not to
  Playwright's `BrowserContext` — a shared context keeps cookies and `localStorage` across pages,
  but a site whose session lives only in `sessionStorage` (a real, mainstream React/Vite pattern)
  is logged out again on every new page. Verified directly: a second page on an authenticated
  context came back with empty `sessionStorage` and the login form. If a flow needs to survive
  across pages, keep it on the SAME page/tab (`TECH_DEBT.md` TD-41, `DECISIONS.md` D-23).

- **The step editor's English format is LOSSY, and that is load-bearing.** A rendered sentence
  carries a step's semantic target and value, not the `css`/`testId`/`nth` grounding wrote. So
  `parse(format(step))` cannot reproduce a grounded step on its own — the contract that actually
  holds is `parseIrStep(formatIrStep(step), step)`, parsing *onto* the original. That is what makes
  an untouched line free to save and a changed target expensive: the deterministic fields are
  cleared precisely when the user stops pointing at that element, forcing a re-ground. Do not
  "fix" the format to be round-trippable; read the header comment in `src/stages/stepText.ts`.
- **`public/app.js` has its own copy of `formatIrStep`** and cannot import the server's (classic
  script, no module surface). `tests/stepText.test.ts` extracts and evaluates that copy and asserts
  it renders identically. If you change one, change both — the test will tell you.

## Don't

- Don't hardcode credentials or site-specific values into a system prompt. This happened twice
  before (a real password once shipped inside a few-shot example) — see the C1/C2 history folded
  into this project's git log and referenced from `TECH_DEBT.md`.
- Don't add a new "what's broken" doc, section, or duplicate list. Extend `TECH_DEBT.md`.
- Don't assume a passing test proves a fix. This repo has shipped green runs that verified
  nothing — a coverage check that only confirms *some* action happened, not the *right* one, is
  exactly the class of bug in `TECH_DEBT.md` TD-01.
- Don't treat a number in these docs (test count, `runs/` size, model name) as current without
  re-checking it. Doc drift is a recorded, recurring failure mode here (`DECISIONS.md` D-01) —
  these docs describe the system as best understood at time of writing, not a live dashboard.

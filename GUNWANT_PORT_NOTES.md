# Gunwant branch — port notes

Produced 2026-08-06 by diffing `Gunwant` (an orphan commit — no shared git history with anything)
against `lakshya` via `git diff lakshya Gunwant --stat` (40 files, +2693/-160). Only covers what's
actually new/different relative to `lakshya` — not the whole Gunwant codebase. **Re-diff before
porting if either branch has moved since.**

Each entry below: what it does, where it lives, the bug/gap it fixes, and any known problem in
Gunwant's own version of it that should be fixed *during* the port rather than copied as-is.

---

## Good parts, priority order

### 1. `extractDomModelFromPage` — snapshot the live page, not a fresh browser
**Files:** `src/stages/domDiscovery.ts` (new export), used by `src/stages/liveExtend.ts`
(`replayAndSnapshot`) and `src/stages/hybridDiscovery.ts` (`discoverSiteHybrid`).

Extracts a DOM model from a Playwright `Page` object that's already open and navigated —
no new browser launch, no fresh navigation.

**Bug it fixes:** the old path called `discoverUsingCrawler(url)` to snapshot a page live-extend
had just replayed to. That function launches a **brand-new, session-less** browser. For any
authenticated URL, that fresh browser hits the login redirect and models the *login page*, not
the real page — and that wrong snapshot then gets cached under the real URL's cache key
permanently. Likely the single highest-value fix in this branch; probably explains some of the
general grounding/live-extend flakiness on authenticated multi-page flows independent of anything
site-specific.

**Port this first** — several other good parts below depend on it.

---

### 2. `discoverSiteHybrid` — follow the entry page's own links
**File:** `src/stages/hybridDiscovery.ts`

Crawls the entry page's same-origin internal links (bounded by `MAX_DISCOVERY_PAGES`, default 5)
and merges every reachable page into one `AppModel`, instead of modeling only the entry page.
Falls back unchanged to today's single-page behavior when the entry page has no crawlable links
(auth walls, SPAs). The link-filtering logic is a small, pure, independently testable helper:

```ts
export function collectCrawlTargets(candidateUrls: string[], entryUrl: string, visited: Set<string>): string[]
```
— same-origin only, `http(s)` only, asset/file extensions skipped (`SKIP_CRAWL_PATH`), hash
stripped, de-duplicated via the `visited` set.

**Must-fix before porting:** `discoverSiteHybrid` calls `cacheGet(url)`/`cacheSet(url, result)`
using the bare URL as the key — the same key `discoverHybrid` (the existing single-page function)
uses for its own, differently-shaped result. If the same URL is discovered once via one path and
later via the other within the cache TTL, one silently returns the other's result. Give the
multi-page result its own cache key/namespace before wiring this in as the default `discover()`.

---

### 3. `cutAtBoundary` — boundary-safe text truncation
**File:** `src/text.ts` (new, 16 lines)

```ts
export function cutAtBoundary(text: string, maxChars: number): string
```
Cuts at the last line break (falling back to the last space) at or before the limit, instead of a
blind `.slice()` that can sever mid-word/mid-line. Used in:
- `liveExtend.ts`'s `capturePageText`
- `failureAnalysis.ts`'s `errorTextFrom`
- `hybridDiscovery.ts`'s concept-labeling prompt truncation

**Note:** this is the exact same class of fix as the still-open `generator.ts` comment-injection
bug (a raw `${ir.meta.sourcePrompt}` interpolated into a `//` comment breaks on an embedded
newline — see issue list below). Gunwant added this utility but never applied it to that spot.
**When porting, use `cutAtBoundary` there too** instead of writing a separate one-off `oneLine`
helper — one truncation primitive for the whole codebase.

---

### 4. `classify.ts` — fix the unreachable `element_missing` category
**File:** `src/stages/classify.ts`

Old regex `/resolved to/i` matched Playwright's timeout log for *both* "resolved to 0 elements"
(truly missing) and "resolved to N elements" (found but the assertion never became true) — so
every genuinely-missing element got misclassified into the generic timeout bucket, and the
`element_missing` category (and its self-heal trigger in `orchestrator.ts`) was effectively dead
code. New version splits `resolved to\s+0` from `resolved to\s+[1-9]\d*` explicitly. Real,
general, no downside — port as-is.

---

### 5. `domExtract.ts` — fix duplicate-element strict-mode failures
**File:** `src/stages/domExtract.ts`

An element with both a real interactive tag (`a`/`button`/`input`/`select`/`textarea`) *and* an
explicit `role` attribute was being emitted twice — once by the tag-based extraction loop, once
by the role-based one — under two different, non-colliding dedup keys. Produced duplicate
`AppModel` elements and Playwright "strict mode: matched 2 elements" failures downstream. Fix
skips the role-based emission when the tag is already covered by the tag-based loop. Port as-is.

---

### 6. `scrubServedSecrets` — close the credential-leak gap in served artifacts
**File:** `src/stages/executor.ts`

Extends the existing "secrets never touch disk as literals" property (env-var references in the
generated spec) to also redact `results.json`, `final-page.txt`, and Playwright's error-context
attachments — all served publicly under `/runs`. Closes a real gap: a logged-in page routinely
echoes the identifier back ("Signed in as you@example.com"), and none of those three sinks were
covered by the existing `redactCredentials` call before this. Best-effort (never fails a run over
its own cleanup). Port as-is — this is a straightforward security hardening with no tradeoff.

---

### 7. `runStore.ts` — close orphaned runs on server restart
**File:** `src/runStore.ts`

A run whose id timestamp predates the current server process's boot time, and whose
`events.ndjson` has no terminal (`done`/`error`) event, died when the previous server process
was killed/restarted — its orchestrator promise is gone and no more events will ever arrive.
`getEvents` now detects this shape and synthesizes a closing `error` event instead of leaving the
frontend polling forever. Port as-is — pure reliability fix, no behavior change for a run that
completes normally.

---

### 8. Case-selection gate — human-in-the-loop case review
**Files:** `src/stages/caseSelectionGate.ts`, `src/server/caseAccumulator.ts`,
`src/server/caseHistoryLedger.ts`, `src/server/pendingCaseSelection.ts`, three new endpoints in
`src/server/index.ts` (`POST /api/runs/:runId/case-selection`,
`GET /api/runs/:runId/accepted-cases`, `GET /api/runs/:runId/case-selection-status`), plus the
`filterNovelCases` addition in `src/stages/testCases.ts` and the whole case-selection panel in
`public/app.js`/`index.html`/`style.css`/`preview.js`.

Pauses a run after generating a batch of test cases, lets the user check/uncheck which to keep,
and either finalizes ("Done") or regenerates against a refinement prompt ("Not satisfied") —
repeating up to `MAX_CASE_REGEN_ATTEMPTS` (default 3) rounds or until the pool hits
`MAX_ACCUMULATED_CASES` (default 5). Two things make the regeneration actually reliable rather
than just prompted-and-hoped:
- `filterNovelCases` (testCases.ts) — a **hard filter**, not just an instruction: drops anything
  in a new batch that title-overlaps an already-accepted OR already-rejected case, regardless of
  what the LLM/cache returned.
- The extend-context additions to `toTestCases` (`rejectedTitles`, `mintPrimary`, `latestPrompt`,
  and all of them folded into the cache key) — without these, a "not satisfied, focus on X" reply
  had no way to actually steer the next batch, and two runs with a rephrased-but-equivalent plan
  could collide on a stale cached suite.

Cleanly feature-flagged: `if (process.env.ENABLE_CASE_SELECTION_GATE === "true")` in
`orchestrator.ts` — while off, the gate is never even imported and the default path is untouched.

**Must-fix before porting:** `.env.example` never documents `ENABLE_CASE_SELECTION_GATE` — this
is exactly what caused the panel to silently not appear this session. Add it (with a comment)
when porting.

---

### 9. `credentialsFor` demo-account removal — behavior change, confirm before porting
**File:** `src/stages/credentials.ts`

Deleted the hardcoded demo-credential registry (`saucedemo.com` → `standard_user`/`secret_sauce`,
`the-internet.herokuapp.com` → `tomsmith`/...). `credentialsFor` now always returns `undefined`;
every site goes through the general `askCredentials` prompt uniformly instead of two different
code paths (silent-autofill for known demo sites vs. ask-the-user for everything else).

This is architecturally aligned with the "general-purpose, not site-specific" direction from
earlier in this session — but it **is a real behavior change**: demo sites that used to run
without any prompt will now pause and ask every time. Not a pure win to copy blindly — confirm
this tradeoff is still wanted before porting, don't just carry it over silently.

---

## Known issues — do NOT port as-is

These are problems in Gunwant's current state, not things to copy over. Fix or avoid them
during the port:

- **`.env.example` has real, live-looking Gemini and Groq API keys committed in plaintext**,
  already pushed to `origin/Gunwant`. Do not copy this file verbatim. Rotate both keys.
- `.env.example`'s `GROQ_MODEL` was reverted to the deprecated `llama-3.3-70b-versatile`, and the
  deprecation-date/replacement-model comment that used to be there was deleted.
- `.github/workflows/ci.yml` sets `working-directory: test-AI-select`, a directory that doesn't
  exist in this repo — every CI run fails immediately, unconditionally.
- `public/app.js`'s `setPhaseFromStage` can show a phase as visually "completed" while its own
  text says "Interrupted — pipeline ended before this step finished" (status class and status
  text are picked from two different signals that can disagree).
- `hybridDiscovery.ts`'s cache-key collision between `discoverSiteHybrid` and `discoverHybrid`
  (see item 2 above).
- `ir.ts`'s new `MAX_PROMPT_CHARS` guard (`buildUser`, ~line 780) throws *inside* the per-attempt
  build function. For a prompt that's over budget even after full model pruning, every one of the
  `MAX_IR_ATTEMPTS` retries rebuilds and re-throws the identical error — each also recorded as a
  real LLM call — instead of failing once on the first attempt.
- **Two bugs diagnosed earlier this session are present on Gunwant too — porting other things
  does not fix them, they still need their own fix:**
  - `generator.ts` (~line 395-397): `// Source: ${ir.meta.sourcePrompt}` is unsanitized — a
    literal newline in the source prompt breaks the `//` comment and produces a syntax error in
    the generated spec. (`cutAtBoundary` from item 3 above should be applied here when porting,
    not a separate helper.)
  - `ir.ts`'s `toIR` retry loop (~line 814-828): every live-extend hop consumes one of only
    `MAX_IR_ATTEMPTS` (default 4) attempts, same as a fresh LLM generation. A flow needing several
    page hops to fully discover can burn its entire attempt budget just reaching the right page
    state, leaving none to actually use the now-correct model — ships a stale truncation note
    instead. (Previously-approved fix: decouple live-extend retries from the outer attempt
    budget — re-ground the same parsed IR against the newly-extended model directly, only
    spending a fresh LLM attempt if that still fails.)

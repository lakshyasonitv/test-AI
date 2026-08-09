# Tech Debt — defects, dead code, and prompt hygiene

Audit of `ai-test-platform` (10,110 lines across `src/` + `public/`), produced 2026-08-08 from a
read-only sweep plus evidence from real runs under `runs/`. Extended 2026-08-09 with a
user-reported bug (A11) and a second, broader audit (Part D), prompted by that bug.

Every item below carries **where it is**, **how it was proven**, and **what to do**. Run ids are
real and their artifacts were inspected directly — where a run has since been deleted, the
finding is marked as such.

**Status legend:** ✅ done · ⬜ open · 🔍 needs investigation before acting

| Part | What | Status |
|---|---|---|
| A | Defects — things that are wrong | ✅ A1, A2, A3, A4, A5, A8, A11 done · rest ⬜ |
| B | Dead code — provably unreferenced | ✅ B1, B2, B3, B4, B5, B7, B8, B9 done · B6 🔍 |
| C | System prompts made general-purpose | ✅ **done 2026-08-08** |
| D | Findings from a second audit (2026-08-09) | ✅ D1 done · D2–D9 open, D10 folds into A7 |

---

## Part C — System prompts (DONE)

Recorded first because it is complete, and because **C0 changes how every other change gets
verified.**

### ✅ C0. Prompts and model names now participate in every LLM cache key

**The problem.** No cache key included the system prompt or the model name, and the disk half of
`llmCache` has no expiry. Editing a prompt therefore changed nothing for any input already
seen — permanently.

This is not theoretical. It produced **two false negatives during verification**: a correct fix
appeared not to work because the previous result was served from disk, with no `[ir] attempt`
line in the log at all (run `2026-08-08T11-30-59-463Z-04ae8f3e`).

**The fix.** Each stage now hashes its own `system` string into the key, plus the model name:

| File | Change |
|---|---|
| `stages/ir.ts` | Key moved to *after* `system` is built; hashes `system` + `GROQ_MODEL` |
| `stages/testCases.ts` | Hashes `system` + `GEMINI_MODEL` |
| `stages/planner.ts` | Key moved after `system`; hashes `system` (model was already in) |
| `stages/failureAnalysis.ts` | Prompt hoisted to module-level `SYSTEM`; hashes it + `GEMINI_MODEL_LITE` |
| `stages/hybridDiscovery.ts` | Prompt hoisted to module-level `LABEL_SYSTEM`; hashes it + `GEMINI_MODEL_LITE` |

Hashing the prompt **text** rather than a hand-maintained `PROMPT_VERSION` constant is
deliberate: a version number is something a future edit can forget to bump, and the failure mode
when it is forgotten is invisible.

> **Operational note.** Because prompt text is now part of the key, the C1–C3 edits below
> invalidated every previously cached plan / test-case batch / IR. The first run after this is
> a full cache miss and costs the usual LLM calls. This is correct, not a regression.

### ✅ C1. Real credentials removed from the test-case few-shot example

`stages/testCases.ts` shipped **the project owner's own live email and password** inside the
few-shot example given to the model on every test-case generation:

```
"steps": ["Navigate to /login", "Fill 'Email' with 'lakshya.soni@thinkvibes.com'",
          "Fill 'Password' with '123456'", "Click 'Sign In'"]
```

This is the most likely reason the model repeatedly invented `admin@thinkvibes.com` /
`ValidAdminPassword123` instead of using the values the user actually typed — the example taught
it that thinkvibes-shaped credentials are what belongs in that slot. Observed in runs
`2026-08-08T11-08-53-602Z-a986748a` and `2026-08-08T11-52-35-503Z-0981bd0c`.

Replaced with slot descriptions (`<the identifier from the request>`), plus an explicit
instruction that the example is a *shape* reference whose names and values are never to be
copied.

### ✅ C2. Demo-site credentials and one school site's navigation removed from `ir.ts`

- `"value": "tomsmith"` / `"SuperSecretPassword!"` — the-internet.herokuapp.com's published demo
  account, embedded in the login example. Now `<the identifier from the test case>`.
- `"Academics"` / `"Programmes"` appeared in the dropdown example and in the
  navigation-independence rule. Now `PARENT` / `CHILD` placeholders with an explicit note that
  they stand for the application model's own item names.

### ✅ C3. Rules generalised — behaviour kept, layout assumptions dropped

Per the decision taken: **generalise the wording, keep every rule.** Rules that now have
deterministic guards behind them stay as cheap first-line steering — that is this codebase's
standing policy (see `ARCHITECTURE.md`, "Prompt nudges are never the only guard").

| Rule | Was | Now |
|---|---|---|
| Duplicate-name disambiguation | *"header links: `nth: 0`; sidebar/footer: `nth: 1` or higher"* — stated as fact, true of one layout | Use the element's position in the application model, and its `containerRole`/`containerName`/`pageSection`; explicitly says not to assume a layout |
| Menu-toggle guard | Named `"Menu"`, `"Toggle"`, `"hamburger"`, `"responsive CSS breakpoint"` | *"a control whose only job is to OPEN or COLLAPSE that region, however it is named"* + viewport-width reasoning |
| Navigation independence | `"Home -> About -> Academics"` | *"several sibling destinations"*, no site names |
| Problematic links | Included *"links that redirect to homepage when a specific page is expected"* — unactionable, the model cannot know a redirect happens | Dropped; kept the `href="#"` / `javascript:void(0)` rule, which is checkable from `domLinks` |

`tests/irSystemPrompt.test.ts` pinned the literal strings `"menu-toggle"` and
`"responsive CSS breakpoint"`. It now asserts the **rule's presence** via a regex tolerant of
phrasing, so the prompt is not frozen to one site's vocabulary.

### ✅ C4. Audited and left unchanged

`stages/discovery.ts`, `stages/hybridDiscovery.ts`, `stages/failureAnalysis.ts` — all already
generic (they use `example.com`). No changes needed.

### C5. Comments are deliberately out of scope

`saucedemo` / `learnvibes` / `thinkvibes` still appear in ~4 code **comments**
(`ir.ts:170`, `ir.ts:501`, `discovery.ts:83`, `discovery.ts:99`). **Leave them.** They document
the real runs that motivated the surrounding code and are the evidence trail for why it looks
the way it does. Only strings sent to a model were in scope.

---

## Part A — What is wrong

### ✅ A1. Green runs that tested nothing (done 2026-08-08)

`missingActions` (`stages/ir.ts`) was a **presence** check — "does *any* `fill` exist, does *any*
`click` exist" — not a coverage check. An IR covering 5 of a case's 9 steps passed it.

**Evidence.** Run `2026-08-08T11-33-53-639Z-0cc9b64c` reported **4/4 passed** while its primary
case's IR stopped at `assert Sign In hidden` — it never touched the Admin or Users steps its own
case text listed. A green run that verified nothing is worse for the user than an honest failure,
because nothing signals that it needs looking at.

**Fix applied.** `missingActions` now also counts action-bearing lines in the case's own step
text (`CASE_ACTION_LINE`) against the IR's actual `click`/`press`/`fill`/`select`/`check` step
count, and rejects when the IR carries out materially fewer (more than one short, to tolerate a
single legitimate consolidation like "fill the login form" becoming two IR fills). This feeds
the existing retry loop the same way the other grounding rejections do — no new wiring, `toIR`
already calls `missingActions` and retries on its message. Covered by
`tests/grounding.test.ts` ("missingActions — the IR must carry out its case").

**Watch for.** This will start rejecting IRs that passed before, producing more retries and more
honest failures. That is the intent — but watch real runs for it pushing ordinary cases into
truncation from a too-tight threshold.

### ✅ A2. A grounding rejection gets multi-attempt retries (done 2026-08-08)

`toIR` in `stages/ir.ts` now continues the retry loop with `correction = ungrounded.message` feedback when a grounding rejection occurs, giving the LLM up to `MAX_IR_ATTEMPTS` to self-correct (e.g. `"Submit"` -> `"Save"`).

### ✅ A3. A truncated IR is cached forever (done 2026-08-08)

`finalize()` in `stages/ir.ts` now skips calling `llmCacheSet` when `ir.meta.truncated` is true. One truncation no longer poisons that (testCase, prompt, model, credentials) combination permanently on disk.

### ✅ A4. The results panel shows what actually ran (done 2026-08-08)

`orchestrator.ts` and `public/app.js` now format and render the executed IR steps in the test results panel (e.g. `Fill "*********" with "${env:TEST_PASSWORD}"`) rather than ungrounded LLM placeholder prose.

### ✅ A5. Uniform route validation for runId (done 2026-08-08)

Added an Express `app.param("runId", ...)` middleware in `server/index.ts` that enforces the `RUN_ID` regex (`^[\dT-]+Z-[0-9a-f]{8}$`) across all routes receiving `:runId`.

### ⬜ A6. `runs/` grows without bound and is served publicly

184 MB across 28 runs at audit time. `app.use("/runs", express.static("runs"))` with **no
authentication** serves every screenshot, trace, generated spec and `results.json`. `runStore`
caps the *history list* at 20 but never prunes the files.

**Fix.** Prune on write (keep N newest run directories). Authentication is tracked separately as a
known gap in `ARCHITECTURE.md`.

### ⬜ A7. Duplicated locator logic with nothing pinning it in sync

By design the generated spec is standalone, so `LOCATE_HELPER` / `SAFE_CLICK_HELPER` /
`FIELD_HELPER` (`stages/generator.ts`) restate `resolveRoleWithFallback` / `resolveField`
(`stages/targetResolver.ts`) as strings. The duplication is deliberate and documented — but **no
test asserts the two remain equivalent**, so they can drift silently and only the generated spec
breaks, at execution time, on a user's run.

**Fix.** One test running both against the same fixture page, or at minimum asserting the injected
helper source lists the same candidates in the same order.

### ✅ A8. `ENABLE_CASE_SELECTION_GATE=true` + CLI = silent success (done 2026-08-08)

Updated `orchestrator.ts` so `gateUsed` is only true when `askCredentials` (or an interactive responder) is supplied (`process.env.ENABLE_CASE_SELECTION_GATE === "true" && !!askCredentials`). In CLI mode, the pipeline bypasses the gate and executes directly instead of hanging on an unresolved Promise.

### 🔍 A9. The username was not env-referenced — unverified

In run `2026-08-08T12-43-15-947Z-07851181`, `s2` filled a literal `'admin@thinkvibes.com'` while
`s3` used `${env:TEST_PASSWORD}`. `runs/` is served publicly, so an identifier reaching disk is a
secrets asymmetry.

**Not investigated.** It may simply be the model inventing a value that was never recognised as a
credential (in which case C1 may have already fixed it), rather than a substitution failure.
Confirm which before changing anything.

### ⬜ A10. Minor

- **85 `console.log` calls**, no levels, no run correlation — pipeline logs can't be filtered by
  run or severity.
- **10 swallowed errors** (`catch {}` / `.catch(() => {})`).
- **No CI runs the 248 tests.** The only workflow, `.github/workflows/directory-tree.yml`,
  regenerates a directory tree and pushes to `main`.

### ✅ A11. `extractCredentialsFromPrompt` can silently substitute the wrong email/password when a (done 2026-08-09)
prompt mentions the keyword more than once

`extractValueAfter` (`stages/credentials.ts:203-210`) tries a "quoted value" regex first via
`prompt.match()`, falling back to a "bare value" regex only if the quoted one finds nothing
*anywhere* in the string. `.match()` without the `g` flag returns the pattern's leftmost
*successful* match — not the leftmost *keyword occurrence*.

**Evidence.** Real user runs `2026-08-08T19-05-03-728Z-487b6f60` and
`2026-08-08T19-01-34-984Z-1450bf5a`, both from one prompt: "...login...using the credentials
email: vaibhav.parmar@thinkvibes.com and password is "123456"... fill the fields Full name:
'Test Case' and email: "testcase@thinkvibes.com"...". The first "email" mention (the real login
identifier) is unquoted; the second (unrelated new-user-form data) is quoted. The quoted-first
regex skips past the unquoted login email and matches the later quoted one instead. Reproduced
directly against the real prompt text: current code returns `username: "testcase@thinkvibes.com"`
(wrong) instead of `"vaibhav.parmar@thinkvibes.com"` (the actual login credential). Both real
runs' IRs truncated at `Step s6 targets role="link" name="Admin", which is not present in the
application model` — consistent with login failing because the wrong username was submitted.

This is a single point of failure: `orchestrator.ts:151` calls `extractCredentialsFromPrompt`
**once per run**, and the result is substituted into every login field for the whole run. One
wrong extraction silently breaks login for the entire run, surfacing later as a confusing
"element not in the model" truncation rather than an obvious credential error. Not site-specific
— any prompt mentioning "email"/"password"-shaped text more than once (login plus any later form
data: new-user creation, checkout, profile edit, etc.) is exposed, regardless of target site.

**Fix.** Merge the two sequential regexes (quoted-then-bare) into one regex with a quoted/bare
alternation, so a single `.match()` finds the true leftmost keyword occurrence regardless of
which variant happens to be quoted:
```ts
const re = new RegExp(`${keyPattern}\\s*(?:is\\s+)?[:=]?\\s*(?:["'\`]([^"'\`]+)["'\`]|(\\S+))`, "i");
```
Verified by hand this produces identical output to today's code on every existing case in
`tests/credentials.test.ts`'s `extractCredentialsFromPrompt` block (all mention each keyword only
once); the only behavior change is for prompts with a repeated keyword, where it now picks the
chronologically first occurrence. Known residual limitation: "leftmost occurrence wins" is a
heuristic, not a guarantee — a prompt describing account creation *before* login (unusual
phrasing) would still pick wrong. Unchanged from today's already-heuristic behavior.

---

## Part B — Dead code (provably unreferenced)

Scope decision: **provably dead only.** Nothing feature-level. The Gemini vision fallback,
`preview.js` and the case-selection gate all stay — each is a fallback for a case that hasn't come
up lately, not one that can't happen.

Every item was verified by a reference scan across `src/` and `tests/`.

| # | Item | Location | Evidence | Action | Status |
|---|---|---|---|---|---|
| B1 | `filterByConcepts` | `schema/appModel.ts` | 0 references anywhere, including its own file | Delete | ✅ Done (2026-08-08) |
| B2 | `discoverInteractiveElements` | `stages/discovery.ts` | 0 references anywhere | Delete | ✅ Done (2026-08-08) |
| B3 | `credentialsFor(_url)` | `stages/credentials.ts:21` | Body is `return undefined` — a stub left behind when the demo-credential registry was removed. Still called at `orchestrator.ts` as `credentialsFor(...) ?? extractCredentialsFromPrompt(...)`, and again inside `ir.ts` | Delete the function and both call sites; keep `extractCredentialsFromPrompt` | ✅ Done (2026-08-08) |
| B4 | `discover` / `discoverPages` alias re-exports | `stages/hybridDiscovery.ts` (end of file) | Labelled "backward compatibility" for names nothing else uses | Rename at the two call sites, drop the alias layer | ✅ Done (2026-08-08) |
| B5 | Planner's LLM-supplied `testTypeScope` and `coverage` | `stages/planner.ts` | **Both are overwritten immediately after parsing** — by `classifyScope` and by the CLI value. The model is asked for two fields whose answers are thrown away | Remove from the prompt and the response contract; keep the schema defaults | ✅ Done (2026-08-08) |
| B6 | `wantsRealCredentials` | `stages/credentials.ts` | 0 `src/` references, 6 in tests — test-only | 🔍 **Decide first.** Either it is the real policy entry point and `credentialPolicyFor` should call it, or the tests are pinning dead behaviour. Do not simply delete — that silently deletes 6 tests' subject | 🔍 Needs decision |
| B7 | `preview.js` fixture points at a deleted run | `public/preview.js` | Fixture run `2026-07-30T17-01-59-013Z-979dbd01` no longer exists, so every preview screenshot 404s | Keep the tool, repoint the fixture at a surviving run | ✅ Done (2026-08-08) |
| B8 | `GUNWANT_PORT_NOTES.md` | repo root | Its own status note says all nine items were ported and *"re-diff before acting on anything here"*. Purely historical now | Archive or delete | ✅ Deleted (2026-08-08) |
| B9 | `findAuthBoundary` | `stages/credentials.ts:417-437` | 0 references anywhere in `src/` or `tests/` besides its own definition (confirmed by repo-wide grep). Not test-only like B6 — nothing calls it at all. Sits directly above `lastFillIndexByKind`, which is used throughout `credentials.ts`/`liveExtend.ts`/`ir.ts` and appears to have superseded it | Delete, or confirm it was meant to replace `lastFillIndexByKind`'s call sites | ✅ Done (2026-08-09) |

---

## Part D — Findings from a second audit (2026-08-09)

Ten items from a broader sweep prompted by the A11 bug above, plus B9 (Part B, dead code). Two
read-only audit agents covered the rest of the codebase; every finding below was independently
re-verified by direct code inspection — and for D3, by live reproduction — before being recorded
here. All ⬜ open; documentation only, none of these have been fixed.

### ✅ D1. Arbitrary local file disclosure + SSRF via the entry URL — no scheme/host validation (done 2026-08-09)

`POST /api/runs` (`server/index.ts:32-45`) validates only that `prompt` and `url`/`urls` are
non-empty — no scheme, no private-IP check, no auth on the endpoint at all. `discoverSiteHybrid`
(`stages/hybridDiscovery.ts:348-353`) validates the URL only by catching a *malformed-string*
exception:

```ts
try { entryOrigin = new URL(url).origin; } catch { throw new Error(`Invalid entry URL: ${url}`); }
```

`new URL("file:///C:/Windows/win.ini").origin` does **not** throw — confirmed directly:
```
> new URL("file:///C:/Windows/win.ini").origin
'null'
> new URL("http://169.254.169.254/latest/meta-data/").origin
'http://169.254.169.254'
```
so both a `file:` URL and a link-local/internal address sail through. `discoverUsingCrawler`
(`stages/domDiscovery.ts:492`) then does `page.goto(url, ...)` with no scheme check either
(confirmed by grep — none exists). The resulting page content flows into the AppModel and is
written to `runs/<runId>/02-appmodel.json` and `events.ndjson`, both served with **no
authentication** by `app.use("/runs", express.static("runs"))` (`server/index.ts:22`). The caller
already has `runId` from the run's own `202` response.

The codebase already applies exactly this discipline to links found *during* a crawl
(`hybridDiscovery.ts:315`: `if (u.protocol !== "http:" && u.protocol !== "https:") continue;`) —
it was just never applied to the entry URL itself.

**Evidence.** `POST /api/runs { "prompt": "check the homepage", "url": "file:///C:/Windows/win.ini" }`
→ poll `GET /runs/<runId>/02-appmodel.json` → local file contents readable by anyone who can reach
the server. Same path reaches internal-network SSRF via an `http://169.254.169.254/...`-style URL.

**Fix applied.** Shared `isAllowedEntryUrl()` / `isPrivateOrLoopbackHost()` in
`stages/hybridDiscovery.ts`, called from both the API boundary (`server/index.ts`) and
`discoverSiteHybrid` — one source of truth instead of two copies. Blocks non-http(s) schemes and
the RFC1918/link-local ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`),
verified directly against every address named above.

**Follow-up fix applied the same day.** The first pass only blocked the exact string
`"127.0.0.1"` and `"::1"` — but the whole `127.0.0.0/8` block is loopback (any other address in
that range, e.g. `127.0.0.2`, is a classic SSRF-filter bypass), and Node's `URL.hostname` keeps
the brackets on an IPv6 host (`"[::1]"`, not `"::1"`), so the IPv6 check never matched anything.
Reproduced both directly (`http://127.0.0.2/` and `http://[::1]/` returned `{ ok: true }`), fixed
with `h.startsWith("127.")` and matching both bracketed and unbracketed IPv6 loopback forms.
Covered by `tests/strategy.test.ts`.

**Known residual limitation, not fixed — architectural, out of scope for now.**
`isPrivateOrLoopbackHost` is a hostname-*string* check performed before any DNS lookup. A
hostname that resolves to a private/loopback IP only at request time (DNS rebinding) still gets
through. Closing that fully means resolving DNS and checking the resolved IP rather than the
literal hostname — a bigger change, not warranted at the current small-trusted-deployment scale.

### ⬜ D2. Generated spec's `safeClick` treats `javascript:`/`mailto:`/`tel:` links as real navigation

`generator.ts`'s `SAFE_CLICK_HELPER` (~line 227) checks only `href !== "#" && href !== ""` before
navigating. Three other places in this codebase agree on the full non-navigating set —
`ir.ts:96`: `const NON_NAVIGATING_HREF = /^\s*(#|javascript:|mailto:|tel:)/i;`, mirrored in
`discovery.ts:70` and `domExtract.ts:91` — `safeClick` alone omits it. Confirmed this path is
live, not theoretical: elements from `crawl.links`/`crawl.navigation` never carry a `css` field
(`domDiscovery.ts:122-135,151-166`), and `generator.ts:292`'s routing (`if (!t.css && t.role &&
t.name)`) sends every such link through `safeClick`.

**Evidence.** `<a href="javascript:void(0)" onclick="openModal()">Contact us</a>` — `safeClick`
sees a non-`#`/non-empty href and calls `page.goto("javascript:void(0)", ...)` instead of
clicking the element, so the `onclick` handler never fires. No error is thrown; the step silently
does nothing and every later step runs against an unchanged page.

**Fix.** Extend `SAFE_CLICK_HELPER`'s href check to match `NON_NAVIGATING_HREF`, ideally generated
from one shared source instead of restated a fourth time (ties into A7).

### ⬜ D3. `credentialPolicyFor`'s veto regex bridges unrelated fields in the joined case text — reproduced

`credentials.ts:371-379` joins `title`, `expected`, `intent`, and every step into one string
before testing `IDENTIFIER_AT_FAULT`/`PASSWORD_AT_FAULT` against it. The `[^.]{0,40}?`/`[^.]{0,25}?`
gaps in those regexes stop only at a literal period — not at the join boundary between fields — so
a trigger word in one field and a fault word in a *different, unrelated* field can together match.

**Evidence — reproduced directly:**
```
title: "Log in with valid email and password"
steps: ["Verify no fields are missing before login"]
→ wording = "Log in with valid email and password e  Verify no fields are missing before login"
→ IDENTIFIER_AT_FAULT.test(wording) === true
→ credentialPolicyFor returns "none" for a genuine happy-path login case
```
`applyCredentials` then substitutes nothing, the model's invented placeholder credential is typed
instead, login fails, and the run just reports "Failed" with no indication why. Same root defect
class as A11, one function over. Not yet observed in the 75 sampled real cases (real LLM-generated
wording tends to run long enough that the short lazy-match window rarely bridges fields by
chance).

**Fix.** Test `IDENTIFIER_AT_FAULT`/`PASSWORD_AT_FAULT` against each field (title, expected,
intent, each step) independently rather than one joined string.

### ⬜ D4. `store.read()` / `listRuns()` have no per-entry error isolation — one bad run 500s the shared run-history endpoint

`runStore.ts:51`: `events = lines.map((l) => JSON.parse(l) as StageEvent);` — no try/catch. A torn
write (crash mid-`appendFileSync`, or a concurrent write racing a read) in any single run's
`events.ndjson` throws out of `store.read()`. `listRuns()` (`runStore.ts:180`) calls `store.read`
inside a `.map()` over the newest 20 run dirs with no try/catch; `listRuns()` also calls
`statSync(path.join(root, runId))` (line 211) on each, unguarded — `DELETE /api/runs/:runId`
(`server/index.ts:144-153`) can remove that exact directory between `listRuns`'s `readdirSync` and
this later `statSync`, throwing `ENOENT`. `GET /api/runs` (`server/index.ts:137-139`) calls
`listRuns()` with no try/catch of its own, so either failure 500s the endpoint every client polls
for run history — not scoped to the one bad/deleted run.

**Evidence.** User A deletes a run while user B's tab has a `/api/runs` poll in flight → that
request 500s for user B (and would for everyone, since the list is shared) until the race window
passes.

**Fix.** Try/catch the `JSON.parse` (skip/flag the bad line instead of throwing); try/catch each
`.map()` entry in `listRuns()` so one bad/missing run drops from the list instead of failing the
whole response.

### ⬜ D5. Stale poll response can misdirect a credential submission to the wrong run

`public/app.js`'s `connectToRun` (~line 1079): `while (generation === pollGeneration)` is checked
only at the top of each loop iteration — never re-checked after the `await fetch`/`await
res.json()`, before `applyEvent(event, runId)` is called with the OLD `runId` closed over in that
iteration.

**Evidence.** Run A's `/state` poll is in flight; before it resolves, the user switches to run B
(`connectToRun(B)` bumps `pollGeneration`, resets the DOM). A's in-flight fetch then resolves and
applies its one stale batch of events regardless. If that batch includes
`{stage:"credentials", status:"started"}`, the credential modal for run A's site pops over what
the user believes is run B's screen; typing credentials there posts them to
`/api/runs/A/credentials` — potentially the wrong site's credentials landing against the wrong
run.

**Fix.** Re-check `generation === pollGeneration` immediately after the awaited fetch, before
calling `applyEvent`.

### ⬜ D6. `caseAccumulator.appendAcceptedCases` doesn't dedup — a within-batch near-duplicate can be "accepted" twice and silently collapse to one

`caseAccumulator.ts:42-53` pushes every selected index into `acceptedCases` checking only the
capacity count — no title dedup. `getAllAcceptedCases` (line 67-78), used everywhere the accepted
list actually matters (remaining capacity, final case list, the gate's `seenTitles`), *does*
dedup by `normalizeTitle` (trim/lowercase/collapse-whitespace/strip trailing punctuation).
`filterNovelCases` (`testCases.ts:145-148`) only filters a new batch against *previously
accepted/rejected* titles, not against duplicates *within* the same batch, and `toTestCases`
never dedupes its own LLM output before offering it for selection.

**Evidence.** One round returns two entries differing only in case/whitespace/trailing
punctuation (e.g. "Verify login with valid credentials" / "verify login with valid credentials.");
the user, with no visible signal they're the same case, selects both. `appendAcceptedCases`
accepts both (two capacity slots consumed, reports both accepted) but `getAllAcceptedCases()` —
what actually becomes the run's case list — collapses them to one. The user believes they used two
of five pool slots on two different tests; only one exists and runs.

**Fix.** Dedup `selectedIndexes`/resulting titles by the same `normalizeTitle` rule inside
`appendAcceptedCases` before counting against the cap, and reflect collapsed picks back to the
caller instead of silently reporting them as separately accepted.

### ⬜ D7. Case-selection-gate progress events briefly overwrite the phase summary with wrong text

`app.js:889-890`: `applyEvent` calls `setPhaseFromStage(event.stage, event.status, event.data)`
**unconditionally**, before the gate-specific `action`-based early returns at lines 900-925. Every
event the gate emits on the `"testcases"` stage (`case_round_requested`, `case_pool_cap_warning`,
`case_end_of_capacity`, `case_selection_finalized`, etc.) carries an `action` field but no
`generated`/`selected`/`total`/`length`. `summarize("testcases", data)` (line 183-192) falls
through to `const count = data.total ?? data.length ?? 0`, so the phase summary repaints to
**"Generated 0 test scenarios"** — overwriting the correct "Generated 15 → selected 4" text shown
moments earlier. The same fallback also does `data.reactive ? \` (${data.reactive} reactive)\` :
""` (line 191); since `data.reactive` is a boolean on the reactive round, this renders the
literal string **"(true reactive)"**.

**Evidence.** Fires on every interactive run that uses the gate (the normal web-UI path since A8
closed), 100% reproducible, but harmless in effect: the case-review panel below shows the correct
data, this only corrupts one summary line temporarily.

**Fix.** Gate `action` events shouldn't flow through `summarize`'s generic count fallback at all —
either skip `setPhaseFromStage` for them, or give `summarize` a branch for `data.action` before
falling through to the count-based text.

### ⬜ D8. `PLAYWRIGHT_TIMEOUT` env var is set but never read — dead config with a misleading comment

`stages/executor.ts:143`: `PLAYWRIGHT_TIMEOUT: String(CONFIG.TIMEOUTS.TEST_RUN)` is injected into
the child process's env. Confirmed by grep: no code anywhere reads
`process.env.PLAYWRIGHT_TIMEOUT` — `playwright.config.ts:5` hardcodes `timeout: 50_000` instead.
`CONFIG.TIMEOUTS.TEST_RUN` (60s) actually only controls the *parent* process's own kill timer
(`executor.ts:176-180`); its comment ("Increased from 30s to 60s") reads as if it controls
Playwright's per-test timeout, which it does not.

**Evidence / failure this sets up.** Today 60s (parent kill) > 50s (Playwright's real timeout) by
coincidence, so Playwright always reports before the parent kills it. If someone edits
`CONFIG.TIMEOUTS.TEST_RUN` down — reasonably assuming, per the env var's name, that it also
shortens Playwright's timeout — to say 40s, the parent now SIGKILLs the child *before* Playwright's
still-50s timeout produces a report. `runSpec`'s retry condition (`!result.passed && !result.raw`)
treats "killed, no report" as infra failure worth retrying, so a legitimately-slow-but-passing test
gets killed and silently re-run instead of correctly reported as a timeout.

**Fix.** Either have `playwright.config.ts` read `process.env.PLAYWRIGHT_TIMEOUT`, or delete the
env var and the comment implying it does something.

### ⬜ D9. Deleting the currently-viewed run leaves its polling loop running indefinitely

The history delete button's handler (`app.js`) calls `DELETE /api/runs/:runId` and `loadHistory()`
but never touches `pollGeneration`. Deleting the run currently on screen leaves `connectToRun`'s
1s poll loop hitting the now-deleted run's `/state` endpoint forever — nothing observes the
deletion. Once the server 404s for it, a non-throwing `res.json()` on a 404 body would keep
`fails` at 0 and loop silently forever; an actually-throwing case surfaces a "Lost contact" banner
for a run the user deliberately removed.

**Fix.** Bump `pollGeneration` in the delete handler when the deleted id matches the
currently-viewed run.

### D10 — addendum to A7, not a separate item

`targetResolver.ts:68` defines `ROLE_SWAP = { button: "link", link: "button" }`, used by
`resolveRoleWithFallback` (the function `liveExtend.ts`'s live-browser grounding replay calls via
`resolveLive`) to recover when a styled `<a>` acts as a button or vice versa. `generator.ts`'s
`LOCATE_HELPER` — confirmed by grep, no match for `ROLE_SWAP` or an equivalent fallback anywhere
in `generator.ts` — has no such fallback at all. A role-mismatched element can therefore ground
successfully during IR generation/replay and then fail to resolve in the executed spec — concrete
proof the two locator implementations A7 already flags have *already* diverged, not just "could
drift." Fold into A7 as evidence when A7 is picked up.

### Footnotes (not scored as findings)

- `kb/llmCache.ts:40-42`'s `makeCacheKey` joins parts with a bare `"|||"` delimiter — not
  collision-free by construction (`["x","|||y"].join("|||")` and `["x|||","y"].join("|||")`
  produce the same string), but no *reachable* real-invocation collision could be constructed
  (every caller's parts include a fixed tail of system-prompt+model). Hygiene note only —
  length-prefix or JSON-array the parts instead of delimiter-joining, if ever touched.
- `renderCaseCard` (`app.js:389`) and `loadCaseDetails` (`app.js:459`) independently construct the
  same case-artifact path two different ways; both agree today only because `suiteRunner.ts:283`
  happens to always set `resultPath` to `cases/${caseId}`. Nothing pins the two constructions
  equal — same latent-drift shape as A7/D10, not a live bug today.

---

## Suggested order

1. ✅ **C0 → C1 → C2/C3** — done.
2. ✅ **A3, A5, A8** — done.
3. ✅ **B1–B5, B7, B8** — done.
4. ✅ **A4** — done.
5. ✅ **A1** — done.
6. **A11** — the reported bug, highest priority of what's left: single point of failure, actively
   breaking real runs, small isolated fix already designed (see A11 above).
7. **D1** — security, high severity, isolated fix (URL scheme allow-list).
8. **A6, A7 (+D10), A10, D2–D9, B9**.
9. **B6** — needs a decision. **A9** — needs investigation.

## Verification baseline

- `npx vitest run` → **253 passing** (24 files)
- `npx tsc --noEmit` → clean

For anything touching prompts or IR generation, **delete `runs/_cache/llm` before an end-to-end
run** — and note that since C0, editing a prompt already rotates the key, so a stale hit now
implies the inputs really were identical.

End-to-end smoke (the gate parks the CLI until A8 is fixed, hence the override):

```bash
ENABLE_CASE_SELECTION_GATE=false npm run generate -- \
  --prompt '<a multi-step flow with credentials>' --url '<target>'
```

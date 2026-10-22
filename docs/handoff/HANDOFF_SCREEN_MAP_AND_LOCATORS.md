# Handoff: screens in the prompt, a persistent screen map, sturdier Salesforce locators

Written 2026-10-15 against branch `shadowdom` at `ffc3d60`. Four phases, each shippable and
testable on its own. **Phase 1 is already done** (commit `98c706b`, verified on the real site:
run `2026-10-15T07-00-35-932Z-25d84b75` compiled 27 steps and passed through Submit); what is
left of it is a short hardening list. **Do one phase per session. Do not start the next phase until the previous
one's gate (its "Done when" list) is met and the work is pushed.**

This is a plan, not a topic owner (`CLAUDE.md` documentation map): defects go in `TECH_DEBT.md`,
rationale in `DECISIONS.md`, and each shipped phase gets its own `docs/phases/PHASE_*_REPORT.md`.

---

## 0. Rules for every phase (read before touching anything)

1. Read `CLAUDE.md` first and follow it. The ones that bite most here:
   - **Every new capability ships behind an env flag defaulting to OFF** (rule 2). A new flag is
     read in code AND registered in `BOOLEAN_ENV_FLAGS` (`src/server/index.ts`) AND documented in
     `.env.example` **in the same commit**, or `tests/booleanEnvFlags.test.ts` turns `main` red.
   - **Never change an existing route's request or response shape** (rule 1). New data → new
     route or an optional field.
   - **A `page.evaluate` callback must not contain inner named or `const`-assigned functions**
     (TD-40). Inline everything; pass data in as an argument.
   - **A generated Playwright expression isn't verified until it's run once** (D-19). Every new
     locator form must be executed in real Chromium in a test, not just string-asserted.
   - **Check IR/AppModel structure, not prose.** No regexes over the model's wording or page text.
   - **Cache keys must carry every input dimension** (TD-22, D-10). Anything stored per site must
     be keyed by organisation (`llmCacheDimension("main")`) and, where it holds post-login
     content, by `credentialFingerprint(creds)`.
   - **Secrets never touch disk.** Anything written under `runs/` is served over HTTP. Run
     `redactCredentials` on it first.
2. Git: author `Lakshya Soni` with **no email**, committer Claude, keep the `Co-Authored-By`
   trailer. Branch: `shadowdom` (push to `origin/shadowdom`). One commit per phase, plus a docs
   commit if needed. Do not push to `main`.
3. Ownership. Editing `src/stages/ir.ts`, `src/stages/liveExtend.ts`, `src/stages/screens.ts`,
   `src/stages/liveDomDiscovery.ts`, `src/stages/targetResolver.ts`, `src/stages/generator.ts`,
   `src/schema/*.ts` is approved. **Stop and ask before editing** `src/server/index.ts`,
   `public/app.js`, `.env.example`, `app.yaml`, `.github/`, `scripts/`, `src/stages/executor.ts`,
   `src/stages/hybridDiscovery.ts`, `supabase/migrations/`. Phase 2 needs two of those for the
   flag registration — get the approval line before starting Phase 2.
4. Salesforce-only gating is `currentRunTargetApp() === "salesforce"` (`src/runTarget.ts`). In
   `toIR` it is already computed as `screenMode`. Everything below is gated on it unless stated.
   **Ordinary runs must stay byte-identical** — there are fixture tests that pin this
   (`tests/fixtures/salesforceTarget/null-run-prompts.json`, `tests/fixtures/discoveryFlagOff/`).
5. Verification, every phase:
   ```bash
   npx tsc --noEmit
   npx vitest run   # baseline: 2 known failures — safeClickBrowser (needs example.com) and
                    # booleanEnvFlags "has no reader for any reserved flag" (red on main since 152e4a5)
   ```
   Real-browser tests need a Chromium that matches Playwright 1.49. If the sandbox's build does
   not match, point `PLAYWRIGHT_BROWSERS_PATH` at a matching one as earlier sessions did.
6. **Mutation-check** each mechanism: break it on purpose, confirm a test fails, restore. Say in
   the phase report which mutation each test caught.
7. **Known breakage on this branch, fix before Phase 2:** `ffc3d60` deleted `.env.example`.
   `tests/extendedLogging.test.ts` reads that file and now fails; `CLAUDE.md`, `README.md` and
   `src/server/index.ts` refer to it; and every flag (including Phase 2's) is supposed to be
   documented there. It is Gunwant's file — **ask Lakshya whether to restore it**
   (`git checkout 4aed61e -- .env.example`) before adding any flag.
8. Each phase ends with: `docs/phases/PHASE_<NAME>_REPORT.md` (what changed, new flags, new
   routes, schema changes, how to verify, how to roll back, deliberately not fixed), a
   `DECISIONS.md` entry if a design choice was made, `TECH_DEBT.md` entries for anything found.

### Where things are (branch `shadowdom`, `4aed61e`)

| What | Where |
|---|---|
| Screen model: fingerprint, loose same-screen rule, `mergeScreenInto`, `findScreen` | `src/stages/screens.ts` |
| `PageModel.screen` (optional: `key`, `title`, `tab`, `labels`) | `src/schema/appModel.ts` |
| Screen capture with settle + scroll, `captureScreenAt`, `trackInflightRequests` | `src/stages/liveExtend.ts` |
| `toIR`: `screenMode`, `MAX_SCREEN_CAPTURES`, `screenAt` (per attempt), `scopeFor()`, capture loop | `src/stages/ir.ts` ~2095–2200 |
| Prompt assembly: `buildUser` (~1780), `correctionBlock` (~1870), `render` (~1885), `MAX_CHARS = 30_000` | `src/stages/ir.ts` |
| Prompt's model projection (ONE page, 30 elements, role+name only) | `toMicroModel` in `src/schema/appModel.ts` |
| Grounding: `groundingError`, `screenAtStep`, `screenControlsHint`, `disabledTargetErr` | `src/stages/ir.ts` ~600–1100 |
| Live walker + css candidate ladder | `src/stages/liveDomDiscovery.ts` ~179–262 (ladder), `verifyWithPlaywright` |
| Generated locator from a target | `resolveCode` in `src/stages/targetResolver.ts` ~417 |
| Disk cache (never expires), namespaces, `makeCacheKey`, `credentialFingerprint` | `src/kb/llmCache.ts` |
| Run artifacts (`runs/<id>/0N-*.json`) | `src/orchestrator.ts` `step(...)`, ~183 |
| Salesforce prompt rules | `src/stages/salesforceGuidance.ts` |
| **Captured screens in the retry prompt** (Phase 1, done): `capturedScreenKeys` (~1812), `capturedScreensBlock` (~1815), `SCREEN_CONTROL_ROLES`, `SCREEN_NAMES_CAP` | `src/stages/ir.ts` |
| Best-attempt shipping (`fromBestPartial`), capture reuse by prefix, select-on-button partial match | `src/stages/ir.ts` (TD-126, TD-128) |
| Request's quoted control names restored in test cases | `src/stages/controlNames.ts` (TD-127) |
| Numbers already taken | `DECISIONS.md` up to D-52; `TECH_DEBT.md` up to TD-129 — new entries start at D-53 / TD-130 |
| Existing real-browser tests to extend | `tests/multiScreenWizard.test.ts`, `tests/screens.test.ts`, `tests/selectOnTextbox.test.ts` |

---

## Phase 1 — Show the model the captured screens on retry (TD-122) — DONE in `98c706b`

What landed: on a Salesforce **retry**, `capturedScreensBlock` lists each captured screen
(`capturedScreenKeys`, in capture order) as `- <url> ("<title>"): role "name", role "name" (disabled), …`,
dialog controls first, ≤ `SCREEN_NAMES_CAP` (30) names per screen. First attempts and
non-Salesforce runs are untouched. Also in that commit: the last attempt ships `bestPartial`
rather than its own short prefix (TD-128), captures are reused by prefix instead of re-taken,
"Self" → "Self Use" on a button group when exactly one matches (TD-126), and quoted control
names from the request are restored in generated cases (TD-127).

### Phase 1b — hardening (small; do it in the Phase 2 session before 2a)
- **Screen cap.** The block caps names per screen but not screens. Cap at 8 screens, newest
  kept, and make the existing `MAX_CHARS` loop drop the oldest screens from the block before it
  drops pages. Log `[ir] screens block: N screens, M chars`.
- **Byte-identical fixture for ordinary retries.** Capture the retry prompt of a NON-Salesforce
  run from the code as it is now into `tests/fixtures/salesforceTarget/retry-prompt-ordinary.json`
  and assert against it (same discipline as `null-run-prompts.json`), so Phase 2 cannot leak the
  block into ordinary runs.
- **Mutation check** on the block (empty it → the wizard "skips Select for EOI" test must fail).

### Done when
- Both tests pass; `tsc` clean; vitest at baseline.
- Nothing else changes: this is tests plus a cap.

---

## Phase 2 — Persist the screen map across runs ("Application Universe", minimal)

### Why
Every run rediscovers the same screens (one browser launch each, ~10 s). Nothing remembers that
"on The Sanctuary, clicking Express Interest opens Your Contact Details". ACCELQ's Context graph is
exactly this memory.

### Design — two sub-steps, both behind one new flag

**Flag:** `SCREEN_MAP_ENABLED`, default off. Registered in `BOOLEAN_ENV_FLAGS` + `.env.example`
in the same commit as its first read (**needs approval for those two files — ask first**).

**2a. Record (write side).** New module `src/stages/screenMap.ts`:
```ts
interface ScreenMapEdge { from: string | null; action: { role: string; name: string }; to: string; seen: number }
interface ScreenMapScreen { key: string; url: string; title: string; tab: string; labels: string[];
  controls: { role: string; name: string; enabled?: boolean }[]; seen: number; lastSeen: string }
interface ScreenMap { version: 1; site: string; screens: ScreenMapScreen[]; edges: ScreenMapEdge[] }
```
- In `toIR`'s capture loop, after `captureScreenAt` succeeds: record the screen (from
  `cap.model`'s page with `screen.key === cap.key`) and an edge from the previous screen (the
  `screenAt` entry before this one, or `null` for the entry page) via the last click/press step in
  the replayed prefix (`role`, `name` only — never css, which is session-bound).
- Write `runs/<id>/09-screen-map.json` (new artifact, additive, via the orchestrator's `step`
  helper or a direct `writeFileSync` beside it). Run `redactCredentials` on it first.
- Persist per site: `llmCacheSet(key, map, "screenmap")` where
  `key = makeCacheKey(siteHost(baseUrl), "salesforce", llmCacheDimension("main"), credentialFingerprint(creds), llmCacheVersion())`.
  Merge with the stored map using `sameScreen` (loose rule) → replace matching screen, bump
  `seen`, update `lastSeen`; edges deduped by (from, action, to). Caps: 60 screens, 200 edges per
  site; drop least-recently-seen. TTL: `SCREEN_MAP_TTL_MS` (default 7 days) checked on read —
  the disk cache itself never expires, so the module enforces it.

**2b. Use (read side).** At the start of `toIR` when `screenMode && flag`:
- Load the site's map. **Stored screens are hints for the model, never grounding evidence**: feed
  them through `capturedScreensBlock` — give it a second source besides `capturedScreenKeys`
  (stored screens, marked `(from an earlier run — may have changed)`), and emit the block on the
  **first** attempt too when stored screens exist. Nothing else reads the map. Grounding still requires a live
  capture, so correctness is unchanged; what improves is the model writing the right steps first
  time, which cuts retries and captures.
- Edges: when `screenBoundaries` marks a step and the map has an edge from the current screen via
  that `role+name`, log it (`[ir] screen map predicts: ... -> ...`). Do not skip the capture in
  this phase (that is a later optimisation once the map proves accurate).

### Do not
- No database table, no migration. Disk cache namespace only (same place as walks).
- No new route in this phase. (A `GET /api/projects/:id/screen-map` can come later.)
- Never store css/testId/ids in the map — they are session-bound on Lightning.

### Tests
- `tests/screenMap.test.ts` (pure): merge replaces same screen and bumps `seen`; adds new screen;
  edge dedupe; caps evict least-recently-seen; TTL expiry returns empty; key differs per org
  dimension and per credential fingerprint; `redactCredentials` applied (a name containing the
  password never reaches the map).
- `tests/multiScreenWizard.test.ts`: run `toIR` twice on the wizard with a fresh
  `llmCacheClear("screenmap")` first; second run's **first** IR prompt contains the stored
  screens' names; second run's IR call count ≤ first run's. Flag off → no `09-screen-map.json`,
  prompt identical to Phase 1 behaviour.
- Mutation: break the merge (always append) → cap test fails; break the key (drop org dimension)
  → tenancy test fails.

### Done when
- Flag off: everything byte-identical to Phase 1 (fixture).
- Flag on, real site: second run of the same request shows `[ir] screen map predicts` lines and
  fewer IR calls than the first. Record both numbers.
- `DECISIONS.md` D-53 (why disk cache not DB, why hints-not-evidence), `TECH_DEBT.md` TD-130+
  for anything found, phase report.

---

## Phase 3 — Label + nearby-text locators for Salesforce (sturdier than ids/positions)

### Why
Current Salesforce css: `... >> c-landing-lead-form >> #email-145` and 300-char positional paths.
Lightning generates `-NNN` id suffixes per session, and positional paths break on any layout
change. ACCELQ's default is "locator-free": label + anchor text + index.

### Design (walker ladder in `src/stages/liveDomDiscovery.ts` ~179–262, Salesforce mode only)
Pass `salesforce: boolean` INTO the `page.evaluate` callback as an argument (no closure, TD-40).
When true, change the candidate ladder to:
1. `[data-test]`, `[data-testid]`, `[data-qa]` (unchanged)
2. `#id` — **only if the id is not generated**: skip when it matches `/-\d+$/` or `/^\w+-\d+-\d+$/`
   (Lightning: `input-145`, `combobox-button-12`, `email-145`). Same rule for the positional
   anchor id.
3. `tag[name=...]`, `tag[aria-label=...]` (unchanged)
4. **NEW — accessible-name selector**: `role=<role>[name="<accname>"]` using Playwright's role
   engine (pierces open shadow roots; usable inside `>>` chains and in `page.locator`). Only when
   the walker computed a non-empty accessible name. Candidate text is built in the browser;
   uniqueness is confirmed by `verifyWithPlaywright` (count === 1), **always** in Salesforce
   mode, not only when a shadow root was seen.
5. **NEW — layout-anchored selector**: for form controls with a visible label/heading text
   nearby: `<tag>:below(:text("<label>"))` or `:right-of(...)` (Playwright layout
   pseudo-classes), only when `verifyWithPlaywright` says unique.
6. Positional path — last, unchanged.

Everything downstream already handles a css string: `resolveCode` emits `page.locator(css)`, the
`>>` frame/shadow chains work, `knownSelectors` lowercases only for lookup. **Check that the
emitted css keeps its case** (`role=textbox[name="Email Address"]` must not be lowercased
anywhere on the way to the spec — grep for `.toLowerCase()` on `css` in `ir.ts`, `screens.ts`,
`deterministicHeal.ts`, `stepText.ts`).

### Do not
- Do not change the ladder for non-Salesforce runs. `tests/fixtures/discoveryFlagOff/` and a new
  fixture for live-mode-ordinary must stay byte-identical.
- Do not use `:near()` (too loose). `:below`/`:right-of`/`:left-of` only, verified unique.

### Tests (real Chromium)
- `tests/salesforceLocators.test.ts`: a page shaped like the EOI form inside a shadow host, ids
  `email-145`, `phone-145`; walker in Salesforce mode emits no `-145` id and a
  `role=textbox[name="Email Address"]` (or `:below`) css; **re-render the page with `-146` ids
  and execute the emitted css** via `page.locator(css)` → still 1 element, `fill` works.
- Duplicate names ("Next" twice): role selector is not unique → falls to the next tier; emitted
  css still resolves to the right one (run it).
- Iframe + shadow combo from `tests/frameTarget.test.ts` still passes.
- Non-Salesforce: walker output byte-identical to a fixture captured before the change.
- Full flow: `tests/multiScreenWizard.test.ts` wizard still passes end to end with the new ladder.
- Mutation: disable tier 4 → the `-146` re-render test fails.

### Done when
- Real site: `04-ir.json` for the EOI case shows no `-\d+` ids in `css`, the form steps use
  role/label selectors, and the case executes as far as before or further.
- `DECISIONS.md` D-54 (ladder change, why role engine, why generated-id rule), phase report,
  TD-13x entry if any step regressed.

---

## Phase 4 (later) — "Record the flow once" mode, then possibly a local agent

**Do not build these in this handoff.** Write the design only, as `docs/handoff/DESIGN_RECORD_MODE.md`,
after Phases 1–3 are live and measured. Open questions that must be answered first:

**Record mode.** The server runs in Azure, so a person cannot drive its browser. Options:
(a) a small browser extension that captures clicks + the walker's element model per screen and
POSTs them to a **new** route (`POST /api/projects/:id/recordings`), feeding the Phase 2 screen
map; (b) a Playwright `codegen`-style session streamed to the browser over a new route; (c)
Chrome remote-debugging (CDP) from the user's machine. (a) is closest to ACCELQ. Decide: auth,
what is stored (names and screens only — never values typed), how a recording merges into the
screen map, and how it is shown in the UI (new view; `showView()` only; existing class contracts).

**Local agent.** Only matters if customers' sites are reachable from inside their network only.
Shape: a worker that polls the server (outbound HTTPS, API key), runs discovery/replay/execution
locally, uploads artifacts. Needs: job queue (`runRegistry` is in-memory today), artifact upload
route, credential handling (secrets stay on the agent), and a security review. Not before the
screen map has proven itself.

---

## Order of work and session plan

| Session | Do | Gate |
|---|---|---|
| 1 | `.env.example` decision, Phase 1b, then Phase 2a+2b (after flag-file approval) | flag-off identical; flag-on second run cheaper |
| 2 | Phase 2 real-site check if session 1 ran out | second run cheaper than the first |
| 3 | Phase 3 | `-146` re-render test; real-site `04-ir.json` free of generated ids |
| 4 | Phase 4 design doc only | reviewed by Lakshya |

Baseline to beat, from `98c706b`'s verification: run `2026-10-15T07-00-35-932Z-25d84b75`, 27 steps,
passed through Submit. Record IR call count and screen-capture count of every later real run next
to it in the phase report.

If a phase's real-site check fails, stop, write the failure (run id, `04-ir.json` truncation
note, screenshots) into the phase report, and do not start the next phase.

---

## Other streams' edits to shared files (log here to avoid merge surprises)

### 2026-10-19 — `src/stages/generator.ts`, `src/stages/ir.ts`, `src/schema/ir.ts` — fixed Salesforce login (D-57)

Branch `vaibhav/determined-dijkstra-0t2ec9`. Behind `SALESFORCE_FIXED_LOGIN` (default off) AND a ticked
Salesforce run. Off: every compile and every spec is byte-identical (pinned by
`tests/fixtures/salesforceFixedLogin/flag-off-specs.json`, captured from the generator before the change).

- `src/schema/ir.ts`: one optional field, `IR.meta.fixedLogin: "salesforce"`. Set only by `toIR`; a
  model-written value is stripped.
- `src/stages/ir.ts`: `swapInRecordedLogin` (a login case that signs in with the real credentials gets the
  recorded login instead of the model's); `toIR` sets `meta.fixedLogin` when the IR starts with the login
  prefix; the IR cache key gains `"sf-fixed-login:1"` only when on.
- `src/stages/generator.ts`: new `SALESFORCE_LOGIN_HELPER` and `fixedLoginBlock`. In `generateSpec`, a marked
  IR's leading `auth-*` steps become one `salesforceLogin(page, loginUrl)` call in step 1; the other `auth-*`
  steps stay as empty `test.step`s (one test.step per IR step is still true — executor/failureAnalysis rely
  on it) and take no screenshot. The generator also requires the flag itself, so a saved case still
  carrying the marker goes back to the step-by-step login when the flag is off. No existing helper,
  emitter or label was changed.

### 2026-10-22 — `src/stages/generator.ts` — pinned `?login` Salesforce login (D-59)
Branch `vaibhav/determined-dijkstra-0t2ec9`. Behind `SALESFORCE_LOGIN_PARAM` (default off), and only
where the D-57 fixed-login block is emitted. Off: byte-identical to D-57 (`tests/salesforceLoginParam.test.ts`).

- New `SALESFORCE_TWO_SCREEN_LOGIN_HELPER` (straight-line two-screen `salesforceLogin`; reuses D-57's
  `salesforceWhere`/`salesforceLoginFailure` text by slicing it), `salesforceLoginParamEnabled()`, and
  exported `withLoginParam(url)`.
- `generateSpec`: with the flag on, step 1's label and its `salesforceLogin(page, url)` argument use
  `withLoginParam(loginUrl)`, and the helper splice picks the two-screen helper. No other emitter changed.

### 2026-10-22 — `src/stages/generator.ts` — D-59 removed (D-62)
`SALESFORCE_TWO_SCREEN_LOGIN_HELPER`, `salesforceLoginParamEnabled` and `withLoginParam` deleted, with
the `SALESFORCE_LOGIN_PARAM` flag and `tests/salesforceLoginParam.test.ts`. `generator.ts` is now
byte-identical to its state before D-59 (`git diff 72127dc -- src/stages/generator.ts` is empty).

### 2026-10-22 — `src/stages/ir.ts`, `executor.ts`, `htmlReport.ts` — Salesforce post-login (D-62)
All behind `SALESFORCE_FIXED_LOGIN` on a ticked run. `ir.ts`: `redirectPostLoginNavigate` accepts the same
org on another host (absolute URL) and now also runs on the D-57 swap path; `knownNavigationTargets` adds
`auth.url`; cache key gains `sf-post-login:1`. `executor.ts` `detectBlocked`: same org's app host is not
"left". `htmlReport.ts`: "Only checked that login works" note via `onlyChecksLogin`. No generator change.


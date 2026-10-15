# Handoff: screens in the prompt, a persistent screen map, sturdier Salesforce locators

Written 2026-10-15 against branch `shadowdom` at `4aed61e`. Four phases, each shippable and
testable on its own. **Do one phase per session. Do not start the next phase until the previous
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
7. Each phase ends with: `docs/phases/PHASE_<NAME>_REPORT.md` (what changed, new flags, new
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
| Existing real-browser tests to extend | `tests/multiScreenWizard.test.ts`, `tests/screens.test.ts`, `tests/selectOnTextbox.test.ts` |

---

## Phase 1 — Show the model the captured screens on retry (TD-122)

### Why
`toMicroModel` hands the IR model **one page** (the entry page), 30 elements, role+name only.
Screens the run captures later are used for grounding but never shown to the model, so it writes
every later step from the user's sentence alone and invents or drops names ("Select" for
"Select for EOI", skipping "Select for EOI" entirely — runs `2026-10-14T02-35-44`,
`2026-10-14T01-59-44`). `screenControlsHint` (TD-124) patches this per rejection; this phase fixes
it at the source.

### Design
- In `buildUser`, when `screenMode` **and** this is a retry (`correction` is set), append a block
  **after** the application model and **before** the test case:
  ```
  Screens captured so far on this site (live, after the steps that reach them). Use ONLY these
  names for steps after the entry page:
  - Screen "The Sanctuary" (url /project-details): button "Select for EOI", button "Express Interest" (disabled), ...
  - Screen "Your Contact Details" (url /project-details): textbox "Full Name", textbox "Email Address", ...
  ```
  Source of truth: `currentModel.pages.filter(p => p.screen)`, in the order they were added.
  Per screen: `screen.title` (fallback: page title, then pageKey), the pageKey, and the visible
  controls as `role "name"` with ` (disabled)` for `enabled === false`. Roles: button, link, tab,
  menuitem, textbox, combobox, searchbox, checkbox, radio, spinbutton. Cap **30 controls per
  screen** and **8 screens** (newest kept). Names come from the capture, never invented.
- **First attempt unchanged.** No block when `correction` is undefined. Non-Salesforce runs:
  no block ever. This keeps first-attempt prompts (and their LLM cache keys) byte-identical.
- Budget: the existing `MAX_CHARS` loop drops pages; make it also drop the oldest screens from
  this block before dropping pages. Log `[ir] screens block: N screens, M chars`.
- Keep `screenControlsHint` as is (it still helps when the retry is for a different reason).

### Do not
- Do not put screens in `toMicroModel` or the first-attempt prompt. (Measure first; a later phase
  can move it if retries still dominate.)
- Do not change the system prompt (`salesforceGuidance.ts`) — the block goes in the user turn.

### Tests (`tests/multiScreenWizard.test.ts`, real Chromium, LLM mocked)
1. Wizard: model's first IR skips "Select for EOI"; assert the **second** IR prompt contains the
   block with `button "Select for EOI"` and `button "Express Interest" (disabled)`, and the first
   prompt does **not** contain "Screens captured". Final IR complete and executes.
2. Non-Salesforce run: the retry prompt is byte-identical to a fixture captured BEFORE this
   change (add `tests/fixtures/salesforceTarget/retry-prompt-ordinary.json`, captured from the
   code before the edit).
3. Cap: 10 screens × 40 controls → block holds 8 screens × 30, newest screens.
4. Mutation: remove the block → test 1 fails.

### Done when
- Tests above pass; `tsc` clean; full vitest at baseline (2 known failures).
- Real run on `th1790674436190--realestate.sandbox.my.site.com` reaches at least step 17 with
  **fewer IR attempts** than run `2026-10-14T04-27-15` (16 IR calls). Record the number.
- `TECH_DEBT.md` TD-122 marked fixed; `docs/phases/PHASE_SCREENS_IN_PROMPT_REPORT.md`.

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
  them into the Phase 1 block (now also on the **first** attempt, marked
  `(from an earlier run — may have changed)`), and nothing else. Grounding still requires a live
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
- `DECISIONS.md` D-53 (why disk cache not DB, why hints-not-evidence), phase report.

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
  TD entry if any step regressed.

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
| 1 | Phase 1 | tests + real-site run with fewer IR attempts |
| 2 | Phase 2a+2b (after flag-file approval) | flag-off identical; flag-on second run cheaper |
| 3 | Phase 3 | `-146` re-render test; real-site `04-ir.json` free of generated ids |
| 4 | Phase 4 design doc only | reviewed by Lakshya |

If a phase's real-site check fails, stop, write the failure (run id, `04-ir.json` truncation
note, screenshots) into the phase report, and do not start the next phase.

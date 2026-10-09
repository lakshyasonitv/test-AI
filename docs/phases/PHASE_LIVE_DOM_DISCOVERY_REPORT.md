# Phase — live-DOM discovery (Stream A, `DISCOVERY_LIVE_DOM`)

Discovery used to know a page only through `page.content()` — a serialized HTML string parsed by
cheerio. That string has no computed style (so `visible` was hardcoded `true`), carries no shadow
root, and says nothing about iframes; and form-extracted elements got no `css`. Together that is
the Salesforce login failure: a hidden password-mirror input entered the model as visible with no
`css`, and the spec emitted `field(page, "passwordShown", "fill")`, which resolved to nothing.

This stream adds a live-DOM element walker behind `DISCOVERY_LIVE_DOM` (default **off**), makes
every locator frame-aware, and fixes five defects found along the way.

**Commits, in order** (all on `main`):

| Commit | What |
|---|---|
| `0294faf`, `4e9911d` | Phase 1 — additive schema: `Element.frame/inShadow/nameSource/visibleSource`, `Target.frame` |
| `5d1f44e` | Phase 2 — the live walker, light DOM |
| `b1a1920` | LS-1…LS-4 filed in `TECH_DEBT.md` |
| `dcc36df` | Phase 3 — open shadow roots |
| `bf4c330` | Phase 4 — same-origin iframes; frame-aware `resolveCode` / generator / `resolveLive` (+ LS-5 filed) |
| `07ba5cb` | LS-4 fixed — `#id` escaping |
| `579fe49` | LS-5 fixed — deterministic heal carries `frame` |
| `657d489` | LS-3 fixed — one `pageKey` |
| `9ffe13b` | Phase 5 — the strategy switch, plus the flag registration |
| *(this commit)* | Phase 7 — this report, `DECISIONS.md` D-40–D-44, `ARCHITECTURE.md`, `README.md` |

LS-1 and LS-2 (grounding ignored `nth`; grounding preferred a hidden twin) were found here and
fixed by Garvit in `f182b5b`; his `782b306` grounds `Target.frame` from `Element.frame`.

**Tests:** `tsc` clean. vitest **1904 passed**, 1 failed, 23 skipped. Baseline before the stream:
1722 passed with the same 1 failure. +112 are this stream's, +70 came from Garvit's commits. The one
failure, `safeClickBrowser › still navigates a REAL href`, needs `example.com`, which this
sandbox's network policy blocks; it fails identically on the commit before this stream.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/liveDomDiscovery.ts` | **New.** The walker: one `page.evaluate` per document, no inner functions (TD-40). Accessible name in accname order, never the HTML `name` attribute; visibility measured with the `recheckVisibility` predicate (not `offsetParent`); a verified `css` for every element (D-40); open shadow roots with Playwright re-verification (D-41); same-origin iframes (D-42). |
| `src/stages/domDiscovery.ts` | The `DISCOVERY_LIVE_DOM` switch (`elementStrategy`, `elementsFor`), landmark tagging factored into `tagLandmarks` (unchanged logic), `recheckVisibility` skips measured elements, strategy-aware cache key `domCacheKey` (D-43). Generic clickables' `#id` now goes through `stableSelector` (LS-4). |
| `src/schema/appModel.ts` | The `Element` block only: four optional fields. `pageKey` now re-exports `src/text.ts`'s (LS-3). `AuthStep` untouched. |
| `src/schema/ir.ts` | `Target.frame`, optional. |
| `src/stages/targetResolver.ts` | `frameSegments` / `frameRootCode` / `frameRoot`; every `resolveCode` and `resolveLive` branch hangs off the frame root; `chooseLive` takes an optional `root`. |
| `src/stages/generator.ts` | `:visible` operand from the target's own root; framed targets skip `safeClick`; `choose()` takes an optional 4th `root`, emitted only for framed targets. |
| `src/stages/discovery.ts` | `cssIdent` (a port of `CSS.escape`); `stableSelector` keeps a plain id as `#id` and quotes the rest (LS-4). |
| `src/stages/deterministicHeal.ts` | Heal takes `frame` from the matched element; `frame` counts in the "same element" early return and in `diffTargets` (LS-5). |
| `src/server/index.ts` | One line: `"DISCOVERY_LIVE_DOM"` in `BOOLEAN_ENV_FLAGS`, landed in the same commit as its first read so `booleanEnvFlags.test.ts` never went red. |
| `public/app.js` | `gatePageKey`'s body only — the third `pageKey` copy (LS-3). No route, response shape or class name. |
| `.env.example`, `README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `TECH_DEBT.md` | Documentation. |

## 2. NEW FILES

- `src/stages/liveDomDiscovery.ts`
- `tests/liveDomDiscovery.test.ts`, `tests/frameTarget.test.ts`, `tests/discoveryStrategy.test.ts`,
  `tests/selectorEscape.test.ts`, `tests/pageKeyParity.test.ts`, `tests/deterministicHealFrame.test.ts`
- `tests/fixtures/discoveryFlagOff/pre-phase5.json` — flag-off output captured from the code
  BEFORE the switch existed
- this report

## 3. NEW ENV FLAGS

`DISCOVERY_LIVE_DOM` — default **off**. With it off, `extractDomModelFromPage` output is
byte-identical to before (pinned by the fixture above, for the flag unset and for `=false`).

## 4. NEW ROUTES

**None.** No route's request or response shape changed.

## 5. SCHEMA CHANGES

All additive and optional; nothing renamed or reordered. `tests/frameTarget.test.ts` parses every
real saved IR and AppModel under `tests/fixtures/` and asserts each parsed object has exactly the
stored key set — so a default that materialised a field would fail (mutation-checked).

## 6. WHAT I DID NOT TOUCH — and the two exceptions

Untouched as the brief required: `src/stages/ir.ts`, `src/stages/hybridDiscovery.ts`,
`src/stages/executor.ts`, `app.yaml`, `supabase/migrations/`, `.github/`, `scripts/`.

Touched outside the brief's list, each with the stream owner's explicit approval in the session:
`public/app.js` (LS-3's third copy, body only), `src/server/index.ts` + `.env.example` (the flag
registration, which could not land separately without turning `main` red), and
`src/stages/deterministicHeal.ts` (LS-5). `src/stages/stepText.ts` was checked for the same frame
gap as LS-5 and does **not** have it — an edited target is rebuilt from scratch.

## 7. HOW TO VERIFY

```bash
npx tsc --noEmit
npx vitest run     # expect 1904 passed; the one failure needs example.com
```

**What was verified, and how.** Every claim below was checked by executing code, not by reading it
(D-19):

- **Every generated locator was run in a real browser.** All walker and frame tests execute the
  selectors through Playwright against synthetic HTML in real Chromium, and every iframe control in
  `frameTarget.test.ts` has a same-named decoy in the top document, so a path that forgot the frame
  lands on the decoy.
- **TD-40 for real.** A test runs the walker in a child process under `tsx` (the transform
  `npm run serve` uses); an injected inner helper fails it with `ReferenceError: __name is not
  defined`, while the rest of vitest still passes.
- **Mutation-checked.** Each mechanism was broken on purpose and a test failed. Four times a
  mutation *survived* first (the fixed-header visibility case, the name-attribute fallback, the
  `:scope` anchor, the `recheckVisibility` selector filter) — the first three exposed tests that did
  not test what they said and were fixed; the fourth is a deliberate double guard.
- **Flag off is byte-identical.** Captured before the switch, asserted after, unset and `=false`.

**Phase 6 — what could and could not be run here.** The brief asks for one non-Salesforce project
end to end with the flag on. This session's network policy denies every external host
(`saucedemo.com`, `example.com`, `the-internet.herokuapp.com` all returned a CONNECT 403) and no
LLM key is configured, so the **full pipeline (discovery → Gemini → spec → run) against a real
external site was NOT run.** That is still owed. It needs the target site and the Gemini API host
allowed in the environment's network settings, plus a key.

What *was* run instead, for real and without an LLM: the production discovery path
(`discoverUsingCrawler`, cache disabled) against a real web app on `localhost` — this project's own
Testbench UI, served by `tsx` exactly as `npm run serve` does — with the flag off and on, then every
flag-on element's emitted `resolveCode` locator executed in a fresh browser:

| | flag off | flag on |
|---|---|---|
| elements | 73 | 74 |
| with a `css` | 37 | **69** |
| `visible: false` | 31 | 53 |
| discovery time | 2.6 s | 1.3 s |

- 69/74 flag-on locators resolve to exactly one element; Playwright's `isVisible()` agrees with the
  walker's `visible` on all 69. The 5 without a `css` are generic clickables merged in from the
  static path (no id), same as with the flag off.
- All 9 flag-off-only entries map to the same control flag-on (same `#id`), under its real
  accessible name — e.g. `button "×"` → `button "Close menu"`. Checked with `includeHidden`:
  `getByRole("button", { name: "×" })` matches **0**, `"Close menu"` matches **1**; likewise
  `"+ Suite"`/`"New suite"` and `"☰"`/`"Open menu"`. The flag-off names were unaddressable.
- The one entry with no counterpart is a nameless heading; the page's three empty headings are
  exactly the three the walker names from their ids. No control was lost (D-44).

**To finish Phase 6 elsewhere:** on a machine with network access, run a project end to end twice —
`DISCOVERY_LIVE_DOM=false` and `=true`, `APPMODEL_CACHE_TTL_MS=0` — and diff `02-appmodel.json`'s
elements by control (not by count), then confirm the generated spec runs.

## 8. HOW TO ROLLBACK

Turning the feature off needs no revert: unset `DISCOVERY_LIVE_DOM` (or set `false`) — output is
then byte-identical. To take the switch out of the code:

```
git revert 9ffe13b    # the switch + the flag registration, together (the guard test needs both gone)
```

Dry-run in a scratch worktree: this reverts **cleanly**. With it reverted nothing calls the walker,
and frameless targets already emit exactly what they did before, so the remaining code is inert.

**Removing the walker and frame code entirely is NOT a clean revert.** Dry-run: reverting
`bf4c330 dcc36df 5d1f44e` after that conflicts in `TECH_DEBT.md`, and `07ba5cb` (LS-4) later edited
the walker's id candidate. Do it by hand if ever needed — delete `liveDomDiscovery.ts` and its tests,
then revert the frame-root changes in `targetResolver.ts`/`generator.ts` — but there is little
reason to: the three fixes (`07ba5cb` LS-4, `579fe49` LS-5, `657d489` LS-3) and the schema
(`0294faf`) stand on their own. No migration, no manual step.

## 9. DELIBERATELY NOT FIXED

- **The real-site end-to-end run** (above). Owed; blocked by network policy, not by code.
- **`hybridDiscovery.ts` cache keys** (`url`, `siteCacheKey`) do not carry the strategy, so after
  flipping the flag a model from the other mode can be served for up to `APPMODEL_CACHE_TTL_MS`
  (30 min). Mitigation: wait it out, or set the TTL to 0 once. Another stream's file.
- **`liveExtend.ts` calls `chooseLive` without the frame root**, so a live replay of a `select` on
  a *wrapper* inside an iframe re-indexes on the page. The generated spec is correct. One argument
  at that call site; another stream's file.
- **Generic clickables keep the static path's behaviour** — no `css` unless they have an id, and
  visibility only from their bounding box. TD-13 is closed for walker elements, not for these.
- **Closed shadow roots and cross-origin iframes** are not enumerated — unreachable by design /
  out of scope. Salesforce orgs in *synthetic* shadow mode are plain light DOM to the walker; the
  spike that would say how much of Lightning uses real shadow roots has not run.
- **Positional selectors are layout-coupled** (D-40). Used only where the page offers nothing stable.
- **`id` fallback values** for elements without an id (`button_7`) are positional in the list, as
  on the static path.
- **Test environment:** the pinned Playwright 1.49 wants Chromium build 1148 and this sandbox has
  1194; local runs here pointed `PLAYWRIGHT_BROWSERS_PATH` at symlinks. CI downloads the right build
  and is unaffected.

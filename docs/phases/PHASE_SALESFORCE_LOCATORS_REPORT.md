# Phase 3 — label and role locators for Salesforce (sturdier than ids and positions)

Handoff `docs/handoff/HANDOFF_SCREEN_MAP_AND_LOCATORS.md`, Phase 3. Rationale: `DECISIONS.md` **D-55**.
The handoff's text says D-54, which Phase 2 has since taken.

> **STATUS: DONE, and the real-site check is MET.** Run `2026-10-15T18-47-43-461Z-28eed5b4` (EOI flow,
> detailed prompt, run locally) **passed all 28 steps through "Thank You"** with 6 IR calls.
> - Its `04-ir.json` has **no generated ids**: 17 css values end in `role=…[name="…"s]`, and one in
>   `select:below(:text("Phone Number"))`.
> - The run before Phase 3 (`17-50-49`) passed with id-based css.
> - The shadow-HOST chain before `>>` is still a positional path through layout components. That is
>   not session-bound, but not layout-proof either.

**Tests:** `tsc` clean. vitest **2210 passed, 7 failed, 23 skipped** (165 files). The 7 are a subset of the
`5196487` baseline's 8; the intermittent Pro `specRoutes` test passed this time.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/liveDomDiscovery.ts` | Salesforce runs only. `salesforce` is passed into the in-page walker as an argument (TD-40: no closures, everything inline). The rest is listed below this table. |
| `src/stages/liveExtend.ts` | **The "walks" cache key gains `sf-locators:1` on Salesforce runs** (`walkCacheKey`, now exported). Captures are cached on disk forever, and the key did not carry the ladder. Without this, a Salesforce run replaying an already-seen prefix would be served the OLD capture, with `#email-145` from a session long gone, and Phase 3 would be invisible. Ordinary keys are byte-identical. |
| `tests/salesforceLocators.test.ts` | **New**, real Chromium. Setup: an EOI-shaped form inside an open shadow root with `-145` ids. See the list below this table. |
| `tests/fixtures/salesforceLocators/walker-ordinary.json` | **New.** Captured from the walker at `f1b1127`, before this change. |
| `tests/multiScreenWizard.test.ts` | One assertion updated: the enabled unit's button is now `#units > div:nth-of-type(2) > button`, not `#sel-102` (TD-133). The test still runs the flow to "Thank you". |
| `DECISIONS.md` D-55, `TECH_DEBT.md` TD-133 | Rationale and the numbered-id trade-off. |

**What the walker change does:**
- Generated ids (`/-\d+$/`, `/^\w+-\d+-\d+$/`) are skipped, both as candidates and as the positional
  path's anchor.
- **Tier 4**, `role=<role>[name="…"s]`, and **tier 5**, `<tag>:below(:text("…"))` / `:right-of(...)`
  for a field with no accessible name, are inserted ahead of the positional path.
- `verifyWithPlaywright` runs on every Salesforce walk, not only when a shadow root was seen.

**What the new test checks:**
- No `-14x` id appears in any css.
- Email gets `role=textbox[name="Email Address"s]`.
- **After a re-render to `-146` ids**, the css still finds exactly one element and `fill` works.
- **The generated spec's own expression** (`resolveCode`) runs and fills.
- With two "Next" buttons, the role selector is not chosen, and each emitted css clicks the right
  button.
- A field with no accessible name gets `input:below(:text("Budget"))`, and it runs after a re-render.
- An ordinary walk is byte-identical to the fixture.

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.** Gated on the existing Salesforce run flag.

## 3. HOW IT WAS VERIFIED

- **Case is kept:** no code writes a lowercased css back. Every `.toLowerCase()` on css in `ir.ts`,
  `screens.ts`, `deterministicHeal.ts` and `stepText.ts` is used for lookup or comparison only.
- **The generator** emits `page.locator(JSON.stringify(css))`, so the quotes inside a role selector
  are escaped. A test executes it.
- **Mutation checks:**

| Mutation | Caught by |
|---|---|
| Tier 4 disabled (the handoff's) | "the role selector still finds and fills the field after -145 becomes -146" |
| Generated ids not skipped | the `-146` test and the "no accessible name" test |
| Tier 5 disabled | "a field with no accessible name is anchored below its visible label" |
| Tiers applied to every run (gate removed) | "an ordinary walk is byte-identical" |
| Role name matched loosely (no `s`) | the `-146` test |
| Walk cache key without the ladder part | "a Salesforce run never reuses a capture cached under the old ladder" |

- **Existing tests still pass:** `frameTarget` (iframe + shadow), `multiScreenWizard` (11/11 after the
  one updated assertion), `screens`, `selectOnTextbox`, `screensBlockCap`, `screenMapRuns` and
  `salesforceTargetApp`.

## 4. HOW TO ROLL BACK

Revert the commit. Nothing is stored. Old screen-map entries are unaffected, because the map holds
names, never css.

## 5. DELIBERATELY NOT DONE

- **The ordinary ladder is unchanged.**
- **Meaningful numbered ids are lost on Salesforce runs** (TD-133).
- **No real-site run yet** (see the status above).

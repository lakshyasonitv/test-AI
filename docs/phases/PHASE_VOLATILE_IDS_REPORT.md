# Phase report — Discovery upgrade Phase 4: spot ids that change every visit

**Flag:** `VOLATILE_ID_DETECTION_ENABLED` (default off). Decision record: `DECISIONS.md` D-59. Date: 2026-10-19.

## What changed

- **New `src/stages/volatileIds.ts`:**
  - `applyIdEvidence` runs in Node between the in-page walk and the Playwright verification
    (`liveDomDiscovery.ts` → `walkOneDocument`). The same element (role + accessible name on the same screen) with a
    DIFFERENT id on a later walk has that id dropped from its candidates, for good. The SAME id twice is put back
    first on a Salesforce walk (TD-133), still verified by Playwright. One sighting keeps today's rule. Ambiguous
    elements (several with the same role + name on one screen) record nothing.
  - `dropVolatileIdCss` strips a proven-volatile id css from cached models: the walk cache (`liveExtend.ts`) and
    the app-model cache (`kb/cache.ts`, which every discovery cache hit passes through).
  - Store: namespace `volatileids`, keyed per site, org, credential fingerprint, locale and cache version. It holds
    role, name, screen, stable yes/no/unknown, a seen count and a 12-hex SHA-1 of the last id (D-59 explains the
    hash).
  - Walk / single-page / crawl cache keys gain a part with the flag on.
  - `runSecrets.ts`: `runCredentialsFor` (for the key's credential fingerprint only).
- **Files owned by others:**
  - Yashika, `src/server/index.ts`: one line appended to `BOOLEAN_ENV_FLAGS`, `"VOLATILE_ID_DETECTION_ENABLED",`.
  - Garvit, `src/stages/hybridDiscovery.ts`: `strategySuffix` appends `#vid` with the flag on, plus the import
    (under the user's "any file" approval).
  - `src/kb/cache.ts`: the cache-hit scrub.

## How to roll back

Unset the flag and restart; every key and path is then as before. The `volatileids` cache namespace can be deleted
freely.

## Tests

- `tests/volatileIds.test.ts`, 6 tests in real Chromium on a local server whose "Save" button gets a new id on
  every visit:
  - flag off: the per-visit id is used and is dead on the next visit;
  - flag on: kept on sighting 1, dropped on sighting 2, and the replacement css resolves on visit 3; a stable plain
    id is untouched;
  - Salesforce: a stable numbered `unit-102` is trusted on sighting 2;
  - flag off, Salesforce: today's rule;
  - a cached walk AND a cached discovery model lose the id css once it is proven volatile.
- Mutations (no drop; no restore): each caught.
- Full suite after all phases: **2329 passed / 7 failed / 23 skipped** (pre-existing failures only; see the
  final summary).

## Live results

Per the plan: the warm-up (all caches cleared, one unmeasured run per site), then ONLY the llm cache cleared and
the second run measured. Flags: settle + best-match + volatile ids. From this phase on, the TD-158 reveal-check
fix (Phase 1 follow-up) is also active.

| Metric | SF P3 | SF P4 warm-up | **SF P4** | Sauce P3 | **Sauce P4** | Demo P3 | Demo P4 warm-up | **Demo P4** |
|---|---|---|---|---|---|---|---|---|
| Primary | pass* | pass* | **pass*** | run error | **pass** | fail | pass | **pass** |
| Cases gen / pass / fail | 4/2/2 | 4/4/0 | **4/4/0** | – | 4/2/2 | 4/2/2 | 4/3/1 | 4/3/1 |
| Grounding rejections | 6 | 4 | **2** | 1 | 1 | 2 | 1 | 2 |
| IR calls | 20 | 16 | **14** | 4 | 16 | 16 | 10 | 18 |
| LLM calls / tokens | 26 / 167k | 20 / 136k | **18 / 127k** | 8 / 36k | 22 / 106k | 22 / 145k | 17 / 112k | 22 / 147k |
| Captures (replaced / added) | 17 (15/2) | 18 (14/4) | 19 (16/3) | 0 | 0 | 0 | 0 | 0 |
| Screen map s / e | 2 / 1 | 2 / 1 | 3 / 2 | n/a | n/a | n/a | n/a | n/a |
| Locators on numbered ids | 0/40 | 9/47 | **12/42** | – | 0/48 | 0/39 | 0/35 | 0/42 |
| Ids dropped volatile / kept stable | – | 0 / 18 | 0 / 27 | – | 0 / 0 | – | 0 / 0 | 0 / 0 |
| Settle waits / s | 29 / 21.5 | 30 / 23.5 | 34 / 24.0 | – | 2 / 1.9 | 9 / 6.4 | 9 / 9.3 | 5 / 6.6 |
| Duration (min) | 12.3 | 7.6 | **6.9** | 1.5 | 6.1 | 11.1 | 8.2 | **6.4** |

\* The SF primary again ends by asserting a line of form text after Next, not a submitted confirmation.

Run ids:
- warm-up: SF `2026-10-19T08-45-57-936Z-c77f7a15`, Sauce `2026-10-19T08-53-37-500Z-40278146`, Demo
  `2026-10-19T08-59-06-357Z-9eceef76`;
- measured: SF `2026-10-19T09-07-57-483Z-f1ac9df8`, Sauce `2026-10-19T09-14-52-482Z-6383802b`, Demo
  `2026-10-19T09-21-00-761Z-2b2346f1`.

Failure reasons (measured):
- Sauce case-2: XSS in First Name → `navigation_error` (as every run). Sauce case-3: "Reset App State" → an Add to
  cart button not found after the reset.
- Demo case-2: SQL injection on the Log in modal → timeout (as every run).

## Verdict

- **What went right:**
  - Demoblaze's primary PASSED with settle on for the first time (warm-up and measured). It always passed with settle
    OFF: this repairs the regression Phase 1 caused, it is not a gain over the baseline. The log shows the new TD-158
    check firing ("…'Username:', which is still hidden on the page after the preceding click…"), and the retry
    filling `#name`.
  - SF had its best run: 4/4 cases, 2 rejections, 14 IR calls, 6.9 min.
- **What it showed about ids:**
  - On this Experience site, Lightning's numbered ids (`#fullName-145`, `#email-145`, `#phone-145`) were IDENTICAL
    across three separate browser sessions.
  - Phase 4 therefore marked them stable and used them: 12 locators, against 0 under D-55's pattern rule. All the
    cases using them passed.
  - No id was ever seen to change, so nothing was dropped as volatile on these sites. The volatile path is proven
    only in the Chromium test.
- **How much it improved:** the SF and Demo measured runs are the best so far, but they ran with warm screen-map,
  walk and discovery caches (the warm-up design). The Demoblaze gain is the TD-158 fix. No part can be credited to
  volatile-id detection with confidence.
- **Risks / not fixed:**
  - **Trusting numbered ids after two sightings.** Lightning numbers by render order, so a page that renders an
    extra component (another path in, a different record) can shift `-145` to `-146`. The store then marks it
    volatile on the next sighting, but the run in between can fail. A stricter rule (more sightings, or sightings
    from different flows, before trusting a PATTERN-looking id) is a reasonable follow-up.
  - TD-157, TD-159, TD-160, TD-161 remain.

## Revision (2026-10-19, after review): a stable id is only a FALLBACK

Generated-id locators per run (css using a Lightning-shaped id / steps with css):

| Run | Salesforce | SauceDemo | Demoblaze |
|---|---|---|---|
| baseline | 0/41 | 0/45 | 0/37 |
| P1 OFF | 0/48 | 0/44 | 0/45 |
| P1 ON | 0/48 | 0/44 | 0/42 |
| P2 | 0/34 | 0/44 | 0/42 |
| P3 | 0/40 | 0/7 | 0/39 |
| P4 warm-up | **9/47** | 0/41 | 0/35 |
| P4 | **12/42** | 0/48 | 0/42 |
| P5 (final) | **6/37** | 0/43 | 0/36 |

It went UP on Salesforce once Phase 4 trusted stable ids, because the restored id was put FIRST. Changed:
- the restored id now goes in after every role / label candidate (D-55) and just before the positional path, so it
  is used only when no role or label locator is unique;
- `tests/volatileIds.test.ts`:
  - a unique "Select" with a stable `unit-102` now gets `role=button[name="Select"s]`;
  - a new twin-button page (a page "Open" and a dialog "Open", both with stable ids, role + name not unique) gets
    `#open-12` / `#open-34` instead of the positional path, and each resolves to exactly 1 element;
  - mutation: putting the id first again fails the test.
- The live counts above were taken BEFORE this change. No live re-run was made for it.

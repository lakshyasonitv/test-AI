# Phase report — Discovery upgrade Phase 3: update the best-matching screen, not the first

**Flag:** `SCREEN_BEST_MATCH_ENABLED` (default off). Decision record: `DECISIONS.md` D-58. Date: 2026-10-19.

## What changed

- `src/stages/screens.ts`: `screenBestMatchEnabled()` and `matchingScreenIndex(candidates, toFp, target)`.
  - Flag off: the first candidate `sameScreen` accepts (as before).
  - Flag on: among every accepted candidate, the highest `labelOverlap`; ties go to the exact key, then the exact
    title, then the earliest.
  - `mergeScreenInto` uses it.
- `src/stages/screenMap.ts`: `mergeIntoMap` uses the same chooser, so the run's model and the stored map agree.
- `ir.ts`'s other `sameScreen` use is an existence check (`.some`) and is unaffected.
- **Files owned by others:** `src/server/index.ts` (Yashika): one line appended to `BOOLEAN_ENV_FLAGS`,
  `"SCREEN_BEST_MATCH_ENABLED",`.

## How to roll back

Unset the flag and restart. To remove the code, revert the two files. No cache key changes: the stored map is
accumulated data, not a derived answer.

## Tests

- `tests/screenBestMatch.test.ts` (pure, 6 tests):
  - the fixture: two distinct wizard steps (overlap 0.6, stored as two screens), and a half-rendered recapture of
    step 2 that passes the 0.7 rule against BOTH;
  - flag off: step 1 is replaced (lost);
  - flag on: step 2 is replaced and step 1 is untouched, in the model AND in the stored map;
  - the exact-key tie-break.
- Mutation (always first match): 2 fail.
- Full suite with Phases 3-5 code: **2324 / 8 / 23** (the same 8 pre-existing failures).

## Live results (flags: settle + best-match; compared with Phase 2)

| Metric | SF P2 | SF P3 | Sauce P2 | Sauce P3 | Demo P2 | Demo P3 |
|---|---|---|---|---|---|---|
| Primary | truncated (screens swapped) | pass* | pass | **run error** (TD-161) | fail (TD-158) | fail (TD-158) |
| Flow reached | EOI → Select for EOI | EOI → Express Interest → Next | full | stopped after Cart | → Purchase | → Purchase |
| Cases gen / pass / fail | 4/3/0+1t | 4/2/2 | 4/3/1 | – | 4/2/2 | 4/2/2 |
| Grounding rejections | 5 | 6 | 1 | 1 | 2 | 2 |
| IR calls | 18 | 20 | 12 | 4 | 14 | 16 |
| LLM calls / tokens | 23 / 149k | 26 / 167k | 18 / 87k | 8 / 36k | 21 / 135k | 22 / 145k |
| Screen captures (replaced / added) | 18 (14 / 4) | 17 (15 / 2) | 0 | 0 | 0 | 0 |
| Screens in primary model / map s-e | 2 / 3-2 | 2 / 2-1 | n/a | n/a | n/a | n/a |
| Generated-id locators | 0/34 | 0/40 | 0/44 | 0/7 | 0/42 | 0/39 |
| Settle waits / s | 33 / 24.4 | 29 / 21.5 | 8 / 5.3 | – | 10 / 8.5 | 9 / 6.4 |
| Duration (min) | 8.2 | 12.3 | 6.2 | 1.5 | 10.5 | 11.1 |

\* The Salesforce primary "passed" by asserting a line of form text after Next, not a confirmation (the same hollow
pass as P1 OFF). It is still the furthest any measured run got: View Project → Available Only → Select for EOI →
Express Interest → contact screen → Next.

Run ids (Phase 3): SF `2026-10-19T08-05-20-116Z-70ff8203`, Sauce `2026-10-19T08-17-38-536Z-29782e27`, Demo
`2026-10-19T08-21-43-787Z-e10b38b7`. A first Demoblaze attempt (`08-19-58-872Z-a16ca551`) died in 6 s with
`browserType.launch: … has been closed`. The system had stopped the server's shell for low memory, and the
surviving server could not launch browsers. It was excluded as an infrastructure failure and re-run after a restart.

Failure reasons, Phase 3:
- SF case-1: an XSS case asserted its own payload text visible. SF case-2: chose "India" in a country-code list
  that only has "+91 (IND)".
- Sauce: the IR stopped after 2 attempts and shipped a truncated best attempt holding a `text_equals` with no value.
  The generator refused it, so the run errored (**TD-161**, new, pre-existing code).
- Demo case-0: TD-158 again (the hidden `#sign-username`). Demo case-1: SQL injection on the Log in modal → timeout.

## Verdict

- **What went right:** the chooser is proven on the exact ambiguous shape, and it applies to both the model and the
  map.
- **What went wrong / surprises:**
  - Captures still overwhelmingly REPLACE (15 of 17). Counts cannot show whether the right screen was replaced; the
    log does not record which candidates were in play. The SF run got furthest so far, but one run cannot credit
    that to Phase 3.
  - Two non-Phase-3 defects surfaced: TD-161 (new) and TD-158. TD-158 was then root-caused: see TD-158's update,
    and the "Phase 1 follow-up" fix in the post-click reveal check (active from Phase 4's runs on).
- **How much it improved:** no measurable change attributable to Phase 3.
- **Not fixed:** TD-157, TD-159, TD-160, TD-161. A follow-up worth having: log which stored screen a capture
  replaced and its overlap, so this phase's effect can be measured directly.

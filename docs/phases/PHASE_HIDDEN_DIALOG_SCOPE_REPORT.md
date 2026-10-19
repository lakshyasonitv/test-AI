# Phase report — Discovery upgrade Phase 2: a hidden popup is never the scope (TD-135)

**Flag:** none (a correctness fix, like the plan said). Decision record: `DECISIONS.md` D-57. Date: 2026-10-19.

## What changed

- `src/stages/targetResolver.ts`: new `VISIBLE_DIALOG_SELECTOR`, which is `DIALOG_SELECTOR` with `:visible` on EVERY
  comma alternative. `resolveScope` uses it instead of `.filter({ visible: true })`, a silent no-op on Playwright
  1.49.
- `src/stages/generator.ts`: the generated spec's `scopeOf` uses the same string. It was NOT correct before: it
  appended `':visible'` to the whole comma list, so only `[class*="modal" i]` was filtered, and a hidden
  `[role="dialog"]` (Demoblaze keeps three, Lightning keeps them too) still became the scope.
- Files owned by others: none needed approval beyond the standing "any file" approval. `generator.ts` is shared
  code; the change alters one string in emitted specs (the `scopeOf` helper).

## How to roll back

Revert the two files. There is no flag and no cache or schema change.

## Tests

- `tests/hiddenDialogScope.test.ts`, real Chromium:
  - with a hidden `.modal-backdrop` and a hidden `role=dialog` (each holding an "Email"), the scope is `<body>` and
    a fill lands in the visible field, in the live resolver AND in the generated spec's own `scopeOf` / `field()`;
  - an open dialog is still the scope;
  - plus two pins for TD-160.
- **4 of 5 FAILED before the fix** (scope = the hidden DIV; the two fills timed out). All pass after it. Mutation
  (back to the whole-list suffix): 4 fail.
- Full suite **2302 passed / 8 failed / 23 skipped, 173 files** (Phase 1: 2293). The same 8 pre-existing failures.
- Grep of `src/` for other `filter({ visible`: none in code, comments only (`browserLaunch.ts`, `generator.ts`).
  Found nearby: `firstUnique`'s `c.locator(":visible")` looks at DESCENDANTS, so its narrowing is a no-op (verified
  in Chromium). A later rung compensates today, so it is filed as **TD-160** (latent) and pinned by tests, with no
  code change.

## Live results (flags: `NETWORK_SETTLE_ENABLED` on, cumulative; compared with Phase 1 ON)

| Metric | SF P1-ON | SF P2 | Sauce P1-ON | Sauce P2 | Demo P1-ON | Demo P2 |
|---|---|---|---|---|---|---|
| Primary | fail (TD-157) | truncated, no assertion | pass | pass | fail (TD-158) | fail (TD-158) |
| Flow reached | EOI → Next | EOI → Select for EOI | full checkout | full checkout | → Purchase | → Purchase |
| Cases gen / pass / fail | 4/3/1 | 4/3/0 (+1 truncated) | 4/3/1 | 4/3/1 | 4/2/2 | 4/2/2 |
| Grounding rejections | 10 | 5 | 3 | 1 | 2 | 2 |
| IR calls | 28 | 18 | 14 | 12 | 18 | 14 |
| LLM calls / tokens | 32 / 221k | 23 / 149k | 20 / 97k | 18 / 87k | 25 / 155k | 21 / 135k |
| Screen captures / reused | 21 / 21 | 18 / 10 | 0 | 0 | 0 | 0 |
| Screen map screens / edges | 3 / 2 | 3 / 2 | n/a | n/a | n/a | n/a |
| Generated-id locators | 0/48 | 0/34 | 0/44 | 0/44 | 0/42 | 0/42 |
| Settle waits / s / capped | 35 / 31.7 / 1 | 33 / 24.4 / 0 | 8 / 6.6 / 0 | 8 / 5.3 / 0 | 9 / 11.3 / 0 | 10 / 8.5 / 0 |
| Duration (min) | 12.0 | 8.2 | 6.4 | 6.2 | 11.0 | 10.5 |

Run ids (Phase 2): SF `2026-10-19T07-35-15-285Z-a10fbc58`, Sauce `2026-10-19T07-43-27-706Z-8c6e3695`, Demo
`2026-10-19T07-49-38-759Z-9e711ec6`.

Failure reasons, Phase 2:
- **SF case-0, truncated:** the IR log shows the project-details URL's screens REPLACING one another. The s8
  capture replaced `bc0d5f5e1af1`, the s10 capture replaced `89f460deffbb`, and the next attempt "reused" for s6 a
  screen that the form capture had already overwritten. "Full Name" was never found where the IR put it. This is
  the first-match merge that **Phase 3** targets, not TD-135.
- Sauce case-2: XSS in First Name → `navigation_error` (the same as every earlier run).
- Demo case-0: filled the hidden Sign-up `#sign-username` (**TD-158**, again). Demo case-1: SQL injection on the
  Log in modal → timeout (every run).

## Verdict

- **What went right:** the fix is proven in Chromium in both the replay resolver and the generated spec, and found
  a second, wider form of the same bug in the spec's `scopeOf`.
- **What went wrong / surprises:** the live failures are all on other known defects (the Phase 3 screen swap,
  TD-158). TD-158 is the same family ("a hidden element chosen as the target"), but it is in grounding (`ir.ts`),
  which binds a css directly, not through the scope. A simple "reject hidden targets" would break legitimate
  modal fills (a modal's fields are hidden in discovery's snapshot until its opener is clicked), so it was NOT
  folded in.
- **How much it improved:** no measurable change in the live outcomes. Fewer IR calls and tokens on all three sites
  than Phase 1 ON, but that is within the spread seen between equivalent runs.
- **Not fixed:** TD-157, TD-158, TD-159, TD-160.

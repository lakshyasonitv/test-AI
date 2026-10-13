# Phase — screens: several pages behind one URL (Salesforce runs)

A Salesforce "New" form, a multi-step wizard or a modal changes the DOM without changing the URL.
The application model kept one page per URL, so the second screen replaced the first, grounding lost
the first screen's fields, and a three-screen form compiled to just the navigate step. Even where a
later screen grounded, its "Next" bound to the first screen's "Next". `DECISIONS.md` D-52 has the
design and what was rejected.

**Tests:** `tsc` clean. Full vitest: **2019 passed**, 2 failed, 23 skipped. Both failures are the
same on `main` before this change: `safeClickBrowser › still navigates a REAL href` (needs
`example.com`, blocked by this sandbox's network) and `booleanEnvFlags › has no reader for any
reserved flag yet` (red on `main` since `152e4a5`, not this stream's). `tests/groundingScope.test.ts`
pinned "toIR calls groundingError with two arguments" as text; it now checks the intent behind that
— toIR never passes the narrowing options, and passes no scope at all off Salesforce runs.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/screens.ts` | **New.** Screen fingerprint (URL, title, tab, field labels, exact `key`); the loose same-screen rule (same title or tab, ≥70% of the smaller label set shared); `mergeScreenInto` replaces the same screen or adds a new one. Pure code. |
| `src/schema/appModel.ts` | `PageModel.screen`, optional. Set only by a screen capture; every existing model is unchanged. |
| `src/stages/liveExtend.ts` | `waitForScreenSettle` (no spinner, control count stable on two polls, 6 s bound; locator counts only, TD-40); `replayAndSnapshot` takes `{ settle }` and records the selected tab — a cache-key part only when used; `captureScreenAt`. |
| `src/stages/ir.ts` | `GroundingScope.screenAt` / `captureBefore`; `screenBoundaries`; a step is grounded against its own screen (dialog first when it has the exact name); a css from another screen is not accepted; toIR captures screens in Salesforce runs with its own budget `MAX_SCREEN_CAPTURES` (default 16) and skips the URL-replacing post-click reveal check there. Garvit's file, edited with approval. |
| `tests/groundingScope.test.ts` | The source-text pin above, updated to the third (screen) argument. |
| `DECISIONS.md` D-52, `TECH_DEBT.md` TD-118 | Documentation. |

## 2. NEW FILES

`src/stages/screens.ts`, `tests/screens.test.ts`, `tests/multiScreenWizard.test.ts`, this report.

## 3. NEW ENV FLAGS

None. Gated on the existing per-run Salesforce checkbox (D-50/D-51). One new tunable,
`MAX_SCREEN_CAPTURES` (default 16), read like `MAX_LIVE_EXTENSIONS`.

## 4. NEW ROUTES

None. No route shape changed.

## 5. SCHEMA CHANGES

`PageModel.screen` — optional, additive.

## 6. HOW TO VERIFY

```bash
npx tsc --noEmit
npx vitest run tests/screens.test.ts tests/multiScreenWizard.test.ts
```

`multiScreenWizard.test.ts` serves synthetic same-URL flows from a local server and runs real
discovery, replays, captures and grounding in Chromium (only the LLM is mocked), then EXECUTES the
compiled IR with the live resolver:

- three-screen form: every step grounded, Next → `#n1`, `#n2`, Save → `#sv`, 3 screens kept, runs to "was created";
- a field removed from screen 2: truncated at that step, screen count still 2 (re-capture replaced, not duplicated);
- branching wizard: the chosen branch's fields and button;
- modal on the same URL: the dialog's Save, not the page's;
- a non-Salesforce run of the same wizard: unchanged (still truncates — TD-118);
- the settle wait against a page that renders five fields in 400 ms passes behind a spinner.

Mutation-checked: no-op settle, screen lookup removed, dialog preference removed, and replace-by-URL
instead of add each fail a test.

## 7. HOW TO ROLLBACK

`git revert <this commit>`. No migration; `PageModel.screen` is optional, so cached models and saved
runs that carry it still parse after a revert (zod strips unknown keys).

## 8. DELIBERATELY NOT FIXED

- **Ordinary (non-Salesforce) runs** keep the URL-keyed behaviour (TD-118).
- **Not run against a live org.** The network policy here blocks external hosts.
- **Vision on dialog captures**: a capture that sees a dialog still runs the pre-existing vision pass.

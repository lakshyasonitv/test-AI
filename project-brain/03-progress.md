# Progress — where we are

*Last updated: 2026-10-22. Claude provider (D-58) committed + pushed (`72127dc`). Pinned `?login` login (D-59) committed + pushed (`a700c1d`). Allow-all-orgs (D-60) built, NOT committed.*

## Branch

`vaibhav/determined-dijkstra-0t2ec9`. Pro (PR #8) is in `main`. Salesforce org login hardening (D-56) is
commit `83bf2bc` on this branch, NOT in `main` (no PR yet). On 2026-10-19 `origin/main` (`b12013f`, 14
commits: screen map D-54, role locators D-55, TD-130..TD-153) was merged INTO this branch; `main` itself
was not touched. Our numbers were moved to avoid clashes: D-54 -> D-56, TD-130/131/132 -> TD-154/155/156.

## Shipped (behind flags, default OFF)

- **Pro document intake** — `SPEC_INTAKE_ENABLED`, `DECISIONS.md` D-53. Merged in PR #8.
- **Salesforce org login hardening** — only when "This URL is a Salesforce org" is ticked
  (`SALESFORCE_ENABLED` + `options.targetApp`), D-56. New file `src/stages/salesforceOrgLogin.ts`;
  production guard (scratch/sandbox only, fails closed), `c.salesforce.com` ad block, email-first
  "Log In with Username" switch, 2.5 s one-screen grace, failure reasons from page structure.
  `loginOnPage` still logs in and records the steps the generated spec replays (D-24).
- **Fixed Salesforce login for generated tests** — `SALESFORCE_FIXED_LOGIN` + a ticked run, D-57. Login
  cases with real credentials reuse the recorded login (`swapInRecordedLogin`, `ir.ts`); specs log in
  through one `salesforceLogin()` routine (`generator.ts`). Flag-off specs byte-identical (fixture).
  **Working tree only until the user says commit.** Not yet run against a real org.

- **Claude as a third LLM provider** — `LLM_PROVIDER[_LITE]=claude`, D-58. New `src/llm/claude.ts`
  (official `@anthropic-ai/sdk` 0.137.0, pinned), keys `ANTHROPIC_API_KEY[S]`, model `ANTHROPIC_MODEL[_LITE]`
  (default `claude-opus-5-5`), effort `ANTHROPIC_EFFORT[_LITE]`. Unset = gemini, unchanged. **Working tree
  Committed `72127dc`. Never called for real (mocked SDK + a local fake server only).
- **Pinned `?login` Salesforce login** — `SALESFORCE_LOGIN_PARAM` (with `SALESFORCE_FIXED_LOGIN`), D-59.
  The generated test opens `<loginUrl>?login` and runs one straight-line two-screen login; a wrong page
  stops with the missing screen named. Discovery unchanged. Committed `a700c1d`.
- **Every Salesforce org allowed** — `SALESFORCE_ALLOW_ALL_ORGS`, D-60. `orgRefusal` accepts any Salesforce
  host; non-Salesforce hosts still refused; non-test orgs named in the server log (not yet in the report).
  **Working tree only until the user says commit.**

## Verification baseline

- `npx tsc --noEmit` — clean.
- `npx vitest run` after merging `main` (2026-10-19): **2309 passed, 2 failed, 23 skipped, 171 files**.
  With D-57 (working tree): **2346 passed, 2 failed (same two), 23 skipped, 174 files**.
- 2026-10-21 in a NEW cloud container: **2067 passed, 46 failed, 271 skipped, 175 files** with D-58.
  The SAME 46 fail with no source change: 45 browser tests (this container lacks Playwright 1.49's
  `chromium_headless_shell-1148`) + `booleanEnvFlags`. Not a regression; compare on a machine with browsers.
- 2026-10-22, same cloud container with a local link `chromium_headless_shell-1148 -> -1194` (container
  only, not in the repo) so the browser tests run: **2368 passed, 2 failed (the same two below), 23
  skipped, 176 files** with D-59; with D-60: 2377 passed, same 2 failed, 177 files.
- The 2 failures pre-date all of this: `booleanEnvFlags` (stale RESERVED list) and
  `safeClickBrowser` (needs `example.com`, blocked in the cloud container; passes in CI).
- CI also fails `discoveryStrategy` "shadowAndFrame" on `main` (Chromium-version dependent
  `srcdoc` serialisation) — passes in the cloud container's newer Chromium.
- **Cloud-container caveat:** run vitest with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch dir of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`), or ~21
  browser tests fail with "Executable doesn't exist".

## Not yet done

See `04-tasks.md`.

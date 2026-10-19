# Progress — where we are

*Last updated: 2026-10-19, plan B (fixed Salesforce login, D-57) built, not yet committed.*

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

## Verification baseline

- `npx tsc --noEmit` — clean.
- `npx vitest run` after merging `main` (2026-10-19): **2309 passed, 2 failed, 23 skipped, 171 files**.
  With D-57 (working tree): **2346 passed, 2 failed (same two), 23 skipped, 174 files**.
- The 2 failures pre-date all of this: `booleanEnvFlags` (stale RESERVED list) and
  `safeClickBrowser` (needs `example.com`, blocked in the cloud container; passes in CI).
- CI also fails `discoveryStrategy` "shadowAndFrame" on `main` (Chromium-version dependent
  `srcdoc` serialisation) — passes in the cloud container's newer Chromium.
- **Cloud-container caveat:** run vitest with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch dir of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`), or ~21
  browser tests fail with "Executable doesn't exist".

## Not yet done

See `04-tasks.md`.

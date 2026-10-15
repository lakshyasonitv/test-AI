# Progress — where we are

*Last updated: 2026-10-15, Salesforce org login hardening session.*

## Branch

`vaibhav/determined-dijkstra-0t2ec9`, reset onto `origin/main` at `5196487` on 2026-10-15 (Pro document
intake — PR #8 — is merged into `main`; its history is in `main`). Salesforce org login hardening
(D-54) is in the working tree on top of that — **not yet committed** at the time of writing; check
`git log` before trusting this line.

## Shipped (behind flags, default OFF)

- **Pro document intake** — `SPEC_INTAKE_ENABLED`, `DECISIONS.md` D-53. Merged in PR #8.
- **Salesforce org login hardening** — only when "This URL is a Salesforce org" is ticked
  (`SALESFORCE_ENABLED` + `options.targetApp`), D-54. New file `src/stages/salesforceOrgLogin.ts`;
  production guard (scratch/sandbox only, fails closed), `c.salesforce.com` ad block, email-first
  "Log In with Username" switch, 2.5 s one-screen grace, failure reasons from page structure.
  `loginOnPage` still logs in and records the steps the generated spec replays (D-24).

## Verification baseline

- `npx tsc --noEmit` — clean.
- `npx vitest run` on `main` at `5196487`: **2173 passed, 2 failed, 23 skipped, 156 files**. With D-54:
  see the journal for the current number.
- The 2 failures pre-date all of this: `booleanEnvFlags` (stale RESERVED list) and
  `safeClickBrowser` (needs `example.com`, blocked in the cloud container; passes in CI).
- CI also fails `discoveryStrategy` "shadowAndFrame" on `main` (Chromium-version dependent
  `srcdoc` serialisation) — passes in the cloud container's newer Chromium.
- **Cloud-container caveat:** run vitest with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch dir of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`), or ~21
  browser tests fail with "Executable doesn't exist".

## Not yet done

See `04-tasks.md`.

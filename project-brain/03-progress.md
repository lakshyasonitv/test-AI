# Progress — where we are

*Last updated: 2026-10-28. main merged into the branch (2142d16, not pushed); shared discovery per project (D-72) built, NOT committed. Earlier, 2026-10-26: Jira Phase 1 (D-71) built, NOT committed. Earlier, 2026-10-22: Claude provider (D-66) committed + pushed (`72127dc`). Pinned `?login` login (D-67) committed + pushed (`a700c1d`). Allow-all-orgs (D-68) committed (`0da6005`); screen/report warning committed (`69dbe17`). Run insights (D-69) committed (`67e5881`). Salesforce post-login fixes (D-70) + D-67 removal built, NOT committed.*

## Branch

`vaibhav/determined-dijkstra-0t2ec9`. Pro (PR #8) is in `main`. Salesforce org login hardening (D-64) is
commit `83bf2bc` on this branch, NOT in `main` (no PR yet). On 2026-10-19 `origin/main` (`b12013f`, 14
commits: screen map D-54, role locators D-55, TD-130..TD-153) was merged INTO this branch; `main` itself
was not touched. Our numbers were moved to avoid clashes: D-54 -> D-56, TD-130/131/132 -> TD-154/155/156 (and moved again on 2026-10-28: our D-56..D-63 -> D-64..D-71, our TD-154..TD-161 -> TD-171..TD-178).

## Shipped (behind flags, default OFF)

- **Pro document intake** — `SPEC_INTAKE_ENABLED`, `DECISIONS.md` D-53. Merged in PR #8.
- **Salesforce org login hardening** — only when "This URL is a Salesforce org" is ticked
  (`SALESFORCE_ENABLED` + `options.targetApp`), D-64. New file `src/stages/salesforceOrgLogin.ts`;
  production guard (scratch/sandbox only, fails closed), `c.salesforce.com` ad block, email-first
  "Log In with Username" switch, 2.5 s one-screen grace, failure reasons from page structure.
  `loginOnPage` still logs in and records the steps the generated spec replays (D-24).
- **Fixed Salesforce login for generated tests** — `SALESFORCE_FIXED_LOGIN` + a ticked run, D-65. Login
  cases with real credentials reuse the recorded login (`swapInRecordedLogin`, `ir.ts`); specs log in
  through one `salesforceLogin()` routine (`generator.ts`). Flag-off specs byte-identical (fixture).
  **Working tree only until the user says commit.** Not yet run against a real org.

- **Claude as a third LLM provider** — `LLM_PROVIDER[_LITE]=claude`, D-66. New `src/llm/claude.ts`
  (official `@anthropic-ai/sdk` 0.137.0, pinned), keys `ANTHROPIC_API_KEY[S]`, model `ANTHROPIC_MODEL[_LITE]`
  (default `claude-opus-5-5`), effort `ANTHROPIC_EFFORT[_LITE]`. Unset = gemini, unchanged. **Working tree
  Committed `72127dc`. Never called for real (mocked SDK + a local fake server only).
- **Pinned `?login` Salesforce login** — `SALESFORCE_LOGIN_PARAM` (with `SALESFORCE_FIXED_LOGIN`), D-67.
  The generated test opens `<loginUrl>?login` and runs one straight-line two-screen login; a wrong page
  stops with the missing screen named. Discovery unchanged. Committed `a700c1d`.
- **Every Salesforce org allowed** — `SALESFORCE_ALLOW_ALL_ORGS`, D-68. `orgRefusal` accepts any Salesforce
  host; non-Salesforce hosts still refused. Committed `0da6005`. Phase A (working tree): the warning also
  shows on the run screen's discovery line and in the HTML report, via `orgWarning(url)` (`69dbe17`).
- **Run insights** — `EXTENDED_LOGGING=true`, D-69. `src/insights.ts`: `[insight]` lines for queue, run
  start, stage ms, plan, discovery (per page + site), Pro rules, cases, per-case IR/spec/execute/analysis/
  heal, run end; saved as `runs/<id>/10-insights.json`. No secrets, no page text, no titles, no query
  strings. Committed `67e5881`.
- **Salesforce post-login (D-70)** — on `SALESFORCE_FIXED_LOGIN` + ticked runs: org hosts read as (My Domain
  name, partition, purpose) per Salesforce's URL tables; same org's Lightning host is not "blocked"; a
  post-login "go to login page" step goes to `auth.url` (also on the D-65 swap path); report labels
  "Only checked that login works". Portal refusal says what it is; refusals no longer say "problem on our
  side". **D-67 (`SALESFORCE_LOGIN_PARAM`) removed.** Working tree only until the user says commit.

- **Jira Phase 1 (D-71)** — `JIRA_ENABLED`. "Connect Jira" (OAuth 2.0 3LO, read-only `read:jira-work`) and
  a story key fills the prompt box with title + description. Token in server memory only (TD-178).
  `src/jira/`, `/api/jira/*`. Never run against a real Atlassian site. Working tree only until the user
  says commit.

- **Shared discovery per project (D-72)** — `PROJECT_DISCOVERY_SHARING`. 7 days, per project + URL +
  login, one discovery at a time per key, "Explore the site again". Working tree only.
- **main merged in (2026-10-28, 2142d16)** — our records renumbered D-64..D-71 / TD-171..TD-178.

## Verification baseline

- `npx tsc --noEmit` — clean.
- `npx vitest run` after merging `main` (2026-10-19): **2309 passed, 2 failed, 23 skipped, 171 files**.
  With D-65 (working tree): **2346 passed, 2 failed (same two), 23 skipped, 174 files**.
- 2026-10-21 in a NEW cloud container: **2067 passed, 46 failed, 271 skipped, 175 files** with D-66.
  The SAME 46 fail with no source change: 45 browser tests (this container lacks Playwright 1.49's
  `chromium_headless_shell-1148`) + `booleanEnvFlags`. Not a regression; compare on a machine with browsers.
- 2026-10-22, same cloud container with a local link `chromium_headless_shell-1148 -> -1194` (container
  only, not in the repo) so the browser tests run: **2368 passed, 2 failed (the same two below), 23
  skipped, 176 files** with D-67; with D-68: 2377 passed, same 2 failed, 177 files; with D-69: 2390 passed, same 2 failed; with D-70: 2412 passed, same 2 failed; with D-71 (2026-10-26): 2447 passed, same 2 failed, 181 files.
- The 2 failures pre-date all of this: `booleanEnvFlags` (stale RESERVED list) and
  `safeClickBrowser` (needs `example.com`, blocked in the cloud container; passes in CI).
- CI also fails `discoveryStrategy` "shadowAndFrame" on `main` (Chromium-version dependent
  `srcdoc` serialisation) — passes in the cloud container's newer Chromium.
- **Cloud-container caveat:** run vitest with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch dir of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`), or ~21
  browser tests fail with "Executable doesn't exist".

## Not yet done

See `04-tasks.md`.

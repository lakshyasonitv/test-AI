# Progress — where we are

*Last updated: 2026-11-13, latest. `ui/dashboard` (pushed) = origin/main 510697d backend byte for byte + the new frontend (dashboard D-79, top-nav layout D-80, in-panel refine TD-187) + GET /dashboard and the health `dashboard` field. The admin-run fixes (TD-188/189) are on local branch fix/admin-signin-order only. See journal/2026-11-13.md.*

*Last updated: 2026-11-13. Branch `ui/dashboard`, still NOT committed: the dashboard (D-79, now ON by default) plus
the top-nav layout (D-80) — one nav row on every page (Dashboard · New test · Projects · History · Settings),
Projects and Settings as pages, the sidebar and ☰ menu folded away; `DASHBOARD_ENABLED=false` gives the old app.
Live Azure is still `main` 88a4b27 (no dashboard). The Hostinger zip on the Desktop predates the landing's
`#/dashboard` links; rebuild it before uploading. Also uncommitted: refine at the case-review gate now confirms
in the panel (TD-187, fixed). UPDATE later 2026-11-13: that work is committed locally (03b52cc, not pushed) and
origin/main e9bae35 is merged in (the branch had been 16 Salesforce commits behind — the "made it worse" report).
TD-188 (a case that logs in after its first click ran signed out) fixed in ir.ts, uncommitted, not yet live-run.
See journal/2026-11-13.md.*

*Last updated: 2026-11-12. Branch `ui/dashboard` = `ui/app-like-landing` (theme.css restyle, pushed for review) +
origin/main `ed59ee1` + an in-app dashboard at `#/dashboard` behind `DASHBOARD_ENABLED` (D-79, read-only, off by
default); landing buttons and `/app` now open `#/dashboard` (home when the flag is off). NOT committed. See
journal/2026-11-12.md.*

*Last updated: 2026-11-06. Branch `redesign/app-ui` (3 commits ahead of main: landing page, top-bar link, theme.css
re-theme). On top of it, NOT committed: the landing page moved out of the app into `landing/` for Hostinger, linked
both ways (buttons → Azure app; `LANDING_URL` → "Landing page" link in the app, off when unset), D-76. Uncommitted
`public/theme.css` edits are someone else's. Windows-checkout baseline: 2913 passed / 7 failed (all pre-existing,
TD-170 + browser) / 23 skipped, 225 files. See journal/2026-11-06.md.*

*Last updated: 2026-11-04, late. TD-186 (History 500 when a run folder is deleted mid-listing) fixed in its own
PR after #21 (brain update, merged `1c170f2`). Baseline with it: 2919 passed / 1 failed (safeClickBrowser) / 23
skipped, 224 files. See journal/2026-11-04.md.*

*Last updated: 2026-11-04, end of day. **Everything is merged into main** (PRs #16-#20); main is the only
working branch. #19: docs say the `archive` branch is protected, no tag. #20: TD-185 fixed — Playwright scans only
the spec's own folder (`PLAYWRIGHT_TEST_DIR`), so a run folder deleted elsewhere can no longer end a spec before its
first step. Baseline: vitest 2915 passed / 1 failed (safeClickBrowser, needs network) / 23 skipped, 223 files; tsc clean. Open on the user's side: protect `archive`; the Azure settings in `04-tasks.md`.*

*Last updated: 2026-11-04, evening. **main is the only working branch.** Old documents live on the `archive` branch
(read with `git show origin/archive:<path>`); `cleanup/production-ready` is retired and fully contained in main.
PRs #16 (deep discovery D-75 + its docs) and #17 (old docs off main) merged; dead-code chain removed (orgForRun,
fetchRunOrgIds). No tag: the user chose to protect the `archive` branch instead (2026-11-04). See `journal/2026-11-04.md`.*

*Last updated: 2026-11-04. main (PR #12, #13: parallel suite cases D-73 / TD-180, the discovery fixture fix,
the rest of cleanup) merged INTO `pro/salesforce-org-context`; this branch's records renumbered to TD-183,
TD-184, D-74 to avoid main's TD-180 / D-73. PR into main opened from this branch. See journal/2026-11-04.md.*

*Last updated: 2026-11-03, evening. PRs #12 and #13 MERGED and DEPLOYED (live image `97ea0c9`); main's CI green.
Parallel suite cases (D-73, `SUITE_CASE_CONCURRENCY`, default 1) are in main but OFF on Azure until the user sets
them (see `journal/2026-11-03.md`). Earlier the same day:
Corrections verified that day: `cleanup/production-ready` IS committed and pushed (6 commits on main
`8bcc3e4`, no PR). D-72 shared discovery, Jira Phase 1, the Claude provider and the Salesforce login work are
all in main (PR #11, merged 2026-10-28). Live Azure: image `8bcc3e4`, 4 vCPU / 8 GiB, MAX_CONCURRENT_RUNS=1
(set back from 4 on 2026-10-28 14:50, reason unrecorded), PROJECT_DISCOVERY_SHARING on, and `/app/runs` NOT
mounted (artifacts and caches lost on every scale-to-zero). The paragraphs below are older history.*

*Last updated: 2026-11-03. Branch `pro/salesforce-org-context`: TD-183 committed + pushed (`fa5a2b9`);
PRO_STORY_PROMPT (TD-184, D-74) committed + pushed (`b190506`) with the user's OK; no PR.
Baseline: vitest 2841 passed / 3 failed (browser, pre-existing), 212 files. See journal/2026-11-03.md.*

*Last updated: 2026-11-02 (later). Branch `pro/salesforce-org-context` (from `cleanup/production-ready`):
Pro on Salesforce now sends the org scan + screen map to case generation (TD-183). Committed and pushed;
no PR. Baseline: vitest 2822 passed / 3 failed (browser tests, pre-existing), 211 files. See journal.*

*Last updated: 2026-11-02. Repo clean-up on branch `cleanup/production-ready` (from main `8bcc3e4`):
unused code removed, docs restructured (`docs/README.md` index, `docs/archive/`, `docs/guides/`),
README rewritten, settings documented, booleanEnvFlags failure fixed. NOT committed yet — see
`journal/2026-11-02.md`. Everything below this line is older history.*

*Last updated: 2026-10-28 (second merge of main: main's D-61 insights kept, PR #11 conflict-free). main merged into the branch (2142d16, not pushed); shared discovery per project (D-72) built, NOT committed. Earlier, 2026-10-26: Jira Phase 1 (D-71) built, NOT committed. Earlier, 2026-10-22: Claude provider (D-66) committed + pushed (`72127dc`). Pinned `?login` login (D-67) committed + pushed (`a700c1d`). Allow-all-orgs (D-68) committed (`0da6005`); screen/report warning committed (`69dbe17`). Run insights (D-69) committed (`67e5881`). Salesforce post-login fixes (D-70) + D-67 removal built, NOT committed.*

*Last updated: 2026-10-28, run insights (D-61) ported to `main`. See `journal/2026-10-28.md`.*

## 2026-10-28 — on `main`'s line

- Branch `vaibhav/intelligent-edison-l6061z` = `main` (`1fb9dcb`) + the D-61 port: `[insight]` lines and
  `runs/<id>/10-insights.json` behind `EXTENDED_LOGGING` (default off). No pull request yet.
- **Gap:** this brain does not record `main`'s own work from 2026-10-18 to 2026-10-28 (discovery
  Phases 1–5, TD-154/156, TD-162, Salesforce OAuth D-63, TD-169). Read `DECISIONS.md`/`TECH_DEBT.md`.
- **Baseline on this branch:** `tsc` clean; `vitest` 2663 passed / 2 failed / 23 skipped, 199 files
  (with the browser symlink workaround below, now `-1148 -> -1243`). Same 2 pre-existing failures.
- `vaibhav/determined-dijkstra-0t2ec9` has diverged from `main`: 9 conflicting files and clashing
  D-/TD- numbers. D-61 is the one record that now means the same thing on both.

*The sections below are from 2026-10-13 and describe `vaibhav/determined-dijkstra-0t2ec9`.*

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
- **Run insights** — `EXTENDED_LOGGING=true`, D-61 (this branch called it D-69; main's port won, see D-69). `src/insights.ts`: `[insight]` lines for queue, run
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
- 2026-11-04, main + TD-185 (PR #20), browser link now `-1148 -> -1243`: **2915 passed, 1 failed, 23 skipped,
  223 files**; tsc clean. The one failure is `safeClickBrowser` (needs `example.com`; passes in CI).
  `booleanEnvFlags` and `discoveryStrategy` were fixed in #13.
- 2026-11-04 later, main + TD-186: **2919 passed, 1 failed (safeClickBrowser), 23 skipped, 224 files**; tsc clean.
- The 2 failures pre-date all of this: `booleanEnvFlags` (stale RESERVED list) and
  `safeClickBrowser` (needs `example.com`, blocked in the cloud container; passes in CI).
- CI also fails `discoveryStrategy` "shadowAndFrame" on `main` (Chromium-version dependent
  `srcdoc` serialisation) — passes in the cloud container's newer Chromium.
- **Cloud-container caveat:** run vitest with `PLAYWRIGHT_BROWSERS_PATH` pointing at a scratch dir of
  symlinks (`chromium_headless_shell-1148 -> /opt/pw-browsers/chromium_headless_shell-1194`), or ~21
  browser tests fail with "Executable doesn't exist".

## Not yet done

See `04-tasks.md`.

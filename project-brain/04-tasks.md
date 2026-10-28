# Open tasks

*Last updated: 2026-10-26.*

## Jira Phase 1 (D-71)

- [ ] Commit and push (ask first).
- [ ] User's first real check: `JIRA_ENABLED=true`, restart, Connect Jira, fetch TBS-1. Free (no AI).
- [ ] Before Azure: add `https://<host>/api/jira/callback` in the Atlassian console + `JIRA_REDIRECT_URL`;
      enable Distribution -> Sharing so other users can connect; TD-178 if more than one replica.
- [ ] Phase 2 (later, needs `write:jira-work` + re-consent): create bug, comment, attach, link.

## Pro document intake (D-53)

- [ ] **One real end-to-end check** with a real document and real Gemini. Everything so far used a
      mocked model. Costs money — ask the user first.
- [ ] Confirm production `GET /api/health` shows `env.GEMINI_API_KEYS.set: true` before turning
      `SPEC_INTAKE_ENABLED` on: distillation is the first call pinned to Gemini under
      `LLM_PROVIDER=azure`.
- [x] Pull request #8 opened and merged into `main`.
- [ ] Later (Pro's own logic): a structural link from a generated case to the rule it proves, so
      `outOfScope` can be enforced in code, not only in the prompt (D-53, "A gap, stated").
- [ ] Later: if comparison warnings are ever persisted, phrase them without quoting the document
      (D-53).

## Salesforce org login hardening (D-64)

- [ ] Commit and push (ask first), then a PR when the user asks.
- [ ] First real-org run (ask first — costs money, holds the run slot): check TD-171 (does a fresh
      browser get the email-first screen?) on the generated test's first login screenshot.
- [ ] TD-172 — fix the one-screen race in `loginOnPage` for every site (needs its own decision).
- [ ] TD-173 — stop screenshotting login steps in generated tests (username visible). Done for
      fixed-login Salesforce runs (D-65); every other run still does it.
- [ ] If Developer Edition orgs should be testable, widen `classifyOrg` (refused today, by choice).
- [ ] Pro follow-up still waiting on the user: the one-way comparison + quoted warnings brief (B3/B4, 12b).

## Fixed Salesforce login (D-65, plan B)

- [ ] Commit and push (ask first). Then a PR for `83bf2bc` + D-65 when the user asks.
- [ ] First real-org run with `SALESFORCE_FIXED_LOGIN=true` (ask first — costs money): the user's scratch
      org `ruby-data-2200-dev-ed.scratch.my.salesforce.com`, one "Create an Account" case and one
      "Log in with valid credentials" case. Check step 1 lands on Lightning, and TD-171.
- [ ] TD-174 — a test that runs `salesforceOrgLogin.ts` and the spec helper on the same pages.
- [ ] TD-175 — negative login cases on a two-screen login (plan C: why screen 2 was not captured).
- [ ] TD-176 — allow `test.salesforce.com`, check the landed host after login.

## Pre-existing, found or re-confirmed this session

- [ ] `tests/booleanEnvFlags.test.ts` fails: remove `DISCOVERY_LIVE_DOM` and `SALESFORCE_ENABLED`
      from its RESERVED list (both now have readers).
- [ ] `tests/safeClickBrowser.test.ts` "still navigates a REAL href" fails.
- [ ] TD-110 — intermittent tenancy pair-run failure.
- [ ] Playwright browser version mismatch in the cloud container (see `03-progress.md`) — either pin
      the image's browsers or document the symlink workaround in the setup script.
- [ ] `CLAUDE.md` / `AGENTS.md` are 214 lines against CLAUDE.md's own "under 200" rule
      (`docs/FINDINGS_2026-09-28.md` §6.3).

## Claude provider (D-66)

- [ ] Commit and push (ask first).
- [ ] One real call with the user's own key (ask first — costs money): set `LLM_PROVIDER=claude` and
      `ANTHROPIC_API_KEY` in `.env` on the laptop, run one small saucedemo run, check
      `08-llm-usage.json` says `claude`. If attempts time out, raise `LLM_TIMEOUT_MS`.
- [ ] Later, only if asked: a UI switch for the provider (needs a new route — platform rule 1).

## Pinned ?login Salesforce login (D-67)

- [x] Commit and push — `a700c1d`.
- [ ] One real run with `SALESFORCE_FIXED_LOGIN=true` + `SALESFORCE_LOGIN_PARAM=true` on the scratch org
      (ask first — costs money). Restart `npm run serve` first.
- [x] `SALESFORCE_ALLOW_ALL_ORGS` (D-68) — committed `0da6005`.
- [x] Production warning on the run screen + HTML report (Phase A) — `69dbe17`.
- [x] Phase B: `[insight]` run logs + `10-insights.json` (D-69) — built, commit when the user says.
- [ ] Insights not yet covered: pages discovery skipped (and why), timing inside discovery's crawl loop
      — need hooks in hybridDiscovery.ts.
- [ ] Turn EXTENDED_LOGGING on for one real run (ask first — costs money) and read 10-insights.json.
- [ ] Separate, found 2026-10-22: text asserts built from hidden labels ("Global Header") and glued
      region text fail after a good login — proposed: ground text asserts against landmark names.
      Needs that run's 04-ir.json to confirm.

## Salesforce post-login (D-70)

- [ ] Commit and push (ask first).
- [ ] One real run on the scratch org (ask first — costs money): expect no false "blocked"; the search case
      compiles past "/"; the homepage case labelled "Only checked that login works".
- [ ] TD-177: show the model the post-login page for a login-URL case (deferred, medium risk).
- [ ] Later option: `?startURL=<path>` on the login (verified by hand to land on Accounts) to start a test on
      its own page.
- Decided 2026-10-22 by the user: app only — no Setup pages, no portals (`my.site.com`).


# Open tasks

*Last updated: 2026-10-19.*

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

## Salesforce org login hardening (D-56)

- [ ] Commit and push (ask first), then a PR when the user asks.
- [ ] First real-org run (ask first — costs money, holds the run slot): check TD-154 (does a fresh
      browser get the email-first screen?) on the generated test's first login screenshot.
- [ ] TD-155 — fix the one-screen race in `loginOnPage` for every site (needs its own decision).
- [ ] TD-156 — stop screenshotting login steps in generated tests (username visible). Done for
      fixed-login Salesforce runs (D-57); every other run still does it.
- [ ] If Developer Edition orgs should be testable, widen `classifyOrg` (refused today, by choice).
- [ ] Pro follow-up still waiting on the user: the one-way comparison + quoted warnings brief (B3/B4, 12b).

## Fixed Salesforce login (D-57, plan B)

- [ ] Commit and push (ask first). Then a PR for `83bf2bc` + D-57 when the user asks.
- [ ] First real-org run with `SALESFORCE_FIXED_LOGIN=true` (ask first — costs money): the user's scratch
      org `ruby-data-2200-dev-ed.scratch.my.salesforce.com`, one "Create an Account" case and one
      "Log in with valid credentials" case. Check step 1 lands on Lightning, and TD-154.
- [ ] TD-157 — a test that runs `salesforceOrgLogin.ts` and the spec helper on the same pages.
- [ ] TD-158 — negative login cases on a two-screen login (plan C: why screen 2 was not captured).
- [ ] TD-159 — allow `test.salesforce.com`, check the landed host after login.

## Pre-existing, found or re-confirmed this session

- [ ] `tests/booleanEnvFlags.test.ts` fails: remove `DISCOVERY_LIVE_DOM` and `SALESFORCE_ENABLED`
      from its RESERVED list (both now have readers).
- [ ] `tests/safeClickBrowser.test.ts` "still navigates a REAL href" fails.
- [ ] TD-110 — intermittent tenancy pair-run failure.
- [ ] Playwright browser version mismatch in the cloud container (see `03-progress.md`) — either pin
      the image's browsers or document the symlink workaround in the setup script.
- [ ] `CLAUDE.md` / `AGENTS.md` are 214 lines against CLAUDE.md's own "under 200" rule
      (`docs/FINDINGS_2026-09-28.md` §6.3).

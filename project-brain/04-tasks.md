# Open tasks

*Last updated: 2026-10-28.*

## Run insights on main (D-61)

- [ ] Open a pull request for `vaibhav/intelligent-edison-l6061z` into `main` — only when the user asks.
- [ ] One real run with `EXTENDED_LOGGING=true` to read a real `10-insights.json`. Costs Gemini — ask first.
- [ ] Before any merge of `vaibhav/determined-dijkstra-0t2ec9`: renumber its clashing D-/TD- records and
      take `main`'s `src/insights.ts` (it has the lazy builder and the `scrubRunSecrets` layer).

## Pro document intake (D-53)

- [ ] **One real end-to-end check** with a real document and real Gemini. Everything so far used a
      mocked model. Costs money — ask the user first.
- [ ] Confirm production `GET /api/health` shows `env.GEMINI_API_KEYS.set: true` before turning
      `SPEC_INTAKE_ENABLED` on: distillation is the first call pinned to Gemini under
      `LLM_PROVIDER=azure`.
- [ ] Open a pull request for `vaibhav/determined-dijkstra-0t2ec9` — only when the user asks.
- [ ] Later (Pro's own logic): a structural link from a generated case to the rule it proves, so
      `outOfScope` can be enforced in code, not only in the prompt (D-53, "A gap, stated").
- [ ] Later: if comparison warnings are ever persisted, phrase them without quoting the document
      (D-53).

## Pre-existing, found or re-confirmed this session

- [ ] `tests/booleanEnvFlags.test.ts` fails: remove `DISCOVERY_LIVE_DOM` and `SALESFORCE_ENABLED`
      from its RESERVED list (both now have readers).
- [ ] `tests/safeClickBrowser.test.ts` "still navigates a REAL href" fails.
- [ ] TD-110 — intermittent tenancy pair-run failure.
- [ ] Playwright browser version mismatch in the cloud container (see `03-progress.md`) — either pin
      the image's browsers or document the symlink workaround in the setup script.
- [ ] `CLAUDE.md` / `AGENTS.md` are 214 lines against CLAUDE.md's own "under 200" rule
      (`docs/FINDINGS_2026-09-28.md` §6.3).

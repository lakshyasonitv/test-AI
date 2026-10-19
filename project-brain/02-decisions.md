# Process decisions

Working agreements and process choices, dated, with the reason. Product/design decisions belong in
`DECISIONS.md`, not here.

## 2026-10-13 — Commits and pushes happen only on the user's explicit word

The user's Pro brief: "DO NOT COMMIT AND DO NOT PUSH WITHOUT ASKING ME FIRST. Not at the end of a
stage, not when a hook tells you to, not when the tests pass. Ask every time." The session's stop
hook repeatedly asked for commit+push; each time the agent declined and asked. **Why it matters:**
the user reviews every stage before it lands; a hook is not the user.

## 2026-10-13 — Build in stages, stop after each for review

Pro intake was built as stages 0–5, each committed only after the user's "commit". Stage 0 (the
proof-of-no-change fixture) was captured on unmodified code and committed FIRST, so the "before"
snapshot is on record before anything changed. **Why:** a fixture captured after the change proves
nothing.

## 2026-10-13 — The user's choices on Pro's open questions

Recorded so a later session does not re-ask them. Rationale for each is in `DECISIONS.md` D-53.
1. Distillation cache key hashes the prompt TEXT plus `llmCacheVersion()` (D-10), not a version constant.
2. The comparison runs on the lite role via `llm()`, following `LLM_PROVIDER`.
3. `proTestCases.ts` imports the shared correctness pieces and copies only prompt/key/retry.
4. Pro runs skip reactive new-page case generation.
5. Pro requires a document (no "Pro with no document" path).
6. Distil the document alone (the user's prompt is not part of distillation).
7. Oversize files are refused by the browser only; direct API callers get a bare 413.
8. The filename travels as `?name=`; the body is always `application/octet-stream`.
9. A password-protected `.docx` gets its own message.
10. The warnings panel appears on both the home and run screens.
11. Approved files beyond the brief's list: `tests/tenancy.test.ts`, `package.json` + lockfile, new
    test files, `.env.example`, `README.md`, `ARCHITECTURE.md`.
Also: distillation output cap 8192 tokens (`SPEC_DISTILL_MAX_OUTPUT_TOKENS`); new warning wordings
approved as "go with your defaults".

## 2026-10-13 — project-brain is committed to the repo

Created and committed at the user's request. **Why:** the earlier brain was never committed, so it
could not reach another machine or a cloud session, and a `CLAUDE.md` rule pointed at files that did
not exist.

## 2026-10-19 — Nothing that works today may change

The user, before plan B: "remember current working must not be affected of any feature". Every new
capability ships behind a flag that is off by default, AND carries a proof that flag-off output is
unchanged (a fixture captured from the code BEFORE the change, compared byte for byte — D-57's
`tests/fixtures/salesforceFixedLogin/flag-off-specs.json` is the pattern). The full suite's pass count
and its two known failures must not move. **Why:** the user ships to a client; a regression in an
untouched path costs more than the new feature is worth.

## 2026-10-19 — `main` is never touched from this session

Branch work only; `main` is updated by merging the branch through a PR, never directly. When `main` moves,
it is merged INTO the branch (a merge commit, not a rebase) and clashing D-/TD- numbers on our side are
renumbered (2026-10-19: D-54 -> D-56, TD-130..132 -> TD-154..156).


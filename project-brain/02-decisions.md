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

## 2026-10-28 — D-61 ported to main with the same number; summaries made lazy

The user asked for the branch's run insights on `main` "without breaking pre-existing functionality".
**Why the same number:** it is the same feature, and D-61 was unused on `main`, so one record means one
thing on both lines. **Why lazy:** the branch's call sites built their summaries before the flag check,
so a malformed model object could have thrown with logging OFF. Now nothing is computed when it is off,
and a throw when it is on is caught. **Why `scrubRunSecrets` too:** `main` has the TD-154 registry; a
second layer costs nothing.

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

# project-brain

Persistent working memory between agent sessions, as `CLAUDE.md` ("Project Brain") requires.
Read `03-progress.md` and the newest file in `journal/` at the start of every session; update
journal + progress + tasks (and `02-decisions.md` for process decisions, with reasons) at the end of
every session that changes anything.

| File | Holds |
|---|---|
| `03-progress.md` | Where things stand right now: branch, last commits, test baseline, what is shipped and what is open |
| `04-tasks.md` | The open task list |
| `02-decisions.md` | Process and working-agreement decisions, dated, with reasons |
| `journal/YYYY-MM-DD.md` | What one session did, in order |

**What does NOT go here** (`DECISIONS.md` D-01 — one owner per topic): design rationale belongs in
`DECISIONS.md`, defects in `TECH_DEBT.md`, the file map and schemas in `ARCHITECTURE.md`. The brain
links to those; it never restates them.

**Provenance.** Created 2026-10-13. `CLAUDE.md` and `AGENTS.md` described a brain before this, but it
was never committed (`git log --all -- '*project-brain*'` was empty; see
`docs/FINDINGS_2026-09-28.md` §6.3), so whatever it held — including the 2026-09-18 entry `CLAUDE.md`
cites — lived on one machine and is not recoverable here. If someone still has a local, untracked
`project-brain/`, merge its contents into these files rather than overwriting them: a `git pull` will
refuse to overwrite untracked files with the same names.

# Documentation

Start with the [project README](../README.md). Each topic below has exactly one owner file, so
nothing is written twice (`DECISIONS.md` D-01).

## The five owners

| Read this | For |
|---|---|
| [`README.md`](../README.md) | What Testbench is, how to run it, every setting |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | How it works inside: every file, every schema, the pipeline |
| [`DECISIONS.md`](../DECISIONS.md) | Why each design choice was made, and what was rejected |
| [`TECH_DEBT.md`](../TECH_DEBT.md) | What is broken or weak, ranked, with the fix |
| [`CLAUDE.md`](../CLAUDE.md) | Working rules for anyone (or any AI agent) changing the code |

## Guides

| Read this | For |
|---|---|
| [`guides/EDITABLE_IR.md`](guides/EDITABLE_IR.md) | How a person edits a compiled test, end to end |
| [`../landing/README.md`](../landing/README.md) | Hosting the landing page on its own (e.g. Hostinger) and linking it to the app both ways |

## History

| Folder | What is in it |
|---|---|
| [`phases/`](phases/) | One report per shipped phase: what changed, how to roll it back, and what it did not fix |

## Archive (not on `main`)

Old plans and audits, a never-built spec, market research, handoff notes, the five onboarding Word volumes,
the old LLM context briefing and the stale `app.yaml` live on the **`archive` branch**, which is read-only
(protected in GitHub). `archive:<path>` in any doc means that file there; read it with
`git show origin/archive:<path>`, or browse the branch on GitHub. `docs/archive/README.md` on that branch
lists where each old file used to live.

The project's working memory between sessions is in [`../project-brain/`](../project-brain/).

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
| [`guides/team-guide/`](guides/team-guide/) | Onboarding: five Word volumes, from orientation to operations |
| [`guides/LLM_CONTEXT_BRIEFING.md`](guides/LLM_CONTEXT_BRIEFING.md) | A self-contained briefing to paste into an AI chat that cannot read this repo (regenerated, never edited) |

## History and research

| Folder | What is in it |
|---|---|
| [`phases/`](phases/) | One report per shipped phase: what changed, how to roll it back, and what it did not fix |
| [`handoff/`](handoff/) | Handoff plans written for the next person picking up a stream of work |
| [`research/`](research/) | Market and competitor research |
| [`archive/`](archive/) | Old plans, audits and a never-built spec, kept for their reasoning ([index](archive/README.md)) |

The project's working memory between sessions is in [`../project-brain/`](../project-brain/).

# Team Guide — ai-test-platform

Five Word documents that take someone who knows nothing about this project to a working
understanding of it, end to end. Written 2026-09-01, **revised 2026-09-05** — the volumes now
describe commit `eca7dee` on `main`.

**What the revision changed.** A UI merge landed after the first edition (header hamburger menu,
the Minimal/Standard/Full coverage control removed, client-side auth session management and
role-based UI gating, sidebar suite management, a Delete control on project rows). Volume 4 was the
most affected. Two factual errors were also corrected in every volume that carried them:

- The first edition said **there is no CI**. There is: `.github/workflows/test.yml` runs
  `tsc --noEmit` and `npm test` on every push and pull request. What is actually missing is branch
  protection, so a red run can still merge. That claim had been taken from `TECH_DEBT.md` TD-20
  instead of from `.github/` — the exact failure this guide warns about.
- The test count was quoted from a dated snapshot rather than measured. It is **816 across 52
  files**, verified by running the suite.

Hand the five `.docx` files to anyone joining. They read in order, but each stands alone.

| File | Pages | Read it when |
|---|---|---|
| `Vol-1-Orientation.docx` | 13 | Start here. What the product does, the 7-stage flow, what a run leaves on disk, the glossary. |
| `Vol-2-The-Pipeline.docx` | 23 | You need to change how tests are generated, or understand why an IR was rejected. |
| `Vol-3-Server-and-Data.docx` | 15 | You are adding a route, touching permissions, or wondering why someone cannot see a run. |
| `Vol-4-Frontend.docx` | 11 | You are changing the UI. Read the class-contract section before touching any CSS. |
| `Vol-5-Operations-and-Debugging.docx` | 12 | Something is broken right now. Start with the decision tree on page 1. |

Every volume opens with a navigable table of contents; headings appear in Word's navigation pane.

## Status

These are a **teaching narrative**, not a topic owner. Per `DECISIONS.md` D-01, the repository's own
documents remain authoritative:

- `ARCHITECTURE.md` — the file map and data contracts
- `DECISIONS.md` — why each choice was made
- `TECH_DEBT.md` — what is currently broken

Where this guide and those disagree, **they win — and the source code beats all of us.**

Every fact in these volumes was read out of the actual source rather than copied from existing
documentation, because doc drift is a recorded, recurring failure mode here. Three corrections to
the existing docs are called out explicitly in the text (the stage count, the SSE-versus-polling
claim, and the state of the suite/case/compare screens).

**Re-check the numbers before quoting them.** That warning applies to this guide too.

## Folder contents

```
Vol-1 … Vol-5 .docx     the deliverable
diagrams/               nine PNGs at 2x — reusable in slides and tickets
src/                    the sources these were generated from
  *.html                one file per volume
  svg/                  the diagram sources
```

## Regenerating

The diagrams are SVG rendered to PNG through the project's own Playwright Chromium; the documents
are HTML converted to `.docx` through the locally installed Microsoft Word over COM. Both scripts
live in the session scratchpad rather than the repository, since neither is part of the product.

To change a volume: edit its `src/*.html`, then re-run the HTML-to-Word conversion.
To change a diagram: edit `src/svg/*.svg`, re-render to `diagrams/`, then rebuild the volume.

Word's HTML importer uses its old engine — it ignores flexbox and grid entirely, so the layout uses
tables and plain block elements only. Images must be embedded rather than linked, or they break the
moment the folder is shared.

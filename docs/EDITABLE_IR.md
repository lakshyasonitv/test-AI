# Editable IR — how a person edits a compiled test, and why it works that way

**What this doc owns:** the *flow* of editing an IR, end to end, across the files it spans.
It is a walkthrough, not a topic owner. `ARCHITECTURE.md` owns the file-by-file map and the schema,
`DECISIONS.md` owns why any individual choice was made, `TECH_DEBT.md` owns what is broken, and
`docs/phases/` owns what each shipped phase changed. Where this doc and those disagree, they win.

---

## 1. The problem

A test case is stored as **IR** — strict JSON that the generator compiles into Playwright:

```json
{ "id": "s4", "action": "click",
  "target": { "role": "button", "name": "Sign In", "css": "#login-submit", "nth": 0 } }
```

That is not something a person edits. But people need to fix tests constantly: a typo in an email,
a renamed button, a step in the wrong order, one extra check at the end.

So the editor shows each step as **one English sentence**:

```
Click on button "Sign In"
```

You edit the sentence. The system turns it back into IR. Everything in this document exists
because that round trip is harder than it looks.

## 2. The one idea everything else follows from

**The English format is lossy, and that is load-bearing.**

A rendered sentence carries the step's *semantic* target — role, name, text — and its value. It
does **not** carry `css`, `testId`, `nth`, `label`, `placeholder`, or `preAction`. Those are the
deterministic identity that grounding wrote against the real page, and they are the only thing that
makes an icon-only control addressable at all.

So this is false:

```
parse(format(step))  ==  step          ✗ can never hold
```

and this is what actually holds, and what the tests pin:

```
parseIrStep(formatIrStep(step), step)  deep-equals  step        ✓
                                ^^^^
                       parse ONTO the original
```

Parsing takes the original step as its **base**. That single design choice produces the whole
behaviour of the editor:

- An **untouched** sentence returns the original object, byte-identical — `css`, `${env:…}`
  references, `preAction`, all of it. Free to save. No browser.
- A **changed** sentence keeps the new semantic fields and **deletes every grounded field**,
  because they described the element the user just stopped pointing at. The result is
  un-grounded *by construction*, which is what forces a re-ground before saving.

Do not "fix" the format to be round-trippable. The lossiness is what makes an untouched line free
and a retargeted line expensive — which is exactly the right cost model.

## 3. The vocabulary

`parseIrStep` accepts eleven sentence shapes, exported as `STEP_VOCABULARY` from `stepText.ts`:

```
Go to /path
Click on button "Name"
Type "value" into textbox "Name"
Choose "option" from combobox "Name"
Check checkbox "Name"
Press the Enter key
Wait briefly
Check that button "Name" appears on the page
Check that button "Name" is not shown
Check that the text "some words" is displayed
Check the page address contains "/path"
```

One exported list, next to the parser that defines it — because two prompts also need to *show*
it, and a second hand-maintained copy would drift the moment the parser gained a form.

**Some renderings are genuinely ambiguous**, and the base resolves them: `text_contains` and
`text_equals` render identically; `Wait briefly` drops its millisecond value; `Press the Enter key`
drops its target entirely; `Go to` cannot say whether the destination came from `target.url` or
`value`. For an unchanged line the base supplies all four. For a genuinely new step there is no
base, so each falls back to a documented default.

## 4. How "did this change?" is decided

Three outcomes per row, and only the third costs anything:

| Outcome | Test | Cost |
|---|---|---|
| Unchanged | `raw === formatIrStep(base).trim()` — the identity fast path | nothing |
| Changed, same target | `sameSemanticTarget(parsed, base)` is true | nothing |
| Target changed | `sameSemanticTarget` is false | a browser walk |

```js
sameSemanticTarget(a, b) =
     (a.role ?? "") === (b.role ?? "")
  && (a.name ?? "") === (b.name ?? "")
  && (a.text ?? "") === (b.text ?? "")
  && (a.url  ?? "") === (b.url  ?? "")
```

This compares **IR fields**, not prose. One side is reconstructed from the rendered sentence, but
that sentence is the system's own closed-vocabulary rendering — not page copy and not model output
— and an unedited line never reaches the parser at all. This is deliberately *not* the
"regex over LLM-authored prose" failure mode `CLAUDE.md` warns about.

When a target changes, `mergeTarget` drops `css`, `testId`, `nth`, `label`, `placeholder`. That is
the mechanism by which "the user retargeted this step" becomes "grounding must re-derive it".

**Rows are matched positionally.** `parseIrSteps(texts, originals)` pairs `texts[i]` with
`originals[i]`. Two consequences worth knowing:

- A step that **moved** reads as changed, because it is compared against whatever used to sit at
  its new index. That is the right answer — a target resolves on whatever page the preceding steps
  arrive at, so moving a step genuinely does need re-verifying.
- A step that was **deleted** shifts every row after it, so the whole tail reads as changed and
  gets re-grounded. Conservative, not incorrect. Rows *before* the deletion are untouched.

## 5. The save path

`POST /api/cases/:caseId/steps` with `{ steps: string[], expectedVersion, changeNote }`.

```
prepareEdit
  ├ 409 if expectedVersion !== currentVersion        (someone else saved while you were editing)
  ├ parseIrSteps(texts, found.ir.steps)              → 400 with stepIndex + stepId if unreadable
  └ parseIr(...)                                     → structural validation, milliseconds, no browser

  regroundIndexes.length === 0 ?
    ├ YES → FAST PATH: write immediately, respond { mode: "instant", regrounded: 0, snapshots: 0 }
    └ NO  → JOB PATH:  respond 202 { jobId, mode: "verifying", ...estimate } and work in background
```

The fast path is the common one. Fixing a typo in a value, renaming the case, reordering nothing —
none of that touches a target, so none of it launches a browser.

**The job path**, once it has answered 202, emits SSE events and ends in exactly one `done` or
`error`:

1. `resolveWalkCredentials` — env first, prompt second (see §7)
2. cancelled while the prompt was open? stop before any browser launches
3. `regroundEditedIr(validated, regroundIndexes, { sourceRunId, creds, shouldCancel, onProgress })`
4. failed or cancelled → emit, **write nothing**
5. succeeded → `updateCase`, emit `done` with the new version and re-rendered steps

Supporting routes: `…/jobs/:jobId/state`, `/cancel`, `/credentials`, and `…/jobs/:jobId/events`.

**Which one the browser actually uses:** `/state`. `pollCaseJob` in `public/app.js` polls it every
800 ms; the SSE route exists and no client code consumes it, for the same tunnel-buffering reason
the run view polls rather than streams. Read "emits SSE events" above as "emits events, which the
server holds for both routes" — the events are real, the streaming transport is not the one in use.

## 6. What re-grounding actually does

`regroundEditedIr` (`caseEdit.ts`) verifies the edited IR against the live site and fills the
deterministic fields back in.

The subtlety: `groundingError` walks **every** step, but only the steps whose target lost its
`css`/`testId` have anything to re-derive — an untouched step still carries its grounding and
passes on the identity it already had. What the walk actually buys is **the page models those
edited steps must resolve against**. You cannot check step 7 without arriving at step 7's page,
which means executing steps 1–6.

That is why the cost is driven by *where* the edit is, not how many edits there are:

- one walk per distinct arrival point; two edits on the same page share a walk
- prefixes are cached (`liveExtend.ts`'s `replayAndSnapshot`), so a deeper walk reuses a shallower one
- an edit at index 0 acts on the entry page and needs no walk at all
- capped by `MAX_LIVE_EXTENSIONS`

Grounding is DOM-first, so it usually spends **no model call at all**. A page that needs vision to
model costs one per snapshot — hence `maxLlmCalls` is a ceiling, not an expectation.

## 7. Telling the user the price first

`estimateRegrounding(parsed)` answers "what will this save cost?" **without doing any of it** —
pure arithmetic over the indexes `parseIrSteps` already produced. No browser, no model, no write.
It is cheap enough to call on every keystroke, which is what lets the editor say
*"Save — re-checks 2 steps, about 40 seconds"* before Save is pressed.

It returns `changedSteps`, `stepsToVerify`, `stepIdsToVerify`, `stepsToReplay`, `snapshots`,
`maxLlmCalls`, `estimatedSeconds`, `instant`, and `needsCredentials`.

`needsCredentials` matters more than it looks: it is read straight off the `${env:…}` values of the
steps the walk will actually replay (capped the same way the real walk caps), so the editor can
warn up front. Otherwise "re-checks 1 step" turns into an unannounced password prompt, and a
surprise credential request is the kind of thing people refuse on reflex.

## 8. Concurrency

Optimistic, and optional. The client sends `expectedVersion`; if it no longer matches, the save is
rejected **409** with the current version *and the current steps*, so the UI can show what changed
rather than just refusing.

The check happens twice on purpose: once in `prepareEdit` (fail fast, before any work) and again
inside `updateCase` against the row it is about to write — which closes the window opened by a
re-ground walk that may have taken 40 seconds. A 409 raised there surfaces through the job's
`error` event with `conflict: true`.

Every accepted save bumps `current_version` and appends to `test_case_versions`, so any version is
readable at `GET /api/cases/:caseId/versions/:version` and diffable in the Compare view.

## 9. Where the model is allowed in — and where it is not

**A model proposes step TEXT. It never writes.** (`DECISIONS.md` D-27.) Approving a proposal fills
the editor; saving it then travels the ordinary path above — one parser, one grounder, one version
history, whoever wrote the words. There are three proposers:

| | What it answers | Constrained to the vocabulary? | Re-checked by `parseIrStep`? |
|---|---|---|---|
| `proposeRewrite` | "change something about this test" | yes | yes, every line |
| `proposeStepTranslation` | "I typed it loosely and the parser said no" | yes | yes, every translated line |
| `proposeGateRewrite` | "change this case, which does not exist yet" | **no** | **no** — see below |

The first two operate on a **saved** case: an IR exists, its steps are grounded, and every proposed
line is run back through the real parser *before the diff is shown*. A sentence the parser cannot
read never reaches a person, so the model cannot widen the accepted grammar.

Two further guarantees on the translation path: it is **line-for-line** (a different line count is
a hard 502, because positional matching means an inserted row would re-base the whole tail), and
**readable lines are restored from the draft, not taken from the model** — so a model that
"improves" a line you never asked about cannot silently cost you a browser walk.

`proposeGateRewrite` is the exception and is covered next.

## 10. The other editor: cases at the selection gate

When `ENABLE_CASE_SELECTION_GATE=true`, the pipeline pauses after generating test cases and lets
you edit them **before** anything is compiled. This looks like the same editor and is deliberately
a different thing:

|  | Saved-case editor | Gate editor |
|---|---|---|
| Is there an IR? | yes | **no** — IR is compiled after approval |
| Steps are | the eleven sentence shapes | free prose |
| `parseIrStep` | yes | **no** — nothing to parse onto |
| Re-grounding | yes, before saving | **no** — grounding happens later, at IR time |
| Versions / 409 | yes | no — nothing is saved yet |
| Cost of an edit | possibly a browser walk | nothing |

Constraining gate steps to `STEP_VOCABULARY` would reject the model's own output, since generated
cases read like *"Type an invalid email into the Email field"*. The vocabulary check is not
skipped, only **deferred to the stage that owns it**: whatever survives review is compiled by
`toIR` and grounded against the live page exactly as an unedited case is. `proposeGateRewrite` sits
upstream of every check in the pipeline, so it cannot widen what the pipeline accepts.

What the gate editor keeps from D-27 is what matters: it proposes, it returns sentences not IR, and
a person approves the round before anything is persisted.

## 11. Where the pieces live

| File | Role |
|---|---|
| `src/stages/stepText.ts` | `formatIrStep`, `parseIrStep`, `parseIrSteps`, `estimateRegrounding`, `STEP_VOCABULARY`, `GROUNDED_FIELDS`, `sameSemanticTarget`, `mergeTarget` |
| `src/stages/caseEdit.ts` | `regroundEditedIr` — the walk that re-verifies changed targets |
| `src/stages/liveExtend.ts` | `refreshPageModel` / `replayAndSnapshot` — replays a step prefix in a real browser and snapshots where it lands; prefix-cached. **This, not `replay.ts`, is the walker the editor uses** — `caseEdit.ts` imports `refreshPageModel` from here. `src/stages/replay.ts` is a different thing entirely: the zero-LLM path that re-runs a *stored* IR, and it takes no part in editing |
| `src/server/index.ts` | the editor's routes: `GET/POST /steps`, `/estimate`, job SSE + `/cancel` + `/credentials`, `/rewrite`, `/steps/translate`, `/versions/:v` |
| `src/server/rewrite.ts` | the three proposers, and the shared 20-per-15-min-per-user rate limit |
| `src/server/library.ts` | `updateCase`, `CaseConflictError`, `current_version`, `test_case_versions` |
| `public/app.js` | the editor UI, and a **display-only copy of `formatIrStep`** |
| `tests/stepText.test.ts` | pins the round trip, and extracts the browser's copy of `formatIrStep` to prove it renders identically |

## 12. Invariants — break these and the editor stops being trustworthy

1. **`parseIrStep(text, base)` — always pass the base.** Every call site does. Omitting it is how
   an untouched line would silently lose its grounding and cost a browser walk.
2. **Never make the format round-trippable.** §2.
3. **`public/app.js`'s `formatIrStep` must render identically.** It is a classic script and cannot
   import the server's copy; the test extracts and compares them. Change one, change both.
4. **A model never writes.** Proposals become editor content, never a saved case.
5. **Credentials stay `${env:…}` in stored steps.** Never literals — saved IR reaches disk and
   `runs/` is served over HTTP.
6. **A failed or cancelled re-ground writes nothing.** Those branches never reach `updateCase`.

## 13. Known limits

- **The gate editor has no page awareness beyond a reference list.** It shows the discovered
  elements of the case's target page as chips (role + name), but it does not check what you typed —
  that would mean parsing a target out of free English, which is the TD-01 failure mode. A step
  naming something that does not exist surfaces at IR time, not while typing.
- **Positional matching makes a deletion expensive.** Everything after the deleted row re-grounds
  (§4). Correct, but more work than strictly necessary.
- **`replayAndSnapshot`'s cache key omits the credentials it was given** (`TECH_DEBT.md` TD-52) —
  fixing wrong credentials and retrying can return the stale failed snapshot.
- **The estimate is a coarse over-estimate** (~2s/replayed step + ~8s/snapshot), deliberately: a
  save that finishes sooner than promised is a good surprise.

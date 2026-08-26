# Phase — plain-language step editing ("Write it for me")

Closing the last gap in the case editor: a person could edit steps in English, but only in the
**exact** vocabulary `parseIrStep` accepts. Typing `click the login button` was rejected with a
list of eleven sentence shapes to copy from — correct, and useless to someone who does not want to
learn a grammar in order to fix a typo.

This phase makes the parser's rejection *actionable*: a model translates the loose line into the
vocabulary, as a **proposal**, and everything downstream is unchanged.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/stepText.ts` | `STEP_VOCABULARY` — the eleven sentence shapes, exported. It was a private array inside `rewrite.ts`; two prompts now need to show it, and a second hand-maintained copy is TD-07 in miniature (the parser gains a form, the prompt does not, and the model keeps rewriting sentences that were already valid). One list, next to the parser that defines it. |
| `src/server/rewrite.ts` | `proposeStepTranslation()` — loose lines in, canonical lines out, **never saves**. `unreadableDraftIndexes()` — which drafts the real parser rejects. `nlStepsEnabled()` — the flag, read at call time. |
| `src/server/index.ts` | `POST /api/cases/:caseId/steps/translate` (new, flag-gated). `GET /api/cases/:caseId/steps` gains the **optional additive** field `nlSteps`. |
| `public/app.js` | A **"Write it for me"** button under the estimate error. `doTranslateSteps()`. The proposal renders through the existing diff card, with a heading that distinguishes a translation from a rewrite. `caseEditor.repaint` — a repaint handle for module-scope helpers that live outside `renderCaseView`'s closure. |
| `tests/stepNl.test.ts` | New. 10 cases, all about what happens when the **model misbehaves**. |
| `.env.example` | `NL_STEPS_ENABLED`, documented, `false`. |

**692 passing** (was 682, +10). `tsc --noEmit` clean. `node --check public/app.js` clean.

## 2. NEW FILES

- `src/` — none. Both new functions live in `rewrite.ts`, which already owned "a model proposes,
  a person approves, nothing is written".
- `tests/stepNl.test.ts` — new.

## 3. NEW ENV FLAGS

**`NL_STEPS_ENABLED`** — default **`false`**, like every capability flag in `implentationplan.md`.

Off is the honest default here rather than a formality: the route spends a Gemini call, so a
server deployed without a key would otherwise advertise a button that fails on press. With the
flag off the route 404s *and* `GET /steps` reports `nlSteps: false`, so the button is never drawn.

Set to `true` in the local `.env` (gitignored).

## 4. NEW ROUTES

### `POST /api/cases/:caseId/steps/translate` — `requireRole("tester")`

```
body  { steps: string[] }          the CURRENT editor draft, loose lines and all
200   { steps, before, translatedIndexes, note, usage }
400   nothing to translate / empty / a line over 500 chars / over 200 lines
404   flag off
429   rate limit (shared with /rewrite)
502   the model returned an unusable proposal — see section 6
```

Three deliberate properties:

1. **It never saves.** Approving puts sentences in the editor; saving them goes back through
   `POST /steps` like any hand-typed edit — one parser, one grounder, one version history,
   whoever wrote the words. A model that could write to the library would be a model authoring
   tests nobody reviewed, against a site it has not looked at.
2. **It returns step TEXT, not IR.** Same reason `proposeRewrite` does: IR straight from a model
   would be a second way into the library with different guarantees.
3. **It shares `/rewrite`'s rate limiter** (20 attempts / 15 min / user). Both spend one Gemini
   call per press on behalf of one signed-in person, so one allowance covering both is the honest
   ceiling — two budgets would let a user double their model spend by alternating buttons.

### `GET /api/cases/:caseId/steps` — one optional field

```diff
  { caseId, currentVersion, expected, steps: [{id, text}]
+ , nlSteps: boolean }
```

Additive and optional, per the standing rule. It exists because the browser has **no parser and no
Gemini key of its own** and so cannot decide locally whether to offer the button; guessing would
mean drawing a button that 404s.

## 5. SCHEMA CHANGES

**None.** No migration, no new table, no new column. The IR contract is untouched — this phase
never produces IR, only sentences that the existing parser turns into IR.

## 6. THE SAFETY ARGUMENT

The feature's entire trustworthiness rests on one property: **a model can never widen what the
system accepts.** Concretely, in `proposeStepTranslation`:

- Every line the model returns is run back through **`parseIrStep`** — the same function the save
  path uses — *before* the proposal is shown. A sentence the parser cannot read never reaches a
  person. So the model cannot invent a grammar, cannot smuggle in a selector, and cannot produce a
  shape the save path would later choke on. The worst it can do is fail, and failing costs one
  call and no writes.
- **Line-for-line, enforced.** A different line count is a hard 502, not something to reconcile.
  `parseIrSteps` matches drafts to their originals *positionally*, so a silently inserted row
  would re-base every step after it and mark the whole tail for re-grounding — an invisible bill.
  Restructuring a test is what "Ask for a change" is for.
- **Readable lines are restored from the draft, not taken from the model.** This is the quiet one.
  A model that "improves" an untouched line produces something that parses fine, so no gate
  catches it — and it would cost a browser walk the person never asked for. Rebuilding `steps`
  from the drafts makes the `[KEEP]` prompt instruction unnecessary to trust.
- **`${env:...}` placeholders** are instructed to be preserved, and that is verified in test. A
  resolved placeholder would be a real secret written into a stored test.

## 7. WHAT I DID NOT TOUCH

- **`parseIrStep` / `formatIrStep`.** Not one line. The whole point is that the translation feeds
  the *existing* parser; changing it would defeat the safety gate.
- **Any existing route's request or response shape.** `GET /steps` gained one optional field.
  Nothing renamed, removed or reordered.
- **`public/style.css`.** The button reuses `dl-btn-inline`; the diff reuses `cd-proposal`.
- **`showView()`.** No view switching is involved.
- **The save, estimate, job, cancel and credential paths.** A translated line is indistinguishable
  from a hand-typed one by the time it reaches them.
- **`scrubServedSecrets`.** Untouched.

## 8. HOW TO VERIFY

Done, on the real server against real data:

**a) The flag gate** — two servers, same code:

```
NL_STEPS_ENABLED=false  ->  404 {"error":"plain-language steps are not available ..."}
NL_STEPS_ENABLED=true   ->  reaches the case lookup
```

**b) `nlSteps` reaches the browser** — `GET /api/cases/<id>/steps` returns `nlSteps: true`.

**c) End-to-end, one real Gemini call.** Took a real 15-step case and replaced line 6 with
`press the admin button at the top`:

```
translatedIndexes: [5]
line 6:  press the admin button at the top   ->   Click on button "Admin"
usage:   1 call, 698 prompt + 214 completion = 912 tokens
```

Every other line came back **byte-identical**, with both `${env:TEST_USERNAME}` and
`${env:TEST_PASSWORD}` intact. Note what the model matched: it reused the case's own existing
wording for that control, so the target was semantically unchanged and **that save would have been
free** — no browser walk at all.

**d) In the UI** — open a case, Steps tab, retype a line loosely, wait for the red error, press
`Write it for me`, the diff appears in the right column, `Apply to editor` fills the editor and
says nothing is saved, `Save` then behaves exactly as it does for a hand-typed edit.

**e) The suite.** 692/692, `tsc --noEmit` clean.

## 9. HOW TO ROLLBACK

Set `NL_STEPS_ENABLED=false` and restart. The route 404s, `nlSteps` reports `false`, the button is
never drawn, and the editor is byte-for-byte the one that shipped last phase. No data is written by
this feature, so there is nothing to unwind.

To remove the code entirely: revert the commit. `STEP_VOCABULARY` can stay — `rewrite.ts` uses it.

## 10. DEFERRED / FOUND-NOT-FIXED

Per the standing rule, written down rather than fixed:

1. **A malformed case id returns 500, not 404.** `GET`/`POST` on `/api/cases/xyz/...` surfaces the
   raw Postgres text `invalid input syntax for type uuid: "xyz"`. Pre-existing, in `getCase`, not
   introduced here. It leaks the database engine to an authenticated caller — low severity, but it
   should be a 404.
2. **The `replayAndSnapshot` cache key still omits credentials** (carried from
   `PHASE_CASE_CREDENTIALS_REPORT.md` section 9). Fixing wrong credentials and retrying returns
   the stale failed snapshot. Unrelated to this phase, still open.
3. **Translation cannot create a case from nothing.** This phase fixes *wording* on an existing
   case. Authoring a brand-new case by typing steps with no run behind it is still not possible —
   a case is still born only from a run or a duplicate. The machinery to do it now exists; the
   entry point does not.
4. **No client-side pre-check.** The button appears only after the server's estimate rejects the
   line (~400 ms after typing stops). That is correct — the browser has no parser — but it means
   the affordance is invisible until the round trip lands.

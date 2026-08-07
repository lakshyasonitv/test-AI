# Updates & Current State

This document records the recent updates to the project, how the pipeline works now, the key
functions, the changes that were made, and the current known issues.

## 1. Recent Updates

### 1.1 Commit history (newest first)

| Commit | Date | Author | Summary |
|--------|------|--------|---------|
| `18a19a5` | Aug 6 | Yashika Aggarwal | **Select cases feature implemented** — the case-selection gate. |
| `459e041` | Aug 3 | Lakshya Soni | Docs: roadmap updated toward general-purpose backend architecture requirements. |
| `53f6a6d` | Aug 3 | Lakshya Soni | Core AI test orchestration, stage logic, and IR management modules. |
| `f9079a0` | Jul 30 | Lakshya Soni | Async credential prompting server, execution retries, full test orchestration pipeline. |
| `3015649` | Jul 30 | Lakshya Soni | Replaced the Python crawler with native Playwright DOM discovery. |
| `366d3b5` | Jul 30 | Lakshya Soni | Structured test case generation + coverage strategy logic. |
| `933c003` | Jul 30 | Lakshya Soni | Dead-code removal (~1900 lines). |
| `49edd95` | Jul 29 | Lakshya Soni | Consolidated project documentation. |
| `c2b5ff8` | Jul 28 | Garvit Khandelwal | Per-step test isolation + screenshots + aggregated phase progress UI. |
| `12da55b` | Jul 28 | Lakshya Soni | Core stages, state management, asset scaffolding. |

### 1.2 The case-selection feature (latest commit `18a19a5`)

A user-driven gate that pauses a run after test-case generation, shows the batch in the UI, and
lets the user accept cases, reject them, or ask for a regeneration round. It is **opt-in** via
`ENABLE_CASE_SELECTION_GATE=true` in `.env` (default: off — the pipeline then behaves exactly as
it did before).

New files:

- `src/schema/caseSelection.ts` — Zod schema for the user decision (`done` | `not_satisfied`)
  plus the `accepted-cases.json` / `case-history.json` shapes.
- `src/stages/caseSelectionGate.ts` — the gate loop: generate batch → park for a decision →
  accumulate accepted cases → regenerate (up to `MAX_CASE_REGEN_ATTEMPTS`) when "not satisfied".
- `src/server/caseAccumulator.ts` — persists accepted cases to `runs/<runId>/accepted-cases.json`,
  enforces `MAX_ACCUMULATED_CASES`.
- `src/server/caseHistoryLedger.ts` — persists every round's batch (selected / rejected /
  selected_but_capped) to `runs/<runId>/case-history.json`; feeds prior-round context back into
  regeneration so the LLM never restates already-covered cases.
- `src/server/pendingCaseSelection.ts` — in-memory promise-parking for the waiting run.

New/updated endpoints (`src/server/index.ts`):

- `POST /api/runs/:runId/case-selection` — submit the user's decision.
- `GET /api/runs/:runId/accepted-cases` — current pool state.
- `GET /api/runs/:runId/case-selection-status` — snapshot of the pending round (polled by UI).
- `POST /api/runs` / orchestrator — gate wired in when the flag is on.

UI: `public/app.js` renders the batch with select/regenerate controls.

## 2. How the Pipeline Works Now

```
prompt + url
   |
   v
1. Plan (Gemini)            planner.ts          NL request -> structured Plan (scope, steps, coverage)
   |
   v
2. Discovery                hybridDiscovery.ts  DOM-first (domDiscovery.ts + domExtract.ts, no LLM),
                            domDiscovery.ts      Gemini vision fallback only (canvas/captcha/image-heavy)
                            domExtract.ts
   |
   v
   AppModel (pages x elements as role+name, cached per URL)
   |
   v
3. Test cases (Gemini)      testCases.ts        Plan + AppModel + coverage taxonomy -> full suite
   |                                            (valid / invalid-input / empty-boundary /
   |                                            security-* / functional-other)
   |
   |-- optional: case-selection gate ----------  caseSelectionGate.ts  (only when
   |       user accepts cases / asks for more       ENABLE_CASE_SELECTION_GATE=true)
   |
   v
4. Primary case selection                       fromPrompt case, else highest priority
   |
   v
5. Credentials               credentials.ts     asks only when needed (demo account / no prompt creds)
   |
   v
6. IR generation (Groq)      ir.ts              TestCase + AppModel -> grounded steps;
   |                                            ungrounded step -> live-extend replay
   |                                            (liveExtend.ts -> extendAppModel /
   |                                            refreshPageModel / groundTerminalTextAssertion)
   v
7. Generate spec (no LLM)    generator.ts       IR -> *.spec.ts, one test.step() per IR step
   |
   v
8. Execute (Playwright)      executor.ts        per-case browser context, screenshots/trace
   |
   +-- failed? -> failureAnalysis.ts (deterministic classifier, Gemini only if ambiguous)
   |              -> self-heal (<=1 attempt): refreshPageModel -> toIR -> re-run once
   v
9. Suite                      suiteRunner.ts     every selected case gets its own test(); primary
                                                result is reused (identity match, not flag match)
   |
   v
10. Done                                      07-suite-summary.json + screenshot URL + Groq usage
```

### Key behaviors

- **Case selection is one authority.** `selectCases()` in `testCases.ts` dedups (title-overlap,
  threshold 0.7), keeps the `fromPrompt` case, then fills the coverage budget by category
  diversity before priority. Selection used to happen inside `toTestCases` — that caused 4-or-8
  case runs and restated primaries.
- **Discovery is single-page.** Only the entry URL is modeled up front; pages behind
  login/clicks are discovered reactively at execution time via live-extend and added to the
  AppModel (`updatedAppModel`).
- **Reactive new-page cases.** After the primary case runs, `orchestrator.ts` detects pages in
  `updatedAppModel` not in the original URLs and can generate extra cases for them
  (`generateCasesForNewPages`, tagged `generatedFrom: "reactive"`).

## 3. Key Functions

### Orchestrator (`src/orchestrator.ts`)
- `runPipeline(...)` — the full run: input → plan → discovery → test cases → (gate) →
  credentials → IR → generate → execute → heal → suite → done. Emits durable `StageEvent`s to
  `runs/<runId>/events.ndjson`.
- `makeRunId()` — shared run-id shape (`YYYY-MM-DDTHH-MM-SS-mmmZ-xxxxxxxx`).

### Discovery
- `discoverHybrid(url)` / `discoverPagesHybrid(urls)` (`hybridDiscovery.ts`) — DOM-first with
  vision fallback; caches per URL.
- `discoverUsingCrawler(url)` (`domDiscovery.ts`) — launches Playwright, extracts structure via
  cheerio (`domExtract.ts`), no LLM tokens.
- `labelConceptsWithDOM(...)` — the single Gemini call in the primary path: labels elements with
  concepts (Login, Search, ...) from DOM + markdown.

### Test cases
- `toTestCases(plan, appModel, extend?)` (`testCases.ts`) — generates the suite via Gemini;
  `extend` supplies existing titles / mint-primary / refined-prompt for regeneration rounds.
- `selectCases(all, budget)` — dedup + diversity-based budget filling.
- `generateCasesForNewPages(updatedAppModel, originalUrls, plan, prompt, existingTitles)` —
  reactive cases for pages discovered during execution.
- `strategyFor(concepts)`, `filterByScope(...)`, `normalizeCategory(...)`, `classifyScope(...)`
  (`kb/testStrategy.ts`) — the coverage checklist floor and category routing.

### Case-selection gate
- `runCaseSelectionGate({ runId, plan, appModel, sourcePrompt })` (`caseSelectionGate.ts`) —
  rounds of generate → wait-for-decision → accumulate → regenerate.
- `awaitCaseSelection(runId, batch, attempt)` / `resolveCaseSelection(...)` /
  `getPendingSelection(...)` (`pendingCaseSelection.ts`).
- `appendAcceptedCases(...)`, `getAllAcceptedCases(...)`, `hasAcceptedPrimary(...)`,
  `remainingCapacity(...)` (`caseAccumulator.ts`).
- `appendRoundToHistory(...)`, `getAllHistoryTitles(...)`, `buildHistoryPromptBlock(...)`
  (`caseHistoryLedger.ts`).

### IR / execution
- `toIR(case, appModel, prompt, url, budget, creds)` (`ir.ts`) — grounded IR generation with
  live-extend for unknown pages; returns `updatedAppModel`.
- `extendAppModel(...)` / `refreshPageModel(...)` / `groundTerminalTextAssertion(...)`
  (`liveExtend.ts`) — browser replay + snapshot + modeling of reached pages.
- `generateSpec(ir, dir)` (`generator.ts`) — IR → Playwright spec.
- `runSpec(spec, dir, envVars)`, `findScreenshot(...)`, `detectBlocked(...)` (`executor.ts`).
- `runSuite(...)` (`suiteRunner.ts`) — per-case execution, primary-result reuse, summary JSON.
- `analyzeFailure(ir, result)` (`failureAnalysis.ts`) — deterministic + Gemini diagnosis.
- `isAuthTriggeringStep(...)` / `waitForAuthSettle(...)` (`authSettle.ts`).

### Credentials
- `credentialsFor(url)`, `credentialFieldsNeeded(appModel, cases)`,
  `promptCarriesCredentials(prompt)`, `credentialEnvVars(creds)`, `credentialPolicyFor(...)`,
  `credentialForTarget(...)`, `credentialFieldMap(...)`, `redactCredentials(...)`
  (`stages/credentials.ts`) — built-in demo accounts, prompt-supplied creds, secret env-var
  substitution (never literals into served `runs/`).

### Server (`src/server/index.ts`)
- `POST /api/runs` (start, queued via semaphore), `POST /api/runs/:id/credentials`,
  `POST /api/runs/:id/case-selection`, `GET /api/runs/:id/accepted-cases`,
  `GET /api/runs/:id/case-selection-status`, `GET /api/runs/:id/events|state`,
  `GET /api/runs`, `DELETE /api/runs/:id`.
- `askCredentials` / `settle` (`pendingCredentials.ts`) — async credential prompt backing the
  UI.

## 4. Config & Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_CASE_SELECTION_GATE` | off | `"true"` runs the case-selection-gate pipeline. |
| `MAX_CASE_REGEN_ATTEMPTS` | 3 | Max refine rounds per case set. |
| `MAX_ACCUMULATED_CASES` | 5 | Cap on accepted cases kept across rounds. |
| `CASE_SELECTION_WAIT_MS` | 600000 | How long a run parks waiting for a selection decision. |
| `MAX_CASES_PER_RUN` | 5 | Hard ceiling on cases turned into scripts (overrides coverage budget). |
| `MAX_LIVE_EXTENSIONS` | 5 | Max browser replays per case to discover pages behind login/click. |
| `MAX_CONCURRENT_RUNS` | 3 | Parallel run slots (each launches Chromium). |
| `GEMINI_API_KEYS` / `GROQ_API_KEYS` | — | Model keys; Groq keys are failover only. |

Full env table: `README.md` → *Configuration*.

## 5. Known Issues & Diagnosis

### 5.1 Why every run only tests login/signup

The suite is driven entirely by the **AppModel**, and discovery only models the **single entry
URL**. For example, `https://www.saucedemo.com` produces one page — the login form — whose only
concept is `Authentication` (`02-appmodel.json`). Generation then follows the login coverage
checklist (`kb/testStrategy.ts`): valid credentials, invalid password, empty fields, SQL
injection, XSS. The generator prompt forbids inventing elements on unseen pages
(`testCases.ts`), so product/cart/checkout cases cannot be written yet — those pages only enter
the model later, at execution time via live-extend.

This is not a selection bug; it is a **discovery-depth** limitation (the old Python crawler that
followed internal links was removed). To get broader suites, discovery must model more pages
before generation (e.g. follow internal URLs / crawl, or let the case-selection gate run a
multi-page model).

### 5.2 Why the "new engine" does not run for a new page

Two compounding causes:

1. **Reactive new-page generation is disabled when the gate is on.** In `orchestrator.ts`, the
   `generateCasesForNewPages(...)` block is wrapped in
   `if (process.env.ENABLE_CASE_SELECTION_GATE !== "true")`. With `.env` set to
   `ENABLE_CASE_SELECTION_GATE=true`, pages discovered at execution time are never turned into
   new test cases.
2. **Empty selection crashes the run.** In the observed run
   (`2026-08-06T12-07-36-279Z-960f2ce7`) the user clicked "Done" without selecting any cases.
   The server rejects that (`index.ts` returns 400 "Select at least one case before clicking
   Done"), but the round then stays parked until `CASE_SELECTION_WAIT_MS` expires, which
   auto-resolves as `done/[]`, so `caseSelectionGate.ts` throws
   `"No test cases were selected for run <id>"`. Because no primary case was accepted, the
   pipeline never reached execution — so live-extend never discovered new pages at all.

Suggested fix directions (not yet implemented):

- Run `generateCasesForNewPages` regardless of the gate flag (gate off → auto-select, gate on →
  append reactive cases to the pool for the user to review).
- Handle the empty-selection `done` gracefully (e.g. treat as "no cases for this round" and end
  the run with a clear message instead of an exception, or fall back to auto-selection).

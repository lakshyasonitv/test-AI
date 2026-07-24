# AI QA Automation Platform — Architecture & Engineering Specification (v2)

**Status:** Living internal engineering document. Single source of truth for all future implementation work by human or AI coding agents.
**Audience:** Any coding agent (Claude Code, Codex, Cursor, human engineer) picking up implementation work on this codebase.
**Supersedes:** v1 of this document. v1's intent and strictness are preserved and strengthened, not replaced.

---

## 0. How to Read This Document

If you are an AI coding agent about to implement a phase of this project, read sections **1–8** in full before touching any code. Sections 9–17 are the operating contract you must follow on every single task. Section 18 is the template every phase prompt must conform to.

If you find yourself skimming, stop. Every rule in this document exists because its absence caused a real category of failure in AI-assisted implementation: silent scope creep, invented APIs, duplicated utilities, regressions in working code, or confident-but-wrong architecture changes. This document is the countermeasure to all of those.

---

## 1. What This Project Is

### 1.1 One-paragraph description

This project is an **enterprise AI QA Automation platform**. Given a natural-language testing request and a target URL, it autonomously understands the structure of a web application, generates a full suite of QA test cases against it, compiles those test cases into deterministic Playwright scripts, executes them against the live application, and — when a test fails — explains *why* in plain English and attempts a bounded, automatic repair. The long-term direction of the project is to remove the human from every step of this loop except stating intent: eventually the platform should be able to autonomously explore an entire application it has never seen before, build a structural map of it, and derive comprehensive test coverage from that map without being told where to look.

### 1.2 The five capabilities, in the platform's own words

1. **Understands web applications.** It does not require a human to describe the UI. It loads the target page(s), takes an accessibility-tree snapshot, and — with vision-model assistance for disambiguation only, never for invention — builds a structured model of every interactive element: role, accessible name, and page context.
2. **Generates QA test suites.** From a plan plus the structural model plus a coverage taxonomy (valid path, invalid input, empty fields, boundary values, security probes), it produces a full set of human-readable test cases, not just the one case the user literally asked for.
3. **Builds deterministic Playwright scripts.** Test cases are translated into a strict, schema-validated intermediate representation (IR), which is then compiled into literal Playwright source code by a pure, non-AI generator. The same locator-resolution logic is shared between generation and live execution so the two paths cannot disagree with each other.
4. **Executes them.** The generated spec is run through the real Playwright test runner — not simulated, not mocked. Screenshots, traces, and structured results are captured for every run.
5. **Analyzes failures.** On failure, a vision-capable model reads the real Playwright error plus a screenshot and returns a structured diagnosis: category, plain-English explanation, suggested fix. A narrow, bounded class of failures (selector drift, missing element) triggers exactly one automatic repair attempt; genuine application-behavior failures (a real assertion failing) are never silently "fixed" — they are reported as bugs.

The long-term target — full autonomous application exploration — is described in Section 3. **Nothing in this document authorizes building toward that target ahead of an explicitly requested phase.** See Section 10 (Strict Implementation Contract).

---

## 2. Current Architecture (As-Built, Ground Truth)

This section describes the pipeline as it exists in the codebase today. It is the baseline every change must be evaluated against. Do not describe an aspirational version of this section — if what's below stops matching the code, the code's behavior wins and this document must be corrected first.

### 2.1 Pipeline diagram

```
User Prompt + URL
        │
        ▼
   ┌──────────┐
   │ Planner  │   stages/planner.ts
   └────┬─────┘
        ▼
   ┌───────────┐
   │ Discovery │   stages/discovery.ts
   └────┬──────┘
        ▼
   ┌────────────────┐
   │ Application     │  (AppModel — schema/appModel.ts)
   │ Model            │
   └────┬────────────┘
        ▼
   ┌────────────────────┐
   │ Test Case Generator │  stages/testCases.ts
   └────┬────────────────┘
        ▼
   ┌──────────────────────┐
   │ Intermediate          │  schema/ir.ts, stages/ir.ts
   │ Representation (IR)   │
   └────┬──────────────────┘
        ▼
   ┌───────────────────┐
   │ Playwright         │  stages/generator.ts
   │ Generator          │
   └────┬───────────────┘
        ▼
   ┌──────────┐
   │ Executor │   stages/executor.ts
   └────┬─────┘
        ▼
   ┌──────────────────┐
   │ Failure Analysis  │  stages/failureAnalysis.ts
   └───────────────────┘
```

### 2.2 Stage-by-stage contract

| Stage | File | Responsibility | Inputs | Outputs | Why it exists |
|---|---|---|---|---|---|
| **Planner** | `stages/planner.ts` | Turn a natural-language request into an ordered high-level plan. Runs *before* any page has been loaded, so it cannot be grounded to real elements yet — it works at the intent level only. | `prompt`, `url` | Ordered plan steps (`01-plan.json`) | Separates "what the user wants" from "what the page actually contains," so later stages can reconcile intent against reality instead of conflating the two. |
| **Discovery** | `stages/discovery.ts` | Load the entry URL in a real browser, take an accessibility snapshot, label it into an `AppModel` (elements by role + accessible name). Vision (screenshot) is used **only** to disambiguate labeling of elements the snapshot already contains — never to add elements the snapshot does not contain. | `url`, live browser | `AppModel` (`02-appmodel.json`) | The single source of truth for "what is really on this page," strictly grounded to the DOM/accessibility tree, not to LLM imagination. Exports `modelFromAria()`, reused verbatim by `liveExtend.ts` so discovery logic is never duplicated. |
| **Application Model** | `schema/appModel.ts` | Zod schema defining `AppModel`, `PageModel`, `Element`. | — | Type contract | Makes the discovery output a validated, structural contract rather than a loose object every downstream stage has to defensively re-parse. |
| **Test Case Generator** | `stages/testCases.ts` | Combine plan + `AppModel` + the coverage taxonomy (`kb/testStrategy.ts`) into a full human-readable suite: valid path, invalid input, empty fields, boundaries, security. Exactly one case is tagged `fromPrompt: true` — the literal translation of what the user asked for. | Plan, `AppModel`, taxonomy | Full case suite (`03-cases.json`) | Ensures the platform tests more than the literal ask by default, closing the gap between "what the user typed" and "what a QA engineer would actually check." |
| **Primary-case selection** | `orchestrator.ts` | `cases.find(fromPrompt) ?? highestPriorityCase`. Selects the **one** case that proceeds to execution today. | Case suite | Selected case | Documents the current, real limitation: only one case executes per run. This is not hidden — it is the single biggest tracked gap in `PROJECT_OVERVIEW.md` §4. |
| **IR generation** | `stages/ir.ts`, `schema/ir.ts` | Turn the selected case into a strict, schema-validated IR (`Step`, `Target`). Runs `groundingError()` against the current `AppModel` for every `{role, name}` target. If ungrounded, calls `liveExtend.extendAppModel()` to replay the grounded prefix in a real browser, reach the next page, and label it via the *same* discovery prompt — merging the result. Retries bounded at ≤2×. If still ungrounded, truncates to the grounded prefix and marks `meta.truncated`. | Selected case, `AppModel` | IR (`04-ir.json`), possibly `meta.truncated: true` | Produces a machine-checkable action contract instead of trusting free-form LLM output to be executable; the truncation path is a deliberate "return a real partial test, don't fail the whole run" tradeoff, explicitly tracked as a known-gap source (§4 of `PROJECT_OVERVIEW.md`). |
| **Live Extend** | `stages/liveExtend.ts` | `extendAppModel()` — replay grounded prefix live, reach a genuinely new page, label it. `refreshPageModel()` — same replay, but upserts an already-known page's *current* state (used by self-heal). | IR prefix, `AppModel` | Extended `AppModel` | Lets grounding continue past the entry page without re-running full discovery, and gives self-heal a way to re-anchor to a drifted page. |
| **Target Resolver** | `stages/targetResolver.ts` | `Target → locator`. Deterministic fallback chain (role swap, text match), always resolves to `.first()`. Shared verbatim by `generator.ts` (codegen) and `liveExtend.ts` (live replay). | `Target` | Playwright locator | The single point of truth for "how do we turn an abstract target into a real locator" — the reason generated code and live replay can never silently disagree. **Never duplicate this logic anywhere else.** |
| **Credentials** | `stages/credentials.ts` | Built-in demo-site credential table + field matcher; substitutes credentials into IR steps, skipped for `fromPrompt` cases. | IR | IR with credentials applied | Lets built-in demo sites (saucedemo.com, the-internet.herokuapp.com) be tested without the user supplying real creds — with a known, tracked gap (see `PROJECT_OVERVIEW.md` §4 item 4: still overwrites a deliberately-wrong password case on those two hosts). |
| **Playwright Generator** | `stages/generator.ts` | IR → literal Playwright source text. **Zero LLM calls.** Inlines the same locator-fallback helper as `targetResolver.ts` so the emitted spec is self-contained. | IR | `generated.spec.ts` | Determinism: the same IR always produces the same test file, byte for byte, given the same generator version. |
| **Executor** | `stages/executor.ts` | Spawns the real Playwright CLI. Zero LLM calls. Collects JSON results, screenshot, trace. | `generated.spec.ts` | `05-result.json`, screenshot, `trace.zip` | Ground truth: the platform never simulates a test result, it always actually runs the browser. |
| **Failure Analysis** | `stages/failureAnalysis.ts` | Vision-capable model reads the real Playwright error text + a screenshot. Returns category, explanation, suggested fix. | Failed result, screenshot | `06-diagnosis.json` | Turns a raw stack trace into something a human (or the self-heal branch) can act on. |
| **Bounded self-heal** | `orchestrator.ts` | If diagnosis category is `selector_changed` / `element_missing` **and** the failing step has a real grounded prefix: re-snapshot the page, generate a fresh IR, regenerate, re-run — **exactly once**. Rejected if the healed IR is itself truncated (would be a false pass). If category is `assertion_failed` (a real app bug), no repair is attempted — it must stay a reported failure. | Diagnosis, IR, page | Healed result (if accepted) or terminal failure | Prevents the platform from "fixing" a real product bug by silently rewriting the test until it passes — see the `PROJECT_OVERVIEW.md` §3 rule on decorative-persistent-element assertions. |

### 2.3 Persisted run artifacts (ground truth for what "a run" means)

Every run persists, under `runs/<id>/`:

| File | Contents |
|---|---|
| `00-input.json` | Raw prompt + URL |
| `01-plan.json` | Planner output |
| `02-appmodel.json` | Discovery output |
| `03-cases.json` | Full generated coverage suite |
| `04-ir.json` | Strict IR for the one case that ran (may be `truncated: true`) |
| `generated.spec.ts` | Literal Playwright test |
| `05-result.json` | Real execution result |
| `06-diagnosis.json` | Present only on failure |
| `healed/` | Present only if self-heal succeeded |
| `events.ndjson` | Every stage-progress event, durable and replayable |
| `artifacts/` | Screenshot(s) + `trace.zip` from the real browser run |

Any implementation work that changes what a run persists must update this table in the same change.

### 2.4 Known, currently-tracked gaps (do not silently "fix" these as a side effect of unrelated work)

From `PROJECT_OVERVIEW.md` §4 — restated here because a coding agent must not treat these as invitations to refactor unless the current task is explicitly about one of them:

1. Only the top-priority / `fromPrompt` case executes; the rest of the suite is generated but never run.
2. A truncated IR can still "pass" if the dropped tail contained the only assertion.
3. **(CLOSED — Phase 3: Auth Settle-Wait)** Live-extend can race a SPA's own client-side auth redirect. A bounded wait for URL change → network idle is now inserted after any auth-triggering step in both `liveExtend.ts`'s replay and `generator.ts`'s emitted spec.
4. Credential substitution still overwrites the taxonomy's own deliberately-wrong "Invalid password" case on the two hardcoded demo hosts.
5. No server authentication — anyone with a tunnel link can start runs and browse all run artifacts.
6. Credentials only cover built-in demo hosts, beyond whatever the user types directly into the prompt.
7. Gemini model/key availability is inconsistent across the configured key pool; the `/v1beta/models` list endpoint does not reliably predict what a real `generateContent` call will accept.

If a phase's explicit objective is to close one of these, say so in the phase prompt's Objective section (§18). Otherwise, leave them alone.

---

## 3. Target Architecture (North Star — Not to Be Built Ahead of an Explicit Phase)

### 3.1 Pipeline diagram

```
User Prompt
        │
        ▼
   ┌──────────┐
   │ Planner  │
   └────┬─────┘
        ▼
   ┌────────────────┐
   │ Crawl Directive │
   └────┬────────────┘
        ▼
   ┌──────────────────────┐
   │ Deterministic Crawler │
   └────┬──────────────────┘
        ▼
   ┌───────────┐
   │ Discovery │
   └────┬──────┘
        ▼
   ┌───────────┐
   │ SiteGraph │
   └────┬──────┘
        ▼
   ┌───────────────────┐
   │ Coverage Analyzer  │
   └────┬───────────────┘
        ▼
   ┌───────────┐
   │ Grounder  │
   └────┬──────┘
        ▼
   ┌─────┐
   │ IR  │
   └──┬──┘
      ▼
   ┌─────────────────────┐
   │ Playwright Generator │
   └────┬──────────────────┘
        ▼
   ┌────────────────┐
   │ Suite Executor  │
   └────┬────────────┘
        ▼
   ┌──────────────────┐
   │ Failure Analysis  │
   └───────────────────┘
```

### 3.2 What changes, and why it is better

| Current concept | Target concept | Why the change |
|---|---|---|
| Single-URL `Discovery` per run | `Deterministic Crawler` + `SiteGraph` | Today, discovery only ever knows about the entry page (plus whatever `liveExtend` reaches reactively, on demand, for one selected case). The target crawler builds a full, deterministic structural map of the application *up front*, so coverage analysis has the whole site to reason about, not just the pages one lucky IR happened to reach. |
| Primary-case selection (run exactly one case) | `Suite Executor` (run the whole generated suite) | This directly closes known-gap #1 in §2.4 — the single biggest tracked gap today. |
| `groundingError()` invoked reactively inside IR generation | `Grounder` as its own pipeline stage, operating against the `SiteGraph` | Separates "does this suite make sense against the whole app" from "does this one IR's targets resolve" — the same grounding discipline, applied earlier and against more complete information, catching invalid targets before IR generation instead of during it. |
| Ad hoc suite coverage vs. taxonomy floor | `Coverage Analyzer` operating against `SiteGraph` | Lets the platform reason about coverage in terms of "what parts of the real, crawled application have a test," not just "did we hit the static taxonomy checklist" — a floor-vs-ceiling distinction already flagged in `kb/testStrategy.ts`'s own docstring today.

**Explicitly not a change:** the IR schema contract, the `gemini()`/`groq()` LLM boundary, and the principle that Discovery output must be strictly grounded to the accessibility snapshot never change. The target architecture is a *widening* of what feeds the same trusted contracts, not a replacement of them. (Mirrors the "IR contract does not change" principle already established for the scaling seams in `ENTERPRISE.md`.)

### 3.3 Component philosophy (the mental model every agent should hold)

- **Planner decides WHERE to go** — the intent-level plan, unconstrained by what pages actually exist yet.
- **Crawler decides HOW to go there** — deterministic traversal of the real application, never recursive/random/BFS-DFS exploration unless a phase explicitly requests it (see §13, Forbidden Implementations).
- **Discovery understands WHAT is on a page** — strictly grounded labeling, vision for disambiguation only.
- **SiteGraph is the structural memory** of everything the crawler + discovery have found, across pages.
- **Coverage Analyzer decides what's missing** — taxonomy floor + `SiteGraph` ceiling.
- **Grounder resolves targets** — confirms every `{role, name}` reference is real, against the fullest available structural picture.
- **IR represents actions** — the strict, schema-validated, model-agnostic action contract.
- **Generator creates deterministic Playwright** — zero LLM calls, same IR always produces the same spec.
- **Suite Executor runs suites** — not one case, the whole generated suite.
- **Failure Analysis explains failures** — category, explanation, fix; feeds bounded self-heal, never silently rewrites a real app-bug into a pass.

---

## 4. Code Generation Rules

Before writing a single line of new code for any phase, a coding agent must:

1. **Inspect the existing project structure first.** Read `PROJECT_OVERVIEW.md` §5 (file-by-file map) and the actual current contents of `src/` — do not assume the map above is still accurate without checking.
2. **Search for reusable functions before writing new ones.** In particular:
   - Reuse `modelFromAria()` (`stages/discovery.ts`) for anything that turns an accessibility snapshot into an `AppModel` shape — never reimplement snapshot-labeling logic elsewhere.
   - Reuse `AppModel` / `PageModel` / `Element` (`schema/appModel.ts`) as the structural contract — never invent a parallel "lite" model type.
   - Reuse `targetResolver.ts`'s `Target → locator` resolution (including its deterministic fallback chain) in both codegen and live-replay paths — never write a second locator-resolution function.
   - Reuse the grounding logic (`groundingError()`) for any new stage that needs to validate a target against an `AppModel` or `SiteGraph`.
   - Reuse `stages/generator.ts`'s Playwright-emission logic for any new output format — extend it, don't fork it.
3. **Never recreate a utility that already exists**, even a small one (e.g. the locator fallback chain, the tolerant JSON parsing in `llm/json.ts`, the retry/backoff in `llm/backoff.ts`, the key rotation in `llm/keyPool.ts`).
4. **Explain, in the response, why each piece of reused code is being reused** — cite the file and function name, not just "reusing existing utilities."

---

## 5. Modification Policy

- **New files are preferred over modifying existing ones.** A new stage, new schema, or new utility should usually live in its own file under the existing directory conventions (`stages/`, `schema/`, `kb/`, `llm/`).
- **Existing files should only be modified when a new file genuinely cannot achieve the goal** — e.g. adding a field to an existing Zod schema that every consumer already depends on.
- **Whenever an existing file is modified, the response must explicitly state why a new file was not sufficient.** "It was simpler" is not an acceptable justification on its own — state the concrete reason (shared state, existing consumers who must see the change atomically, a contract that cannot have two competing versions, etc.).

---

## 6. Backward Compatibility

- **Existing behavior must never regress** as a side effect of implementing a new phase. If a phase's explicit goal *is* to change existing behavior, that must be stated as the phase's objective, not discovered as a side effect.
- **Feature flags are preferred** over unconditional behavior changes when a new code path is not yet proven.
- **Composition is preferred over rewriting.** Wrap or extend an existing stage rather than replacing its internals wholesale, unless the phase's objective is explicitly a replacement.
- **Adapters are preferred** when bridging the current architecture (§2) toward the target architecture (§3) — e.g. a `Crawler` that today wraps the existing single-URL `Discovery` + `liveExtend` reactive-extension logic is preferred over a ground-up rewrite, until a phase explicitly calls for a full crawler.
- **Existing public APIs (function signatures, IR schema fields, persisted run-artifact file names/shapes) must remain stable** unless the phase's objective is explicitly to change them, in which case the migration impact must be documented (see §9, "Better Idea" section, and §18's Acceptance Criteria).

---

## 7. Clarification Policy (Strengthened)

An implementing agent **must stop and ask before writing any code** whenever any of the following is true:

- It is uncertain which of two or more valid implementations best fits the existing architecture.
- Multiple valid implementations exist and the phase prompt does not disambiguate between them.
- The change would require modifying a module unrelated to the stated phase.
- The change reveals an architectural conflict between the current architecture (§2) and the requested work.
- A prerequisite the phase depends on is missing (e.g. a phase for the `Crawler` is requested before `Crawl Directive`'s schema exists).

**The agent must never guess in these situations.** Guessing and proceeding is treated as a specification violation, not a minor judgment call — even if the guess turns out to be reasonable in hindsight. Ask a specific, answerable question; do not ask an open-ended "what do you want me to do?" question when the ambiguity can be narrowed to 2–3 concrete options.

---

## 8. "Better Idea" Protocol (Strengthened)

If, during implementation, the agent identifies an architecture, algorithm, or approach that is genuinely superior to what the phase prompt specifies:

**The agent must NOT implement it.** Instead, it must present, and then wait for explicit approval before writing any code toward it:

1. **Current approach** — what the phase prompt actually specifies.
2. **Proposed approach** — the alternative.
3. **Advantages** — concretely, not "cleaner code."
4. **Disadvantages** — including migration cost and risk.
5. **Migration impact** — what breaks, what needs to change, what tests need to be rewritten.
6. **Files affected** — an explicit list.
7. **Recommendation** — the agent's own honest opinion, clearly labeled as a recommendation, not a decision.

Then **stop and wait.** Do not proceed with either the original or the proposed approach until the person responds.

---

## 9. Strict Implementation Contract

- Every requested phase implements **only** that phase. Nothing else.
- **Never implement future phases**, even partially, even as "helpful" scaffolding.
- **Never anticipate future work** by adding hooks, config flags, or extension points "for later" unless the current phase's Acceptance Criteria explicitly ask for that extensibility.
- **Never create helper modules for functionality that isn't needed yet**, even if you can see it coming in a later phase.
- **Every phase must compile independently** — the project must build with only that phase's changes applied on top of the last accepted state.
- **Every phase must be testable independently** — it must be possible to verify the phase's Acceptance Criteria (see §18) without needing any later phase to exist.

This is the single most commonly violated rule in AI-assisted incremental development, and violating it is the single most common cause of un-reviewable, un-revertable diffs. Treat it as a hard constraint, not a guideline.

---

## 10. Output Format (Every Response, Every Phase)

Every implementation response must follow this structure, in this order:

1. **Task Understanding** — restate the phase's objective in your own words.
2. **Architectural Analysis** — where this fits in §2 (current) and, if relevant, §3 (target).
3. **Existing Components Being Reused** — named, with file paths (see §4).
4. **Files To Create** — full list, with one-line purpose each.
5. **Files To Modify** — full list, each with the §5 justification for why a new file wasn't sufficient.
6. **Public APIs** — every new exported function/type, with its exact signature.
7. **Responsibilities** — what this phase's code is responsible for.
8. **Non-Responsibilities** — what it explicitly is not responsible for (prevents scope creep from being "helpful").
9. **Constraints** — anything the implementation must respect (schema shapes, existing call sites, etc.).
10. **Step-by-Step Implementation Plan** — before any code is written.
11. **Complete Code** — no partial snippets, no "add this somewhere," no TODOs.
12. **Verification Steps** — how a human confirms this phase actually works.
13. **Regression Checklist** — see §16.
14. **Risks** — anything that could break later, or that was a judgment call.
15. **Next Logical Phase** — named, but **not started**.

---

## 11. Acceptance Criteria (Mandatory, Per Phase)

Every phase must define, explicitly, before implementation begins:

| Element | Requirement |
|---|---|
| **Inputs** | Exact types/shapes the phase's code receives |
| **Outputs** | Exact types/shapes the phase's code produces |
| **Responsibilities** | What this code owns |
| **Non-responsibilities** | What this code explicitly does not own |
| **Public API** | Exact exported function signatures |
| **Acceptance criteria** | Concrete, checkable conditions for "this phase does what it was asked to do" |
| **Completion criteria** | Concrete, checkable conditions for "this phase is done" (may be broader than acceptance criteria — e.g. includes docs/tests) |
| **Manual verification steps** | Exact commands or actions a human runs to confirm the phase works |

---

## 12. Forbidden Implementation Patterns

Unless a phase prompt explicitly requests one of these, an implementation must avoid:

- Unnecessary abstractions (interfaces/classes with exactly one implementation and no stated plan for a second).
- Duplicate utilities (see §4 — always search first).
- Recursive crawling.
- Random crawling.
- BFS/DFS crawling when the phase calls for deterministic traversal (the target Crawler in §3 is deterministic by design — this is a named architectural property, not an incidental choice).
- URL guessing (constructing URLs the crawler/discovery has not actually observed as links or navigation targets).
- Rewriting working code that the current phase does not need to touch.
- `TODO` placeholders of any kind in delivered code.
- Incomplete implementations — if a function is declared, its body must be complete and correct for the phase's stated scope, not stubbed.

---

## 13. Dependency Awareness

Every phase prompt must explicitly list **Available Existing Components** that must be reused, for example:

- `AppModel` (`schema/appModel.ts`)
- `modelFromAria()` (`stages/discovery.ts`)
- `targetResolver.ts`'s `Target → locator` resolution
- `kb/cache.ts` (per-URL `AppModel` cache)
- `llm/gemini.ts` / `llm/groq.ts` (the only two files permitted to call an LLM endpoint)
- Playwright utilities already wrapped in `stages/executor.ts` and `stages/generator.ts`

This list prevents an agent from rediscovering (and reimplementing) infrastructure that already exists in the codebase.

---

## 14. API Contract Awareness

Whenever a phase introduces a new module, its exported API must be defined exactly, in the phase prompt, before implementation. Example, for a future `Crawler` phase:

```ts
async function crawlSite(
    directive: CrawlDirective,
    context: BrowserContext
): Promise<SiteGraph>
```

An implementing agent must not invent a different signature, return type, or parameter order than what the phase prompt specifies. If the agent believes the specified signature is wrong, that is a "Better Idea" situation (§8) — present it and wait, do not silently implement a different one.

---

## 15. Regression Checklist (Mandatory, Every Phase, Before Reporting Done)

- [ ] Existing tests still compile.
- [ ] Existing behavior preserved (manually reasoned through, not assumed).
- [ ] No unrelated files changed.
- [ ] New functionality isolated to the files listed in the phase's "Files To Create" / "Files To Modify."
- [ ] Requested functionality is complete — nothing partially implemented.
- [ ] No future-phase functionality implemented.
- [ ] No placeholder/TODO code remains.
- [ ] Every run-artifact file this phase touches (see §2.3 table) is documented if its shape changed.

---

## 16. Definition of Done

A phase is complete only when **all** of the following hold:

- The project compiles.
- The implementation is isolated to the phase's stated scope.
- The current architecture (§2) — or, if explicitly in scope, the target architecture (§3) — is preserved/advanced as intended, not accidentally diverged from.
- All Acceptance Criteria (§11) are satisfied.
- The Regression Checklist (§15) passes in full.
- The new functionality is independently testable without any later phase existing.

---

## 17. Every Additional Improvement Worth Naming

- **Truncation and self-heal must remain visible, not silently absorbed.** Per §2.4 item 2, a truncated IR can currently "pass" without asserting anything. Any new stage that touches IR generation, execution, or self-heal must explicitly consider `meta.truncated` and must not introduce a new way for a partial result to be reported as a full pass.
- **The two-hardcoded-demo-host credential special-case (§2.4 item 4) is a trap for future phases.** Any phase touching `credentials.ts` must explicitly check whether it interacts with the "Invalid password" taxonomy case on saucedemo.com / the-internet.herokuapp.com before considering itself done.
- **The LLM boundary is exactly two files** (`llm/gemini.ts`, `llm/groq.ts`). Any new stage that needs an LLM call must go through one of these, never call a model API directly from a `stages/*.ts` file.
- **Vision is for disambiguation only, never for invention**, in Discovery and in Failure Analysis alike. This is a cross-cutting invariant, not a Discovery-specific rule — restate it explicitly in any phase prompt that touches a vision-model call site.

---

## 18. Phase Prompt Template (Mandatory Structure for Every Phase Prompt)

Every independent implementation phase prompt for this project must be fully standalone and contain the following sections, in this order:

```markdown
# Phase N: <Name>

## Objective
<One paragraph, concrete, unambiguous.>

## Background
<Why this phase exists, how it fits §2/§3 of the spec.>

## Available Existing Components
<Explicit list, file paths + function/type names, that must be reused.>

## Dependencies
<What must already exist for this phase to be implementable. If missing, STOP and ask — do not implement the prerequisite silently.>

## Inputs
<Exact types/shapes.>

## Outputs
<Exact types/shapes.>

## Public API
<Exact exported signatures, e.g. `async function crawlSite(directive: CrawlDirective, context: BrowserContext): Promise<SiteGraph>`>

## Responsibilities
<What this phase's code owns.>

## Non-Responsibilities
<What it explicitly does not own — including any future-phase functionality it must NOT anticipate.>

## Constraints
<Schema shapes, existing call sites, performance/determinism requirements, etc.>

## Forbidden Implementations
<Project-wide list from §12, plus anything phase-specific.>

## Acceptance Criteria
<Concrete, checkable.>

## Manual Verification
<Exact steps/commands a human runs.>

## Regression Checklist
<Project-wide list from §15, plus anything phase-specific.>

## Definition of Done
<Exact conditions from §16, restated for this phase.>
```

Every phase prompt must additionally, explicitly state:

- **"Do NOT implement future phases."**
- **"If prerequisites are missing, ASK FIRST. Do NOT silently implement them."**

---

## Appendix: Document Maintenance

- If the actual codebase diverges from §2 (Current Architecture), §2 must be corrected in the same change that caused the divergence — this document must never describe a pipeline that no longer exists.
- If a phase moves any component from §3 (Target) into reality, move its row out of §3.2 and into §2.2, and note the change in this appendix.
- This document does not replace `README.md` (the practical run-it doc) or `PROJECT_OVERVIEW.md` (the "why" doc) — it is the engineering contract that governs *how future AI-assisted implementation work on this codebase must be conducted*. Where this document and `PROJECT_OVERVIEW.md` disagree on a factual description of current behavior, `PROJECT_OVERVIEW.md` and the actual code win, and this document must be corrected.

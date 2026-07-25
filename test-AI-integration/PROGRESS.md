# Project Progress

## Problem Statement

Manual QA testing is slow, repetitive, and error-prone. QA engineers spend hours writing test scripts, maintaining them as UIs change, and debugging flaky tests. The core problem:

> **How do we automatically convert a natural-language testing request into real, executed Playwright tests against a live website — with zero human scripting?**

Traditional test automation requires:
1. A human to manually inspect the UI and identify elements
2. A human to write test scripts (Playwright, Selenium, Cypress)
3. A human to maintain scripts as the UI evolves
4. A human to diagnose failures and determine root cause

This project eliminates steps 1–4 by using AI to understand the application, generate tests, execute them, and diagnose failures — all from a single sentence like "Test login with invalid password."

---

## Development Timeline

### Phase 0: Foundation (Completed)
**Goal:** Basic pipeline that converts a prompt + URL into an executed test.

| Component | Status | Description |
|-----------|--------|-------------|
| Planner | ✅ Done | LLM converts natural language into high-level test plan |
| Discovery | ✅ Done | Playwright + Gemini captures page structure via accessibility snapshot + vision |
| Test Cases | ✅ Done | LLM generates full coverage suite (valid/invalid/boundary/security) |
| IR Generation | ✅ Done | LLM converts test case into strict JSON test model |
| Generator | ✅ Done | Pure code converts IR → Playwright spec (zero LLM) |
| Executor | ✅ Done | Runs spec in real browser, captures artifacts |
| Failure Analysis | ✅ Done | Vision model diagnoses failures with screenshots |

**Output:** Single test case execution with screenshot + trace artifacts.

---

### Phase 1: Suite Executor (Completed)
**Goal:** Execute every generated test case, not just the primary one.

| Change | Status | Description |
|--------|--------|-------------|
| `PrimaryCaseResult` type | ✅ Done | Reuse primary case result in suite runner |
| `runSuite()` function | ✅ Done | Iterates all cases, executes each through full pipeline |
| Per-case artifacts | ✅ Done | `cases/case-N/` directories with IR, spec, result, diagnosis |
| Suite summary | ✅ Done | `07-suite-summary.json` with pass/fail/truncated counts |

**Output:** All 6–11 generated test cases execute with independent artifacts.

---

### Phase 2: Terminal Assertion Guard (Completed)
**Goal:** Prevent truncated tests from falsely passing.

| Change | Status | Description |
|--------|--------|-------------|
| `hasTerminalAssertion()` | ✅ Done | Checks if IR ends with an assert step |
| IR meta field | ✅ Done | `meta.hasTerminalAssertion` tracks assertion presence |
| Result override | ✅ Done | Truncated + no assertion → `truncated_no_assertion` status |

**Output:** Tests that verify nothing are marked as such, not falsely reported as passed.

---

### Phase 3: Auth Settle-Wait (Completed)
**Goal:** Fix SPA redirect race condition in live-extend.

| Change | Status | Description |
|--------|--------|-------------|
| `authSettle.ts` | ✅ Done | `isAuthTriggeringStep()` heuristic + `waitForAuthSettle()` bounded wait |
| Live-extend integration | ✅ Done | Wait after auth-triggering steps in `liveExtend.ts` |
| Generator inlining | ✅ Done | Generated specs include settle-wait helper |

**Output:** Login flows that trigger client-side redirects no longer race with page snapshot.

---

### Phase 4: Intent-Aware Credentials (Completed)
**Goal:** Stop credential substitution from overwriting deliberate negative test cases.

| Change | Status | Description |
|--------|--------|-------------|
| `category` field on TestCase | ✅ Done | Metadata to identify test intent |
| `shouldSkipCredentialSubstitution()` | ✅ Done | Protects "Invalid password" and similar categories |
| Demo host protection | ✅ Done | Taxonomy cases with wrong credentials are preserved |

**Output:** "Invalid password" tests actually test invalid passwords, even on demo hosts.

---

### Phase N: Intent-Scoped Test Case Generation (Completed)
**Goal:** Filter test cases by intent (smoke, full, security, etc.).

| Change | Status | Description |
|--------|--------|-------------|
| `scope` field on Category | ✅ Done | Each coverage category has a scope tag |
| `classifyScope()` | ✅ Done | Heuristic determines scope from prompt |
| `filterByScope()` | ✅ Done | Filters cases to match requested scope |
| Plan schema update | ✅ Done | `testTypeScope` field on Plan |
| Orchestrator filtering | ✅ Done | Cases filtered before suite execution |

**Output:** Prompt can request "smoke test" → only high-priority cases execute.

---

### Phase N: Primary-Case Dedup (Completed)
**Goal:** Prevent executing the same test case twice.

| Change | Status | Description |
|--------|--------|-------------|
| `PrimaryCaseResult` interface | ✅ Done | Carries primary case artifacts |
| `runSuite()` parameter | ✅ Done | Accepts optional `primaryResult` |
| Artifact reuse | ✅ Done | Primary case copies artifacts instead of re-running |

**Output:** Primary case runs once in main pipeline, reused in suite (no duplicate execution).

---

### Phase N: Multi-Page Input (Completed)
**Goal:** Accept multiple starting URLs for complex flows.

| Change | Status | Description |
|--------|--------|-------------|
| `urls` parameter | ✅ Done | `runPipeline()` accepts `url` or `urls` array |
| `discoverPages()` | ✅ Done | Discovery for multiple URLs |
| `targetUrl` on TestCase | ✅ Done | Each case specifies which page it targets |
| CLI/Server support | ✅ Done | `--urls` flag and POST body field |

**Output:** Can test flows spanning multiple entry points (e.g., login page + dashboard).

---

### Phase N: testTypeScope Sentinel Fix (Completed)
**Goal:** Remove the broken `"all"` sentinel value.

| Change | Status | Description |
|--------|--------|-------------|
| Remove `"all"` from ScopeFilter | ✅ Done | Type no longer includes invalid value |
| `ALL_SCOPES` constant | ✅ Done | `["smoke", "functional", "regression", "security"]` |
| Derived Plan enum | ✅ Done | `testTypeScope` enum derived from `ALL_SCOPES` |
| Fallback updates | ✅ Done | All hardcoded fallbacks use `ALL_SCOPES` |

**Output:** No more Zod validation errors from invalid scope values.

---

### Phase N: Deterministic Crawler (Completed)
**Goal:** Build infrastructure for full-site crawling (not yet wired in).

| Component | Status | Description |
|-----------|--------|-------------|
| SiteGraph schema | ✅ Done | `schema/siteGraph.ts` defines crawl output |
| `crawlSite()` function | ✅ Done | `stages/crawler.ts` implements BFS crawl |
| Test script | ✅ Done | `scripts/test-crawler.ts` for manual testing |

**Output:** Crawler exists but is **not integrated** into orchestrator (future work).

---

### Phase N: Reactive Coverage Generation (Completed)
**Goal:** Generate test cases for pages discovered during primary-case execution.

| Change | Status | Description |
|--------|--------|-------------|
| `generatedFrom` field | ✅ Done | `"upfront"` or `"reactive"` on TestCase |
| `IRResult` type | ✅ Done | `toIR()` returns `{ ir, updatedAppModel }` |
| `generateCasesForNewPages()` | ✅ Done | Creates cases for newly-discovered pages |
| Orchestrator wiring | ✅ Done | Detects new pages, generates cases, merges suite |
| `03-cases.json` persistence | ✅ Done | Overwritten with extended case list |

**Output:** When live-extend discovers new pages (e.g., after login), test cases are automatically generated for those pages and merged into the suite.

---

## Current Output Status

### What Passes ✅

| Scenario | Evidence | Notes |
|----------|----------|-------|
| Login with literal credentials | Verified against `the-internet.herokuapp.com`, `learnvibes.vercel.app` | Uses exact user-provided email/password |
| Homepage / smoke tests | Verified against `the-internet.herokuapp.com`, `thinkvibes.com` | "Verify homepage loads and key elements visible" |
| Multi-page flows via live-extend | Verified against `saucedemo.com` | Login → product page → add-to-cart across 2 extensions |
| Navigation / search / form validation | Original 5 templates, single-page | Still works on entry page |
| Discriminating success assertion | Verified via direct IR generation | Asserts login control disappears, not unseen page |
| Full suite execution (6–11 cases) | `07-suite-summary.json` with per-case status | Every case in `03-cases.json` executes |
| Terminal assertion guard | `truncated_no_assertion` status | Truncated tests without assertions marked correctly |
| Auth settle-wait | SPA redirect race fixed | Bounded wait after auth-triggering steps |
| Intent-aware credentials | "Invalid password" tests preserved | Category-based substitution skipping |
| Intent-scoped filtering | Smoke/functional/regression/security scopes | Prompt can request specific scope |
| Reactive coverage generation | New pages get test cases | Live-extend discoveries → auto-generated cases |

### What Partially Works ⚠️

| Scenario | Status | Known Issue |
|----------|--------|-------------|
| Self-healing broken locators | Mechanism verified at code level | No end-to-end test against real drifted site yet |
| Flows needing 3+ page-hops | Truncates after 2 extensions | `MAX_EXTENSIONS = 2` bound |
| Login gates without credentials | Fails if user didn't provide creds | Only demo sites have built-in credentials |

### What Fails / Is Known-Unreliable ❌

| Scenario | Status | Root Cause |
|----------|--------|------------|
| "Invalid password" on demo hosts | Overwrites wrong password | Credential substitution still fires for taxonomy cases |
| Assertion quality generally | Prompt nudge only, not deterministic | No code-level check rejects bad assertions |
| No server authentication | Anyone can start runs | No auth on `/api/runs` endpoint |
| Gemini model/key inconsistency | Different keys have different model access | `/v1beta/models` endpoint unreliable |

---

## Project State Summary

### Architecture
```
Prompt + URL
    → Planner (Gemini)
    → Discovery (Playwright + Gemini)
    → Test Cases (Gemini + Taxonomy)
    → Primary Case Selection
    → IR Generation (Groq) + Grounding + Live-Extend
    → Reactive Coverage Generation (new pages)
    → Playwright Generator (pure code)
    → Execution (Playwright)
    → Failure Analysis (Gemini + Vision)
    → Self-Heal (bounded, 1 attempt)
```

### Key Metrics
- **LLM calls per run:** ~8–12 (planner, discovery, test cases, IR ×1–3, failure analysis ×0–1)
- **Browser launches per run:** 1–4 (discovery + live-extend ×0–2 + execution)
- **Generated test cases:** 6–11 per run (valid/invalid/boundary/security)
- **Executed test cases:** All (6–11)
- **Self-heal attempts:** 0–1 (only for selector drift/missing element)
- **Artifacts per run:** ~20–30 files (JSON, spec, screenshot, trace)

### Codebase Stats
- **TypeScript files:** 30+
- **Key modules:** `orchestrator.ts`, `testCases.ts`, `ir.ts`, `liveExtend.ts`, `generator.ts`
- **Schema files:** `appModel.ts`, `ir.ts`, `siteGraph.ts`, `crawlDirective.ts`
- **LLM integrations:** Gemini (discovery, test cases, failure analysis), Groq (IR generation)

### What's Next (Prioritized)
1. **UI updates** for per-case results display
2. **Server authentication** for tunnel sharing
3. **Real-site credential handling** (env-var path)
4. **End-to-end self-heal verification** against drifted site
5. **Wire in deterministic crawler** for full-site coverage
6. **Multi-framework export** (Selenium/Cypress from same IR)

---

## File Reference

| File | Purpose |
|------|---------|
| `src/orchestrator.ts` | Wires all stages, manages primary case, suite execution |
| `src/stages/testCases.ts` | Generates coverage suite, reactive case generation |
| `src/stages/ir.ts` | IR generation with grounding + live-extend |
| `src/stages/liveExtend.ts` | Browser replay for new page discovery |
| `src/stages/suiteRunner.ts` | Executes all cases, manages per-case artifacts |
| `src/stages/generator.ts` | IR → Playwright spec (pure code) |
| `src/stages/executor.ts` | Runs spec, captures artifacts |
| `src/kb/testStrategy.ts` | Coverage taxonomy (floor, not ceiling) |
| `src/schema/appModel.ts` | AppModel zod schema |
| `src/schema/ir.ts` | IR zod schema (the contract) |
| `PROJECT_OVERVIEW.md` | Full architecture + design decisions |
| `AI-QA-Platform-Architecture-Engineering-Spec-v2.md` | Implementation contract for AI agents |
| `UPDATE.md` | Detailed changelog for recent phases |

# Today's Progress — July 24, 2026

## Changes Made

### 1. SPA State Change Fix (`ir.ts`)
**Problem:** When login → dashboard navigates to a known URL, `extendAppModel()` throws because the URL is already in the model, causing the IR to truncate and lose steps like "+ Add New" button.

**Fix:** Added fallback to `refreshPageModel()` when `extendAppModel()` fails with "already in the model" error. This re-snapshots the same page to capture dynamic content.

**Files:** `src/stages/ir.ts` (lines 6, 214-225)

### 2. Network Idle Wait (`discovery.ts`)
**Problem:** `domcontentloaded` + 1000ms fixed sleep wasn't waiting for SPA components to render, causing icons and dynamic elements to be missed in the ARIA snapshot.

**Fix:** Changed to `networkidle` with 15s timeout — waits for no network activity for 500ms, ensuring JavaScript-rendered UI elements exist before snapshotting.

**Files:** `src/stages/discovery.ts` (line 36)

### 3. Interactive Elements Discovery (`discovery.ts`)
**Problem:** Playwright's `ariaSnapshot()` captures the accessibility tree but misses icon-only buttons without ARIA labels, background CSS icons, and other non-accessible interactive elements.

**Fix:** Added `discoverInteractiveElements(page)` function that uses `page.evaluate()` to find all clickable elements via DOM traversal. Results are appended to the ARIA snapshot as an "Interactive elements found on page" section.

**Features:**
- Detects buttons, links, clickable divs, elements with onclick handlers
- Identifies elements with SVG/icon children (`[has-icon]`)
- Identifies elements without labels (`[no-label]`)
- Deduplicates by role + name + tag

**Files:** `src/stages/discovery.ts` (new function + modified `discover()`)

### 4. Live-Extend Interactive Elements (`liveExtend.ts`)
**Problem:** Dynamic pages discovered during live-extend also missed interactive elements.

**Fix:** Modified `replayAndSnapshot()` to call `discoverInteractiveElements()` and append to the combined snapshot before sending to LLM.

**Files:** `src/stages/liveExtend.ts` (lines 4, 63-68)

### 5. modelFromAria Prompt Update (`discovery.ts`)
**Problem:** The LLM prompt said "Never invent an element that isn't literally present in the snapshot" — but interactive elements detected via JavaScript weren't in the ARIA snapshot.

**Fix:** Updated prompt to explain the "Interactive elements found on page" section and how to use it. LLM now includes these real elements in its output.

**Files:** `src/stages/discovery.ts` (lines 78-106)

### 6. Generator Helper Bug Fix (`generator.ts`)
**Problem:** Line 101 used `${helpers}` (array) instead of `${helper}` (joined string). When both `locate()` and `waitForAuthSettle()` helpers were needed, the array `.toString()` inserted a comma between them, causing a SyntaxError in the generated Playwright spec.

**Fix:** Changed `${helpers}` to `${helper}` on line 101.

**Files:** `src/stages/generator.ts` (line 101)

### 7. "Generated undefined test case(s)" Fix (`app.js`)
**Problem:** The frontend displayed "Generated undefined test case(s)" because the `testcases` stage emits two different data shapes: an array (first emit) and an object `{ total, reactive }` (reactive emit). The second emit overwrites the first, and `data.length` is undefined on an object.

**Fix:** Updated `summarize()` to handle both formats: `data.total ?? data.length ?? 0`.

**Files:** `public/app.js` (line 73)

### 8. generatedFrom Schema Validation Fix (`testCases.ts`)
**Problem:** The LLM was returning values like "goal", "checklist", "Verify a user can..." for the `generatedFrom` field, causing repeated schema validation failures. The LLM doesn't know about this internal field — it's pipeline provenance, not LLM output.

**Fix:**
- Created `LLMTestCase` schema (same as `TestCase` but without `generatedFrom`)
- Parse LLM output against `LLMTestCase` (no `generatedFrom` field)
- Stamp `generatedFrom` in code immediately after parsing: `"upfront"` for upfront generation, `"reactive"` for reactive pages

**Files:** `src/stages/testCases.ts` (lines 80-88, 174-181)

### 9. Merge Conflict Resolution
Resolved unresolved git merge conflicts in:
- `src/orchestrator.ts` — kept PrimaryCaseResult + reactive coverage logic
- `src/stages/generator.ts` — kept cleaner helper detection logic
- `src/stages/ir.ts` — kept `testCase` parameter + IRResult return type
- `src/stages/suiteRunner.ts` — kept PrimaryCaseResult interface + primary case reuse logic

---

## Verification
- Typecheck: ✅ Passed (no errors)
- All merge conflict markers: ✅ Removed from source files
- Only remaining conflicts: markdown docs (PROJECT_OVERVIEW.md, AI-QA-Platform-Architecture...md) — no runtime impact

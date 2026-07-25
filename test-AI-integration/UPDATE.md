# Update Log

## Reactive Coverage Generation (Phase N)

### Date
July 24, 2026

### Summary
Implemented reactive test case generation for pages discovered during primary-case execution via `live-extend.ts`. Previously, when `toIR()` discovered new pages (e.g., after login), the test suite only contained cases for the original entry page. Now, new pages automatically get their own test cases generated and merged into the suite.

---

### Changes

#### 1. `src/stages/testCases.ts`

**New field on `TestCase` schema:**
```typescript
generatedFrom: z.enum(["upfront", "reactive"]).optional().default("upfront")
```
- Distinguishes cases generated before execution ("upfront") from those generated after discovering new pages ("reactive")
- All existing cases default to "upfront" for backward compatibility

**New function: `generateCasesForNewPages()`**
```typescript
export async function generateCasesForNewPages(
  updatedAppModel: AppModel,
  originalPageUrls: string[],
  plan: Plan,
  prompt: string
): Promise<TestCase[]>
```
- Filters the updated AppModel to only include pages NOT in the original URL set
- Calls `toTestCases()` with the filtered model
- Tags all generated cases with `generatedFrom: "reactive"`

---

#### 2. `src/stages/ir.ts`

**New return type: `IRResult`**
```typescript
export interface IRResult {
  ir: IR;
  updatedAppModel: AppModel;
}
```

**Modified `toIR()` signature:**
```typescript
export async function toIR(
  testCase: TestCase, appModel: AppModel, sourcePrompt: string, entryUrl: string
): Promise<IRResult>  // was: Promise<IR>
```
- Returns both the IR and the updated AppModel after live-extension
- Allows orchestrator to see what pages were discovered during grounding
- All return statements updated to include `updatedAppModel: currentModel`

---

#### 3. `src/orchestrator.ts`

**Updated imports:**
```typescript
import { toTestCases, generateCasesForNewPages } from "./stages/testCases.js";
```

**Updated primary IR generation:**
```typescript
const { ir, updatedAppModel } = await step("ir", "04-ir.json", () => 
  toIR(primary, appModel, prompt, resolvedUrls[0])
);
```

**New reactive coverage step (after primary execution):**
```typescript
const originalUrlsSet = new Set(resolvedUrls);
const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));

let allCases = [...cases];
if (newPages.length > 0) {
  emit("testcases", "started", { newPages: newPages.map(p => p.url) });
  const reactiveCases = await generateCasesForNewPages(
    updatedAppModel, resolvedUrls, thePlan, prompt
  );
  if (reactiveCases.length > 0) {
    allCases = [...allCases, ...reactiveCases];
    save("03-cases.json", allCases);  // Persist updated cases
    emit("testcases", "completed", { total: allCases.length, reactive: reactiveCases.length });
  }
}
```

**Updated heal path:**
```typescript
const { ir: healedIr } = await toIR(primary, freshModel, prompt, resolvedUrls[0]);
```

---

#### 4. `src/stages/suiteRunner.ts`

**Updated non-primary case execution:**
```typescript
const { ir } = await toIR(tc, appModel, sourcePrompt, entryUrl);
```
- Destructures the `IRResult` to get just the IR for suite execution

---

#### 5. `README.md`

**Architecture diagram updated:**
```
  → Reactive coverage generation     → generate cases for newly-discovered pages (if any)
```

**Architecture notes updated:**
- Added description of `generateCasesForNewPages()` function
- Explained `generatedFrom: "reactive"` tagging

**Phase 2+ section updated:**
- Noted that reactive coverage generation is now implemented
- Clarified that full suite execution is still a Phase 2+ item

---

### How It Works

1. **Primary case executes** → `toIR()` may call `extendAppModel()` to discover new pages
2. **Orchestrator receives `updatedAppModel`** with any newly-discovered pages
3. **Compare page URLs** → detect new pages not in original `urls` array
4. **Generate cases for new pages** → `generateCasesForNewPages()` creates test cases tagged as "reactive"
5. **Merge into suite** → reactive cases appended to upfront cases
6. **Persist updated `03-cases.json`** → includes both upfront and reactive cases
7. **Re-apply scope filter** → final suite passed to `runSuite()`

---

### Example Flow

**Input:**
- `urls: ["https://example.com/login"]`
- Prompt: "Log in and buy a product"

**Execution:**
1. Discovery generates AppModel for `/login`
2. `toTestCases()` generates cases for login page (upfront)
3. Primary case executes login, `live-extend` discovers `/products` and `/cart`
4. `toIR()` returns `updatedAppModel` with 3 pages
5. Orchestrator detects 2 new pages (`/products`, `/cart`)
6. `generateCasesForNewPages()` creates cases for product browsing and cart operations
7. Suite now includes: 5 upfront cases + 3 reactive cases = 8 total cases

---

### Backward Compatibility

- `generatedFrom` defaults to `"upfront"` if not specified
- Existing `03-cases.json` files without the field are still valid
- `runSuite()` doesn't use the field (execution logic unchanged)
- All TypeScript compilation checks pass

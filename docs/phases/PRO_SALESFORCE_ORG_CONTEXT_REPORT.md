# Pro on Salesforce: the test writer now sees the org scan (TD-180)

*2026-11-02 · branch `pro/salesforce-org-context` (from `cleanup/production-ready`) · records:
`TECH_DEBT.md` TD-180, `DECISIONS.md` D-53*

## In one paragraph

When you upload a requirements document (Pro) and run against a Salesforce org, the AI that writes
the test cases was given your request, the pages found by browsing, and your document, but **not**
the org scan (objects, required fields, picklist values, record types, validation rules) and **not**
the screen map (which field sits on which screen of a multi-screen form). A normal run without a
document always got both. So with Pro on, the AI had to guess real field names and values. It now
gets the same org scan and screen map a normal run gets, placed in the same spot.

## Why it was broken

Pro's test writer (`src/stages/proTestCases.ts`) was built as a **copy** of the normal one
(`src/stages/testCases.ts`), on purpose, so Pro changes can never break normal runs (D-53).
Afterwards, the normal writer gained the screen map (TD-137) and the org scan (D-63). Nobody added
them to the copy, and no test checked a Pro run on Salesforce, so the gap went unnoticed.

One detail made it worse: the page summary sent to the AI deliberately removes the org scan
(`toLiteModel`), because the writer is expected to add it back as its own section. The normal writer
does that; the copy never did. The org scan, which takes about 8 minutes to make, was simply never
used by Pro.

## What changed

**`src/stages/proTestCases.ts`** (about 20 lines):

1. Three imports: `currentRunTargetApp`, `orgModelForCases`, and the screen-map helpers.
2. Before the AI message is built, the two sections are created with **the exact same calls** the
   normal writer uses, and only on a Salesforce run:
   ```ts
   const isSalesforce = currentRunTargetApp() === "salesforce";
   const screensBlock = isSalesforce && screenMapEnabled()
     ? screensForCases(loadScreenMap(appModel.baseUrl, undefined, new Date())) : "";
   const orgBlock = isSalesforce ? orgModelForCases(appModel.salesforceOrg) : "";
   ```
3. They go into the message right after the page summary, where the normal writer puts them:
   ```
   Application model: {...pages...}<screens block><org block>
   Coverage checklist floor ...
   Requirements specification (your document) ...
   ```
4. They also join the **cache key** (the fingerprint used to reuse a saved AI answer), in the same
   position as in the normal writer's key and before the document. Without this, an answer saved
   before the fix (made without the org scan) could be reused forever, since the cache never expires
   (TD-22).

**`tests/proTestCases.test.ts`**: four new tests.

| Test | What it proves |
|---|---|
| The prompt holds the org block and the screens block | A Pro Salesforce message contains "required on create: Company", the picklist values and the screen map, in the right order, and **byte-for-byte the same** sections as the normal writer's |
| Key parity on Salesforce | The Pro key is the normal key (13 parts on Salesforce) plus the document |
| A different org scan changes the key | A saved answer from a run without the scan is never reused |
| Non-Salesforce Pro run unchanged | No org or screen section, and the same 12-part key as before |

The first three **fail on the old code** (checked by reverting the fix), so they really test the bug.

## What did not change

- **Normal (non-Pro) runs:** `testCases.ts` was not touched. `tests/testCasesNoChange.test.ts` still
  passes, and it checks the normal prompt and key byte-for-byte.
- **Pro runs on ordinary websites:** both sections are empty there, so the message and key are
  exactly as before (pinned by the fourth test).
- **No new setting or flag.** This is a fix inside Pro, which already sits behind
  `SPEC_INTAKE_ENABLED` (off by default). It only affects runs where Pro is on **and** the run is a
  Salesforce one. The screen map additionally needs `SCREEN_MAP_ENABLED`, exactly as on normal runs.
- **No route, UI or schema change.**

## Deliberately not fixed (next step, if wanted)

The normal writer also tidies the AI's answer on Salesforce runs: it puts back your exact control
names (`restoreControlNames`), re-adds values the AI dropped (`restoreDroppedValues`), and drops cases
about other objects or unrequested checklist features (`dropOffObjectCases`,
`dropUnrequestedChecklistCases`). Pro still does **not** do this. All four look only at the text you
**typed**. On a Pro run most of what you ask comes from the document, so they would throw away good
cases, for example a test on an object only the document mentions. Doing it properly means also
feeding them the document's confirmed `entities` list. That is a separate change.

The two writers are still copies (D-53). Anything added to one in future can drift again; the new
Salesforce parity test now covers these two sections.

## Verification

| Check | Before | After |
|---|---|---|
| `npx tsc --noEmit` | clean | clean |
| `npx vitest run` | 2818 passed, 3 failed, 23 skipped (211 files) | **2822 passed**, 3 failed, 23 skipped (211 files) |

The 3 failures are the same before and after, all browser tests unrelated to this change:
`negativeCaseCredentials`, `safeClickBrowser` (needs internet), `targetlessPress`. This cloud container
needed a local link so Playwright 1.49 could find its browser (container only, not in the repo).

**Not done:** a real Pro run against a live org. It costs one Azure case-generation call plus the
browser run. How to check it yourself after deploying:
1. Tick the Salesforce option, connect the org (scan saved), turn Pro on, upload a document.
2. In the server log, `[proTestCases] prompt chars:` should be noticeably larger than before for the
   same run, since the org scan is now included (up to about 9000 characters).
3. The cases should use the org's real field labels and picklist values.

## How to roll back

Revert the commit. It touches only `src/stages/proTestCases.ts`, its test file, and three docs.
Nothing is stored differently, so no data needs cleaning. Cached Pro Salesforce answers made with the
fix will simply stop matching, and the old behaviour returns.

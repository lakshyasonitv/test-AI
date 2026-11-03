# Pro: the story becomes the run's request (PRO_STORY_PROMPT, TD-181, D-73)

*2026-11-03 · branch `pro/salesforce-org-context` · NOT committed (waiting for the user's go-ahead)*

## In one paragraph

With a requirements story uploaded (Pro), a prompt like "give test cases according to the story"
produced tests about whatever pages exploration wandered into. The planner, page exploration, the
Primary test and the Salesforce filters all read only the **typed** prompt; the story reached only
the very last step. Now, behind `PRO_STORY_PROMPT`: (1) after **Continue**, an empty prompt box is
filled with a plain request built from the story, so every stage reads it; (2) the planner also
reads the story on a Pro run, as a safety net when the box is vague or emptied.

## What the user sees

| Prompt box before Continue | After Continue |
|---|---|
| Empty | Filled from the story, plus the note *"The prompt box was filled from your requirements. Check it, then Run."* |
| Text you typed | **Kept.** Note: *"Your typed prompt is kept…"* and a **Use the requirements as the prompt** button |
| Our own earlier fill (you edited rules and pressed Continue again) | Refilled with the new version |
| Setting off | Nothing changes |

Example fills (one line, at most 160 characters):
```
Test the uploaded requirements on Account: Create a new Account from the Accounts tab (2 checks)
Test the uploaded requirements on Case and Work Order: Create reports on the Case object including survey fields (+5 more, 10 checks)
```
The first version filled the box with the whole story (about 2,000 characters for the Case story), which
made the run screen's title a wall of text. It is one line now: the full story already reaches the
planner and the case writer directly, so the box only needs to name the flow and the objects.

## What changed

| File | Change |
|---|---|
| `src/stages/storyPrompt.ts` (new) | `proStoryPromptEnabled()`; `storyPromptText(spec)`: the one-line prompt-box text (no AI call, never the open questions or answers, max 160 characters; the action is shortened first so the objects and counts always show); `storyPlanBlock(spec)`: the block the planner reads |
| `src/server/index.ts` | `POST /api/spec/confirm` returns an **optional** `promptText` when the setting is on (rule 1: existing routes only gain optional fields). `PRO_STORY_PROMPT` registered as a true/false setting |
| `src/stages/planner.ts` | Optional 4th argument `story`. When given: the block goes into the message **and** the cache key. Without it: message and key byte-identical to before |
| `src/orchestrator.ts` | Passes the run's spec to the planner only when the setting is on and the run has a spec |
| `public/app.js` | After Continue: fill or offer, using existing CSS classes only (`field-label`, `composer-save-btn`). Edit / new upload clears the note |
| `.env.example`, `README.md`, `ARCHITECTURE.md` | Setting documented; new file listed |
| `TECH_DEBT.md` TD-181, `DECISIONS.md` D-73 | The defect and the reasoning |

## Why it was built this way

- **Fill the box rather than rewire four stages.** One change upgrades the planner, exploration, the
  Primary test and the Salesforce filters together, and you can read and edit the request before paying
  for a run. Jira already fills the box the same way.
- **The server builds the text.** It's deterministic and testable, and with the setting off the response
  is unchanged, so the browser does nothing.
- **Never overwrite what you typed.** Replacing someone's prompt silently would be the tool deciding what
  they meant.
- **The planner reads it too.** That covers a box that was emptied, or a vague "test as per the story".
- **The story is in the planner's cache key**, so a plan saved without the story is never reused (TD-22).

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **2841 passed**, 3 failed, 23 skipped, 212 files (was 2822 / same 3 failed / 211 files). The 3 failures are browser tests that were already failing: `negativeCaseCredentials`, `safeClickBrowser`, `targetlessPress` |
| New tests | `tests/proStoryPrompt.test.ts` (12), plus 2 in `specRoutes.test.ts` and 3 in `proOrchestrator.test.ts`. Every setting-on test fails with the change reverted |
| Real browser | Server run locally with the settings on; only the upload's AI answer faked, the confirm route real. Empty box → filled; typed prompt → kept + button; button → filled; setting off → nothing; no page errors |

**Not done:** a real run against your org (costs AI calls). To check it yourself: set
`SPEC_INTAKE_ENABLED=true` and `PRO_STORY_PROMPT=true`, restart, upload a story with an empty prompt
box, press Continue, then check that `runs/<id>/01-plan.json` describes the story's flow.

## Deliberately not done

- **Exploration still doesn't hunt for the story's pages directly.** It is steered only through the prompt
  text. A Case list view or report the prompt doesn't lead to can still go unexplored (improvement #4).
- **A typed prompt that contradicts the story** is kept. The planner reads both, and the button is there
  to switch.
- **The Salesforce clean-up steps are still not applied to Pro (TD-180).** They do now read the filled
  prompt, which names the story's objects.

## How to roll back

Set `PRO_STORY_PROMPT=false` (the default) for an immediate rollback with no deploy. To remove the code,
revert the commit. Nothing is stored differently; cached plans made with a story simply stop matching.

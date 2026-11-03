import type { SpecModel } from "../schema/spec.js";

/**
 * Pro story -> request (PRO_STORY_PROMPT, default off; needs SPEC_INTAKE_ENABLED).
 *
 * THE PROBLEM THIS SOLVES. A Pro run's uploaded story reached only the case generator. Every stage
 * before it — the planner, site discovery (which takes the typed prompt), the "primary" case (the
 * literal translation of the typed request), and the Salesforce request filters — reads the TYPED
 * prompt only. A prompt like "give test cases according to the story" therefore planned and
 * explored nothing in particular, and the suite came back about whatever discovery wandered into.
 *
 * TWO REMEDIES, both built from the user's CONFIRMED spec (structured fields the user reviewed,
 * not model prose), both deterministic and free (no model call here):
 *
 *   1. `storyPromptText` — a plain request the browser puts in the prompt box after Continue, so
 *      the whole run reads it like a prompt the user typed. Returned by POST /api/spec/confirm as
 *      the OPTIONAL `promptText` field. The browser never overwrites text the user typed.
 *   2. `storyPlanBlock` — the same facts appended to the PLANNER's message on a Pro run, so a vague
 *      or emptied prompt box still yields a plan about the story.
 */

export function proStoryPromptEnabled(): boolean {
  return process.env.PRO_STORY_PROMPT === "true";
}

/**
 * The prompt-box text is ONE short line. The full story already reaches the planner
 * (`storyPlanBlock`) and the case generator (`proTestCases`) directly, so the box only needs to
 * name the main action and objects — for discovery and the Salesforce request filters, which read
 * the typed prompt — and it stays readable as the run's title and the report's "You asked".
 */
export const STORY_PROMPT_MAX_CHARS = 160;

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * The prompt-box text for a confirmed spec, or "" when the spec names nothing to test (no actions,
 * criteria or rules) — the browser then leaves the box alone. Shape:
 *   "Test the uploaded requirements on Case and Report: <first action> (+5 more, 10 checks)"
 * Never the open questions or the user's answers.
 */
export function storyPromptText(spec: SpecModel): string {
  const actions = unique(spec.actions);
  const checks = unique([...spec.criteria, ...spec.rules]);
  if (!actions.length && !checks.length) return "";
  const entities = unique(spec.entities).slice(0, 2).map((e) => clip(e, 24));
  const on = entities.length ? ` on ${entities.join(" and ")}` : "";
  const counts: string[] = [];
  if (actions.length) {
    if (actions.length > 1) counts.push(`+${actions.length - 1} more`);
    if (checks.length) counts.push(`${checks.length} check${checks.length === 1 ? "" : "s"}`);
  } else if (checks.length > 1) {
    counts.push(`+${checks.length - 1} more check${checks.length === 2 ? "" : "s"}`);
  }
  const head = `Test the uploaded requirements${on}: `;
  const tail = counts.length ? ` (${counts.join(", ")})` : "";
  // The first action names the flow (with no actions, the first check does). It is the part that
  // gets shortened, so the objects and the counts always survive and the line stays under the cap.
  const first = clip(actions[0] ?? checks[0], Math.min(80, STORY_PROMPT_MAX_CHARS - head.length - tail.length));
  return head + first + tail;
}

/**
 * The block appended to the planner's user message on a Pro run. Lists only, never the answers or
 * open questions: the planner picks the flow to test, the case generator handles the detail.
 */
export function storyPlanBlock(spec: SpecModel): string {
  const list = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((i) => `  - ${i}`).join("\n")}\n` : "";
  const body =
    list("Who:", unique(spec.actors)) +
    list("What they want to do:", unique(spec.actions)) +
    list("Objects involved:", unique(spec.entities)) +
    list("Acceptance criteria:", unique(spec.criteria)) +
    list("Rules:", unique(spec.rules)) +
    list("Out of scope — do NOT plan these:", unique(spec.outOfScope));
  if (!body) return "";
  return `
The user also uploaded and confirmed this requirements story. Plan the story's main flow. If the
request above only points at the story (for example "test as per the story") or is vague, plan
entirely from the story. Stay on what the story covers.
${body}`;
}

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

/** The prompt box text is capped like the Jira fill (JIRA_MAX_PROMPT_CHARS default). */
export const STORY_PROMPT_MAX_CHARS = 4000;

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/**
 * The prompt-box text for a confirmed spec, or "" when the spec names nothing to test (no actions,
 * criteria or rules) — the browser then leaves the box alone.
 */
export function storyPromptText(spec: SpecModel): string {
  const actions = unique(spec.actions);
  const checks = unique([...spec.criteria, ...spec.rules]);
  if (!actions.length && !checks.length) return "";
  const lines: string[] = ["Test the requirements from the uploaded document."];
  const actors = unique(spec.actors);
  if (actors.length) lines.push(`As: ${actors.join(", ")}`);
  if (actions.length) lines.push(`Do: ${actions.join("; ")}`);
  const entities = unique(spec.entities);
  if (entities.length) lines.push(`On: ${entities.join(", ")}`);
  if (checks.length) lines.push("Check:", ...checks.map((c) => `- ${c}`));
  const out = unique(spec.outOfScope);
  if (out.length) lines.push(`Do not test: ${out.join("; ")}`);
  const text = lines.join("\n");
  if (text.length <= STORY_PROMPT_MAX_CHARS) return text;
  // Cut at a line boundary so no check is left half-written.
  const cut = text.slice(0, STORY_PROMPT_MAX_CHARS);
  return cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0)).trimEnd();
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

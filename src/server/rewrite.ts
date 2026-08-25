import { gemini } from "../llm/gemini.js";
import { LlmBudget, enterWithBudget } from "../llm/llmBudget.js";
import { IR, type Step } from "../schema/ir.js";
import { formatIrStep } from "../stages/stepText.js";
import { AccessError } from "./authz.js";

/**
 * "Ask for a change" — turn a plain-English instruction into a PROPOSED edit.
 *
 * The one hard rule: **this never saves.** It returns a proposal the user approves or rejects in
 * the editor, and approving it goes back through the ordinary edit path — parse, re-ground, then
 * write. A model that could write straight to the library would be a model authoring tests nobody
 * reviewed, against a site it has not looked at since the case was created.
 *
 * It also returns only STEP TEXT, not IR. The model proposes sentences in exactly the vocabulary
 * `stepText.ts` renders and parses; those sentences then travel the same route a hand-typed edit
 * does. So there is one parser, one grounder, and one validation path regardless of who wrote the
 * words — a model that emitted IR directly would be a second way into the library with different
 * guarantees.
 */

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 20;
const attemptsByUser = new Map<string, number[]>();

/**
 * Per-user allowance for rewrite requests. Counts *attempts*, not successes — a failed or
 * unparseable proposal still spent a Gemini call, so it has to count against the ceiling too.
 * Keyed by user rather than IP: this route is authenticated, so the account is the real actor and
 * one office behind a single NAT address should not share one budget.
 */
export function consumeRewriteAttempt(userId: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  for (const [key, times] of attemptsByUser) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) attemptsByUser.delete(key);
    else attemptsByUser.set(key, live);
  }
  const recent = (attemptsByUser.get(userId) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  attemptsByUser.set(userId, recent);
  return recent.length <= RATE_MAX_ATTEMPTS;
}

/** Test seam — the limiter is module state, and cases must not inherit each other's counters. */
export function resetRewriteRateLimit(): void {
  attemptsByUser.clear();
}

export interface RewriteProposal {
  /** The proposed step sentences, in the same vocabulary the editor shows. */
  steps: string[];
  /** The steps as they stand now, so the editor can diff without re-deriving them. */
  before: string[];
  /** What the model says it did — shown above the diff, never trusted as a description of safety. */
  note: string;
  usage: ReturnType<LlmBudget["snapshot"]>;
}

const VOCABULARY = [
  `Go to /path`,
  `Click on button "Name"`,
  `Type "value" into textbox "Name"`,
  `Choose "option" from combobox "Name"`,
  `Check checkbox "Name"`,
  `Press the Enter key`,
  `Wait briefly`,
  `Check that button "Name" appears on the page`,
  `Check that button "Name" is not shown`,
  `Check that the text "some words" is displayed`,
  `Check the page address contains "/path"`,
].join("\n");

function buildPrompt(title: string, current: string[], instruction: string): string {
  return [
    `You are editing an automated browser test called "${title}".`,
    ``,
    `Its steps, one per line, numbered:`,
    ...current.map((s, i) => `${i + 1}. ${s}`),
    ``,
    `The person testing this app asked for the following change:`,
    instruction,
    ``,
    `Rewrite the FULL step list with that change applied.`,
    ``,
    `RULES`,
    `- Use ONLY these sentence shapes, exactly:`,
    VOCABULARY,
    `- Keep every step that the request does not affect, worded EXACTLY as it is above. Do not`,
    `  reword, re-order or "improve" steps the request did not ask about — an unchanged line is`,
    `  free to save, and a reworded one costs a browser check for no reason.`,
    `- Refer to elements by their accessibility role and name, in double quotes, copying the`,
    `  wording from the existing steps wherever the same element is meant.`,
    `- Never invent a CSS selector, an id, or an element you have no evidence exists.`,
    `- Leave any \${env:...} placeholder exactly as written. It is a credential reference, and`,
    `  resolving it to a real value would write a secret into the test.`,
    ``,
    `Reply with JSON only, no markdown fence:`,
    `{"steps":["...","..."],"note":"one short sentence on what you changed"}`,
  ].join("\n");
}

function extractJson(raw: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AccessError(502, "the model did not return a usable proposal — try rephrasing the request");
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new AccessError(502, "the model's proposal was not valid JSON — try rephrasing the request");
  }
}

/**
 * Ask the model for a revised step list. Returns a proposal; writes nothing.
 *
 * Budgeted through the same `LlmBudget` every other stage uses, so a rewrite is metered the same
 * way an IR compilation is and the caller can show what it cost.
 */
export async function proposeRewrite(
  ir: IR, instruction: string,
): Promise<RewriteProposal> {
  const trimmed = String(instruction ?? "").trim();
  if (!trimmed) throw new AccessError(400, "say what you would like changed");
  if (trimmed.length > 2000) throw new AccessError(400, "that instruction is too long — keep it under 2000 characters");

  const budget = new LlmBudget();
  enterWithBudget(budget);

  const before = ir.steps.map((s: Step) => formatIrStep(s));
  const { content } = await gemini(buildPrompt(ir.meta.title, before, trimmed), {
    model: process.env.GEMINI_MODEL,
    stage: "rewrite",
  });

  const parsed = extractJson(content);
  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
    : [];
  if (steps.length === 0) {
    throw new AccessError(502, "the model returned no steps — try rephrasing the request");
  }

  return {
    steps,
    before,
    note: typeof parsed?.note === "string" ? parsed.note.trim() : "",
    usage: budget.snapshot(),
  };
}

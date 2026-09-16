import { llm } from "../llm/client.js";
import { LlmBudget, enterWithBudget } from "../llm/llmBudget.js";
import { IR, type Step } from "../schema/ir.js";
import { STEP_VOCABULARY, formatIrStep, parseIrStep } from "../stages/stepText.js";
import { caseElementContext } from "../stages/caseEdit.js";
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
  /**
   * Lines the save path's own parser cannot read. Additive and optional in practice — an existing
   * client that ignores it sees exactly what it saw before, and the diff still renders. TD-91.
   */
  unreadableIndexes?: number[];
  usage: ReturnType<LlmBudget["snapshot"]>;
}

/** The one list, owned by the parser that defines it — never a second copy in a prompt file. */
const VOCABULARY = STEP_VOCABULARY.join("\n");

function buildPrompt(
  title: string, current: string[], instruction: string, elements: string[],
): string {
  return [
    `You are editing an automated browser test called "${title}".`,
    ``,
    `Its steps, one per line, numbered:`,
    ...current.map((s, i) => `${i + 1}. ${s}`),
    ``,
    // Without this the model is guessing at element names from the instruction's wording alone.
    // Asked to "navigate to the admin panel" it answered `Click on button "Admin Panel"` — the
    // page HEADING — when the real control is `button "Admin"`. It had no way to know. TD-91.
    ...(elements.length
      ? [
        `These are the controls that actually exist on the pages this test touches. When the`,
        `change needs an element, use one of these EXACTLY as written — role and name:`,
        ...elements,
        ``,
      ]
      : []),
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
  ir: IR, instruction: string, sourceRunId: string | null = null,
): Promise<RewriteProposal> {
  const trimmed = String(instruction ?? "").trim();
  if (!trimmed) throw new AccessError(400, "say what you would like changed");
  if (trimmed.length > 2000) throw new AccessError(400, "that instruction is too long — keep it under 2000 characters");

  const budget = new LlmBudget();
  enterWithBudget(budget);

  const before = ir.steps.map((s: Step) => formatIrStep(s));
  const context = caseElementContext(ir, sourceRunId);
  const { content } = await llm(buildPrompt(ir.meta.title, before, trimmed, context.lines), {
    role: "main",
    stage: "rewrite",
  });

  const parsed = extractJson(content);
  const steps = Array.isArray(parsed?.steps)
    ? parsed.steps.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
    : [];
  if (steps.length === 0) {
    throw new AccessError(502, "the model returned no steps — try rephrasing the request");
  }

  // Every proposed line must satisfy the SAME parser the save path uses — the check
  // `proposeStepTranslation` has always done and this path never did, so an unreadable suggestion
  // was shown as a clean diff and only failed when the person pressed Save. Flagged rather than
  // rejected: a rewrite touches the whole list, so one bad line should not discard the rest.
  // TD-91.
  const unreadableIndexes: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!parseIrStep(steps[i], ir.steps[i]).ok) unreadableIndexes.push(i);
  }

  const provenance =
    context.source === "run" ? ""
      : context.source === "walks"
        ? " (element names taken from earlier verification snapshots of this site)"
        : " (no page snapshot was available, so element names are unverified)";

  return {
    steps,
    before,
    unreadableIndexes,
    note: (typeof parsed?.note === "string" ? parsed.note.trim() : "") + provenance,
    usage: budget.snapshot(),
  };
}

// ---------------------------------------------------------------------------
// Free-text steps — "write it however you like, we'll say it properly"
// ---------------------------------------------------------------------------

/**
 * Translate loosely-written step lines into the vocabulary `parseIrStep` accepts.
 *
 * This is the sibling of `proposeRewrite`, and it obeys the same two rules for the same reasons:
 * **it never saves**, and **it returns step TEXT, not IR**. Approving a translation puts the
 * sentences in the editor; saving them travels the ordinary parse → re-ground → version route. A
 * translator that wrote IR would be a second way into the library with different guarantees, and
 * one that saved directly would be a model authoring tests nobody read.
 *
 * What it adds over the rewrite path is the trigger. `proposeRewrite` answers "change something
 * about this test"; this answers "I typed `click the login button` and the parser said no." The
 * user is not asking for a different test — they are asking for the same test, spelled the way the
 * parser understands.
 *
 * THE SAFETY PROPERTY, and the reason this can be trusted at all: every line the model returns is
 * run back through `parseIrStep` HERE, before the proposal is shown. A sentence the parser cannot
 * read never reaches the editor. So the model cannot widen the accepted grammar, cannot smuggle in
 * a selector, and cannot invent a shape the save path would later choke on — the worst it can do
 * is fail, and failing costs one call and no writes.
 *
 * LINE-FOR-LINE, deliberately. The model may not add, remove or reorder rows. Two things depend on
 * that: `parseIrSteps` matches drafts to their originals POSITIONALLY (so a silently inserted row
 * would re-point every step after it at the wrong base and mark the whole tail for re-grounding),
 * and a person reviewing a diff can only check a translation they can line up. Restructuring the
 * test is what "Ask for a change" is for.
 */
export interface TranslationProposal {
  /** The full list, with only the unreadable rows replaced. */
  steps: string[];
  /** The drafts as typed, so the editor can diff without re-deriving them. */
  before: string[];
  /** Indices that were actually rewritten — everything else is byte-identical to `before`. */
  translatedIndexes: number[];
  note: string;
  usage: ReturnType<LlmBudget["snapshot"]>;
}

function buildTranslatePrompt(title: string, drafts: string[], unreadable: number[]): string {
  const marked = drafts.map((s, i) => `${i + 1}. ${unreadable.includes(i) ? "[REWRITE] " : "[KEEP] "}${s}`);
  return [
    `You are tidying up the wording of an automated browser test called "${title}".`,
    ``,
    `Here are its steps, one per line, numbered. Lines marked [REWRITE] were typed loosely and`,
    `the test tool cannot read them. Lines marked [KEEP] are already correct.`,
    ...marked,
    ``,
    `Rewrite ONLY the [REWRITE] lines so they say the same thing in the tool's vocabulary.`,
    ``,
    `RULES`,
    `- Use ONLY these sentence shapes, exactly:`,
    VOCABULARY,
    `- Return EVERY line, in the SAME ORDER, exactly ${drafts.length} of them. Do not add a step,`,
    `  remove a step, merge two into one, or split one into two. If a loose line describes two`,
    `  actions, express the main one — the person can add the other themselves.`,
    `- Reproduce every [KEEP] line CHARACTER FOR CHARACTER. Do not reword or "improve" them.`,
    `- Refer to elements by their accessibility role and name in double quotes. Where the loose`,
    `  wording names an element that also appears in a [KEEP] line, copy that line's exact wording`,
    `  for it, so both steps point at the same thing.`,
    `- Never invent a CSS selector, an id, or an element you have no evidence exists. If the loose`,
    `  wording does not say which element it means, guess the most ordinary role ("button" for`,
    `  something clicked, "textbox" for something typed into) and keep the person's own words as`,
    `  the name.`,
    `- Leave any \${env:...} placeholder exactly as written. It is a credential reference, and`,
    `  resolving it to a real value would write a secret into the test.`,
    ``,
    `Reply with JSON only, no markdown fence:`,
    `{"steps":["...","..."],"note":"one short sentence on what you interpreted"}`,
  ].join("\n");
}

/**
 * Which draft lines the parser cannot read.
 *
 * Uses the REAL parser, positionally against the stored steps, exactly as the save path will. No
 * heuristic "does it look like a step" check — a second opinion about what is valid is the drift
 * this module exists to avoid.
 */
export function unreadableDraftIndexes(drafts: string[], originals: Step[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (!parseIrStep(drafts[i], originals[i]).ok) out.push(i);
  }
  return out;
}

export async function proposeStepTranslation(ir: IR, drafts: unknown): Promise<TranslationProposal> {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    throw new AccessError(400, "there are no steps to translate");
  }
  if (drafts.length > 200) {
    throw new AccessError(400, "that is too many steps to translate at once");
  }
  const lines = drafts.map((s) => String(s ?? "").trim());
  if (lines.some((s) => s.length > 500)) {
    throw new AccessError(400, "a step line is too long — keep each one under 500 characters");
  }

  const unreadable = unreadableDraftIndexes(lines, ir.steps);
  if (unreadable.length === 0) {
    throw new AccessError(400, "every line already reads correctly — there is nothing to translate");
  }

  const budget = new LlmBudget();
  enterWithBudget(budget);

  const { content } = await llm(buildTranslatePrompt(ir.meta.title, lines, unreadable), {
    role: "main",
    stage: "translate",
  });

  const parsed = extractJson(content);
  const proposed: string[] = Array.isArray(parsed?.steps)
    ? parsed.steps.map((s: unknown) => String(s ?? "").trim())
    : [];

  // Line-for-line or nothing. A model that dropped or invented a row would silently re-base every
  // step after it, so this is a hard failure rather than something to reconcile.
  if (proposed.length !== lines.length) {
    throw new AccessError(
      502,
      `the model returned ${proposed.length} steps for ${lines.length} lines — try rewording the ` +
        `line it could not read, or use "Ask for a change" if you meant to restructure the test`,
    );
  }

  // Readable lines are restored from the draft, not taken from the model. Cheaper than trusting
  // the [KEEP] instruction and it removes a whole class of surprise: a line the person did not ask
  // about cannot come back subtly different and quietly cost a browser walk.
  const steps = lines.map((original, i) => (unreadable.includes(i) ? proposed[i] : original));

  // The safety gate. Every translated line must satisfy the SAME parser the save path uses.
  for (const i of unreadable) {
    const check = parseIrStep(steps[i], ir.steps[i]);
    if (!check.ok) {
      throw new AccessError(
        502,
        `line ${i + 1} could not be translated — the suggestion "${steps[i]}" is still not ` +
          `readable. Try saying which element you mean, e.g. the button's visible label.`,
      );
    }
  }

  return {
    steps,
    before: lines,
    translatedIndexes: unreadable,
    note: typeof parsed?.note === "string" ? parsed.note.trim() : "",
    usage: budget.snapshot(),
  };
}

/**
 * Is plain-language step translation available on this server?
 *
 * Read at CALL time, not at import time, so a test can flip it per-case and so a restart is the
 * only thing needed to turn it off in an incident — an import-time snapshot would need a rebuild.
 *
 * Defaults OFF, like every capability flag in implentationplan.md. Off is the honest default here:
 * the route spends a Gemini call, and a server deployed without a key would otherwise advertise a
 * button that fails on press.
 */
export function nlStepsEnabled(): boolean {
  return process.env.NL_STEPS_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// The case-selection gate -- "ask for a change" BEFORE anything is grounded
// ---------------------------------------------------------------------------

/**
 * The third proposer, and the only one that runs on cases which do not exist yet.
 *
 * `proposeRewrite` and `proposeStepTranslation` both operate on a SAVED case: there is an IR, the
 * steps are grounded against a real page, and every proposed line is re-checked by `parseIrStep`
 * before a person sees it. None of that is available at the selection gate. A case there is a
 * batch of plain English the model has just written, hours before anything is compiled or a
 * browser is opened -- there is no IR to parse onto, no page to ground against, and no version to
 * conflict with.
 *
 * So this deliberately does NOT call `parseIrStep`, and deliberately does NOT constrain the model
 * to `STEP_VOCABULARY`. Gate steps read like "Type an invalid email into the Email field", not
 * like the eleven sentence shapes the executor's grammar accepts, and forcing the executor's
 * grammar here would reject the model's own output. The vocabulary check has not been skipped --
 * it still happens, later, in the place that owns it: whatever survives this review is compiled
 * to IR by `toIR` and grounded against the live page exactly as an unedited case is. This
 * function cannot widen what the pipeline accepts because it is upstream of every check.
 *
 * It keeps the two rules that DO transfer, for the same reasons (D-27):
 *   - it never saves -- it returns a proposal that fills the editor, and the batch is only
 *     persisted when a person approves the round;
 *   - it returns step TEXT, never IR.
 *
 * Unlike the translation path it MAY add, remove or reorder steps. That restriction exists there
 * to protect positional re-basing against a stored IR; here there is no stored anything, and
 * restructuring a case before it is compiled is exactly the edit a reviewer wants to make.
 */
function buildGatePrompt(title: string, current: string[], instruction: string): string {
  return [
    `You are revising a browser test case that has been proposed to a tester but not yet built.`,
    `The case is called "${title}".`,
    ``,
    `Its steps, one per line, numbered:`,
    ...current.map((s, i) => `${i + 1}. ${s}`),
    ``,
    `The tester asked for the following change:`,
    instruction,
    ``,
    `Rewrite the FULL step list with that change applied.`,
    ``,
    `RULES`,
    `- Write each step as one plain English sentence describing a single action a person would`,
    `  take in a browser, in the same style as the steps above. Do not number them yourself.`,
    `- Keep every step the request does not affect worded EXACTLY as it is above.`,
    `- Refer to things on the page the way a person would: the visible label of a button, field`,
    `  or link. Never write a CSS selector, an XPath or an element id.`,
    `- You may add, remove or reorder steps if the request calls for it.`,
    `- Do not write a real password or any other credential into a step.`,
    ``,
    `Reply with JSON only, no markdown fence:`,
    `{"steps":["...","..."],"note":"one short sentence on what you changed"}`,
  ].join("\n");
}

/**
 * Enabled separately from the gate itself. The gate's manual editing costs nothing and works
 * whenever the gate is on; THIS spends a Gemini call per press, so a deployment without a key
 * would otherwise draw a button that always fails -- the same reason `NL_STEPS_ENABLED` exists.
 * Read at call time, not at import, so tests can flip it.
 */
export function gateRewriteEnabled(): boolean {
  return String(process.env.GATE_CASE_EDIT_AI ?? "").toLowerCase() === "true";
}

export async function proposeGateRewrite(
  title: string, steps: string[], instruction: string,
): Promise<RewriteProposal> {
  const trimmed = String(instruction ?? "").trim();
  if (!trimmed) throw new AccessError(400, "say what you would like changed");
  if (trimmed.length > 2000) throw new AccessError(400, "that instruction is too long -- keep it under 2000 characters");

  const before = (Array.isArray(steps) ? steps : [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  if (before.length === 0) throw new AccessError(400, "this case has no steps to change");

  const budget = new LlmBudget();
  enterWithBudget(budget);

  const { content } = await llm(buildGatePrompt(String(title ?? "").trim() || "Untitled case", before, trimmed), {
    role: "main",
    stage: "rewrite",
  });

  const parsed = extractJson(content);
  const proposed = Array.isArray(parsed?.steps)
    ? parsed.steps.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
    : [];
  if (proposed.length === 0) {
    throw new AccessError(502, "the model returned no steps -- try rephrasing the request");
  }
  // The editor renders one row per step and the batch caps step counts at 50; a model that
  // returned hundreds would blow past what a person can review, which is the actual failure.
  if (proposed.length > 50) {
    throw new AccessError(502, "the model returned too many steps to review -- try a narrower request");
  }

  return {
    steps: proposed,
    before,
    note: typeof parsed?.note === "string" ? parsed.note.trim() : "",
    usage: budget.snapshot(),
  };
}

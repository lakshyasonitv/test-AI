import { z } from "zod";

export const Target = z.object({
  url: z.string().optional(),         // navigate only
  role: z.string().optional(),        // preferred: accessibility role
  name: z.string().optional(),        // preferred: accessible name
  nth: z.number().optional(),         // index for duplicate elements (0-indexed)
  label: z.string().optional(),
  text: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
  // Deterministic selector. NEVER produced by the LLM (the IR prompt forbids CSS selectors,
  // and that rule stands — it guards against invented selectors). This is written in code
  // during grounding, copied from the matching AppModel element that discovery verified
  // exists. It is what makes icon-only controls addressable at all.
  css: z.string().optional(),
  /**
   * Same-origin iframe path the target lives in, outermost first: one CSS selector per
   * `<iframe>`, joined by `" >>> "`. Absent means the top-level document. Written in code during
   * grounding, copied from the matching AppModel element (like `css`) — never by the LLM.
   * Once wired, `resolveCode` and the generator both wrap the locator in
   * `page.frameLocator(...)` once per segment; until then nothing reads it. Additive and
   * optional, so every stored IR parses unchanged.
   */
  frame: z.string().optional(),
  /**
   * Provenance, not behaviour. `"replay"` marks a target that was grounded against the LIVE page
   * during a replay (`REPLAY_REGROUND`) rather than against the model discovery built — the case
   * of a control revealed by a click, which discovery never saw.
   *
   * Additive and optional, so every existing IR parses unchanged. It exists so the grounding is
   * VISIBLE in the run's `04-ir.json` and a person can choose to save it back: a replay must not
   * silently rewrite the stored case (`CLAUDE.md` rule 6, `DECISIONS.md` D-27). Nothing branches
   * on it — the generator and executor never read it.
   */
  groundedAt: z.literal("replay").optional(),
});
export type Target = z.infer<typeof Target>;

export const Step = z.object({
  id: z.string(),
  action: z.enum(["navigate", "click", "fill", "select", "check", "press", "wait", "assert"]),
  target: Target.optional(),
  value: z.string().optional(),
  // title_contains/title_equals assert against the page's <title> metadata, NOT body text.
  // Added because there was no way to express "verify the page title is X" at all: the model
  // degraded such a step to text_equals/text_contains against a {text} target, which compiles
  // to a body-text search for a string that (on most sites) only ever exists in <title> — an
  // assertion that can never pass. Reproduced repeatedly against amazon.in, whose title
  // ("Online Shopping site in India: ...") appears zero times in the rendered body. A
  // prompt rule telling the model not to do this already existed and was ignored; this makes
  // the correct thing expressible instead of merely requested. Like url_contains, these are
  // PAGE-level — they take no target.
  assertion: z.enum([
    "visible", "hidden", "text_equals", "text_contains",
    "url_contains", "title_contains", "title_equals", "enabled", "disabled",
  ]).optional(),
  preAction: z.object({
    action: z.enum(["hover", "click"]),
    target: Target,
  }).optional(),
});
export type Step = z.infer<typeof Step>;

// Models sometimes ignore the requested lowercase casing (e.g. "High") — normalize
// before validating rather than rejecting an otherwise-valid IR.
//
// TOTAL, for the same reason as the twin in `src/stages/testCases.ts`: an unrecognised value
// becomes "medium" instead of failing the parse. Fixing only the test-case side would have left
// the identical trap one stage downstream — `IR.meta.priority` is parsed in `toIR`'s grounding
// loop, where a rejection burns a retry attempt and can fail the whole compile over a sort hint.
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const Priority = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const lower = v.toLowerCase().trim();
    return (PRIORITIES as readonly string[]).includes(lower) ? lower : "medium";
  },
  z.enum(PRIORITIES)
).default("medium");

export const IR = z.object({
  meta: z.object({
    feature: z.string(),
    title: z.string(),
    priority: Priority,
    sourcePrompt: z.string(),
    baseUrl: z.string(),
    // Set by toIR when it couldn't ground the full flow and fell back to the grounded
    // prefix — the test is real but partial. Optional so the model never has to emit them.
    truncated: z.boolean().optional(),
    truncationNote: z.string().optional(),
    // True when the surviving (post-truncation) step list ends in an assertion step.
    // Only meaningful when truncated is true — a truncated IR without a terminal assertion
    // cannot report "passed" because the dropped tail may have contained the only assertion.
    hasTerminalAssertion: z.boolean().optional(),
    /**
     * WHAT kind of grounding rejection truncated this IR, as a structured value rather than
     * something to be read back out of `truncationNote`.
     *
     * `truncationNote` is `ungrounded.message` — prose, written for a model to act on, and
     * partly shaped by page text. Pattern-matching it to make a decision is exactly the failure
     * `CLAUDE.md`'s central rule and `TECH_DEBT.md` TD-01 record, so the decision reads this
     * instead. Set alongside `truncated`, never on its own.
     *
     * Its one consumer today is `isHealable` (TD-83): a heal re-runs `toIR` against a fresh
     * snapshot, so it can recover a target that genuinely moved — but a `navigate-url` rejection
     * is the guard refusing an invented route, which a new snapshot cannot make real. Healing
     * that spends a full IR regeneration to be told the same thing, and `attemptHeal` then
     * discards the result anyway because a heal that truncates is not a heal.
     */
    truncationKind: z.string().optional(),
  }),
  steps: z.array(Step).min(1),
});
export type IR = z.infer<typeof IR>;

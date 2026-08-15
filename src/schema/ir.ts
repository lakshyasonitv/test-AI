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
const Priority = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["low", "medium", "high", "critical"])
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
  }),
  steps: z.array(Step).min(1),
});
export type IR = z.infer<typeof IR>;

import { z } from "zod";

export const Target = z.object({
  url: z.string().optional(),         // navigate only
  role: z.string().optional(),        // preferred: accessibility role
  name: z.string().optional(),        // preferred: accessible name
  label: z.string().optional(),
  text: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
});
export type Target = z.infer<typeof Target>;

export const Step = z.object({
  id: z.string(),
  action: z.enum(["navigate", "click", "fill", "select", "check", "press", "wait", "assert"]),
  target: Target.optional(),
  value: z.string().optional(),
  assertion: z.enum([
    "visible", "hidden", "text_equals", "text_contains",
    "url_contains", "enabled", "disabled",
  ]).optional(),
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

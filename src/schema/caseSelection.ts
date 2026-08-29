import { z } from "zod";
import type { TestCase } from "../stages/testCases.js";

/**
 * One user edit to a case the model proposed, addressed by its position in the batch the user
 * was shown. Every content field is optional because the client sends only what actually
 * changed — an untouched case produces no entry at all.
 *
 * The index is the SAME index space as `selectedIndexes`. That is the whole reason editing a
 * batch needs no new addressing scheme: the gate already speaks in batch positions, so an edit
 * is just "position 3, but with these words".
 */
export const GateCaseEditSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(300).optional(),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(50).optional(),
  expected: z.string().trim().min(1).max(2000).optional(),
  whyItMatters: z.string().trim().min(1).max(2000).optional(),
});
export type GateCaseEdit = z.infer<typeof GateCaseEditSchema>;

/**
 * A case the user wrote themselves. Only the four fields a person can meaningfully author are
 * accepted; everything else on `TestCase` (priority, category, feature, generatedFrom) is filled
 * with defaults server-side. Deliberately NOT accepted: `fromPrompt` and `generatedFrom`, which
 * are routing state the pipeline stamps — letting a client set them would make the request able
 * to reclassify what the run thinks it is doing.
 */
export const GateCaseAddSchema = z.object({
  title: z.string().trim().min(1).max(300),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  expected: z.string().trim().min(1).max(2000),
  whyItMatters: z.string().trim().min(1).max(2000).optional(),
});
export type GateCaseAdd = z.infer<typeof GateCaseAddSchema>;

/**
 * Both new fields are OPTIONAL on both arms, so a client that has never heard of case editing
 * sends exactly what it sent before and gets exactly what it got before. `selectedIndexes` keeps
 * its meaning untouched — positions in the batch — with added cases appended to the end of that
 * batch in the order they arrive, which is the order the client already numbered them in.
 */
const gateEditFields = {
  editedCases: z.array(GateCaseEditSchema).max(50).optional(),
  addedCases: z.array(GateCaseAddSchema).max(20).optional(),
};

export const CaseSelectionDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("done"),
    selectedIndexes: z.array(z.number().int().nonnegative()),
    ...gateEditFields,
  }),
  z.object({
    action: z.literal("not_satisfied"),
    selectedIndexes: z.array(z.number().int().nonnegative()),
    newPrompt: z.string().min(1, "Describe what should change before refining"),
    ...gateEditFields,
  }),
]);

export type CaseSelectionDecision = z.infer<typeof CaseSelectionDecisionSchema>;

export interface AcceptedCasesFile {
  runId: string;
  hasAcceptedPrimary: boolean;
  rounds: {
    attempt: number;
    prompt: string;
    acceptedCases: TestCase[];
    overflowIndexes: number[];
  }[];
}

export interface CaseHistoryFile {
  runId: string;
  rounds: {
    attempt: number;
    prompt: string;
    entries: {
      normalizedTitle: string;
      originalTitle: string;
      status: "selected" | "selected_but_capped" | "rejected";
    }[];
  }[];
}

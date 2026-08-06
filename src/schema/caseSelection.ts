import { z } from "zod";
import type { TestCase } from "../stages/testCases.js";

export const CaseSelectionDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("done"),
    selectedIndexes: z.array(z.number().int().nonnegative()),
  }),
  z.object({
    action: z.literal("not_satisfied"),
    selectedIndexes: z.array(z.number().int().nonnegative()),
    newPrompt: z.string().min(1, "Describe what should change before refining"),
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

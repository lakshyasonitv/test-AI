import { describe, it, expect } from "vitest";
import { CaseSelectionDecisionSchema, type CaseSelectionDecision } from "./caseSelection.js";

describe("CaseSelectionDecisionSchema", () => {
  it("accepts a valid 'done' decision", () => {
    const decision: unknown = { action: "done", selectedIndexes: [0, 2] };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.action : null).toBe("done");
  });

  it("accepts a valid 'not_satisfied' decision", () => {
    const decision: unknown = {
      action: "not_satisfied",
      selectedIndexes: [0],
      newPrompt: "Add a case for an empty password field.",
    };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.action === "not_satisfied") {
      expect(parsed.data.newPrompt).toMatch(/empty password/);
    }
  });

  it("rejects 'not_satisfied' with an empty newPrompt", () => {
    const decision: unknown = { action: "not_satisfied", selectedIndexes: [0], newPrompt: "" };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message === "Describe what should change before refining")).toBe(true);
    }
  });

  it("rejects an unknown action value", () => {
    const decision: unknown = { action: "maybe", selectedIndexes: [0], newPrompt: "whatever" };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative index", () => {
    const decision: unknown = { action: "done", selectedIndexes: [-1] };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(false);
  });

  it("rejects string indexes", () => {
    const decision: unknown = { action: "done", selectedIndexes: ["0"] };
    const parsed = CaseSelectionDecisionSchema.safeParse(decision);
    expect(parsed.success).toBe(false);
  });
});

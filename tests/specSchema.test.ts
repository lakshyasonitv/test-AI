import { describe, it, expect } from "vitest";
import {
  LlmSpecModel, SpecModel, isEmptySpec, MAX_UNRESOLVED, MAX_ITEM_CHARS, MAX_LIST_ITEMS,
} from "../src/schema/spec.js";

/**
 * The SpecModel schemas (Pro test 8, and the client-input half).
 *
 * The questions column is capped at 10 IN THE SCHEMA, not only in the prompt — the prompt asks,
 * the schema enforces. A model answer with 14 questions is cut to the first 10, deterministically;
 * a browser sending 14 is refused.
 */

const fourteen = Array.from({ length: 14 }, (_, i) => `Question ${i + 1}?`);

describe("LlmSpecModel — what the model returned (test 8)", () => {
  it("cuts 14 unresolved questions to the first 10, in order", () => {
    const parsed = LlmSpecModel.parse({ rules: ["A Lead needs a phone number."], unresolved: fourteen });
    expect(parsed.unresolved).toHaveLength(MAX_UNRESOLVED);
    expect(parsed.unresolved).toEqual(fourteen.slice(0, 10));
  });

  it("never fails for being too long — trims, drops blanks and non-strings, cuts long items", () => {
    const parsed = LlmSpecModel.parse({
      rules: ["  Only a Manager may reassign.  ", "", "   ", 42, null, "x".repeat(MAX_ITEM_CHARS + 50)],
      criteria: Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `c${i}`),
      actors: "not an array",
    });
    expect(parsed.rules).toEqual(["Only a Manager may reassign.", "x".repeat(MAX_ITEM_CHARS)]);
    expect(parsed.criteria).toHaveLength(MAX_LIST_ITEMS);
    expect(parsed.actors).toEqual([]);
    expect(parsed.entities).toEqual([]);
  });

  it("never takes answers from the model — answers come from the user only", () => {
    const parsed = LlmSpecModel.parse({ answers: [{ question: "Currency?", answer: "INR" }] });
    expect(parsed.answers).toEqual([]);
  });

  it("the result always satisfies the strict client schema", () => {
    const parsed = LlmSpecModel.parse({ unresolved: fourteen, rules: ["r"] });
    expect(SpecModel.safeParse(parsed).success).toBe(true);
  });
});

describe("SpecModel — what the browser sends back", () => {
  it("refuses 14 questions rather than silently dropping four", () => {
    expect(SpecModel.safeParse({ unresolved: fourteen }).success).toBe(false);
  });

  it("refuses unknown keys, blank rules and over-long answers", () => {
    expect(SpecModel.safeParse({ rules: ["r"], injected: "x" }).success).toBe(false);
    expect(SpecModel.safeParse({ rules: ["   "] }).success).toBe(false);
    expect(SpecModel.safeParse({ answers: [{ question: "q", answer: "a".repeat(1001) }] }).success).toBe(false);
  });

  it("an unanswered question is simply absent — an empty answer is refused, not stored", () => {
    expect(SpecModel.safeParse({ answers: [{ question: "Currency?", answer: "" }] }).success).toBe(false);
    expect(SpecModel.parse({ unresolved: ["Currency?"] }).answers).toEqual([]);
  });

  it("fills every missing list with []", () => {
    expect(SpecModel.parse({})).toEqual({
      actors: [], entities: [], actions: [], rules: [], criteria: [], outOfScope: [], unresolved: [], answers: [],
    });
  });
});

describe("isEmptySpec", () => {
  it("is true only when distillation found nothing at all", () => {
    expect(isEmptySpec(SpecModel.parse({}))).toBe(true);
    expect(isEmptySpec(SpecModel.parse({ outOfScope: ["Refunds"] }))).toBe(false);
  });
});

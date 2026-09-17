import { describe, it, expect } from "vitest";
import { z } from "zod";
import { IR } from "../src/schema/ir.js";
import { LLMTestCase } from "../src/stages/testCases.js";

/**
 * An unrecognised `priority` must never fail a batch — TECH_DEBT-worthy, found in production.
 *
 * WHAT HAPPENED. A run died with `Test cases failed schema validation after retry`: gpt-5-mini
 * returned `priority: "functional"` on 3 of 12 cases. `toTestCases` validates the WHOLE array in
 * one `safeParse`, so the other 9 — all valid, three of them already chosen by the user at the
 * gate — were rejected alongside them and the run aborted.
 *
 * `"functional"` is not a typo of a priority and not another field's value either. It is a
 * run-level SCOPE (`TestCategory` in `src/kb/testStrategy.ts`), and the prompt puts it in front of
 * the model as "This run is FUNCTIONAL testing only" in capitals, in the same block as the priority
 * instruction — while never stating what a priority may be.
 *
 * `src/kb/testStrategy.ts` already wrote the rule, for `category`: "a label the pipeline can't
 * parse must not be able to fail a whole run, since toTestCases validates the entire array at once
 * and would reject every case alongside it." `category` got a stated legal set AND a normaliser;
 * `priority` had neither. These tests pin that it now does — on BOTH schemas, because the same
 * shape sits in `src/schema/ir.ts` one stage downstream.
 */

const validCase = (over: Record<string, unknown> = {}) => ({
  title: "Sort products using catalog dropdown",
  priority: "high",
  feature: "catalog",
  steps: ["Navigate to /inventory"],
  expected: "Products are reordered",
  category: "valid",
  intent: "proves sorting reorders the catalog",
  whyItMatters: "If this breaks, shoppers cannot find what they came for.",
  ...over,
});

describe("priority coercion — testCases", () => {
  it("accepts the reported bad value instead of rejecting the case", () => {
    const parsed = LLMTestCase.safeParse(validCase({ priority: "functional" }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.priority).toBe("medium");
  });

  it("does not let one bad element reject the whole batch", () => {
    // The actual shape of the failure: indices 9/10/11 bad, the rest fine, all twelve discarded.
    const batch = Array.from({ length: 12 }, (_, i) =>
      validCase(i >= 9 ? { priority: "functional" } : {}));

    const result = z.array(LLMTestCase).safeParse(batch);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(12);
      expect(result.data[0].priority).toBe("high");
      expect(result.data[9].priority).toBe("medium");
    }
  });

  it("still preserves every legal value, and still normalises case", () => {
    for (const p of ["low", "medium", "high", "critical"]) {
      const parsed = LLMTestCase.safeParse(validCase({ priority: p }));
      expect(parsed.success && parsed.data.priority).toBe(p);
    }
    const upper = LLMTestCase.safeParse(validCase({ priority: "HIGH" }));
    expect(upper.success && upper.data.priority).toBe("high");
    const padded = LLMTestCase.safeParse(validCase({ priority: "  Critical " }));
    expect(padded.success && padded.data.priority).toBe("critical");
  });

  it("falls back for the other scope-shaped words the prompt exposes", () => {
    // "security" is the other TestCategory; "smoke"/"regression" are testTypeScope vocabulary the
    // planner uses. None is a priority, and each is plausible for the same reason "functional" was.
    for (const wrong of ["security", "smoke", "regression", "p1", "urgent", ""]) {
      const parsed = LLMTestCase.safeParse(validCase({ priority: wrong }));
      expect(parsed.success, `priority "${wrong}" must not fail the case`).toBe(true);
      if (parsed.success) expect(parsed.data.priority).toBe("medium");
    }
  });

  it("an absent priority still defaults, as before", () => {
    const { priority, ...withoutPriority } = validCase();
    const parsed = LLMTestCase.safeParse(withoutPriority);
    expect(parsed.success && parsed.data.priority).toBe("medium");
  });
});

describe("priority coercion — IR.meta (the same trap one stage downstream)", () => {
  const ir = (priority: unknown) => ({
    meta: {
      feature: "catalog", title: "Sort products", priority,
      sourcePrompt: "sort the catalog", baseUrl: "https://www.saucedemo.com",
    },
    steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
  });

  it("coerces an unknown value rather than failing the compile", () => {
    const parsed = IR.safeParse(ir("functional"));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.meta.priority).toBe("medium");
  });

  it("keeps legal values and casing behaviour", () => {
    expect(IR.safeParse(ir("critical")).success).toBe(true);
    const upper = IR.safeParse(ir("High"));
    expect(upper.success && upper.data.meta.priority).toBe("high");
  });
});

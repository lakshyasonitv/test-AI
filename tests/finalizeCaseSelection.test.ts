import { describe, it, expect } from "vitest";
import { finalizeCaseSelection } from "../src/stages/testCases.js";
import { ALL_SCOPES } from "../src/kb/testStrategy.js";
import type { TestCase } from "../src/stages/testCases.js";

const tc = (title: string, category = "valid", fromPrompt = false): TestCase => ({
  title, priority: "high", feature: "f", steps: ["s"], expected: "e",
  fromPrompt, category, generatedFrom: "upfront",
} as TestCase);

// Regression: selecting exactly 1 case through the case-selection gate resulted in 4 tests
// actually running. Root cause: orchestrator.ts re-applied selectCases's coverage-budget
// fill/cap (4 for "standard") on top of what the gate had already finalized as the user's
// explicit decision — a step that predates the gate and was never adjusted when it was added.
describe("finalizeCaseSelection", () => {
  it("when the gate was used, returns EXACTLY what was selected — 1 in, 1 out, not padded to the coverage budget", () => {
    const out = finalizeCaseSelection([tc("Only this one", "valid", true)], ALL_SCOPES, "standard", true);
    expect(out.length).toBe(1);
  });

  it("when the gate was used, does not cap a selection larger than the coverage budget", () => {
    const titles = ["Login succeeds", "Invalid password rejected", "Empty username blocked", "Search returns results", "Cart updates on add"];
    const five = titles.map((title, i) => tc(title, "valid", i === 0));
    const out = finalizeCaseSelection(five, ALL_SCOPES, "standard", true);
    expect(out.length).toBe(5);
  });

  it("when the gate was used, still applies scope filtering as a defensive floor", () => {
    const cases = [tc("Login", "valid", true), tc("SQL injection", "security-injection")];
    const out = finalizeCaseSelection(cases, ["functional"], "standard", true);
    expect(out.map((c) => c.title)).toEqual(["Login"]);
  });

  it("when the gate was NOT used, keeps today's exact behavior: capped to the coverage budget", () => {
    const titles = [
      "Login succeeds", "Invalid password rejected", "Empty username blocked", "Search returns results",
      "Cart updates on add", "Checkout completes", "Contact form submits", "Newsletter signup works",
    ];
    const eight = titles.map((title, i) => tc(title, "valid", i === 0));
    const out = finalizeCaseSelection(eight, ALL_SCOPES, "standard", false);
    expect(out.length).toBe(4); // budgetFor("standard")
  });
});

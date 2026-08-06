import { describe, it, expect } from "vitest";
import { filterNovelCases } from "../src/stages/testCases.js";
import type { TestCase } from "../src/stages/testCases.js";

const tc = (title: string): TestCase => ({
  title, priority: "high", feature: "f", steps: ["s"], expected: "e",
  fromPrompt: false, category: "valid", generatedFrom: "upfront",
} as TestCase);

// Regression: the LLM prompt asks for novelty and the cache key includes rejected titles,
// but neither is a guarantee — the model can restate a case anyway, or a cache hit can
// return a stale batch. filterNovelCases is the hard floor that drops it regardless.
describe("filterNovelCases", () => {
  it("passes everything through when nothing has been seen yet (round 1)", () => {
    const all = [tc("Login"), tc("Invalid password")];
    expect(filterNovelCases(all, [])).toEqual(all);
  });

  it("drops a case whose title overlaps an already-seen title", () => {
    const all = [tc("Login with valid credentials"), tc("Submit empty form")];
    const out = filterNovelCases(all, ["Login with valid credentials"]);
    expect(out.map((c) => c.title)).toEqual(["Submit empty form"]);
  });

  it("drops a near-reworded duplicate, not just an exact title match", () => {
    const all = [tc("Verify end-to-end checkout flow for the Fleece Jacket")];
    const out = filterNovelCases(all, ["Verify the end-to-end checkout flow for the Fleece Jacket"]);
    expect(out).toEqual([]);
  });
});

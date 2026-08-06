import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  appendAcceptedCases, getAllAcceptedCases, hasAcceptedPrimary, remainingCapacity,
  MAX_ACCUMULATED_CASES,
} from "../src/server/caseAccumulator.js";
import type { TestCase } from "../src/stages/testCases.js";

const tc = (title: string, fromPrompt = false): TestCase => ({
  title, priority: "high", feature: "f", steps: ["s"], expected: "e",
  fromPrompt, category: "valid", generatedFrom: "upfront",
} as TestCase);

describe("caseAccumulator", () => {
  const runId = "test-run-caseAccumulator";
  beforeEach(() => rmSync(path.join("runs", runId), { recursive: true, force: true }));
  afterEach(() => rmSync(path.join("runs", runId), { recursive: true, force: true }));

  it("accepts selected cases and marks the primary as accepted", () => {
    const batch = [tc("Login", true), tc("Invalid password")];
    const { accepted, overflow } = appendAcceptedCases(runId, 1, "prompt", batch, [0, 1]);
    expect(accepted.map((c) => c.title)).toEqual(["Login", "Invalid password"]);
    expect(overflow).toEqual([]);
    expect(hasAcceptedPrimary(runId)).toBe(true);
    expect(getAllAcceptedCases(runId).length).toBe(2);
  });

  it("routes anything past MAX_ACCUMULATED_CASES into overflow instead of the pool", () => {
    const batch = Array.from({ length: MAX_ACCUMULATED_CASES + 2 }, (_, i) => tc(`Case ${i}`));
    const allIndexes = batch.map((_, i) => i);
    const { accepted, overflow } = appendAcceptedCases(runId, 1, "prompt", batch, allIndexes);
    expect(accepted.length).toBe(MAX_ACCUMULATED_CASES);
    expect(overflow.length).toBe(2);
    expect(remainingCapacity(runId)).toBe(0);
  });

  it("dedups accepted cases across rounds by normalized title", () => {
    appendAcceptedCases(runId, 1, "prompt", [tc("Login.")], [0]);
    appendAcceptedCases(runId, 2, "prompt", [tc("  login  ")], [0]);
    expect(getAllAcceptedCases(runId).length).toBe(1);
  });

  it("skips an out-of-range selected index instead of throwing", () => {
    const { accepted } = appendAcceptedCases(runId, 1, "prompt", [tc("Login")], [0, 5]);
    expect(accepted.length).toBe(1);
  });
});

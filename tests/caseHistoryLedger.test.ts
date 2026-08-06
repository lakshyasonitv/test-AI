import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import { appendRoundToHistory, getRejectedTitles, buildHistoryPromptBlock } from "../src/server/caseHistoryLedger.js";
import type { TestCase } from "../src/stages/testCases.js";

const tc = (title: string): TestCase => ({
  title, priority: "high", feature: "f", steps: ["s"], expected: "e",
  fromPrompt: false, category: "valid", generatedFrom: "upfront",
} as TestCase);

describe("caseHistoryLedger", () => {
  const runId = "test-run-caseHistoryLedger";
  beforeEach(() => rmSync(path.join("runs", runId), { recursive: true, force: true }));
  afterEach(() => rmSync(path.join("runs", runId), { recursive: true, force: true }));

  it("classifies a batch's cases as selected / selected_but_capped / rejected", () => {
    const batch = [tc("Login"), tc("Invalid password"), tc("Empty form")];
    // index 0 accepted into the pool, index 1 chosen but overflowed the pool, index 2 never picked
    appendRoundToHistory(runId, 1, "prompt", batch, [0], [1]);
    const rejected = getRejectedTitles(runId);
    expect(rejected).toEqual(["Empty form"]);
  });

  it("never surfaces the same rejected title twice, even across rounds", () => {
    appendRoundToHistory(runId, 1, "prompt", [tc("Empty form")], [], []);
    appendRoundToHistory(runId, 2, "prompt2", [tc("Empty form")], [], []);
    expect(getRejectedTitles(runId)).toEqual(["Empty form"]);
  });

  it("builds a prompt block listing the prompt trail and title statuses", () => {
    appendRoundToHistory(runId, 1, "prompt one", [tc("Login")], [0], []);
    const block = buildHistoryPromptBlock(runId, "prompt two");
    expect(block).toContain("1. prompt one");
    expect(block).toContain("2. prompt two (latest)");
    expect(block).toContain("[SELECTED] login");
  });

  it("labels an overflowed-but-wanted case distinctly from a plain rejection", () => {
    appendRoundToHistory(runId, 1, "prompt", [tc("Overflowed one")], [], [0]);
    const block = buildHistoryPromptBlock(runId, "next");
    expect(block).toContain("DID NOT FIT — POOL WAS FULL");
  });
});

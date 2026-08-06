import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendAcceptedCases,
  getAllAcceptedCases,
  hasAcceptedPrimary,
  remainingCapacity,
  MAX_ACCUMULATED_CASES,
} from "./caseAccumulator.js";
import type { TestCase } from "../stages/testCases.js";

type TestCaseWithId = TestCase & { id: string };

const runIds: string[] = [];

function makeCase(id: string, over: Partial<TestCaseWithId> = {}): TestCaseWithId {
  return {
    id,
    priority: "medium",
    feature: "Login",
    title: "Case " + id,
    steps: ["step"],
    expected: "ok",
    fromPrompt: false,
    category: "functional-other",
    generatedFrom: "upfront",
    ...over,
  } as TestCaseWithId;
}

function newRunId(): string {
  const id = "__test-" + randomUUID();
  runIds.push(id);
  return id;
}

afterEach(() => {
  for (const runId of runIds) {
    fs.rmSync(path.join("runs", runId), { recursive: true, force: true });
  }
  runIds.length = 0;
});

describe("empty-file reads", () => {
  it("treats a run with no saved file as empty", () => {
    const runId = newRunId();
    expect(getAllAcceptedCases(runId)).toEqual([]);
    expect(hasAcceptedPrimary(runId)).toBe(false);
    expect(remainingCapacity(runId)).toBe(MAX_ACCUMULATED_CASES);
  });

  it("creates the file on first append", () => {
    const runId = newRunId();
    const c = makeCase("c1");
    appendAcceptedCases(runId, 1, "p", [c], [0]);
    expect(fs.existsSync(path.join("runs", runId, "accepted-cases.json"))).toBe(true);
  });
});

describe("cap enforcement and overflow routing", () => {
  it("accepts up to MAX_ACCUMULATED_CASES and routes the rest to overflow", () => {
    const runId = newRunId();
    const cases = Array.from({ length: MAX_ACCUMULATED_CASES + 2 }, (_, i) => makeCase("c" + i));
    const indexes = cases.map((_, i) => i);

    const { accepted, overflow } = appendAcceptedCases(runId, 1, "p", cases, indexes);

    expect(accepted.length).toBe(MAX_ACCUMULATED_CASES);
    expect(overflow.length).toBe(2);
    expect(getAllAcceptedCases(runId).length).toBe(MAX_ACCUMULATED_CASES);
    expect(remainingCapacity(runId)).toBe(0);
  });

  it("persists overflow indexes for the round", () => {
    const runId = newRunId();
    const cases = Array.from({ length: MAX_ACCUMULATED_CASES + 1 }, (_, i) => makeCase("c" + i));
    const indexes = cases.map((_, i) => i);

    appendAcceptedCases(runId, 1, "p", cases, indexes);

    const file = JSON.parse(fs.readFileSync(path.join("runs", runId, "accepted-cases.json"), "utf-8"));
    expect(file.rounds[0].overflowIndexes).toEqual([MAX_ACCUMULATED_CASES]);
  });

  it("counts already-accepted cases against the cap in later rounds", () => {
    const runId = newRunId();
    const first = Array.from({ length: MAX_ACCUMULATED_CASES }, (_, i) => makeCase("c" + i));
    appendAcceptedCases(runId, 1, "p", first, first.map((_, i) => i));

    const next = [makeCase("c-extra")];
    const { accepted, overflow } = appendAcceptedCases(runId, 2, "q", next, [0]);

    expect(accepted).toEqual([]);
    expect(overflow.length).toBe(1);
  });

  it("ignores cases the user did not select", () => {
    const runId = newRunId();
    const checked = makeCase("c1");
    const unchecked = makeCase("c2");

    const { accepted } = appendAcceptedCases(runId, 1, "p", [checked, unchecked], [0]);

    expect(accepted.map((c) => (c as TestCaseWithId).id)).toEqual(["c1"]);
    expect(getAllAcceptedCases(runId).length).toBe(1);
  });

  it("skips an out-of-range index rather than throwing", () => {
    const runId = newRunId();
    const c = makeCase("c1");

    const { accepted, overflow } = appendAcceptedCases(runId, 1, "p", [c], [5]);

    expect(accepted).toEqual([]);
    expect(overflow).toEqual([]);
  });
});

describe("primary-flag tracking", () => {
  it("sets hasAcceptedPrimary when a fromPrompt case is accepted", () => {
    const runId = newRunId();
    const primary = makeCase("p", { fromPrompt: true });
    appendAcceptedCases(runId, 1, "p", [primary], [0]);
    expect(hasAcceptedPrimary(runId)).toBe(true);
  });

  it("stays false when the fromPrompt case overflows the cap", () => {
    const runId = newRunId();
    const filler = Array.from({ length: MAX_ACCUMULATED_CASES }, (_, i) => makeCase("c" + i));
    const primary = makeCase("p", { fromPrompt: true });
    const all = [...filler, primary];
    appendAcceptedCases(runId, 1, "p", all, all.map((_, i) => i));

    expect(hasAcceptedPrimary(runId)).toBe(false);
  });
});

describe("dedupe across rounds", () => {
  it("returns each normalized title at most once", () => {
    const runId = newRunId();
    const a = makeCase("c1", { title: "Log in with valid credentials" });
    const b = makeCase("c2", { title: "Log in with valid credentials." });

    appendAcceptedCases(runId, 1, "p", [a], [0]);
    appendAcceptedCases(runId, 2, "q", [b], [0]);

    const all = getAllAcceptedCases(runId);
    expect(all.length).toBe(1);
    expect((all[0] as TestCaseWithId).id).toBe("c1");
  });
});

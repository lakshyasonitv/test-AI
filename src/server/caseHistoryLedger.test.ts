import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeTitle,
  appendRoundToHistory,
  buildHistoryPromptBlock,
} from "./caseHistoryLedger.js";
import type { TestCase } from "../stages/testCases.js";

type TestCaseWithId = TestCase & { id: string };

const runIds: string[] = [];

function makeCase(id: string, title: string): TestCaseWithId {
  return {
    id,
    priority: "medium",
    feature: "Login",
    title,
    steps: ["step"],
    expected: "ok",
    fromPrompt: false,
    category: "functional-other",
    generatedFrom: "upfront",
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

describe("normalizeTitle", () => {
  it("trims, lowercases, collapses whitespace and strips trailing punctuation", () => {
    expect(normalizeTitle("  LOG IN   With VALID  Credentials! ")).toBe("log in with valid credentials");
    expect(normalizeTitle("Log in with valid credentials.")).toBe("log in with valid credentials");
    expect(normalizeTitle("Log in with valid credentials?")).toBe("log in with valid credentials");
    expect(normalizeTitle("Log in with valid credentials...")).toBe("log in with valid credentials");
  });

  it("leaves an already-clean title unchanged", () => {
    expect(normalizeTitle("log in with valid credentials")).toBe("log in with valid credentials");
  });
});

describe("appendRoundToHistory labeling", () => {
  it("labels accepted / capped / rejected by index membership", () => {
    const runId = newRunId();
    const accepted = makeCase("a", "Log in with valid credentials");
    const capped = makeCase("b", "Log in with wrong password");
    const rejected = makeCase("c", "Submit empty login form");

    appendRoundToHistory(runId, 1, "first", [accepted, capped, rejected], [0], [1]);

    const file = JSON.parse(fs.readFileSync(path.join("runs", runId, "case-history.json"), "utf-8"));
    const entries = file.rounds[0].entries;
    expect(entries).toEqual([
      { normalizedTitle: "log in with valid credentials", originalTitle: "Log in with valid credentials", status: "selected" },
      { normalizedTitle: "log in with wrong password", originalTitle: "Log in with wrong password", status: "selected_but_capped" },
      { normalizedTitle: "submit empty login form", originalTitle: "Submit empty login form", status: "rejected" },
    ]);
  });

  it("dedupes entries with the same normalized title within a round (first wins)", () => {
    const runId = newRunId();
    const a = makeCase("a", "Log in with valid credentials");
    const b = makeCase("b", "Log in with valid credentials!");
    const c = makeCase("c", "Log in with valid credentials");

    appendRoundToHistory(runId, 1, "first", [a, b, c], [0], []);

    const file = JSON.parse(fs.readFileSync(path.join("runs", runId, "case-history.json"), "utf-8"));
    const entries = file.rounds[0].entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({
      normalizedTitle: "log in with valid credentials",
      originalTitle: "Log in with valid credentials",
      status: "selected",
    });
  });
});

describe("empty-file reads", () => {
  it("builds a prompt block with only the latest prompt when there is no history", () => {
    const runId = newRunId();
    const block = buildHistoryPromptBlock(runId, "latest");
    expect(block).toContain("1. latest (latest)");
    expect(block).toContain("Prompt trail (oldest to latest)");
  });

  it("creates the ledger file on first append", () => {
    const runId = newRunId();
    const c = makeCase("a", "Log in");
    appendRoundToHistory(runId, 1, "first", [c], [0], []);
    expect(fs.existsSync(path.join("runs", runId, "case-history.json"))).toBe(true);
  });
});

describe("buildHistoryPromptBlock", () => {
  it("lists the prompt trail oldest to latest", () => {
    const runId = newRunId();
    const a = makeCase("a", "Log in with valid credentials");
    appendRoundToHistory(runId, 1, "first prompt", [a], [0], []);
    appendRoundToHistory(runId, 2, "second prompt", [a], [], []);

    const block = buildHistoryPromptBlock(runId, "third prompt");
    expect(block).toContain("1. first prompt");
    expect(block).toContain("2. second prompt");
    expect(block).toContain("3. third prompt (latest)");
  });

  it("labels capped titles with the DID-NOT-FIT marker", () => {
    const runId = newRunId();
    const capped = makeCase("b", "Log in with wrong password");
    appendRoundToHistory(runId, 1, "first prompt", [capped], [], [0]);

    const block = buildHistoryPromptBlock(runId, "latest");
    expect(block).toContain("- [SELECTED (DID NOT FIT — POOL WAS FULL)] log in with wrong password");
  });
});

import fs from "fs";
import path from "path";
import type { CaseHistoryFile } from "../schema/caseSelection.js";
import type { TestCase } from "../stages/testCases.js";

/** Normalize title for comparison (lowercase, collapse whitespace, strip non-alphanumeric). */
export function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "");
}

function filePath(runId: string): string {
  return path.join("runs", runId, "case-history.json");
}

function readFile(runId: string): CaseHistoryFile {
  const p = filePath(runId);
  if (!fs.existsSync(p)) return { runId, rounds: [] };
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeFile(runId: string, data: CaseHistoryFile): void {
  const p = filePath(runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

/** Record this round's batch (all cases labeled selected, selected_but_capped, or rejected). */
export function appendRoundToHistory(
  runId: string,
  attempt: number,
  prompt: string,
  batch: TestCase[],
  acceptedIndexes: number[],
  overflowIndexes: number[]
): void {
  const data = readFile(runId);
  const acceptedSet = new Set(acceptedIndexes);
  const overflowSet = new Set(overflowIndexes);

  const entries = batch.map((c, idx) => {
    let status: "selected" | "selected_but_capped" | "rejected" = "rejected";
    if (overflowSet.has(idx)) {
      status = "selected_but_capped";
    } else if (acceptedSet.has(idx)) {
      status = "selected";
    }

    return {
      normalizedTitle: normalizeTitle(c.title),
      originalTitle: c.title,
      status,
    };
  });

  data.rounds.push({ attempt, prompt, entries });
  writeFile(runId, data);
}

/** Retrieves ALL titles ever generated across all rounds (both accepted and rejected). */
export function getAllHistoryTitles(runId: string): string[] {
  const data = readFile(runId);
  const titles: string[] = [];
  for (const round of data.rounds) {
    for (const entry of round.entries) {
      titles.push(entry.originalTitle);
    }
  }
  return titles;
}

/** Builds the "prompt trail + case history" summary block. */
export function buildHistoryPromptBlock(runId: string, latestPrompt: string): string {
  const data = readFile(runId);
  if (data.rounds.length === 0) return "";

  const lines: string[] = ["Prior regeneration rounds context:"];
  for (const round of data.rounds) {
    lines.push(`Attempt ${round.attempt} Prompt: "${round.prompt}"`);
    lines.push("Shown cases:");
    for (const entry of round.entries) {
      lines.push(`  - [${entry.status}] ${entry.originalTitle}`);
    }
  }
  lines.push(`Current Round Prompt: "${latestPrompt}"`);
  return lines.join("\n");
}
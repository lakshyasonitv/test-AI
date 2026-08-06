import fs from "fs";
import path from "path";
import type { CaseHistoryFile } from "../schema/caseSelection.js";
import type { TestCase } from "../stages/testCases.js";

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

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

export function appendRoundToHistory(
  runId: string,
  attempt: number,
  prompt: string,
  batch: TestCase[],
  acceptedIndexes: number[],
  overflowIndexes: number[]
): void {
  const data = readFile(runId);
  const seenThisRound = new Set<string>();

  const entries = batch.reduce<CaseHistoryFile["rounds"][number]["entries"]>((acc, c, i) => {
    const normalizedTitle = normalizeTitle(c.title);
    if (seenThisRound.has(normalizedTitle)) return acc;
    seenThisRound.add(normalizedTitle);
    const status = acceptedIndexes.includes(i)
      ? "selected"
      : overflowIndexes.includes(i)
      ? "selected_but_capped"
      : "rejected";
    acc.push({ normalizedTitle, originalTitle: c.title, status });
    return acc;
  }, []);

  data.rounds.push({ attempt, prompt, entries });
  writeFile(runId, data);
}

export function buildHistoryPromptBlock(runId: string, latestPrompt: string): string {
  const data = readFile(runId);
  const promptTrail = data.rounds
    .map((r, i) => `${i + 1}. ${r.prompt}`)
    .concat(`${data.rounds.length + 1}. ${latestPrompt} (latest)`)
    .join("\n");
  const titleBreakdown = data.rounds
    .map((r) => {
      const lines = r.entries
        .map((e) => {
          const label = e.status === "selected_but_capped"
            ? "SELECTED (DID NOT FIT — POOL WAS FULL)"
            : e.status.toUpperCase();
          return `  - [${label}] ${e.normalizedTitle}`;
        })
        .join("\n");
      return `Round ${r.attempt}:\n${lines}`;
    })
    .join("\n");
  return `Prompt trail (oldest to latest):\n${promptTrail}\n\nCase titles seen so far, labeled by what the user did with them. Note: anything marked "DID NOT FIT — POOL WAS FULL" was wanted by the user but never actually made it into the run — treat it the same as REJECTED for repetition purposes, it is eligible to be regenerated:\n${titleBreakdown}`;
}

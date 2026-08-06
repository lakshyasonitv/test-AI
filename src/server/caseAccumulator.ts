import fs from "fs";
import path from "path";
import type { AcceptedCasesFile } from "../schema/caseSelection.js";
import type { TestCase } from "../stages/testCases.js";

export const MAX_ACCUMULATED_CASES = Number(process.env.MAX_ACCUMULATED_CASES ?? 5);

const normalizeTitle = (title: string): string =>
  title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");

function filePath(runId: string): string {
  return path.join("runs", runId, "accepted-cases.json");
}

function readFile(runId: string): AcceptedCasesFile {
  const p = filePath(runId);
  if (!fs.existsSync(p)) return { runId, hasAcceptedPrimary: false, rounds: [] };
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeFile(runId: string, data: AcceptedCasesFile): void {
  const p = filePath(runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function appendAcceptedCases(
  runId: string,
  attempt: number,
  prompt: string,
  batch: TestCase[],
  selectedIndexes: number[]
): { accepted: TestCase[]; overflow: TestCase[]; overflowIndexes: number[] } {
  const data = readFile(runId);
  const currentTotal = data.rounds.reduce((n, r) => n + r.acceptedCases.length, 0);

  const accepted: TestCase[] = [];
  const overflow: TestCase[] = [];
  const overflowIndexes: number[] = [];
  let runningTotal = currentTotal;

  for (const i of selectedIndexes) {
    const c = batch[i];
    if (!c) continue; // out-of-range index — skip rather than throw
    if (runningTotal >= MAX_ACCUMULATED_CASES) {
      overflow.push(c);
      overflowIndexes.push(i);
      continue;
    }
    accepted.push(c);
    runningTotal++;
    if (c.fromPrompt) data.hasAcceptedPrimary = true;
  }

  if (accepted.length > 0 || overflow.length > 0) {
    data.rounds.push({
      attempt, prompt,
      acceptedCases: accepted,
      overflowIndexes,
    });
    writeFile(runId, data);
  }

  return { accepted, overflow, overflowIndexes };
}

export function getAllAcceptedCases(runId: string): TestCase[] {
  const data = readFile(runId);
  const seen = new Set<string>();
  const result: TestCase[] = [];
  for (const round of data.rounds) {
    for (const c of round.acceptedCases) {
      const key = normalizeTitle(c.title);
      if (!seen.has(key)) { seen.add(key); result.push(c); }
    }
  }
  return result;
}

export function hasAcceptedPrimary(runId: string): boolean {
  return readFile(runId).hasAcceptedPrimary;
}

export function remainingCapacity(runId: string): number {
  return MAX_ACCUMULATED_CASES - getAllAcceptedCases(runId).length;
}

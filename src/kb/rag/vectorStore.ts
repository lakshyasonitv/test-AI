import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { EmbeddedChunk, RagIndex } from "./types.js";

// Same "runs/_cache/*" location your kb/cache.ts already uses for AppModel caching.
const INDEX_PATH = path.join("runs", "_cache", "rag", "index.json");

export function loadIndex(): RagIndex | null {
  if (!existsSync(INDEX_PATH)) return null;
  try { return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as RagIndex; }
  catch { return null; }
}

export function saveIndex(index: RagIndex): void {
  mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function topKByScore(
  queryEmbedding: number[],
  chunks: EmbeddedChunk[],
  k: number,
): (EmbeddedChunk & { score: number })[] {
  return chunks
    .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
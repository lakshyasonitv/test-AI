import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = path.join("runs", "_cache", "llm");
const memCache = new Map<string, { data: unknown; ts: number }>();
const TTL_MS = 30 * 60 * 1000;

function hash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function llmCacheGet<T>(key: string): T | null {
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < TTL_MS) return mem.data as T;
  memCache.delete(key);

  const f = path.join(DIR, key + ".json");
  if (!existsSync(f)) return null;
  try {
    const data = JSON.parse(readFileSync(f, "utf8")) as T;
    memCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

export function llmCacheSet<T>(key: string, data: T): void {
  memCache.set(key, { data, ts: Date.now() });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, key + ".json"), JSON.stringify(data));
}

export function makeCacheKey(...parts: string[]): string {
  return hash(parts.join("|||"));
}

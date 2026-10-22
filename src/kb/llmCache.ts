import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { countCacheRead } from "../insights.js";
import crypto from "node:crypto";

/**
 * Namespaced on-disk cache.
 *
 * The namespace exists so one KIND of entry can be cleared without throwing away the rest. Every
 * entry used to live in `runs/_cache/llm/`, and since `makeCacheKey` hashes its inputs the keys
 * are opaque — there was no way to say "drop the browser walks but keep the concept labels".
 * That mattered once a poisoned walk could be cached (TD-85): the only remedy was deleting the
 * whole cache, including the LLM answers that cost real money.
 *
 * Existing entries under `llm/` are simply never read again by a namespaced caller. That is the
 * intended outcome here rather than a migration gap: the walk entries in there were written by
 * the code path this change fixes, so serving them would be serving the bug.
 */
const ROOT = path.join("runs", "_cache");
const DEFAULT_NS = "llm";
const memCache = new Map<string, { data: unknown; ts: number }>();

/**
 * The MEMORY half expires after 30 minutes. The DISK half does not expire at all — `llmCacheGet`
 * falls through to the file unconditionally — which is deliberate for LLM answers (they cost
 * money and the inputs are in the key) and was exactly wrong for browser walks, whose result
 * depends on things the key did not cover. See TD-85.
 */
const TTL_MS = 30 * 60 * 1000;
const MAX_MEM_ENTRIES = 500;

/**
 * The directory one namespace's entries live in.
 *
 * Exported because a reader outside this module needs it: `caseElementContext` enumerates the
 * `walks` namespace to recover element names when a case's source run is gone. One definition, so
 * the reader cannot drift from the writer.
 */
export function cacheNamespaceDir(ns: string): string { return nsDir(ns); }

/** Namespaces are used as directory names, so they are restricted rather than trusted. */
function nsDir(ns: string): string {
  if (!/^[a-z0-9_-]+$/i.test(ns)) throw new Error(`invalid cache namespace: ${ns}`);
  return path.join(ROOT, ns);
}

function hash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function llmCacheGet<T>(key: string, ns: string = DEFAULT_NS): T | null {
  // D-61: hit/miss per namespace for the run's insight summary. Free when EXTENDED_LOGGING is off.
  const found = readCache<T>(key, ns);
  countCacheRead(ns, found !== null);
  return found;
}

function readCache<T>(key: string, ns: string): T | null {
  const memKey = `${ns}/${key}`;
  const mem = memCache.get(memKey);
  if (mem && Date.now() - mem.ts < TTL_MS) return mem.data as T;
  memCache.delete(memKey);

  const f = path.join(nsDir(ns), key + ".json");
  if (!existsSync(f)) return null;
  try {
    const data = JSON.parse(readFileSync(f, "utf8")) as T;
    memCache.set(memKey, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

export function llmCacheSet<T>(key: string, data: T, ns: string = DEFAULT_NS): void {
  // Belt-and-suspenders: if a caller forgets to check isCacheableResult before writing,
  // refuse silently rather than persisting empty/whitespace results that would be served
  // forever (the disk cache never expires). This is a safety net, not the primary guard —
  // callers should check isCacheableResult explicitly so they can also throw/emit as needed.
  if (data === null || data === undefined) return;
  if (typeof data === "string" && !data.trim()) return;
  if (Array.isArray(data) && data.length === 0) return;
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.cases) && obj.cases.length === 0) return;
    if (Object.keys(obj).length === 0) return;
  }

  const memKey = `${ns}/${key}`;
  memCache.set(memKey, { data, ts: Date.now() });
  if (memCache.size > MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  const dir = nsDir(ns);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, key + ".json"), JSON.stringify(data));
}

/**
 * Drop every entry in one namespace, from disk AND from memory, and say how many went.
 *
 * The memory half matters as much as the disk half: a long-running server holds up to 500
 * entries, so clearing only the files would leave the poisoned answer being served from RAM for
 * another half hour and make the button look broken.
 */
export function llmCacheClear(ns: string): number {
  const dir = nsDir(ns);
  let removed = 0;
  try {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try { rmSync(path.join(dir, f)); removed++; } catch { /* leave it; report the rest */ }
      }
    }
  } catch { /* an unreadable directory is "nothing to clear", not a failure */ }
  for (const k of [...memCache.keys()]) {
    if (k.startsWith(`${ns}/`)) memCache.delete(k);
  }
  return removed;
}

export function makeCacheKey(...parts: string[]): string {
  return hash(parts.join("|||"));
}

/**
 * A stable, non-reversible fingerprint of credential VALUES, for use as a cache-key part.
 *
 * The values themselves must never enter a key: `makeCacheKey` hashes its parts together, but the
 * parts are joined in memory first and a key is not a safe place to reason about secrets. This
 * hashes them separately so only a digest is ever passed along. Returns "anon" when there are no
 * credentials, so a credentialled and an anonymous walk are still different keys.
 */
export function credentialFingerprint(creds?: { username?: string; password?: string }): string {
  if (!creds || (!creds.username && !creds.password)) return "anon";
  return hash(`${creds.username ?? ""}\t${creds.password ?? ""}`);
}

/**
 * "No answer" is never an answer worth caching. An empty result served from the disk cache
 * persists the absence forever — the cache never expires, so every later run is served the same
 * nothing, and the run that produced it (run 2026-09-16T07-10-56-871Z-2a364a79) showed exactly
 * this: llmUsage.calls === 0 and zero test cases, from a cached empty result nobody wrote
 * intentionally.
 *
 * Call this BEFORE every `llmCacheSet` call. It handles both raw strings (with `json: true` to
 * validate parseability) and already-parsed data (arrays, objects). A result that fails this
 * check must never enter memory or disk.
 */
export function isCacheableResult(content: unknown, opts?: { json?: boolean }): boolean {
  if (typeof content === "string") {
    if (!content.trim()) return false;
    if (opts?.json) {
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { return false; }
      return isCacheableParsed(parsed);
    }
    return true;
  }
  return isCacheableParsed(content);
}

function isCacheableParsed(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  if (data === null || data === undefined) return false;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // An object that claims to hold cases but has none: {"cases": []}
    if (Array.isArray(obj.cases) && obj.cases.length === 0) return false;
    // Completely empty object: {}
    if (Object.keys(obj).length === 0) return false;
    return true;
  }
  return false;
}

/**
 * The cache-version salt, included alongside provider/model in every cache key. Bumping it
 * invalidates all cached LLM results (the key changes for identical inputs). Defaults to "1"
 * so the default behaviour is identical to pre-fix; any value forces a clean cache because
 * the hash changes.
 */
export function llmCacheVersion(): string {
  return process.env.LLM_CACHE_VERSION ?? "1";
}

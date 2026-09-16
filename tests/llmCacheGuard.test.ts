import { describe, it, expect, afterEach } from "vitest";
import {
  isCacheableResult, llmCacheVersion, llmCacheSet, llmCacheGet, llmCacheClear, makeCacheKey,
} from "../src/kb/llmCache.js";

/**
 * The never-expiring disk cache must never be handed a negative result — "no answer" caches as
 * a permanent absence, and run 2026-09-16T07-10-56-871Z-2a364a79 was served exactly that (a
 * cached zero-case answer, llmUsage.calls === 0). These pin `isCacheableResult` (the guard every
 * write path must pass) and the belt inside `llmCacheSet` (a safety net if a caller forgets).
 */

describe("isCacheableResult — 'no answer' is never cacheable", () => {
  it("rejects the empty / whitespace string", () => {
    expect(isCacheableResult("")).toBe(false);
    expect(isCacheableResult("   \n\t  ")).toBe(false);
  });

  it("rejects '[]' when JSON was requested (parses to an empty array)", () => {
    expect(isCacheableResult("[]", { json: true })).toBe(false);
  });

  it("rejects '{\"cases\":[]}' (an object claiming cases, with none)", () => {
    expect(isCacheableResult('{"cases":[]}', { json: true })).toBe(false);
  });

  it("rejects unparseable JSON when JSON was requested", () => {
    expect(isCacheableResult("{not json", { json: true })).toBe(false);
  });

  it("keeps a non-empty raw JSON string cacheable", () => {
    expect(isCacheableResult('{"cases":[{"title":"Login"}]}', { json: true })).toBe(true);
    expect(isCacheableResult("plain prose", {})).toBe(true);
  });

  it("applies the same rules to already-parsed data (what call sites actually pass)", () => {
    expect(isCacheableResult([])).toBe(false);
    expect(isCacheableResult({})).toBe(false);
    expect(isCacheableResult({ cases: [] })).toBe(false);
    expect(isCacheableResult({ concepts: [], labeledElements: [] })).toBe(true); // valid discovery "nothing found"
    expect(isCacheableResult([{ title: "Login" }])).toBe(true);
    expect(isCacheableResult(null)).toBe(false);
    expect(isCacheableResult(undefined)).toBe(false);
  });
});

describe("llmCacheVersion — the manual invalidation salt", () => {
  afterEach(() => { delete process.env.LLM_CACHE_VERSION; });

  it("defaults to '1'", () => {
    delete process.env.LLM_CACHE_VERSION;
    expect(llmCacheVersion()).toBe("1");
  });

  it("reads the env value when set", () => {
    process.env.LLM_CACHE_VERSION = "2";
    expect(llmCacheVersion()).toBe("2");
  });

  it("a version change produces a different key for identical inputs", () => {
    delete process.env.LLM_CACHE_VERSION;
    const key1 = makeCacheKey("same prompt", "same model", llmCacheVersion());
    process.env.LLM_CACHE_VERSION = "2";
    const key2 = makeCacheKey("same prompt", "same model", llmCacheVersion());
    expect(key1).not.toBe(key2);
  });
});

describe("llmCacheSet belt — refuses to persist negative results even if a caller forgets", () => {
  const NS = "llm-test-guard";
  afterEach(() => { llmCacheClear(NS); });

  it("does not write an empty array, null, undefined, or a whitespace string", () => {
    llmCacheSet("empty-arr", [], NS);
    llmCacheSet("null", null, NS);
    llmCacheSet("undef", undefined, NS);
    llmCacheSet("space", "   ", NS);
    llmCacheSet("cases-empty", { cases: [] }, NS);
    llmCacheSet("obj-empty", {}, NS);
    for (const k of ["empty-arr", "null", "undef", "space", "cases-empty", "obj-empty"]) {
      expect(llmCacheGet<any>(k, NS)).toBeNull();
    }
  });

  it("still writes a valid payload", () => {
    llmCacheSet("valid", [{ title: "Login" }], NS);
    expect(llmCacheGet<any>("valid", NS)).toEqual([{ title: "Login" }]);
  });
});
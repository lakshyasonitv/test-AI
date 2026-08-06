import { describe, it, expect } from "vitest";
import { collectCrawlTargets, MAX_DISCOVERY_PAGES } from "../src/stages/hybridDiscovery.js";

const ENTRY = "https://example.com/";

describe("collectCrawlTargets", () => {
  it("returns only same-origin http(s) URLs, absolute or relative", () => {
    const out = collectCrawlTargets(
      ["/cart", "https://example.com/login", "https://other.com/evil", "javascript:void(0)"],
      ENTRY,
      new Set(),
    );
    expect(out).toEqual(["https://example.com/cart", "https://example.com/login"]);
  });

  it("strips fragments so /cart#top and /cart are the same page", () => {
    const out = collectCrawlTargets(["/cart#top", "/cart#bottom"], ENTRY, new Set());
    expect(out).toEqual(["https://example.com/cart"]);
  });

  it("skips asset and file-download paths", () => {
    const out = collectCrawlTargets(
      ["/logo.png", "/spec.pdf", "/app.js", "/styles.css", "/data.json", "/movie.mp4", "/font.woff2", "/cart"],
      ENTRY,
      new Set(),
    );
    expect(out).toEqual(["https://example.com/cart"]);
  });

  it("never returns the same URL twice and marks queued URLs visited", () => {
    const visited = new Set<string>();
    const out = collectCrawlTargets(["/cart", "/cart", "/checkout"], ENTRY, visited);
    expect(out).toEqual(["https://example.com/cart", "https://example.com/checkout"]);
    expect(visited.has("https://example.com/cart")).toBe(true);
    expect(visited.has("https://example.com/checkout")).toBe(true);
  });

  it("respects URLs the caller already visited", () => {
    const visited = new Set(["https://example.com/cart"]);
    const out = collectCrawlTargets(["/cart", "/checkout"], ENTRY, visited);
    expect(out).toEqual(["https://example.com/checkout"]);
  });

  it("ignores empty strings and returns nothing for a bad entry url", () => {
    expect(collectCrawlTargets(["", "   "], ENTRY, new Set())).toEqual([]);
    expect(collectCrawlTargets(["/cart"], "::nonsense::", new Set())).toEqual([]);
    expect(collectCrawlTargets([], ENTRY, new Set())).toEqual([]);
  });
});

describe("MAX_DISCOVERY_PAGES", () => {
  it("is a sane positive bound", () => {
    expect(Number.isInteger(MAX_DISCOVERY_PAGES)).toBe(true);
    expect(MAX_DISCOVERY_PAGES).toBeGreaterThanOrEqual(1);
  });
});

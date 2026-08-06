import { describe, it, expect } from "vitest";
import { extractCrawlResponse } from "../src/stages/domExtract.js";

// Regression: an <a>/<button>/<input>/<select>/<textarea> that ALSO carries an explicit
// `role` attribute was extracted twice — once by the tag-based loop, once by the
// role-based `[role]` loop — under two different, non-colliding dedup keys. That produced
// duplicate interactive_elements with identical role+name, which downstream becomes a
// duplicate AppModel element and a Playwright "strict mode: matched 2 elements" failure.
describe("extractCrawlResponse — interactive element dedup", () => {
  it("does not double-emit an <a> that also carries an explicit role attribute", () => {
    const html = `<html><body><a href="/cart" role="tab">Cart</a></body></html>`;
    const result = extractCrawlResponse(html, "https://example.com", 200);
    const matches = result.interactive_elements.filter((e) => e.name === "Cart");
    expect(matches.length).toBe(1);
  });

  it("still extracts a role-only element with no interactive tag exactly once", () => {
    const html = `<html><body><div role="tab">Overview</div></body></html>`;
    const result = extractCrawlResponse(html, "https://example.com", 200);
    const matches = result.interactive_elements.filter((e) => e.name === "Overview");
    expect(matches.length).toBe(1);
  });
});

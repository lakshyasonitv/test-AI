import { describe, it, expect } from "vitest";
import { extractCrawlResponse } from "../src/stages/domExtract.js";

describe("extractCrawlResponse interactive elements", () => {
  // Regression: the tag loop (a/button/input/select/textarea) and the [role] loop used
  // disjoint dedupe keys (selector || role:name:index vs role:name), so any control that
  // also carried an explicit role — e.g. <a role="tab"> — was emitted twice with the same
  // role+name. Duplicate AppModel elements then triggered Playwright strict-mode
  // "resolved to 2 elements" failures in generated tests.
  it("emits a control with an explicit role exactly once", () => {
    const res = extractCrawlResponse(
      '<a role="tab" aria-label="Events" href="/events">Events</a>',
      "https://example.test",
      200,
    );
    const tabs = res.interactive_elements.filter((e) => e.role === "tab" && e.name === "Events");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tag).toBe("a");
  });

  it("still emits role-carrying non-control elements (div/span/nav)", () => {
    const res = extractCrawlResponse(
      '<div role="menuitem">About</div><nav role="navigation" aria-label="Main">…</nav>',
      "https://example.test",
      200,
    );
    const menuitem = res.interactive_elements.filter((e) => e.role === "menuitem" && e.name === "About");
    expect(menuitem).toHaveLength(1);
    expect(menuitem[0].tag).toBe("div");
  });

  it("emits plain controls (no explicit role) exactly once", () => {
    const res = extractCrawlResponse(
      '<button>Sign in</button><a href="/home">Home</a>',
      "https://example.test",
      200,
    );
    expect(res.interactive_elements.filter((e) => e.role === "button" && e.name === "Sign in")).toHaveLength(1);
    expect(res.interactive_elements.filter((e) => e.role === "link" && e.name === "Home")).toHaveLength(1);
  });
});

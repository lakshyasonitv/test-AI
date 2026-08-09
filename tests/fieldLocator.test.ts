import { describe, it, expect } from "vitest";
import { resolveCode, fieldHint, nearFieldSelector } from "../src/stages/targetResolver.js";
import { generateSpec } from "../src/stages/generator.js";
import type { IR } from "../src/schema/ir.js";

const ir = (steps: any[]): IR =>
  ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" },
    steps,
  }) as unknown as IR;

// Regression for the learnvibes run (2026-08-08T11-52-35-503Z-0981bd0c):
//   await page.getByText('Name').first().fill("test")
//   -> locator resolved to <label>Full Name</label>
//   -> "Element is not an <input>, <textarea>, <select> or [contenteditable]"
// getByText matches the element CONTAINING the text, which for a labelled field is the label.
// For fill/select/check that isn't a weak choice, it's a category error.
describe("field locators", () => {
  it("never resolves a fill through getByText", () => {
    const code = resolveCode({ text: "Name" }, "fill");
    expect(code).not.toContain("getByText");
    expect(code).toContain("field(page,");
  });

  it("still resolves a click through the normal text path", () => {
    const code = resolveCode({ text: "Read more" }, "click");
    expect(code).toContain("getByText");
  });

  // A role+name whose name was inferred from an adjacent <div> cannot be found by
  // getByRole — the DOM has no such accessible name — so field actions must not take that
  // path even when role+name are both present.
  it("routes a role+name fill through the field helper too", () => {
    const code = resolveCode({ role: "textbox", name: "Full Name" }, "fill");
    expect(code).toContain(`field(page, "Full Name")`);
    expect(code).not.toContain("getByRole");
  });

  // A selector discovery actually verified is stronger than any name guess and still wins.
  it("prefers a verified css selector over the field helper", () => {
    const code = resolveCode({ css: "#full-name", name: "Full Name" }, "fill");
    expect(code).toContain(`page.locator("#full-name")`);
    expect(code).not.toContain("field(page,");
  });

  it("reads the hint from whichever slot carries it", () => {
    expect(fieldHint({ label: "A", name: "B", text: "C" })).toBe("A");
    expect(fieldHint({ name: "B", text: "C" })).toBe("B");
    expect(fieldHint({ text: "C" })).toBe("C");
  });

  // The positional rung is the only one that can reach a control with no accessible name at
  // all. :text() matches on substring, which is what lets "Name" find "Full Name".
  it("builds a positional selector restricted to form controls", () => {
    const sel = nearFieldSelector("Full Name");
    expect(sel).toContain(`input:near(:text("Full Name"), 120)`);
    expect(sel).toContain("textarea:near(");
    expect(sel).toContain("select:near(");
  });

  it("injects the field helper into a spec that fills, and not into one that doesn't", () => {
    const withFill = generateSpec(ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { text: "Name" }, value: "test" },
    ]));
    expect(withFill).toContain("async function field(page, hint)");

    const noFill = generateSpec(ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Go" } },
    ]));
    expect(noFill).not.toContain("async function field(page, hint)");
  });
});

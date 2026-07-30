import { describe, it, expect } from "vitest";
import { isPureTextAssertion } from "../src/stages/liveExtend.js";
import type { Step } from "../src/schema/ir.js";

const step = (o: Partial<Step>): Step => ({ id: "s1", action: "assert", ...o }) as Step;

describe("isPureTextAssertion", () => {
  it("is true for a text-only visible assertion", () => {
    expect(isPureTextAssertion(step({ target: { text: "Your password is invalid!" }, assertion: "visible" }))).toBe(true);
  });

  it("is true for text-only hidden/text_contains/text_equals", () => {
    for (const assertion of ["hidden", "text_contains", "text_equals"] as const) {
      expect(isPureTextAssertion(step({ target: { text: "x" }, assertion }))).toBe(true);
    }
  });

  it("is false once role or name is present — groundingError already covers that", () => {
    expect(isPureTextAssertion(step({ target: { text: "x", role: "heading", name: "x" }, assertion: "visible" }))).toBe(false);
    expect(isPureTextAssertion(step({ target: { role: "button", name: "Login" }, assertion: "visible" }))).toBe(false);
  });

  it("is false for a non-assert action", () => {
    expect(isPureTextAssertion(step({ action: "click", target: { text: "x" } }))).toBe(false);
  });

  it("is false for url_contains — value-based, not text-based", () => {
    expect(isPureTextAssertion(step({ target: { url: "/x" }, assertion: "url_contains" }))).toBe(false);
  });

  it("is false with no target at all", () => {
    expect(isPureTextAssertion(step({ assertion: "visible" }))).toBe(false);
  });
});

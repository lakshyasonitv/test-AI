import { describe, it, expect } from "vitest";
import { assertionContradictsCase } from "../src/stages/ir.js";
import { withTargetApp } from "../src/runTarget.js";

// TD-132: run 2026-10-15T18-02-40's case was category "valid", but its expected text said "the user
// is not left on the BLANK form screen". NEGATIVE_CASE matched "blank", the success assertion was
// rejected twice, and the case ended on a url_contains that proved nothing.
const caseFrom18_02: any = {
  title: "Express interest end-to-end with valid data (multi-screen)", category: "valid",
  expected: "A visible Thank You or confirmation message is shown after submitting the interest form, and the user is not left on the blank form screen.",
  steps: ["s"], priority: "high", feature: "EOI",
};
const ir: any = { meta: {}, steps: [
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "assert", target: { text: "Thank You" }, assertion: "visible" },
] };

describe("a category-\"valid\" case is never treated as negative (Salesforce run, TD-132)", () => {
  it("its success assertion is accepted, whatever words its expected text uses", () => {
    expect(withTargetApp("salesforce", () => assertionContradictsCase(ir, caseFrom18_02))).toBeNull();
  });

  it("an ordinary run is unchanged: the wording rule still applies there", () => {
    expect(assertionContradictsCase(ir, caseFrom18_02)?.stepIds).toEqual(["s2"]);
  });

  it("a genuinely negative category is still caught on a Salesforce run", () => {
    const negative = { ...caseFrom18_02, title: "Required field left empty", category: "Empty required fields" };
    expect(withTargetApp("salesforce", () => assertionContradictsCase(ir, negative))?.stepIds).toEqual(["s2"]);
  });

  it("a case with NO category still falls back to the wording rule", () => {
    const uncategorised = { ...caseFrom18_02, category: undefined };
    expect(withTargetApp("salesforce", () => assertionContradictsCase(ir, uncategorised))?.stepIds).toEqual(["s2"]);
  });
});

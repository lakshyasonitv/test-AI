import { describe, it, expect } from "vitest";
import { classify } from "../src/stages/classify.js";

// Regression: the old /resolved to/i check matched Playwright's "resolved to 0 elements"
// line too, so a truly-missing element was misclassified as "timeout" instead of
// "element_missing" — making element_missing (and its self-heal trigger) unreachable.
describe("classify — timeout with a locator resolution count", () => {
  it("classifies 'resolved to 0 elements' as element_missing", () => {
    const t = 'Timeout 10000ms exceeded.\nwaiting for getByRole(\'button\', { name: \'Checkout\' })\nlocator resolved to 0 elements';
    expect(classify(t)?.category).toBe("element_missing");
  });

  it("classifies 'resolved to 1 element' + hidden as element_not_interactable", () => {
    const t = 'Timeout 10000ms exceeded.\nwaiting for getByRole(\'button\', { name: \'Checkout\' })\nlocator resolved to 1 element\n- element is not visible';
    expect(classify(t)?.category).toBe("element_not_interactable");
  });

  it("classifies 'resolved to 2 elements' with no visibility signal as timeout", () => {
    const t = 'Timeout 10000ms exceeded.\nwaiting for getByRole(\'button\', { name: \'Checkout\' })\nlocator resolved to 2 elements';
    expect(classify(t)?.category).toBe("timeout");
  });

  it("classifies a timeout with no 'resolved to' line at all as element_missing", () => {
    const t = 'Timeout 10000ms exceeded.\nwaiting for getByRole(\'button\', { name: \'Checkout\' })';
    expect(classify(t)?.category).toBe("element_missing");
  });
});

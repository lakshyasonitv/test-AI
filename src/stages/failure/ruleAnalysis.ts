import type { Diagnosis } from "../failureAnalysis.js";
import type { ExecResult } from "../executor.js";
import { errorTextFrom } from "../failureAnalysis.js";

export function ruleAnalysis(result: ExecResult): Diagnosis | null {
  const text = errorTextFrom(result).toLowerCase();

  const multiple =
    /resolved to \d+ elements/i.test(text) ||
    text.includes("strict mode violation");

  if (multiple) {
    return {
      failingStepId: null,
      category: "selector_changed",
      explanation: "Locator resolved to multiple elements.",
      suggestedFix: "Disambiguate the locator using visibility or a parent container."
    };
  }

  if (
    text.includes("received: hidden") ||
    text.includes("element is not visible") ||
    text.includes("display: none") ||
    text.includes("visibility:hidden")
  ) {
    return {
      failingStepId: null,
      category: "element_missing",
      explanation: "Element exists but is hidden.",
      suggestedFix: "Scroll, expand menus, dismiss overlays or wait for visibility."
    };
  }

  if (text.includes("navigation timeout")) {
    return {
      failingStepId: null,
      category: "timeout",
      explanation: "Navigation timed out.",
      suggestedFix: "Check network conditions and page load performance."
    };
  }

  if (text.includes("locator timeout") || text.includes(".waitfor(")) {
    return {
      failingStepId: null,
      category: "timeout",
      explanation: "Locator wait timed out — element never appeared.",
      suggestedFix: "Verify the element exists on the page and is not behind a loading state."
    };
  }

  if (text.includes("expect timeout") || text.includes("tohavetext") || text.includes("tobevisible")) {
    return {
      failingStepId: null,
      category: "timeout",
      explanation: "Assertion timed out — expected condition never met.",
      suggestedFix: "Check if the expected state is reachable within the timeout period."
    };
  }

  if (text.includes("timeout")) {
    return {
      failingStepId: null,
      category: "timeout",
      explanation: "Operation timed out.",
      suggestedFix: "Wait for network idle or correct the locator."
    };
  }

  return null;
}

import type { IR } from "../schema/ir.js";

// Single source of truth for the failure-category vocabulary — failureAnalysis.ts's zod
// schema imports this rather than defining its own list, so the deterministic and
// LLM-fallback paths can never drift out of sync with each other.
export const KNOWN_CATEGORIES = [
  "selector_changed", "element_missing", "element_hidden", "multiple_matches",
  "detached", "timeout", "assertion_failed", "navigation_error", "network", "other",
] as const;
export type FailureCategory = typeof KNOWN_CATEGORIES[number];

export interface ClassifiedFailure {
  category: FailureCategory;
  explanation: string;
  suggestedFix: string;
}

/**
 * Deterministic (no AI) classification of a Playwright failure, from the real error text
 * Playwright itself produces. Covers the failure shapes that have a distinctive, stable
 * error-message signature — the majority of real failures in practice — so a Gemini call
 * is spent only on genuinely ambiguous cases. failureAnalysis.ts's analyzeFailure() is the
 * FALLBACK now, called only when this returns null — see orchestrator.ts's failure_analysis
 * step. "Gemini last, not first."
 *
 * Every branch here is anchored to a real Playwright error string this project has
 * actually seen in production — see the SKIT run (a jQuery UI tab reported "hidden" while
 * carrying aria-selected="true") that prompted this module. Order matters: more specific
 * patterns are checked before generic ones so a specific signature never falls through to
 * a vaguer bucket that also happens to match.
 */
export function classify(errorText: string): ClassifiedFailure | null {
  const t = errorText;

  if (/strict mode violation/i.test(t)) {
    return {
      category: "multiple_matches",
      explanation: "The locator matched more than one element on the page — Playwright's strict mode rejects an ambiguous match rather than guessing which one was meant.",
      suggestedFix: "Narrow the target (a more specific role/name, or scope the locator to a container) so it resolves to exactly one element.",
    };
  }

  if (/not attached to the DOM|element is not attached/i.test(t)) {
    return {
      category: "detached",
      explanation: "The element was found and then removed or replaced in the DOM — commonly a client-side re-render — before the action or assertion completed.",
      suggestedFix: "Re-query the locator immediately before interacting with it instead of reusing a handle captured earlier, or wait for the re-render to settle first.",
    };
  }

  if (/toBeVisible\(\)\s*failed/i.test(t) && /Received:\s*hidden/i.test(t)) {
    return {
      category: "element_hidden",
      explanation: "The element resolved in the DOM but was not visible (display:none, zero dimensions, or a hidden ancestor) for the entire assertion timeout.",
      suggestedFix: "Check whether the element needs a preceding interaction to become visible (open a menu/tab/accordion first), or is simply slow to render — a settle wait after navigation, or scrolling it into view, is often enough.",
    };
  }

  if (/toBeHidden\(\)\s*failed/i.test(t) && /Received:\s*visible/i.test(t)) {
    return {
      category: "assertion_failed",
      explanation: "The element was expected to become hidden but was still visible — most often because the preceding action didn't actually complete, or didn't have the intended effect.",
      suggestedFix: "Confirm the preceding action step actually succeeded and had the expected effect on this specific element before this assertion runs.",
    };
  }

  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(t)) {
    return {
      category: "network",
      explanation: "The browser could not complete a network request (DNS failure, connection refused, or similar) — a connectivity issue, not a problem with the test's selectors or assertions.",
      suggestedFix: "Verify the target URL is reachable from wherever this run executes, and that nothing (firewall, proxy, VPN) is blocking it.",
    };
  }

  if (/toHaveURL/i.test(t)) {
    return {
      category: "navigation_error",
      explanation: "The page's URL after navigation didn't match what was expected.",
      suggestedFix: "Confirm the navigation actually completed (no redirect loop, no blocked navigation) and that the expected URL pattern is still correct for the current site.",
    };
  }

  if (/Timeout\s+\d+ms\s+exceeded/i.test(t) && /waiting for (getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)/i.test(t)) {
    // "resolved to" present means the element WAS found — the assertion condition just
    // never became true — as opposed to never being found at all (handled below).
    if (/resolved to/i.test(t)) {
      return {
        category: "timeout",
        explanation: "The locator resolved to an element, but the expected assertion state was never reached within the timeout.",
        suggestedFix: "Increase the timeout if the app is simply slow, or re-check whether the asserted condition is actually the right success signal for this step.",
      };
    }
    return {
      category: "element_missing",
      explanation: "No element matching this role/name was ever found on the page during the entire retry window.",
      suggestedFix: "The element may have been renamed, moved behind another interaction, or removed entirely — worth a fresh look at the live page.",
    };
  }

  if (/Timeout\s+\d+ms\s+exceeded/i.test(t)) {
    return {
      category: "timeout",
      explanation: "The step exceeded its timeout without a more specific, recognizable error signature.",
      suggestedFix: "Check whether the page is slow to load or respond, or whether the awaited condition can actually occur at all.",
    };
  }

  return null; // inconclusive by pattern alone — let Gemini take a look, as a fallback
}

/**
 * Best-effort: identify which IR step a Playwright error refers to, from the `Locator:`
 * line Playwright itself prints (e.g. `Locator:  getByRole('tab', { name: 'Events' })`),
 * matched back to the IR step whose target carries the same role+name. Deterministic — no
 * LLM call — and reliable precisely because generator.ts's `locate()`/resolveCode() always
 * emit getByRole/getByText calls built directly from a step's own target fields, so the
 * round-trip back to a step id is exact whenever the pattern is found. Returns null (not a
 * guess) when the error text doesn't contain a recognizable locator line — analyzeFailure's
 * Gemini fallback is better equipped to infer a step id from context in that case.
 */
export function findFailingStepId(ir: IR, errorText: string): string | null {
  const roleMatch = errorText.match(/getByRole\(\s*'([^']+)'\s*,\s*\{\s*name:\s*'([^']*)'/);
  if (roleMatch) {
    const [, role, name] = roleMatch;
    const step = ir.steps.find(
      (s) => s.target?.role?.toLowerCase() === role.toLowerCase() && s.target?.name === name
    );
    if (step) return step.id;
  }
  const textMatch = errorText.match(/getByText\(\s*'([^']*)'/);
  if (textMatch) {
    const [, text] = textMatch;
    const step = ir.steps.find((s) => s.target?.text === text || s.target?.name === text);
    if (step) return step.id;
  }
  return null;
}
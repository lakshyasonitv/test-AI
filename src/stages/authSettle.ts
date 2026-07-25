import type { Page } from "playwright";
import type { Step } from "../schema/ir.js";

/** Normalize a string for matching: lowercase, collapse whitespace, trim. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns true if the step is an auth-triggering action (click/press on a button
 * whose accessible name matches common login/submit vocabulary).
 */
export function isAuthTriggeringStep(step: Step): boolean {
  if (step.action !== "click" && step.action !== "press") return false;
  const name = step.target?.name;
  if (!name) return false;
  const n = norm(name);
  // Exact match against common auth verbs (normalized).
  return /^(sign\s*in|log\s*in|login|authenticate|submit)$/.test(n);
}

/**
 * Wait for an auth-triggering navigation to settle.
 * - First waits for a URL change (indicating a redirect happened).
 * - If no URL change within a short window, falls back to waiting for network idle.
 * - Bounded total time; on timeout, proceeds without throwing so the caller
 *   can continue with the existing "ungrounded, retry live-extend" path.
 */
export async function waitForAuthSettle(page: Page, timeoutMs = 8000): Promise<void> {
  const startUrl = page.url();
  // Phase 1: wait for URL to change (fast path for real redirects).
  try {
    await page.waitForURL((url) => url.toString() !== startUrl, { timeout: Math.min(timeoutMs, 3000) });
    return;
  } catch {
    // URL didn't change within the short window; fall through to network idle.
  }
  // Phase 2: wait for network idle (SPA may mutate state without URL change).
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  } catch {
    // Ignore timeout; the caller will handle ungrounded steps via its existing logic.
  }
}
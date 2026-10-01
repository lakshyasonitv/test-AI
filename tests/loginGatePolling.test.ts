import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { waitForLoginGateToClear, hasLoginGate, verifySession } from "../src/stages/hybridDiscovery.js";

/**
 * Verifying a sign-in must POLL, not sample — TECH_DEBT.md TD-107.
 *
 * WHAT IT WAS. `verifySession` asked `hasLoginGate` once at +600ms, and once more at +800ms after
 * re-navigating. `hasLoginGate` is `locator(...).count() > 0` — an instant read with no waiting.
 *
 * THE EVIDENCE. On learnvibes.vercel.app (a Supabase app: `supabase`/`jwt`/`localStorage` in the
 * bundle, no cookies set), discovery reported `auth.status: "login-failed"` and produced a ONE-page
 * model — while the generated spec's own login case PASSED with the same credentials in the same
 * run. The spec asks the identical question as `expect(locator).toBeHidden({ timeout: 10000 })`,
 * which POLLS. Supabase keeps its session in `localStorage` and resolves it ASYNCHRONOUSLY on load,
 * so after a navigation the app renders its unauthenticated view until `getSession()` settles and
 * then redirects. One sample lands inside that window; a poll rides through it.
 *
 * Downstream that single sample is expensive: a `login-failed` verdict means the crawl runs
 * anonymously, the model is the login page alone, and every generated case truncates — reported as
 * broken tests rather than as a login problem.
 *
 * WHY EXECUTED IN A REAL BROWSER (DECISIONS.md D-19). The whole defect is a timing relationship
 * between a DOM that changes late and a check that reads early. A unit test with a fake page would
 * be asserting my own model of the race, which is exactly the thing that was wrong. These pages
 * remove the password field on a timer, which is the real shape.
 */

let browser: Browser;

beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** A login form whose password field is removed after `clearAfterMs` — an app resolving a session. */
const gatePage = async (clearAfterMs: number | null): Promise<Page> => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <form><input type="email" placeholder="you@example.com" />
    <input type="password" id="pw" placeholder="********" />
    <button type="submit">Sign In</button></form>
    <script>
      ${clearAfterMs === null ? "" : `setTimeout(function(){ document.getElementById("pw").remove(); }, ${clearAfterMs});`}
    </script></body></html>`);
  return page;
};

describe("waitForLoginGateToClear — executed (D-19)", () => {
  it("rides through a gate that clears LATER than the old 800ms sample", async () => {
    // The regression, in its exact shape: the field is still there at 800ms and gone by ~1.6s.
    const page = await gatePage(1600);
    expect(await hasLoginGate(page), "sanity: the gate is up at t=0").toBe(true);
    expect(await waitForLoginGateToClear(page, 8000),
      "a session that resolved at 1.6s was reported as a failed login").toBe(true);
    await page.close();
  }, 60_000);

  it("reproduces the old behaviour when the budget is tiny — proving the budget is what fixed it", async () => {
    // Negative control built into the test: same page, 500ms budget, and it fails exactly as the
    // single 600/800ms sample did. The page is unchanged; only the waiting changed.
    const page = await gatePage(1600);
    expect(await waitForLoginGateToClear(page, 500)).toBe(false);
    await page.close();
  }, 60_000);

  it("returns true immediately when there was never a gate", async () => {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><p>dashboard</p></body></html>");
    const started = Date.now();
    expect(await waitForLoginGateToClear(page, 8000)).toBe(true);
    expect(Date.now() - started, "an already-clear page must not wait out the budget").toBeLessThan(2000);
    await page.close();
  }, 60_000);

  it("still reports failure for a gate that never clears — a real rejected login", async () => {
    // The honest red. Polling must not turn a failed sign-in green; it only costs the full budget
    // before saying so, which is TD-31's own argument for its hydration poll.
    const page = await gatePage(null);
    expect(await waitForLoginGateToClear(page, 1200)).toBe(false);
    await page.close();
  }, 60_000);

  it("ignores a hidden password field, so a honeypot is not read as a gate", async () => {
    // PASSWORD_INPUT carries `:visible` for this reason; the poll must inherit it rather than
    // waiting out the budget on an invisible anti-bot input.
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <input type="password" style="display:none" /><p>dashboard</p></body></html>`);
    expect(await waitForLoginGateToClear(page, 1500)).toBe(true);
    await page.close();
  }, 60_000);
});

describe("verifySession uses the poll", () => {
  it("accepts an in-place login whose form clears late", async () => {
    // In-place auth (the url never changes) returns before any re-navigation, so this exercises the
    // FIRST of the two samples — the one that used to fire at +600ms.
    const page = await gatePage(1500);
    const url = page.url();
    expect(await verifySession(page, url),
      "an in-place login that cleared at 1.5s was rejected").toBe(true);
    await page.close();
  }, 60_000);

  it("still rejects a form that never clears", async () => {
    const page = await gatePage(null);
    process.env.AUTH_VERIFY_TIMEOUT_MS = "1200";
    try {
      expect(await verifySession(page, page.url())).toBe(false);
    } finally {
      delete process.env.AUTH_VERIFY_TIMEOUT_MS;
    }
    await page.close();
  }, 60_000);
});

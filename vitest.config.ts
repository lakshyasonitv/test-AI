import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our own tests. `runs/` holds generated Playwright specs (playwright.config.ts
    // points its testDir there) — vitest must never try to execute those.
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "runs/**", "artifacts/**"],
    environment: "node",
    /**
     * Above vitest's 5s default, because this suite is no longer what that default assumes.
     *
     * It used to be pure functions only. It is not: `DECISIONS.md` D-19 — "a generated Playwright
     * expression isn't verified until it's run once" — means a growing number of these files
     * launch a real Chromium, and several more dynamically import whole pipeline stages. Under
     * parallel load that pushes a test BODY past five seconds while it is still importing, and
     * vitest kills it.
     *
     * The symptom was a suite that failed 1-3 tests per run with `Test timed out in 5000ms`, on a
     * different set of files each time, every one of which passed in isolation. That is a flaky
     * suite, and a flaky suite is worse than a slow one: it trains you to re-run instead of read.
     *
     * 20s is still a bound, not a removal — a genuine hang is caught, roughly four times faster
     * than the 100s the executor allows a real Playwright run. Raise it only with evidence; if a
     * single unit test needs more than this, the test is doing too much.
     */
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our own tests. `runs/` holds generated Playwright specs (playwright.config.ts
    // points its testDir there) — vitest must never try to execute those.
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "runs/**", "artifacts/**"],
    // Pure functions only: no network, no browser. Anything needing either belongs in an
    // end-to-end run, not here.
    environment: "node",
  },
});

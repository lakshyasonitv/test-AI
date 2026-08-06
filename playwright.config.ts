import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./runs",
  timeout: 50_000,
  retries: 0,
  reporter: [["json", { outputFile: "results.json" }], ["list"]],
  use: {
    headless: true,
    // retain-on-failure, not "on": a full trace per passing run was ~0.5 MB each and made up
    // ~80% of the runs/ folder. Traces matter for debugging failures; a passing run doesn't
    // need one. screenshot stays "on" — the UI shows it for every result and it's tiny.
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
  },
});

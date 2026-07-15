import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./runs",
  timeout: 30_000,
  retries: 0,
  reporter: [["json", { outputFile: "results.json" }], ["list"]],
  use: {
    headless: true,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
});

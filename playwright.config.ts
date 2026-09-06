import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./runs",
  // TD-24: this used to be hardcoded and silently ignore PLAYWRIGHT_TIMEOUT, which executor.ts
  // documented setting but nothing ever read. Now genuinely configurable; unset, the default
  // (50000) is unchanged from before this line existed.
  timeout: Number(process.env.PLAYWRIGHT_TIMEOUT) || 50_000,
  retries: 0,
  reporter: [["json", { outputFile: "results.json" }], ["list"]],
  use: {
    headless: true,
    // retain-on-failure, not "on": a full trace per passing run was ~0.5 MB each and made up
    // ~80% of the runs/ folder. Traces matter for debugging failures; a passing run doesn't
    // need one. screenshot stays "on" — the UI shows it for every result and it's tiny.
    trace: "retain-on-failure",
    screenshot: "on",
    // TD-71: recording starts when the CONTEXT is created, so a missing ffmpeg does not degrade
    // to "no video" — it stops browserContext.newPage() outright and reports a valid case as a
    // test failure. executor.ts probes for the binary and sets PLAYWRIGHT_VIDEO=off when it is
    // absent, so the run still happens. Unset (the normal case) this is unchanged.
    video: process.env.PLAYWRIGHT_VIDEO === "off" ? "off" : "retain-on-failure",
  },
});

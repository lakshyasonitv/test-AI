import { defineConfig } from "@playwright/test";
import { chromiumLaunchOptions, browserContextOptions } from "./src/browserLaunch.js";

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
    // `PLAYWRIGHT_VIDEO=on` records every case, not just failures. It exists because
    // "retain-on-failure" means Playwright DELETES the recording of any test it considers passed
    // — and `blocked` / `truncated` / `truncated_no_assertion` are all cases Playwright passed
    // and the pipeline then reclassified. So those cards could never show a video: there was
    // never a file, and no UI change could conjure one.
    //
    // Defaults to "retain-on-failure" (platform rule 2 — a new capability ships off), because it
    // is not free: a video is recorded for EVERY case including passing ones, on a deployment
    // whose storage is ephemeral. Same reasoning that put `trace` on retain-on-failure, where a
    // per-passing-run trace was ~80% of the runs/ folder.
    //
    // "off" is checked FIRST and stays absolute: executor.ts sets it when ffmpeg is missing, and
    // that is a hard capability limit, not a preference — `on` must never override it.
    video: process.env.PLAYWRIGHT_VIDEO === "off" ? "off"
      : process.env.PLAYWRIGHT_VIDEO === "on" ? "on"
        : "retain-on-failure",
    // Same flags the four in-process chromium.launch() sites get (src/browserLaunch.ts), so
    // the generated spec's browser — launched by the Playwright runner, not by the pipeline —
    // carries CHROMIUM_EXTRA_ARGS too. Empty when the var is unset.
    launchOptions: chromiumLaunchOptions(),
    // locale + timezoneId, so a spec EXECUTES under the same locale its
    // AppModel was DISCOVERED under. Without this the pipeline pins four browsers and the fifth —
    // the one that actually runs the test — inherits the host's, which is where a locator
    // generated against one language meets a page rendered in another.
    //
    // This config is loaded by the Playwright child process, which has no AsyncLocalStorage rail
    // to read, so it resolves from RUN_LOCALE / RUN_TIMEZONE in its environment. executor.ts sets
    // both on the child from the run's own locale. Spreads to {} when RUN_LOCALE="" — the same
    // rollback switch every other consumer has.
    ...browserContextOptions(),
  },
});

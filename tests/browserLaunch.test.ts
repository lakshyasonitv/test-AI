import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromiumLaunchOptions } from "../src/browserLaunch.js";

/**
 * CHROMIUM_EXTRA_ARGS reaches all five browser-launching consumers through one helper:
 * the four in-process `chromium.launch()` sites (domDiscovery, hybridDiscovery x2, liveExtend)
 * and playwright.config.ts's `use.launchOptions`, which the generated spec's Playwright runner
 * reads. The four call sites all pass `chromiumLaunchOptions()` directly, so testing the helper
 * covers them; the config is the only consumer that transforms the value itself, so it is
 * imported and asserted against rather than assumed.
 *
 * Per CLAUDE.md's central rule, this checks behavior structure (the exact args array each
 * consumer would hand Chromium) rather than grepping source text.
 */

const FLAGS = ["--disable-dev-shm-usage", "--no-sandbox"];

beforeEach(() => {
  delete process.env.CHROMIUM_EXTRA_ARGS;
});

afterEach(() => {
  delete process.env.CHROMIUM_EXTRA_ARGS;
});

describe("chromiumLaunchOptions", () => {
  it.each([undefined, "", "   "])("returns { args: [] } when the var is unset/empty (%j)", (v) => {
    if (v !== undefined) process.env.CHROMIUM_EXTRA_ARGS = v;
    expect(chromiumLaunchOptions()).toEqual({ args: [] });
  });

  it("splits a space-separated value into individual flags", () => {
    process.env.CHROMIUM_EXTRA_ARGS = FLAGS.join(" ");
    expect(chromiumLaunchOptions()).toEqual({ args: FLAGS });
  });

  it("drops runs of whitespace and empty tokens", () => {
    process.env.CHROMIUM_EXTRA_ARGS = "  --one   --two\t--three\n  ";
    expect(chromiumLaunchOptions().args).toEqual(["--one", "--two", "--three"]);
  });

  it("re-reads the variable on every call, never caches", () => {
    expect(chromiumLaunchOptions()).toEqual({ args: [] });
    process.env.CHROMIUM_EXTRA_ARGS = "--disable-dev-shm-usage";
    expect(chromiumLaunchOptions().args).toEqual(["--disable-dev-shm-usage"]);
  });
});

describe("all five consumers receive the same array", () => {
  it("playwright.config.ts launchOptions match the helper, unset", async () => {
    vi.resetModules();
    const { default: config } = await import("../playwright.config.js");
    const launch = (config.use as { launchOptions?: { args?: string[] } }).launchOptions;
    expect(launch?.args).toEqual(chromiumLaunchOptions().args);
    expect(launch?.args).toEqual([]);
  });

  it("playwright.config.ts launchOptions match the helper, set", async () => {
    vi.resetModules();
    process.env.CHROMIUM_EXTRA_ARGS = FLAGS.join(" ");
    const { default: config } = await import("../playwright.config.js");
    const launch = (config.use as { launchOptions?: { args?: string[] } }).launchOptions;
    expect(launch?.args).toEqual(chromiumLaunchOptions().args);
    expect(launch?.args).toEqual(FLAGS);
  });
});
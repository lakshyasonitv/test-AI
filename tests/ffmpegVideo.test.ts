import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegAvailable, resetFfmpegProbe, warnIfNoVideo } from "../src/stages/executor.js";

/**
 * A missing ffmpeg must cost the video, not the run — TECH_DEBT.md TD-71.
 *
 * THE DEFECT. `playwright.config.ts` records video, and Playwright starts the recorder when the
 * browser CONTEXT is created. So a missing ffmpeg does not degrade to "no video" — it stops the
 * context opening:
 *
 *     browserContext.newPage: Executable doesn't exist at …\ms-playwright\ffmpeg-1010\ffmpeg-win64.exe
 *
 * Every case in run `2026-08-31T06-56-52-852Z-7943ebb2` died that way ~960 ms in, before a single
 * `page.goto`. Because `screenshot: "on"` still fired, the UI showed a blank white 4,331-byte PNG
 * and called it a test failure. Nothing about the site under test was wrong.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` is the seam: the probe honours it, so these tests can point at a
 * synthetic directory and assert on both answers without touching the real install.
 */

let dir: string;
const ORIGINAL = process.env.PLAYWRIGHT_BROWSERS_PATH;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ffprobe-"));
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  resetFfmpegProbe();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = ORIGINAL;
  resetFfmpegProbe();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("ffmpegAvailable", () => {
  it("reports available when the binary is present", () => {
    mkdirSync(path.join(dir, "ffmpeg-1010"), { recursive: true });
    writeFileSync(path.join(dir, "ffmpeg-1010", "ffmpeg-win64.exe"), "binary");
    mkdirSync(path.join(dir, "chromium-1148"), { recursive: true });
    expect(ffmpegAvailable().ok).toBe(true);
  });

  it("reports MISSING when the browsers dir has chromium but no ffmpeg — the shipped failure", () => {
    // Exactly the state the reported run was in: an interrupted `playwright install` had landed
    // chromium and stopped before ffmpeg, which is last in browsers.json's install order.
    mkdirSync(path.join(dir, "chromium-1148"), { recursive: true });
    mkdirSync(path.join(dir, "chromium_headless_shell-1148"), { recursive: true });
    expect(ffmpegAvailable().ok).toBe(false);
  });

  it("reports MISSING when the ffmpeg directory exists but is empty", () => {
    // A download that created the folder and then stalled. The folder existing is not the
    // question — the binary inside it is.
    mkdirSync(path.join(dir, "ffmpeg-1010"), { recursive: true });
    expect(ffmpegAvailable().ok).toBe(false);
  });

  it("errs toward available when the browsers directory does not exist at all", () => {
    // Cannot tell. Turning video off for a run that could have had it is a real cost; assuming
    // present costs nothing, because the run then behaves exactly as it does today.
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dir, "nope");
    resetFfmpegProbe();
    expect(ffmpegAvailable().ok).toBe(true);
  });

  it("memoizes — a real run globs the disk once, not once per case", () => {
    mkdirSync(path.join(dir, "chromium-1148"), { recursive: true });
    expect(ffmpegAvailable().ok).toBe(false);
    // Add the binary WITHOUT resetting: the cached answer must stand.
    mkdirSync(path.join(dir, "ffmpeg-1010"), { recursive: true });
    writeFileSync(path.join(dir, "ffmpeg-1010", "ffmpeg-linux"), "binary");
    expect(ffmpegAvailable().ok).toBe(false);
    resetFfmpegProbe();
    expect(ffmpegAvailable().ok).toBe(true);
  });
});

describe("warnIfNoVideo", () => {
  it("says nothing when ffmpeg is present", () => {
    mkdirSync(path.join(dir, "ffmpeg-1010"), { recursive: true });
    writeFileSync(path.join(dir, "ffmpeg-1010", "ffmpeg-linux"), "binary");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfNoVideo();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("names the command that fixes it, once", () => {
    mkdirSync(path.join(dir, "chromium-1148"), { recursive: true });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfNoVideo();
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain("npx playwright install");
    // The reassurance matters as much as the command: the failure mode being fixed is a person
    // reading "test failed" and going to look at their website.
    expect(msg).toMatch(/still run|still pass/i);
    spy.mockRestore();
  });
});

describe("playwright.config.ts honours PLAYWRIGHT_VIDEO", () => {
  const ORIGINAL_VIDEO = process.env.PLAYWRIGHT_VIDEO;
  afterEach(() => {
    if (ORIGINAL_VIDEO === undefined) delete process.env.PLAYWRIGHT_VIDEO;
    else process.env.PLAYWRIGHT_VIDEO = ORIGINAL_VIDEO;
    vi.resetModules();
  });

  it("records by default — the existing behaviour is unchanged when the var is unset", async () => {
    delete process.env.PLAYWRIGHT_VIDEO;
    vi.resetModules();
    const cfg = (await import("../playwright.config.js")).default as any;
    expect(cfg.use.video).toBe("retain-on-failure");
  });

  it("turns recording off when executor.ts sets the var", async () => {
    process.env.PLAYWRIGHT_VIDEO = "off";
    vi.resetModules();
    const cfg = (await import("../playwright.config.js")).default as any;
    expect(cfg.use.video).toBe("off");
    // Screenshots and traces must NOT be collateral damage — they are what the UI shows.
    expect(cfg.use.screenshot).toBe("on");
    expect(cfg.use.trace).toBe("retain-on-failure");
  });
});

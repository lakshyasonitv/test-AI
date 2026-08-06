import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findScreenshot } from "../src/stages/executor.js";

// Regression: findScreenshot used to return the FIRST .png found by a directory walk, which
// was always step-1.png (the pre-action frame) for any multi-step case — so every case in a
// run showed the same generic screenshot regardless of what it actually tested. Confirmed on
// a real run: a 4-step "navigate to Services" case showed the homepage, not the Services page.
describe("findScreenshot", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("prefers the LAST numbered step screenshot, not the first file found", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "find-shot-"));
    // A subdirectory (mirrors Playwright's own per-test attachment dir, which sorts before
    // "step-*.png" alphabetically) must not win over a real numbered step either.
    const sub = path.join(dir, "2026-08-06T00-00-00-000Z-some-test-name");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "test-finished-1.png"), "x");
    writeFileSync(path.join(dir, "step-1.png"), "x");
    writeFileSync(path.join(dir, "step-2.png"), "x");
    writeFileSync(path.join(dir, "step-10.png"), "x"); // numeric, not lexicographic, sort
    writeFileSync(path.join(dir, "step-3.png"), "x");

    expect(findScreenshot(dir)).toBe(path.join(dir, "step-10.png"));
  });

  it("falls back to the DFS walk when no numbered step screenshot exists", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "find-shot-"));
    const sub = path.join(dir, "some-subdir");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "only-shot.png"), "x");

    expect(findScreenshot(dir)).toBe(path.join(sub, "only-shot.png"));
  });

  it("returns null when the directory doesn't exist", () => {
    expect(findScreenshot(path.join(os.tmpdir(), "definitely-not-a-real-dir-xyz"))).toBeNull();
  });
});

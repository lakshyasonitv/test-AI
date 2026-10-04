import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pruneVideosForPassedCases, type CaseRunResult } from "../src/stages/suiteRunner.js";

/**
 * Videos for blocked and unconfirmed cases — the half that could not be done in the UI.
 *
 * WHY A PRUNE AND NOT A SETTING. Playwright decides recording when the CONTEXT is created, before
 * any outcome exists, so no mode means "keep a video for the cases I will later find interesting".
 * `retain-on-failure` keeps only what PLAYWRIGHT failed — and `blocked`, `truncated` and
 * `truncated_no_assertion` are every one of them cases Playwright PASSED and the pipeline
 * reclassified afterwards. By the time `computeCaseStatus` runs the file is already gone, which is
 * why those cards could never show a video however the frontend was changed.
 *
 * So: record everything (`PLAYWRIGHT_VIDEO=on`), then delete the one outcome nobody debugs. `passed`
 * is also the common case, so that is where all the storage saving is.
 */

let runDir: string;

const caseDir = (id: string) => path.join(runDir, "cases", id);

/** A video where Playwright really puts one: nested under a generated slug dir. */
const putVideo = (id: string, sub = "artifacts"): string => {
  const dir = path.join(caseDir(id), sub, "a1b2c3");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "video.webm");
  writeFileSync(f, "fake-webm");
  return f;
};

const result = (caseId: string, status: CaseRunResult["status"]): CaseRunResult =>
  ({ caseId, title: caseId, status, irPath: "", resultPath: "" }) as CaseRunResult;

beforeEach(() => {
  runDir = path.join(os.tmpdir(), `prune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(runDir, { recursive: true });
  process.env.PLAYWRIGHT_VIDEO = "on";
});

afterEach(() => {
  delete process.env.PLAYWRIGHT_VIDEO;
  rmSync(runDir, { recursive: true, force: true });
});

describe("pruneVideosForPassedCases", () => {
  it("KEEPS the recordings for blocked and unconfirmed — the whole point of the request", () => {
    const blocked = putVideo("c-blocked");
    const unconfirmed = putVideo("c-unconfirmed");
    const partial = putVideo("c-partial");
    pruneVideosForPassedCases([
      result("c-blocked", "blocked"),
      result("c-unconfirmed", "truncated_no_assertion"),
      result("c-partial", "truncated"),
    ], runDir);
    expect(existsSync(blocked), "a blocked case lost its video").toBe(true);
    expect(existsSync(unconfirmed), "an unconfirmed case lost its video").toBe(true);
    expect(existsSync(partial), "a partial case lost its video").toBe(true);
  });

  it("keeps a failed case's recording, exactly as retain-on-failure already did", () => {
    const failed = putVideo("c-failed");
    pruneVideosForPassedCases([result("c-failed", "failed")], runDir);
    expect(existsSync(failed)).toBe(true);
  });

  it("deletes a passed case's recording — the outcome nobody debugs, and the common one", () => {
    const passed = putVideo("c-passed");
    expect(pruneVideosForPassedCases([result("c-passed", "passed")], runDir)).toBe(1);
    expect(existsSync(passed)).toBe(false);
  });

  it("prunes a passed case's HEALED recording too, so a heal leaves nothing behind", () => {
    const healed = putVideo("c-healed", path.join("healed", "artifacts"));
    const original = putVideo("c-healed");
    pruneVideosForPassedCases([result("c-healed", "passed")], runDir);
    expect(existsSync(healed)).toBe(false);
    expect(existsSync(original)).toBe(false);
  });

  it("prunes only the passed cases in a mixed run", () => {
    const kept = putVideo("keep-me");
    const gone = putVideo("drop-me");
    pruneVideosForPassedCases([result("drop-me", "passed"), result("keep-me", "blocked")], runDir);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("does NOTHING when PLAYWRIGHT_VIDEO is not 'on' — nothing extra was recorded to prune", () => {
    // Under the default retain-on-failure a passed case has no video anyway, so a prune that ran
    // regardless would only be a pointless directory walk on every run.
    delete process.env.PLAYWRIGHT_VIDEO;
    const f = putVideo("c-passed");
    expect(pruneVideosForPassedCases([result("c-passed", "passed")], runDir)).toBe(0);
    expect(existsSync(f), "pruned while the flag was off").toBe(true);
  });

  it("is a no-op, not a throw, when a case has no video or no directory at all", () => {
    expect(() => pruneVideosForPassedCases([
      result("never-ran", "passed"), result("also-missing", "blocked"),
    ], runDir)).not.toThrow();
    expect(pruneVideosForPassedCases([result("never-ran", "passed")], runDir)).toBe(0);
  });

  it("runs BEFORE the summary is built, so no card can link a deleted file", () => {
    // buildSuiteSummary resolves videoUrl by looking for the file. Pruning after it would leave a
    // card pointing at a recording that no longer exists — a broken player instead of no player.
    const src = require("node:fs").readFileSync(
      new URL("../src/stages/suiteRunner.ts", import.meta.url), "utf8") as string;
    expect(src.indexOf("pruneVideosForPassedCases(results, runDir);"))
      .toBeLessThan(src.indexOf("const summary = buildSuiteSummary(results, runDir);"));
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { playwrightOutcomeLine } from "../src/orchestrator.js";

/**
 * Guards for the STEP 2 log-prose fixes. Two kinds of assertion live here, and they are labelled
 * so a reader knows which is which:
 *
 *  - BEHAVIOURAL, for `playwrightOutcomeLine`: the function is called and its real output checked,
 *    so reverting the verdict logic turns the test red.
 *  - SOURCE guards, for the lines that only ever existed as prose. These read the emitted source
 *    and assert the over-claim is gone. They are NOT behavioural — they cannot catch a reworded
 *    over-claim — but they do fail if the exact fix is reverted, which is what a regression guard
 *    for a wording change can honestly offer. Every one was mutation-tested (fix removed -> RED,
 *    restored -> GREEN) per the project's standing rule.
 */

const SRC = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const DB = SRC("db.ts");
const HYBRID = SRC("stages/hybridDiscovery.ts");
const LIVE = SRC("stages/liveExtend.ts");

describe("playwrightOutcomeLine (behavioural)", () => {
  it("distinguishes a parsed report from a bare exit code on a PASS", () => {
    // The bug class: exit 0 with no report (browser never launched, or killed) read as PASSED.
    expect(playwrightOutcomeLine(true, true)).toBe("PASSED (report parsed)");
    const noReport = playwrightOutcomeLine(true, false);
    expect(noReport).toContain("PASSED BY EXIT CODE ONLY");
    expect(noReport).toContain("UNVERIFIED");
    expect(noReport).not.toBe("PASSED (report parsed)");
  });

  it("distinguishes a parsed report from a bare exit code on a FAIL", () => {
    expect(playwrightOutcomeLine(false, true)).toBe("FAILED (report parsed)");
    const noReport = playwrightOutcomeLine(false, false);
    expect(noReport).toContain("FAILED - no report parsed");
    expect(noReport).toContain("timeout");
    expect(noReport).not.toBe("FAILED (report parsed)");
  });

  it("all four combinations are distinct — none collapse to a bare PASSED/FAILED", () => {
    const all = [
      playwrightOutcomeLine(true, true),
      playwrightOutcomeLine(true, false),
      playwrightOutcomeLine(false, true),
      playwrightOutcomeLine(false, false),
    ];
    expect(new Set(all).size).toBe(4);
    for (const line of all) expect(line).not.toBe("PASSED");
    for (const line of all) expect(line).not.toBe("FAILED");
  });
});

describe("shadow divergence line says what the two sides actually are (source guard)", () => {
  it("says 'at least' and 'field(s)', not a bare count of divergences", () => {
    expect(DB).toContain("[shadow] at least ");
    expect(DB).toContain("divergence field(s)");
    // The old line claimed equality of populations it never had.
    expect(DB).not.toContain("divergence(s) between disk and database");
  });

  it("names the disk side as the caller's visible set and the DB side as unscoped", () => {
    expect(DB).toContain("visible");
    expect(DB).toContain("deliberately NOT scoped");
  });
});

describe("auth outcome distinguishes a crashed probe from a confirmed no-gate (source guard)", () => {
  it("carries a detection error into the no-gate AuthOutcome instead of reporting it flat", () => {
    expect(HYBRID).toContain("gateDetectionError");
    expect(HYBRID).toContain("Login-gate detection threw");
  });

  it("stops asserting the login values were wrong when all it saw was a surviving password field", () => {
    expect(HYBRID).not.toContain("Check the values are correct for this site");
    expect(HYBRID).toContain("it is not proof the values are wrong");
  });

  it("carries the authenticated-but-empty-model hedge into auth.detail", () => {
    expect(HYBRID).toContain("the model contains ONLY the login page");
  });
});

describe("crawl and near-miss lines state the real condition (source guard)", () => {
  it("says 'no crawlable links from its hrefs', not 'no links'", () => {
    expect(HYBRID).toContain("no crawlable links from its hrefs");
    expect(HYBRID).not.toContain(": no links, found ");
  });

  it("states findVerbatim's length slack instead of claiming only presentation differed", () => {
    expect(LIVE).toContain("up to max(16, half the guess) characters longer");
    expect(LIVE).not.toContain("differs only in case/punctuation/whitespace");
    expect(LIVE).toContain("TECH_DEBT.md TD-115");
  });
});

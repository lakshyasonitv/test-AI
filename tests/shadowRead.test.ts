import { describe, it, expect } from "vitest";
import { diffRuns, isDbEnabled, type DbRunRow } from "../src/db.js";
import type { RunSummary } from "../src/runStore.js";

// Step 3.2's comparison logic. This decides whether Step 3.3 (flipping authority to the database)
// is safe to do, so it is tested directly rather than only through a live database — which would
// make the test depend on a service-role secret and on network access.

const T = Date.parse("2026-08-20T10:00:00.000Z");

function disk(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "2026-08-20T10-00-00-000Z-aaaaaaaa",
    url: "https://example.com",
    prompt: "check the homepage",
    status: "passed",
    startedAt: T,
    hasEvents: true,
    ...over,
  };
}

function row(over: Partial<DbRunRow> = {}): DbRunRow {
  return {
    id: "2026-08-20T10-00-00-000Z-aaaaaaaa",
    url: "https://example.com",
    prompt: "check the homepage",
    status: "passed",
    started_at: new Date(T).toISOString(),
    ...over,
  };
}

describe("shadow read — diffRuns", () => {
  it("reports nothing when disk and database agree (the state Step 3.3 is gated on)", () => {
    expect(diffRuns([disk()], [row()])).toEqual([]);
  });

  it("flags a run present on disk but missing from the database", () => {
    const out = diffRuns([disk()], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("missing from database");
  });

  it("flags a status disagreement, naming both sides", () => {
    const out = diffRuns([disk({ status: "failed" })], [row({ status: "passed" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("status differs");
    expect(out[0]).toContain("disk=failed");
    expect(out[0]).toContain("db=passed");
  });

  it("flags url and prompt disagreements independently", () => {
    const out = diffRuns(
      [disk()],
      [row({ url: "https://elsewhere.com", prompt: "something else" })],
    );
    expect(out).toHaveLength(2);
    expect(out.some((p) => p.includes("url differs"))).toBe(true);
    expect(out.some((p) => p.includes("prompt differs"))).toBe(true);
  });

  it("treats a NULL database column as an empty string rather than a false mismatch", () => {
    const out = diffRuns([disk({ prompt: "", url: "" })], [row({ prompt: null, url: null })]);
    expect(out).toEqual([]);
  });

  it("flags a database row newer than the oldest on disk that disk doesn't have", () => {
    const newer = new Date(T + 60_000).toISOString();
    const out = diffRuns([disk()], [row(), row({ id: "ghost", started_at: newer })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("present in database but not on disk: ghost");
  });

  // The regression this guards: disk is capped at the newest 20 while the database holds every
  // run (51 today). Without the window check, every older database row would be reported as a
  // divergence on every single call, burying any real one.
  it("does NOT flag database rows older than disk's 20-run window", () => {
    const older = new Date(T - 86_400_000).toISOString();
    const out = diffRuns([disk()], [row(), row({ id: "old-run", started_at: older })]);
    expect(out).toEqual([]);
  });

  it("does not flag a database row whose started_at is unparseable", () => {
    const out = diffRuns([disk()], [row(), row({ id: "weird", started_at: "not-a-date" })]);
    expect(out).toEqual([]);
  });
});

describe("shadow read — DB_ENABLED flag", () => {
  it("defaults to off, so nothing contacts the database", () => {
    const original = process.env.DB_ENABLED;
    delete process.env.DB_ENABLED;
    expect(isDbEnabled()).toBe(false);
    process.env.DB_ENABLED = "false";
    expect(isDbEnabled()).toBe(false);
    if (original === undefined) delete process.env.DB_ENABLED;
    else process.env.DB_ENABLED = original;
  });
});

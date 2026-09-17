import { describe, it, expect } from "vitest";
import { summariseMissingRun } from "../src/runStore.js";

/**
 * Runs that exist in the database but whose `runs/<id>/` directory is gone.
 *
 * WHY. `listRuns` builds History from DISK (`allRunIds().slice(0, 20).map(summariseRun)`), so a run
 * whose directory has been removed silently disappears while its row remains. On a container with
 * ephemeral storage that is most of them — measured on this project: **207 run rows in the
 * database, 16 directories on disk**. The disappearance reads as "no runs happened" rather than
 * "the artifacts are gone".
 *
 * `diffRuns` in `src/db.ts` has always detected exactly this (`present in database but not on
 * disk: <id>`) and, by its own comment, "never blocks or alters the response" — it only logs.
 *
 * SCOPE, deliberately: this is NOT Step 3.3 (flipping read authority to the database), which four
 * phase reports record as deferred by agreement and gated on a soak. Disk stays authoritative for
 * everything it still holds; these rows are APPENDED and marked, never substituted.
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: "2026-09-17T11-55-50-219Z-0a948aa9",
  prompt: "test the checkout flow",
  url: "https://www.saucedemo.com",
  status: "passed",
  started_at: "2026-09-17T11:55:50.219Z",
  ...over,
}) as Parameters<typeof summariseMissingRun>[0];

describe("summariseMissingRun", () => {
  it("carries what the row knows and marks the artifacts gone", () => {
    const s = summariseMissingRun(row());
    expect(s.runId).toBe("2026-09-17T11-55-50-219Z-0a948aa9");
    expect(s.prompt).toBe("test the checkout flow");
    expect(s.url).toBe("https://www.saucedemo.com");
    expect(s.status).toBe("passed");
    expect(s.startedAt).toBe(Date.parse("2026-09-17T11:55:50.219Z"));
    // The flag the UI branches on. Present and false — never true, never absent, on this path.
    expect(s.artifactsAvailable).toBe(false);
    // There is no event log to replay and no suite breakdown to read: both came from disk.
    expect(s.hasEvents).toBe(false);
    expect(s.suite).toBeUndefined();
  });

  it("preserves every status the database actually stores", () => {
    // Exactly the five values present in the live runs table, all of which are already legal
    // RunSummary statuses — so none needs translating and none may be silently dropped.
    for (const status of ["passed", "failed", "error", "incomplete", "truncated_no_assertion"]) {
      expect(summariseMissingRun(row({ status })).status).toBe(status);
    }
  });

  it("falls back to incomplete for a null or unknown status", () => {
    // A row written by a process that crashed mid-run, or a status this build does not know.
    // "incomplete" is what summariseRun defaults to for the same situation on disk.
    expect(summariseMissingRun(row({ status: null })).status).toBe("incomplete");
    expect(summariseMissingRun(row({ status: "something-new" })).status).toBe("incomplete");
  });

  it("survives null prompt/url/date without producing NaN or undefined", () => {
    // These columns are all nullable. A NaN startedAt would sort unpredictably against real runs
    // and render as "Invalid Date"; empty strings are what the disk summariser produces too.
    const s = summariseMissingRun(row({ prompt: null, url: null, started_at: null }));
    expect(s.prompt).toBe("");
    expect(s.url).toBe("");
    expect(s.startedAt).toBe(0);
    expect(Number.isFinite(s.startedAt)).toBe(true);
  });

  it("sorts correctly against ordinary summaries", () => {
    // The route merges both kinds on recency before capping at 20, so a missing run must order by
    // its real timestamp rather than sinking to the bottom.
    const older = summariseMissingRun(row({ id: "old", started_at: "2026-07-28T00:00:00.000Z" }));
    const newer = summariseMissingRun(row({ id: "new", started_at: "2026-09-17T00:00:00.000Z" }));
    const sorted = [older, newer].sort((a, b) => b.startedAt - a.startedAt);
    expect(sorted.map((s) => s.runId)).toEqual(["new", "old"]);
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { listRuns } from "../src/runStore.js";

/**
 * TD-186. `/api/runs` reads the folder list, then summarises each folder. A folder deleted in
 * between (DELETE /api/runs/:runId, retention, or in CI another test file's cleanup) threw ENOENT
 * out of summariseRun and failed the WHOLE History list with a 500 — tenancy.test.ts's
 * "/api/runs exactly as before" failed that way on CI on 2026-11-04. Such a run is now skipped.
 */

const tag = `${process.pid}-${Date.now()}`;
const made: string[] = [];
const run = (name: string, files: Record<string, string>) => {
  const id = `0000-listrace-${tag}-${name}`;
  const dir = path.join("runs", id);
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
  made.push(id);
  return id;
};
// No 00-input.json or events.ndjson in any of these: allRunIds() lists only folders with one, so other
// test files listing runs/ at the same time never see (or trip over) this file's folders.
const summary = JSON.stringify({ total: 1, passed: 1, failed: 0 });
afterAll(() => { for (const id of made) rmSync(path.join("runs", id), { recursive: true, force: true }); });

describe("listRuns while run folders are being deleted", () => {
  it("skips a run whose folder is gone instead of failing the whole list", () => {
    const kept = run("kept", { "07-suite-summary.json": summary });
    const gone = `0000-listrace-${tag}-gone`; // listed, then deleted before it was read
    expect(listRuns([gone, kept]).map((r) => r.runId)).toEqual([kept]);
  });

  it("still returns twenty runs when one of the newest twenty has gone", () => {
    const ids = Array.from({ length: 21 }, (_, i) => run(`n${String(i).padStart(2, "0")}`, { "07-suite-summary.json": summary }));
    const listed = listRuns([ids[0], `0000-listrace-${tag}-gone2`, ...ids.slice(1)]);
    expect(listed).toHaveLength(20);
    expect(listed.map((r) => r.runId)).toEqual(ids.slice(0, 20));
  });

  it("still throws for a run that is broken but not being deleted", () => {
    const corrupt = run("corrupt", { "07-suite-summary.json": "{not json" });
    expect(() => listRuns([corrupt])).toThrow(SyntaxError);
  });

  it("never throws while another process deletes the folders it is reading", async () => {
    // Another process, as in production and CI: makes and deletes run folders as fast as it can.
    // Files are written by rename, so a read sees a whole file or none — only DELETION is raced.
    const ids = Array.from({ length: 6 }, (_, i) => `0000-listrace-${tag}-churn${i}`);
    made.push(...ids);
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs"), path = require("path");
      const ids = ${JSON.stringify(ids)};
      const end = Date.now() + 2500;
      for (let k = 0; Date.now() < end; k++) {
        const dir = path.join("runs", ids[k % ids.length]);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, ".s"), '{"total":1,"passed":1,"failed":0}');
        fs.renameSync(path.join(dir, ".s"), path.join(dir, "07-suite-summary.json"));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    `], { stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", r));
    let calls = 0;
    const errors: string[] = [];
    const stopAt = Date.now() + 2000;
    while (Date.now() < stopAt) {
      try { listRuns(ids); } catch (err) { errors.push(String((err as Error).message)); }
      calls++;
      await new Promise((r) => setImmediate(r));
    }
    await exited;
    expect(calls).toBeGreaterThan(50);
    expect(errors).toEqual([]);
  }, 30_000);
});

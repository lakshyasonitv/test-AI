import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateSpec } from "../src/stages/generator.js";
import { runSpec } from "../src/stages/executor.js";
import type { IR } from "../src/schema/ir.js";

/**
 * TD-185, run for real (D-19). With `testDir: "./runs"`, every spec start walked every folder under
 * runs/ before running, and a folder another run (or another test file) deleted during that walk
 * ended the spec with "ENOENT: no such file or directory, scandir 'runs/…'" before any step ran —
 * the cause of `suiteParallelBrowser`'s intermittent CI failure on 2026-11-04. The executor now
 * points testDir at the spec's own folder. Here folders are created and deleted under runs/ the
 * whole time three specs run; each must still pass.
 */

const PAGE = `data:text/html,${encodeURIComponent("<main><h1>Scan race</h1><p id='p'>ready</p></main>")}`;
const ir = (title: string): IR => ({
  meta: { feature: "f", title, priority: "high", sourcePrompt: "p", baseUrl: PAGE },
  steps: [
    { id: "s1", action: "navigate", target: { url: PAGE } },
    { id: "s2", action: "assert", assertion: "visible", target: { text: "ready" } },
  ],
} as unknown as IR);

const root = path.join("runs", `0000-scanrace-${process.pid}-${Date.now()}`);
const churnBase = path.join("runs", `0000-scanrace-churn-${process.pid}`);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (let i = 0; i < 12; i++) rmSync(`${churnBase}-${i}`, { recursive: true, force: true });
});

describe("a spec run while other runs' folders come and go", () => {
  it("is not ended by another folder disappearing under runs/", async () => {
    let i = 0;
    let stop = false;
    // Another "run" making and deleting folders under runs/ as fast as it can, the whole time.
    const churn = (async () => {
      while (!stop) {
        const d = `${churnBase}-${i++ % 12}`;
        mkdirSync(path.join(d, "a", "b"), { recursive: true });
        writeFileSync(path.join(d, "a", "b", "f.txt"), "x");
        rmSync(d, { recursive: true, force: true });
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      const results = await Promise.all(["A", "B", "C"].map((n) => {
        const dir = path.join(root, n);
        mkdirSync(dir, { recursive: true });
        return runSpec(generateSpec(ir(`scan race ${n}`), path.join(dir, "artifacts")), dir, {});
      }));
      expect(results.map((r) => r.passed)).toEqual([true, true, true]);
    } finally {
      stop = true;
      await churn;
    }
  }, 240_000);
});

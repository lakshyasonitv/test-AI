import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactStoreEnabled, uploadableFiles } from "../src/artifactStore.js";

describe("artifactStore", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("keeps screenshots and report inputs, skips video and trace", () => {
    const run = mkdtempSync(path.join(os.tmpdir(), "art-"));
    dirs.push(run);
    const put = (rel: string, body = "x") => {
      const p = path.join(run, ...rel.split("/"));
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    };
    put("00-input.json"); put("events.ndjson"); put("07-suite-summary.json");
    put("cases/case-0/05-result.json"); put("cases/case-0/artifacts/step-1.png");
    put("cases/case-0/generated/test.spec.ts");
    put("cases/case-0/artifacts/slug/video.webm"); put("cases/case-0/artifacts/slug/trace.zip");
    put("cases/case-0/artifacts/raw.bin");
    expect(uploadableFiles(run).sort()).toEqual([
      "00-input.json", "07-suite-summary.json", "cases/case-0/05-result.json",
      "cases/case-0/artifacts/step-1.png", "cases/case-0/generated/test.spec.ts", "events.ndjson",
    ]);
  });

  it("is off when ARTIFACTS_TO_SUPABASE=false, whatever the database says", () => {
    const prev = process.env.ARTIFACTS_TO_SUPABASE;
    process.env.ARTIFACTS_TO_SUPABASE = "false";
    try { expect(artifactStoreEnabled()).toBe(false); }
    finally { if (prev === undefined) delete process.env.ARTIFACTS_TO_SUPABASE; else process.env.ARTIFACTS_TO_SUPABASE = prev; }
  });
});

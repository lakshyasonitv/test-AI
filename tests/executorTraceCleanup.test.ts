import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scrubServedSecrets } from "../src/stages/executor.js";

// D-63: a Playwright child KILLED by the executor's safety timeout never zips its trace, so the
// trace.zip removal found nothing and the raw trace stayed under artifacts/.playwright-artifacts-*:
// `traces/*.trace` and `*.network` record every request URL, the frontdoor sign-in URL (and its
// access token) included, and the folder is served under /runs like the rest of artifacts/.
// Layout taken from run 2026-10-24T21-26-12-355Z-15cbc64f. Made-up canary values only.
describe("scrubServedSecrets: a killed run's trace files", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const fixture = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "zq-trace-cleanup-"));
    const artifactsDir = path.join(dir, "artifacts");
    const work = path.join(artifactsDir, ".playwright-artifacts-0");
    const traces = path.join(work, "traces");
    mkdirSync(path.join(traces, "resources"), { recursive: true });
    const url = "https://zqcanary-dev-ed.scratch.my.salesforce.com/secur/frontdoor.jsp?sid=zqcanarytoken0123456789";
    const files = {
      trace: path.join(traces, "6d18-972c.trace"),
      network: path.join(traces, "6d18-972c.network"),
      networkCopy: path.join(traces, "6d18-972c-pwnetcopy-1.network"),
      resource: path.join(traces, "resources", "0122931fb054.json"),
      chunk: path.join(work, "4a96673ffebf111de8fa784e5d14fe5e.zip"),
      video: path.join(work, "66ee060e642606cef6507d8603d72623.webm"),
    };
    for (const f of Object.values(files)) writeFileSync(f, `{"url":"${url}"}`, "utf8");
    return { artifactsDir, resultsJson: path.join(dir, "results.json"), url, files };
  };

  it("removes the trace, network and resource files on a frontdoor run, and keeps the video", () => {
    const { artifactsDir, resultsJson, url, files } = fixture();
    scrubServedSecrets(null, artifactsDir, resultsJson, [], { SF_FRONTDOOR_URL: url });
    for (const f of [files.trace, files.network, files.networkCopy, files.resource, files.chunk]) {
      expect(existsSync(f), f).toBe(false);
    }
    expect(existsSync(files.video)).toBe(true);
  });

  it("touches nothing on a run without an org connection", () => {
    const { artifactsDir, resultsJson, files } = fixture();
    scrubServedSecrets(null, artifactsDir, resultsJson, [], {});
    for (const f of Object.values(files)) expect(existsSync(f)).toBe(true);
  });
});

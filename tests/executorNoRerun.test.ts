import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A test the safety timer killed is never run again.
 *
 * Run 2026-11-03T05-07-28-369Z-388aa153: the timer killed Playwright mid-teardown, no results.json
 * existed, and runSpec treated that like a failed start and ran the WHOLE spec again, so the org saw
 * every step twice. Mocks only `spawn`, as tests/executorChildEnv.test.ts does.
 */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { runSpec } from "../src/stages/executor.js";
import { FRONTDOOR_ENV } from "../src/stages/salesforceFrontdoor.js";

let runDir = "";

/** A Playwright child that never finishes on its own: only the safety timer's kill ends it. */
function hangingChild(): any {
  const proc: any = new EventEmitter();
  proc.pid = 7100;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => { setImmediate(() => proc.emit("close", null)); });
  return proc;
}

/** One that ends at once without a report: a start that never got going. */
function deadOnArrival(): any {
  const proc: any = new EventEmitter();
  proc.pid = 7200;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", 1));
  return proc;
}

beforeEach(() => { runDir = mkdtempSync(path.join(tmpdir(), "norerun-")); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  rmSync(runDir, { recursive: true, force: true });
});

describe("runSpec after the safety timer fires", () => {
  it("does not run the spec a second time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("PLAYWRIGHT_TIMEOUT", "1000");
    vi.mocked(spawn).mockImplementation((() => hangingChild()) as any);
    const pending = runSpec("test('x', async () => { await test.step('s1', async () => {}); });", runDir, {});
    await vi.advanceTimersByTimeAsync(60_000);   // past 2 x 1s + 50s
    const result = await pending;
    expect(result.passed).toBe(false);
    expect(result.killed).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it("still retries a start that produced nothing and was not killed", async () => {
    vi.mocked(spawn).mockImplementation((() => deadOnArrival()) as any);
    const result = await runSpec("test('x', async () => {});", runDir, {});
    expect(result.passed).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  }, 30_000);
});

describe("trace on an org-connection run", () => {
  it("is turned off: the trace would hold the sign-in URL", async () => {
    vi.mocked(spawn).mockImplementation((() => deadOnArrival()) as any);
    await runSpec("test('x', async () => {});", runDir, { [FRONTDOOR_ENV]: "https://zqcanary.example/secur/frontdoor.jsp?sid=zqcanary" });
    const env = (vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> }).env;
    expect(env.PLAYWRIGHT_TRACE).toBe("off");
  }, 30_000);

  it("stays on (retain-on-failure) for any other run", async () => {
    vi.mocked(spawn).mockImplementation((() => deadOnArrival()) as any);
    await runSpec("test('x', async () => {});", runDir, {});
    const env = (vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> }).env;
    expect(env.PLAYWRIGHT_TRACE).toBeUndefined();
  }, 30_000);
});

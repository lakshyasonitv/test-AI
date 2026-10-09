import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Playwright child's environment is an ALLOW-LIST, not a copy of the server's.
 *
 * `executePlaywright` used to spawn the child with `{ ...process.env, ...secretEnv, ... }`, which
 * handed a process that executes site-authored assertions every credential the server holds —
 * `GEMINI_API_KEY(S)`, `AZURE_OPENAI_API_KEY`, the Supabase service-role key. A crash that dumps
 * the environment, or a future feature that lets a spec read `process.env`, was one step from those
 * secrets reaching the log or an artifact. Only explicitly-named variables cross now.
 *
 * This file mocks ONLY `spawn` (same seam as `secretInLog.test.ts`) and inspects the real options
 * object the production code builds — not a re-implementation, which would pass with the fix
 * deleted.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { runSpec } from "../src/stages/executor.js";

let runDir = "";

/** A fake Playwright child that finishes cleanly on its first spawn (so runSpec does not retry). */
function fakeChild(): any {
  const proc: any = new EventEmitter();
  proc.pid = 7000;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setImmediate(() => {
    // A minimal valid report so executePlaywright returns on attempt 1 instead of retrying.
    writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ suites: [], stats: {} }), "utf8");
    proc.emit("close", 0);
  });
  return proc;
}

/** The env object the parent handed the Playwright child on its first (and only) spawn. */
function childEnv(): Record<string, string> {
  const call = vi.mocked(spawn).mock.calls[0];
  expect(call, "spawn was never called").toBeTruthy();
  return (call![2] as { env: Record<string, string> }).env;
}

beforeEach(() => {
  runDir = mkdtempSync(path.join(tmpdir(), "childenv-"));
  vi.mocked(spawn).mockImplementation((() => fakeChild()) as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  rmSync(runDir, { recursive: true, force: true });
});

describe("the Playwright child's environment", () => {
  it("does not leak the server's own credentials into the child", async () => {
    // Distinctive values so a leak is unambiguous.
    vi.stubEnv("GEMINI_API_KEY", "AIza-SERVER-SECRET");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "azure-server-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "supabase-role-secret");

    await runSpec("test('x', async () => {});", runDir, {});

    const env = childEnv();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    // Positive control: the child environment really was populated, so "no secret" is not vacuous.
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });

  it("forwards the variables the child's own readers need", async () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright");
    vi.stubEnv("CHROMIUM_EXTRA_ARGS", "--disable-dev-shm-usage");
    vi.stubEnv("RUN_TIMEZONE", "Europe/London");

    await runSpec("test('x', async () => {});", runDir, {});

    const env = childEnv();
    // Read by the browser launch / config in the CHILD (src/browserLaunch.ts, playwright.config.ts).
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
    expect(env.CHROMIUM_EXTRA_ARGS).toBe("--disable-dev-shm-usage");
    // The run's timezone has to reach the spec's browser or it runs under the host's zone.
    expect(env.RUN_TIMEZONE).toBe("Europe/London");
  });

  it("still hands the child the run's own credentials and the explicit Playwright vars", async () => {
    await runSpec("test('x', async () => {});", runDir, {
      TEST_USERNAME: "zoe.secret.user@example.com",
      TEST_PASSWORD: "CorrectHorse-Battery-42",
    });

    const env = childEnv();
    // The per-run site credential is the WHOLE reason the child exists; the allow-list must not
    // starve it. (It is not a server secret — the user supplied it for their own site.)
    expect(env.TEST_USERNAME).toBe("zoe.secret.user@example.com");
    expect(env.TEST_PASSWORD).toBe("CorrectHorse-Battery-42");
    // The runner's own controls are set explicitly AFTER the allow-list, so they always win.
    expect(env.PLAYWRIGHT_HEADLESS).toBe("true");
    expect(env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(path.join(runDir, "results.json"));
  });

  it("matches allow-listed names case-insensitively (Windows spells them inconsistently)", async () => {
    // Lowercase spelling of an allow-listed upper-case name, as Windows sometimes stores it.
    vi.stubEnv("Node_Extra_Ca_Certs", "C:\\probe-ca.pem");

    await runSpec("test('x', async () => {});", runDir, {});

    const env = childEnv();
    const matched = Object.entries(env).filter(([k]) => k.toLowerCase() === "node_extra_ca_certs");
    expect(matched.map(([, v]) => v)).toContain("C:\\probe-ca.pem");
  });

  it("omits an allow-listed variable the parent does not set, rather than injecting an empty string", async () => {
    const original = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    try {
      await runSpec("test('x', async () => {});", runDir, {});
      const env = childEnv();
      expect("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" in env).toBe(false);
    } finally {
      if (original !== undefined) process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = original;
    }
  });
});

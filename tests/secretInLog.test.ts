import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Secret material in log lines â€” the repo's second secret-in-log test, and deliberately the same
 * shape as `orgLlmConfig.test.ts`'s ("never appears in a log line"), because that was the only
 * one and it covers exactly one code path.
 *
 * What this file exists to prove, in the order it would hurt:
 *
 *  1. **The Playwright child's stdout/stderr is redacted.** Those two lines are the one
 *     credential-bearing console sink `redactCredentials` did not already cover: artifacts have
 *     `scrubServedSecrets`, API responses never see the value, but `[PW STDOUT]`/`[PW STDERR]`
 *     printed raw bytes straight into the log. A real child is replaced by a fake one so the
 *     actual handlers registered in `runSpec` are the code under test â€” not a re-implementation
 *     of them, which would pass with the fix deleted.
 *  2. **A pool key never reaches the log in any spelling.** `[backoff]` used to print
 *     `key.slice(0, 8) + "..."` â€” the same secret, shortened.
 *  3. **An upstream error body never reaches the log or an Error's `.message` in full.**
 *     gemini.ts/azureOpenAI.ts used to build the Error from the whole body while cutting their
 *     own console line at 200 chars, so the cut protected one printer and not the three in
 *     ir.ts that print `err.message` whole.
 */

const USERNAME = "zoe.secret.user@example.com";
const PASSWORD = "CorrectHorse-Battery-42";

/** A pool key distinctive enough that any substring of it is a meaningful leak test. */
const POOL_KEY = "AIzaSyPOOLKEY-THAT-MUST-NEVER-APPEAR-0001";
const POOL_PREFIX = POOL_KEY.slice(0, 8);

// ---------------------------------------------------------------------------
// 1. executor.ts's PW STDOUT / PW STDERR
// ---------------------------------------------------------------------------

// Only `spawn` is replaced; everything else the child_process module exports stays real, so
// nothing else in executor.ts (ffmpeg probe, etc.) changes behaviour.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { runSpec } from "../src/stages/executor.js";
import { callWithPool, boundErrorBody, retryAfterFromBody, isRateLimitError, ERROR_BODY_LIMIT } from "../src/llm/backoff.js";
import { KeyPool } from "../src/llm/keyPool.js";
import { gemini } from "../src/llm/gemini.js";
import { azureOpenAI } from "../src/llm/azureOpenAI.js";

let runDir = "";
let seen: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

function captureConsole(): void {
  seen = [];
  spies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: any[]) => {
      seen.push(a.map(String).join(" "));
    }),
  );
}

function restoreConsole(): void {
  spies.forEach((s) => s.mockRestore());
  spies = [];
}

function allOutput(): string {
  return seen.join("\n");
}

beforeEach(() => {
  runDir = mkdtempSync(path.join(tmpdir(), "secretinlog-"));
  captureConsole();
});

afterEach(() => {
  restoreConsole();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
  rmSync(runDir, { recursive: true, force: true });
});

describe("[PW STDOUT] / [PW STDERR]", () => {
  it("never carry the run's own credential â€” and the lines really were exercised", async () => {
    const secretEnv = { TEST_USERNAME: USERNAME, TEST_PASSWORD: PASSWORD };

    vi.mocked(spawn).mockImplementation((() => {
      const proc: any = new EventEmitter();
      proc.pid = 4242;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      // Emit only after runSpec has attached its own handlers (it does so synchronously, right
      // after spawn returns), then close so the awaiting promise settles.
      setImmediate(() => {
        proc.stdout.emit(
          "data",
          Buffer.from(`expect(locator).toHaveValue("${PASSWORD}") for user ${USERNAME}\n`, "utf8"),
        );
        proc.stderr.emit(
          "data",
          Buffer.from(`Error: secret value ${PASSWORD} did not match\n`, "utf8"),
        );
        proc.emit("close", 1);
      });
      return proc;
    }) as any);

    await runSpec("test('x', async () => {});", runDir, secretEnv);

    // Otherwise this test proves nothing: if the fake child never spoke, "no secret seen" is
    // vacuous. Same shape as orgLlmConfig's "the decryption really did happen".
    expect(seen.some((l) => l.includes("[PW STDOUT]"))).toBe(true);
    expect(seen.some((l) => l.includes("[PW STDERR]"))).toBe(true);

    expect(allOutput()).not.toContain(PASSWORD);
    expect(allOutput()).not.toContain(USERNAME);
    // Positive control: the scrub is visible, not merely absent.
    expect(allOutput()).toContain("[redacted]");
  });

  it("leaves output alone for a run that carries no secret", async () => {
    vi.mocked(spawn).mockImplementation((() => {
      const proc: any = new EventEmitter();
      proc.pid = 4243;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("public demo output\n", "utf8"));
        proc.emit("close", 0);
      });
      return proc;
    }) as any);

    await runSpec("test('x', async () => {});", runDir, {});
    expect(allOutput()).toContain("public demo output");
    expect(allOutput()).not.toContain("[redacted]");
  });
});

describe("[backoff] attempt line", () => {
  it("names provider and key position, never the key", async () => {
    const pool = new KeyPool([POOL_KEY], "gemini");
    const boom: any = new Error("Invalid API Key");
    boom.status = 401;

    await expect(
      callWithPool(pool, async () => { throw boom; }, { maxRetries: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow();

    const line = seen.find((l) => l.includes("[backoff] attempt"));
    expect(line).toBeTruthy();
    expect(line).toContain("provider: gemini");
    expect(line).toContain("key 1 of 1");

    expect(allOutput()).not.toContain(POOL_KEY);
    expect(allOutput()).not.toContain(POOL_PREFIX);
  });

  it("keeps the rotation position honest across a real rotation", async () => {
    const pool = new KeyPool([POOL_KEY, POOL_KEY.replace("0001", "0002")], "azure");
    const seenOrder: string[] = [];
    const boom: any = new Error("nope");
    // 429 so the loop actually RETRIES — a 401 would be thrown through on attempt 1 and there
    // would be no second rotation to observe.
    boom.status = 429;
    await expect(
      callWithPool(
        pool,
        async (k) => { seenOrder.push(k); throw boom; },
        { maxRetries: 2, baseDelayMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow();

    expect(seenOrder[0]).toBe(POOL_KEY);
    const lines = seen.filter((l) => l.includes("[backoff] attempt"));
    expect(lines[0]).toContain("key 1 of 2");
    expect(lines[1]).toContain("key 2 of 2");
    expect(allOutput()).not.toContain(POOL_PREFIX);
  });
});

describe("provider error bodies", () => {
  it("boundErrorBody collapses to one line and never exceeds the limit", () => {
    // The newline must sit INSIDE the bound for this to test the collapse at all — put it late
    // and the truncation removes it, and the assertion becomes vacuous.
    expect(boundErrorBody("first line\nsecond line")).toBe("first line second line");

    const huge = `{"error":{"code":400,"message":"${"x".repeat(5_000)}\nsecond line here"}}`;
    const bounded = boundErrorBody(huge);
    expect(bounded.length).toBeLessThanOrEqual(ERROR_BODY_LIMIT + 40);
    expect(bounded).not.toContain("\n");
    expect(bounded).toContain("[+");
    // The tail really was cut, not merely reported.
    expect(bounded).not.toContain("x".repeat(5_000));
  });

  it("retryAfterFromBody still reads a server-advised delay the message no longer carries", () => {
    expect(retryAfterFromBody("...quota... Please retry after 31s.")).toBe(31);
    // Groq's own wording (TD-03): "try again", not "retry", and in milliseconds.
    expect(retryAfterFromBody("Please try again in 495ms")).toBeCloseTo(0.495);
    expect(retryAfterFromBody("nothing useful here")).toBeNull();
  });

  it("keeps classifying a bounded message as a rate limit", () => {
    const body = JSON.stringify({ error: { code: 429, message: "Resource exhausted".padEnd(4_000, ".") } });
    const e: any = new Error(`Gemini 429: ${boundErrorBody(body)}`);
    e.status = 429;
    expect(isRateLimitError(e)).toBe(true);
  });

  it("gemini: the constructed Error and the log line are both bounded, and retryAfter survives", async () => {
    vi.stubEnv("GEMINI_API_KEYS", POOL_KEY);
    // The unique marker sits at the very END of the body, far past the cut — a marker near the
    // front would be inside the bound by construction and the assertion would be meaningless.
    const tail = "A".repeat(5_000) + "GEMINI-TAIL-MARKER";
    const body = JSON.stringify({
      error: { code: 400, message: "bad request. Please retry after 31s. " + tail },
    });
    const okRes = { ok: false, status: 400, text: async () => body, json: async () => ({}),
      headers: new Headers() };
    vi.stubGlobal("fetch", vi.fn(async () => okRes as any));

    let caught: any;
    try { await gemini("hi", { model: "gemini-test" }); } catch (e) { caught = e; }

    expect(caught).toBeTruthy();
    expect(caught.message).not.toContain("GEMINI-TAIL-MARKER");
    expect(caught.message.length).toBeLessThan(ERROR_BODY_LIMIT + 120);
    // The delay the body asked for is still available to backoff's parseRetryDelay, even though
    // it sits past the cut.
    expect(caught.retryAfter).toBe(31);
    expect(allOutput()).not.toContain("GEMINI-TAIL-MARKER");
    // Pins the PRODUCTION pool's label: gemini.ts builds its env pool with "gemini". Deleting
    // that argument still leaks nothing, but the line stops naming the provider, which is half
    // of why it exists.
    expect(allOutput()).toContain("provider: gemini");
  });

  it("azure: the constructed Error and the log line are both bounded", async () => {
    vi.stubEnv("AZURE_OPENAI_API_KEY", POOL_KEY);
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://unit.example.openai.azure.com");
    const tail = "B".repeat(5_000) + "AZURE-TAIL-MARKER";
    const body = JSON.stringify({ error: { code: "400", message: "nope. " + tail } });
    const okRes = { ok: false, status: 400, text: async () => body, json: async () => ({}),
      headers: new Headers() };
    vi.stubGlobal("fetch", vi.fn(async () => okRes as any));

    let caught: any;
    try { await azureOpenAI("hi", { deployment: "unit-deploy" }); } catch (e) { caught = e; }

    expect(caught).toBeTruthy();
    expect(caught.message).not.toContain("AZURE-TAIL-MARKER");
    expect(caught.message.length).toBeLessThan(ERROR_BODY_LIMIT + 120);
    expect(allOutput()).not.toContain("AZURE-TAIL-MARKER");
    // Pins azureOpenAI.ts's own pool label.
    expect(allOutput()).toContain("provider: azure");
  });
});

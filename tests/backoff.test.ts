import { describe, it, expect, vi } from "vitest";
import { callWithPool } from "../src/llm/backoff.js";
import { KeyPool } from "../src/llm/keyPool.js";

// Reproduces the exact failure shape observed mid-run: Node's fetch (undici) wraps a
// transport-level timeout as TypeError("fetch failed") with the real cause attached.
const networkError = () => {
  const err = new TypeError("fetch failed");
  (err as any).cause = { code: "UND_ERR_HEADERS_TIMEOUT" };
  return err;
};

describe("callWithPool — network error retry", () => {
  // Regression: a single transient network blip talking to Gemini mid-run killed the
  // entire pipeline with zero retry, because only rate-limit errors were retried.
  it("retries a fetch-failed transport error and succeeds", async () => {
    const pool = new KeyPool(["k1"]);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw networkError();
      return "ok";
    });
    const result = await callWithPool(pool, fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not penalize the key for a network error (not the key's fault)", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw networkError();
      return "ok";
    });
    await callWithPool(pool, fn, { baseDelayMs: 1 });
    // Both keys still immediately available — neither was put in cooldown.
    expect(pool.next()).toBeTruthy();
  });

  it("still throws immediately on a non-network, non-rate-limit error", async () => {
    const pool = new KeyPool(["k1"]);
    const authError: any = new Error("Invalid API Key");
    authError.status = 401;
    const fn = vi.fn(async () => { throw authError; });
    await expect(callWithPool(pool, fn, { baseDelayMs: 1 })).rejects.toBe(authError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries network errors", async () => {
    const pool = new KeyPool(["k1"]);
    const fn = vi.fn(async () => { throw networkError(); });
    await expect(callWithPool(pool, fn, { baseDelayMs: 1, maxRetries: 2 })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// A hanging fn only settles when its signal is aborted — mirrors how fetch() behaves once
// callWithPool's timeout fires.
function hangs(signal: AbortSignal): Promise<string> {
  return new Promise<string>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

describe("callWithPool — timeout", () => {
  it("aborts a hanging call and retries", async () => {
    const pool = new KeyPool(["k1"]);
    let calls = 0;
    const fn = vi.fn((_apiKey: string, signal: AbortSignal) => {
      calls++;
      return calls === 1 ? hangs(signal) : Promise.resolve("ok");
    });
    const result = await callWithPool(pool, fn, { baseDelayMs: 1, timeoutMs: 5 });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("passes an AbortSignal into fn", async () => {
    const pool = new KeyPool(["k1"]);
    let seenSignal: unknown;
    const fn = vi.fn(async (_apiKey: string, signal: AbortSignal) => {
      seenSignal = signal;
      return "ok";
    });
    await callWithPool(pool, fn, { baseDelayMs: 1 });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("does not penalize the key for a timeout (not the key's fault)", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    let calls = 0;
    const fn = vi.fn((_apiKey: string, signal: AbortSignal) => {
      calls++;
      return calls === 1 ? hangs(signal) : Promise.resolve("ok");
    });
    await callWithPool(pool, fn, { baseDelayMs: 1, timeoutMs: 5 });
    expect(pool.next()).toBeTruthy();
  });

  it("gives up after maxRetries timeouts", async () => {
    const pool = new KeyPool(["k1"]);
    const fn = vi.fn((_apiKey: string, signal: AbortSignal) => hangs(signal));
    await expect(
      callWithPool(pool, fn, { baseDelayMs: 1, timeoutMs: 5, maxRetries: 2 })
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default timeout when LLM_TIMEOUT_MS is invalid", async () => {
    const prev = process.env.LLM_TIMEOUT_MS;
    process.env.LLM_TIMEOUT_MS = "not-a-number";
    try {
      const pool = new KeyPool(["k1"]);
      // Resolves after 20ms — a broken NaN-timeout guard (setTimeout(cb, NaN) fires almost
      // immediately) would abort before this settles; the real 45s default easily allows it.
      const fn = vi.fn(
        (_apiKey: string, signal: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            const t = setTimeout(() => resolve("ok"), 20);
            signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
          })
      );
      const result = await callWithPool(pool, fn, { baseDelayMs: 1 });
      expect(result).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env.LLM_TIMEOUT_MS;
      else process.env.LLM_TIMEOUT_MS = prev;
    }
  });
});

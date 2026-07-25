import { KeyPool } from "./keyPool.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Gemini quota typically resets every 22 seconds; use as minimum wait. */
const GEMINI_QUOTA_RESET_MS = 22_000;

/** Detect a rate-limit / transient error and return the status, else null. */
function rateLimited(err: any): number | null {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  if (status === 429 || status === 503) return status;
  const msg = String(err?.message ?? "");
  if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED|overloaded/i.test(msg)) return 429;
  return null;
}

/** True when the error is specifically a quota exhaustion (not just a 429 spike). */
function isQuotaExhausted(err: any): boolean {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  if (status === 429) {
    const msg = String(err?.message ?? "");
    if (/quota|RESOURCE_EXHAUSTED|exhausted/i.test(msg)) return true;
  }
  return false;
}

/** Parse server-suggested retry delay from header or error body. */
function parseRetryDelay(err: any): number | null {
  if (err?.retryAfter) {
    const sec = Number(err.retryAfter);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
  }
  const msg = String(err?.message ?? "");
  const m = msg.match(/retry\s+in\s+(\d+)s/i);
  if (m) return parseInt(m[1], 10) * 1000;
  return null;
}

export interface CallOpts { maxRetries?: number; baseDelayMs?: number; }

/** Run `fn(apiKey)` with key rotation + exponential backoff on rate-limit errors. */
export async function callWithPool<T>(
  pool: KeyPool,
  fn: (apiKey: string) => Promise<T>,
  opts: CallOpts = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key = pool.next();
    try {
      console.log("[backoff] attempt", attempt + 1, "/", maxRetries, "| key:", key.slice(0, 8) + "...");
      return await fn(key);
    } catch (err) {
      lastErr = err;
      if (rateLimited(err) === null) throw err;
      const serverDelay = parseRetryDelay(err);
      let wait = serverDelay ?? Math.min(base * 2 ** attempt, 30_000) + Math.random() * 300;
      if (isQuotaExhausted(err)) {
        wait = Math.max(wait, GEMINI_QUOTA_RESET_MS);
        console.error("[backoff] quota exhausted — sleeping", Math.round(wait / 1000), "s (attempt", attempt + 1, ")");
      } else {
        console.error("[backoff] rate-limited, sleeping", Math.round(wait), "ms (server:", serverDelay, ")");
      }
      pool.penalize(key, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

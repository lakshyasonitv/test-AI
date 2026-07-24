import { KeyPool } from "./keyPool.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Detect a rate-limit / transient error and return the status, else null. */
function rateLimited(err: any): number | null {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  if (status === 429 || status === 503) return status;
  const msg = String(err?.message ?? "");
  if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED|overloaded/i.test(msg)) return 429;
  return null;
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
      return await fn(key);
    } catch (err) {
      lastErr = err;
      if (rateLimited(err) === null) throw err;
      const serverDelay = parseRetryDelay(err);
      const wait = serverDelay ?? Math.min(base * 2 ** attempt, 30_000) + Math.random() * 300;
      pool.penalize(key, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

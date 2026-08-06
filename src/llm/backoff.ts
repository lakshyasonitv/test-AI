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

/**
 * True for a network-transport failure (DNS hiccup, connection reset, TLS handshake, a
 * timeout waiting for response headers — the exact shape seen in practice: `TypeError:
 * fetch failed` wrapping `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT` while calling
 * Gemini mid-run) rather than an HTTP-level response.
 *
 * Node's built-in fetch (undici) always wraps a transport failure as `TypeError: fetch
 * failed`. A legitimate HTTP error response (401 invalid key, 400 bad request, ...) never
 * reaches here as a thrown TypeError — it comes back as a normal Response, which
 * gemini.ts/groq.ts turn into their OWN Error with `.status` set. So this check can never
 * misfire on "the server told us no" — only on "the request never got an answer at all" —
 * which is exactly the class of failure worth an automatic retry: this project has already
 * had one full pipeline run die outright on a single transient timeout with zero retry.
 */
function isNetworkError(err: any): boolean {
  return err instanceof TypeError && err.message === "fetch failed";
}

export interface CallOpts { maxRetries?: number; baseDelayMs?: number; timeoutMs?: number; }

// A hung fetch() (server accepts the connection, never responds) never settles, so nothing
// above — not the retry loop, not ir.ts's budget guard — can react to it. Seen in practice:
// a run stuck at "ir started" with zero further events for 50+ minutes. Bounded here so a
// hang costs at most timeoutMs * maxRetries instead of forever.
const DEFAULT_LLM_TIMEOUT_MS = 45_000;

/** Run `fn(apiKey, signal)` with key rotation + exponential backoff on rate-limit errors.
 *  `signal` aborts once a single attempt exceeds the timeout. */
export async function callWithPool<T>(
  pool: KeyPool,
  fn: (apiKey: string, signal: AbortSignal) => Promise<T>,
  opts: CallOpts = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  // Guard against a bad env value: setTimeout(cb, NaN) fires immediately, which would abort
  // every single request instantly — strictly worse than the hang this exists to fix.
  const rawTimeout = Number(process.env.LLM_TIMEOUT_MS ?? DEFAULT_LLM_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_LLM_TIMEOUT_MS);
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key = pool.next();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      console.log("[backoff] attempt", attempt + 1, "/", maxRetries, "| key:", key.slice(0, 8) + "...");
      const p = fn(key, controller.signal);
      p.catch(() => {}); // avoid an unhandled rejection if the timeout below wins the race
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error(`LLM call exceeded ${timeoutMs}ms`), { isTimeout: true }))
          );
        }),
      ]);
    } catch (err) {
      lastErr = err;

      // A network-transport failure or a timeout isn't the KEY's fault — any key would hit
      // the same DNS/connection/timeout issue — so retry without penalizing it (a rate-limit
      // penalty here would needlessly shrink the rotation pool for an unrelated problem).
      // `timedOut` (set by this attempt's own timer), not err.name/message, is the reliable
      // signal — an aborted fetch can surface as `TypeError: terminated` instead of a clean
      // AbortError if the abort lands mid-body-read.
      if (isNetworkError(err) || timedOut || (err as any)?.name === "AbortError") {
        const wait = Math.min(base * 2 ** attempt, 10_000) + Math.random() * 300;
        console.error(
          "[backoff]", timedOut ? "timeout" : "network error", "(",
          (err as any)?.cause?.code ?? (err as any)?.message,
          ") — retrying in", Math.round(wait), "ms (attempt", attempt + 1, ")"
        );
        await sleep(wait);
        continue;
      }

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
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

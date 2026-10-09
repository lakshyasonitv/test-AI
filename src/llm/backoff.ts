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

/** Parse server-suggested retry delay from header or error body.
 *
 *  Previously only matched a whole-second "retry in Ns" shape. Groq's own TPM rate-limit body
 *  actually reads "Please try again in 495ms." — different wording ("try again", not "retry")
 *  AND a different unit (ms, not s) — so that message was never matched, the server's own
 *  short, accurate wait was silently discarded, and every Groq 429 fell through to a generic
 *  ~1s+ exponential guess instead. See TECH_DEBT.md TD-03. */
export function parseRetryDelay(err: any): number | null {
  if (err?.retryAfter) {
    const sec = Number(err.retryAfter);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
  }
  const msg = String(err?.message ?? "");
  const m = msg.match(/(?:retry|try again)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (m) {
    const value = parseFloat(m[1]);
    return m[2].toLowerCase() === "ms" ? value : value * 1000;
  }
  return null;
}

/** Exported so callers outside this module's own retry loop (ir.ts's outer attempt loop, in
 *  particular) can tell a rate-limit failure apart from a genuine schema/parse failure, rather
 *  than treating every thrown error identically. */
export function isRateLimitError(err: any): boolean {
  return rateLimited(err) !== null;
}

/**
 * How much of an upstream response body may travel inside an Error's `.message`.
 *
 * gemini.ts and azureOpenAI.ts used to build `new Error(\`<provider> <status>: \${fullBody}\`)`,
 * while their own console line cut the body at 200 chars. The cut was cosmetic: the untruncated
 * body then rode the Error into ir.ts (`non-retryable infrastructure error`, `rate-limited`,
 * `gemini/parse error`) and backoff.ts's own network line, all of which print `err.message`
 * whole. An upstream body is uncontrolled text — it is provider prose, and a 4xx can quote back
 * part of the request it rejected — so bounding it belongs at the point the Error is CONSTRUCTED,
 * where every downstream printer inherits the bound, not at one printer.
 *
 * Collapsed to a single line because one `console.*` call must be one log line: a body carrying
 * its own newlines would otherwise fan out into several, and ACA wraps but does not re-indent.
 */
export const ERROR_BODY_LIMIT = 200;

export function boundErrorBody(text: string, limit = ERROR_BODY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit)}...[+${oneLine.length - limit} chars]`;
}

/**
 * A server-advised retry delay read from an error BODY rather than the `retry-after` header.
 *
 * Exists because bounding `.message` would otherwise silently drop this signal: Gemini's 429 body
 * puts `Please retry after Ns` well past the first ERROR_BODY_LIMIT characters, so `parseRetryDelay`
 * — which is fed `err.message` — would stop seeing it and every quota wait would fall back to a
 * local exponential guess. Checked only when the header is absent, and only used for a delay the
 * server itself asked for. Returns seconds, matching what `parseRetryDelay` expects of
 * `err.retryAfter`.
 */
export function retryAfterFromBody(text: string): number | null {
  // Two wordings, deliberately: `retry after Ns` (Gemini's quota prose) and `try again in Nms`
  // (the Groq body TD-03 was filed over). `parseRetryDelay` — which used to be the only reader
  // of this string, via `err.message` — matches the same two, so bounding the message does not
  // narrow what can be found.
  const m = text.match(/(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return m[2].toLowerCase() === "ms" ? value / 1000 : value;
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
    const entry = pool.nextEntry();
    const key = entry.key;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      // Which provider, which slot, how big the pool is — never anything derived from the key.
      // This line used to read `key.slice(0, 8) + "..."`, which is the same secret in a shorter
      // spelling: short enough to be guessed, long enough to be worth correlating across logs,
      // and in Log Analytics it is durable storage. keyPool.ts carries the label; `index` is a
      // rotation position, not a fingerprint.
      console.log(
        "[backoff] attempt", attempt + 1, "/", maxRetries,
        "| provider:", entry.label, "| key", entry.index + 1, "of", entry.size,
      );
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
        // Bounded like every other untrusted string printed here: `err.message` for an abort can
        // be whatever the transport put in it, and this is a printer, so it does its own cut
        // rather than trusting the constructor it did not see.
        console.error(
          "[backoff]", timedOut ? "timeout" : "network error", "(",
          boundErrorBody(String((err as any)?.cause?.code ?? (err as any)?.message ?? err)),
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

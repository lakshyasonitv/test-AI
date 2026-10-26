import { credentialsAsEnvRefs, credentialsFromEnv, redactCredentials, type Credentials } from "./stages/credentials.js";
import { currentRunId } from "./runContext.js";

/**
 * The credentials each live run was given, held in PROCESS MEMORY ONLY, so that every event can be
 * scrubbed on its way out: to `events.ndjson` (runStore.append), to `/api/runs/:id/state` and the
 * SSE replay (runStore.read), and to the live SSE stream (runRegistry.record). TECH_DEBT.md TD-154.
 *
 * Why a registry rather than scrubbing at each emit site: events are written from five places
 * (the orchestrator, the suite runner, replay, the case-selection gate, the replay route), and the
 * leak that motivated this came through a payload nobody had thought of as credential-bearing —
 * the `testcases` event's full candidate pool, in which the model had typed the password it read
 * off the login page. Scrubbing at the one shared writer covers every event, including future ones.
 *
 * Only the VALUE changes (redactCredentials' placeholder); an event's shape never does. The
 * registry itself is never serialised and never logged.
 */
const byRun = new Map<string, Credentials[]>();

/** How long after a run's terminal event its credentials are still held, for the live SSE push
 *  that follows the durable append. */
const FORGET_AFTER_END_MS = 60_000;
/** Upper bound for any entry, including waiters that are not runs (re-ground jobs) and runs that
 *  never reach a terminal event: CLAUDE.md rule 5 wants credentials held for one walk, not forever. */
const MAX_HOLD_MS = 2 * 60 * 60 * 1000;

export function rememberRunSecrets(runId: string, creds: Credentials | null | undefined): void {
  if (!creds?.secret) return;
  const list = byRun.get(runId) ?? [];
  if (!list.some((c) => c.username === creds.username && c.password === creds.password)) list.push(creds);
  byRun.set(runId, list);
  const timer = setTimeout(() => byRun.delete(runId), MAX_HOLD_MS);
  timer.unref?.();
}

/**
 * Secrets that are not a username/password pair — a Salesforce org connection's access token and
 * the frontdoor URL that carries it (D-63). Same lifetime and same scrubbers as the credentials
 * above; only the matching differs (an exact string, replaced wherever it appears).
 */
const stringsByRun = new Map<string, Set<string>>();
/** Shorter than this is never registered: replacing a short string would rewrite ordinary text
 *  (the TD-156 lesson). Tokens and URLs are far longer. */
const MIN_SECRET_STRING = 16;
const SECRET_STRING_PLACEHOLDER = "[redacted]";

export function rememberRunSecretStrings(runId: string, values: Array<string | null | undefined>): void {
  const set = stringsByRun.get(runId) ?? new Set<string>();
  for (const v of values) if (typeof v === "string" && v.length >= MIN_SECRET_STRING) set.add(v);
  if (!set.size) return;
  stringsByRun.set(runId, set);
  const timer = setTimeout(() => stringsByRun.delete(runId), MAX_HOLD_MS);
  timer.unref?.();
}

/** `value` with every registered secret string replaced, walking arrays and plain objects. */
function scrubStrings<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(SECRET_STRING_PLACEHOLDER);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function forgetRunSecretsSoon(runId: string): void {
  if (stringsByRun.has(runId)) {
    const t = setTimeout(() => stringsByRun.delete(runId), FORGET_AFTER_END_MS);
    t.unref?.();
  }
  if (!byRun.has(runId)) return;
  const timer = setTimeout(() => byRun.delete(runId), FORGET_AFTER_END_MS);
  timer.unref?.();
}

/** The first credentials registered for a run, for a cache key's credential FINGERPRINT (TD-22).
 *  Callers hash it (credentialFingerprint); it is never stored or logged. */
export function runCredentialsFor(runId: string): Credentials | undefined {
  return byRun.get(runId)?.[0];
}

/**
 * TD-156: what may be CACHED. The current run's credentials (and the operator's TEST_USERNAME /
 * TEST_PASSWORD) become `${env:...}` references, never left as values, in a cache body or a cache key's
 * input. Outside a run with credentials it returns `value` itself.
 */
export function cacheSafe<T>(value: T): T {
  const runId = currentRunId();
  let out = value;
  for (const creds of runId ? byRun.get(runId) ?? [] : []) out = credentialsAsEnvRefs(out, creds);
  const fromEnv = credentialsFromEnv();
  return fromEnv ? credentialsAsEnvRefs(out, fromEnv) : out;
}

/** `value` with this run's credentials (and the operator's TEST_USERNAME/TEST_PASSWORD, which any
 *  run may use) replaced by the placeholder. Returns `value` itself when there is nothing to scrub. */
export function scrubRunSecrets<T>(runId: string, value: T): T {
  // Longest first, so a URL that contains the token is replaced whole rather than leaving its tail.
  let out = scrubStrings(value, [...(stringsByRun.get(runId) ?? [])].sort((a, b) => b.length - a.length));
  for (const creds of byRun.get(runId) ?? []) out = redactCredentials(out, creds);
  const fromEnv = credentialsFromEnv();
  return fromEnv ? redactCredentials(out, fromEnv) : out;
}

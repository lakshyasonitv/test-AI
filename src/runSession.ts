import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserContext } from "playwright";

/**
 * Run questions, and the signed-in session one of them unlocks (DECISIONS.md D-51).
 *
 * `RUN_QUESTIONS=true` (default off) lets a run PAUSE and ask the person watching it a question,
 * then carry on with the answer. The first question is the one Salesforce asks: after the password
 * it may show a "Verify your identity" screen wanting a code from email, SMS or an authenticator
 * app. Discovery cannot invent that code, so it asks.
 *
 * A one-time code cannot be replayed. Every later browser in the run (the grounding replay in
 * liveExtend.ts, the generated spec's runner) logs in again from scratch, and would meet the same
 * screen with nobody to answer it. So the session discovery established is KEPT — in this run's
 * memory only — and handed to those browsers as Playwright `storageState`. That is what this
 * module carries.
 *
 * SECRETS (CLAUDE.md platform rule 5). A storage state is a bearer credential: its cookies ARE
 * the session. It lives in process memory for the length of one run, crosses to the spec's child
 * process as an environment variable (never a file), and is never logged, emitted as an event or
 * written under runs/. It is dropped with the run's async context.
 *
 * WHY A RAIL — the same reason `currentRunLocale()` and `currentRunTargetApp()` give: discovery
 * WRITES it, and liveExtend and the executor READ it, behind three different call chains. The
 * holder is a mutable object entered once at the start of the run, so the write discovery makes
 * deep inside its own chain is visible to the stages that run after it.
 *
 * ABSENT MEANS AS BEFORE. With the flag off nothing enters a holder, every accessor here answers
 * "nothing", and every browser opens exactly as it did before this file existed.
 */

/** Whether a run may pause to ask a question. Registered in BOOLEAN_ENV_FLAGS (index.ts). */
export function runQuestionsEnabled(): boolean {
  return process.env.RUN_QUESTIONS === "true";
}

/** What `BrowserContext.storageState()` returns — cookies plus per-origin localStorage. */
export type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface RunSessionHolder {
  state?: SessionState;
}

const runSessionContext = new AsyncLocalStorage<RunSessionHolder>();

/**
 * Give the rest of this run an (empty) session holder. Called once by the orchestrator, and only
 * when the run can ask questions — so a run with the flag off has no holder at all.
 */
export function enterWithRunSession(): void {
  runSessionContext.enterWith({});
}

/** Scoped form for tests: `enterWith` leaks into whatever shares the async context next. */
export function withRunSession<T>(fn: () => T): T {
  return runSessionContext.run({}, fn);
}

/** Record the session discovery established. A no-op outside a run that entered a holder. */
export function setRunSession(state: SessionState): void {
  const holder = runSessionContext.getStore();
  if (holder) holder.state = state;
}

/** The kept session, or null. */
export function currentRunSession(): SessionState | null {
  return runSessionContext.getStore()?.state ?? null;
}

/**
 * Spread into the options of every in-process browser this run opens after discovery.
 * `{}` when there is no session — byte-identical options to before.
 */
export function runSessionContextOptions(): { storageState?: SessionState } {
  const state = currentRunSession();
  return state ? { storageState: state } : {};
}

/**
 * A cache-key part for anything whose result depends on whether the browser started signed in.
 * NULL when there is no session, and the caller must then leave its key exactly as it was — so a
 * run with the flag off keeps every key it ever had (CLAUDE.md: a key must carry every real input,
 * and must not change for inputs that did not).
 *
 * The value is constant, not a fingerprint of the cookies: a session is new on every run, so a
 * fingerprint would never hit, and what changes the RESULT is only "started signed in" or not.
 */
export function runSessionCacheDimension(): string | null {
  return currentRunSession() ? "session:reused" : null;
}

/** The environment variable that carries the session to the spec's child process. */
export const SESSION_ENV = "TEST_STORAGE_STATE_JSON";

/**
 * Linux refuses any single environment string over 128 KiB (MAX_ARG_STRLEN), and the spawn then
 * fails outright. Kept well under it; a larger state is not passed at all, and the spec logs in
 * from scratch exactly as before.
 */
const MAX_SESSION_ENV_BYTES = 96 * 1024;

/**
 * The child-process environment that hands the session to the spec's browser. `{}` when there is
 * none, or when it is too large to pass — in which case the spec falls back to logging in itself.
 */
export function specSessionEnv(): Record<string, string> {
  const state = currentRunSession();
  if (!state) return {};
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > MAX_SESSION_ENV_BYTES) {
    console.warn("[session] the signed-in session is too large to hand to the test runner — "
      + "the tests will log in from scratch");
    return {};
  }
  return { [SESSION_ENV]: json };
}

/**
 * The spec runner's side, for playwright.config.ts: the session from the environment, or `{}`.
 * A malformed value is ignored rather than thrown — a config that throws fails every test.
 */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): { storageState?: SessionState } {
  const raw = env[SESSION_ENV];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.cookies) ? { storageState: parsed } : {};
  } catch {
    return {};
  }
}

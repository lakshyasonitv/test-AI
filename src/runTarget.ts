import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which enterprise application a run's URL belongs to — carried ambiently (DECISIONS.md D-50).
 *
 * The person running a test ticks "This URL is a Salesforce org" on the run screen; POST
 * /api/runs carries it as `options.targetApp: "salesforce"`; the orchestrator enters it here; and
 * any stage that needs Salesforce-specific handling asks `currentRunTargetApp()`. Nothing is
 * stored in advance and nothing is configured: the URL and the credentials arrive exactly as they
 * always have, in the URL box and the prompt (or the credential prompt).
 *
 * A STRING, NOT A BOOLEAN. Two booleans (`salesforce`, `servicenow`, …) could both be true at
 * once, which means nothing; one field holding one value from an allow-list cannot. And the field
 * is part of POST /api/runs, which can never change shape afterwards (platform rule 1), so the
 * room for a second application is made now.
 *
 * WHY A RAIL AND NOT A PARAMETER — the same reason `currentRunLocale()` in browserLaunch.ts gives
 * at length: the stages that will read this sit behind different call chains, and threading one
 * value through every function in between would touch a dozen signatures. This is the fourth use
 * of the same `AsyncLocalStorage` rail (LLM budget, LLM config, locale), entered in the same place
 * in orchestrator.ts, safe across MAX_CONCURRENT_RUNS for the same reason.
 *
 * NULL MEANS AN ORDINARY WEB APP. Outside a run, in the CLI, in a unit test, on every run with
 * SALESFORCE_ENABLED off and on every run where the box was not ticked, `currentRunTargetApp()` is
 * null — so a consumer writes `if (currentRunTargetApp() === "salesforce")` and nothing else.
 */

/** Every value `options.targetApp` may take. Extend this list to support another application. */
export const TARGET_APPS = ["salesforce"] as const;
export type TargetApp = typeof TARGET_APPS[number];

/** True for a value a request is allowed to send. Used by the route, like `isSupportedRunLocale`. */
export function isTargetApp(v: unknown): v is TargetApp {
  return typeof v === "string" && (TARGET_APPS as readonly string[]).includes(v);
}

/**
 * Whether this server offers target-app handling at all. SALESFORCE_ENABLED, default off, and
 * registered in BOOLEAN_ENV_FLAGS (index.ts) so a malformed value refuses to boot.
 */
export function salesforceEnabled(): boolean {
  return process.env.SALESFORCE_ENABLED === "true";
}

const runTargetContext = new AsyncLocalStorage<TargetApp | null>();

/**
 * Make `app` the target application for the rest of this async causal chain.
 *
 * `enterWith`, not a wrapping callback, for the reason llmBudget.ts gives: the orchestrator sets it
 * once for a whole run without nesting its body. Called beside `enterWithRunLocale`. Entered on
 * EVERY run, with null for an ordinary one, so a run never inherits a previous run's value.
 */
export function enterWithTargetApp(app: TargetApp | null): void {
  runTargetContext.enterWith(app);
}

/**
 * THE ACCESSOR. The target application of the run this code is executing in, or null for an
 * ordinary web app (and outside any run).
 */
export function currentRunTargetApp(): TargetApp | null {
  return runTargetContext.getStore() ?? null;
}

/**
 * Run `fn` with `app` ambient, and leave it behind on the way out — the scoped form for tests, for
 * the reason `withRunLocale` gives (enterWith leaks into whatever shares the async context next).
 */
export function withTargetApp<T>(app: TargetApp | null, fn: () => T): T {
  return runTargetContext.run(app, fn);
}

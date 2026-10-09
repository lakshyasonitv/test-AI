import { AsyncLocalStorage } from "node:async_hooks";

/**
 * This run's id, carried ambiently so any log line emitted deep in a run — or by an LLM call made
 * on a run's behalf — can say which run it belongs to without threading the id through every
 * signature in between.
 *
 * WHY A RAIL. The id is known at the top of `runPipeline` (`orchestrator.ts`) and at the editor
 * request handlers, but the logging sits at the very bottom: `llm/client.ts`, the credential-refresh
 * and backoff paths, discovery. Passing a run id down to each of them would touch every function
 * between — the same argument `llmBudget.ts`, `llmContext.ts` and `browserLaunch.ts` each record for
 * their own rail. This is the fourth use of that pattern.
 *
 * `AsyncLocalStorage` "scopes to the async causal chain the call entered from, not to the process",
 * so it is safe across the concurrent runs a single server process serves (MAX_CONCURRENT_RUNS) by
 * construction — one run's `enterWith` cannot leak into a sibling run's chain — and it does not
 * reintroduce a module-level singleton.
 *
 * ABSENT MEANS NO RUN. Outside a run that entered one — a direct unit test, a CLI invocation of a
 * helper — `currentRunId()` is null and consumers omit the id rather than inventing one. That is
 * what makes this invisible until something reads it.
 *
 * TWO ENTRY SHAPES, on purpose:
 *  - `enterWithRunId` is for `runPipeline`, which is one long function and wants the id for its
 *    whole remainder without nesting (same reason as `enterWithBudget`).
 *  - `withRunId` is the SCOPED form for request handlers, which must NOT let the id survive past
 *    the request into whatever async work shares the worker next. `tests/apiContract.test.ts`
 *    documents that exact class of leak for `process.env`; the scoped form is the rail's answer for
 *    handlers, mirroring `withRunLocale` in `browserLaunch.ts`.
 */
const runIdContext = new AsyncLocalStorage<string>();

/** Make `runId` ambient for the remainder of this async causal chain. See the block comment. */
export function enterWithRunId(runId: string): void {
  runIdContext.enterWith(runId);
}

/** The ambient run id, or null outside any run that entered one. */
export function currentRunId(): string | null {
  return runIdContext.getStore() ?? null;
}

/**
 * Run `fn` with `runId` ambient, and leave it behind on the way out.
 *
 * The scoped counterpart to `enterWithRunId`, for one request's worth of work. A handler that
 * entered with `enterWith` would leave the id set for everything that shares the async context
 * afterwards — which in a test process, or on a reused server worker, is the next request.
 *
 * A falsy `runId` (an editor request whose case has no source run) calls `fn` directly rather than
 * entering an empty string: `currentRunId()` would then return `""`, which is worse than `null`
 * because `""` is a value a consumer might print. Null/undefined means "no run", and stays that way.
 */
export function withRunId<T>(runId: string | null | undefined, fn: () => T): T {
  return runId ? runIdContext.run(runId, fn) : fn();
}

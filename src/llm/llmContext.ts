import { AsyncLocalStorage } from "node:async_hooks";
import { KeyPool } from "./keyPool.js";

/**
 * Per-run LLM configuration — which credentials and which model this run should use.
 *
 * WHY IT LOOKS LIKE THIS. `gemini()` held one module-level `KeyPool` built from
 * `GEMINI_API_KEYS`, shared by every run in the process. Per-organisation keys need a different
 * credential per run, and the obvious implementation — threading a key through every call site —
 * would have touched all nine `gemini()` callers across seven files and every function between
 * them.
 *
 * It is also unnecessary, because this codebase already solved this exact problem once.
 * `llmBudget.ts` carries the per-run budget on `AsyncLocalStorage` for precisely the same reason,
 * and its own comment records the reasoning: AsyncLocalStorage "scopes to the async causal chain
 * the call entered from, not to the process", so it is safe across concurrent runs by
 * construction and does not reintroduce the module-level-singleton problem.
 *
 * So this is the same rail. The orchestrator enters a config once, near the top of a run, right
 * beside where it already enters the budget; `gemini()` reads it ambiently. Every call site in
 * between is untouched and does not know this exists.
 *
 * ABSENT MEANS ENV. Outside `enterWithLlmConfig` — the CLI, a unit test, a server with the
 * feature switched off — `currentLlmConfig()` returns null and `gemini()` falls back to exactly
 * the process-wide pool and `GEMINI_MODEL` it used before. That is what makes the whole feature
 * invisible when its flag is off.
 */
export interface LlmConfig {
  /** Credentials for this run. Null means "use the process-wide pool built from env". */
  pool: KeyPool | null;
  /** Model for ordinary calls. Null means `GEMINI_MODEL` / the built-in default. */
  model: string | null;
  /** Model for cheap calls. Null means `GEMINI_MODEL_LITE`, which itself falls back to `model`. */
  modelLite: string | null;
  /**
   * A non-reversible fingerprint of the credential in use.
   *
   * THIS IS A CACHE-KEY INPUT, not decoration. The disk cache never expires, so two organisations
   * whose requests hash to the same key would share answers forever. The fingerprint — never the
   * key — is what keeps them apart. `TECH_DEBT.md` TD-22, `DECISIONS.md` D-10.
   */
  keyFingerprint: string;
  /** Which organisation this run bills to, for diagnostics. Never a secret. */
  organisationId: string | null;
}

/** The config used when nothing has been entered: env-driven, exactly as before this existed. */
export const ENV_LLM_CONFIG: LlmConfig = {
  pool: null, model: null, modelLite: null,
  keyFingerprint: "env", organisationId: null,
};

const configContext = new AsyncLocalStorage<LlmConfig>();

/**
 * Make `config` the LLM configuration for everything that follows in this async causal chain.
 *
 * Called beside `enterWithBudget`, using `enterWith` for the same reason that one does: it applies
 * to the rest of the current execution without wrapping the caller's body in a callback.
 */
export function enterWithLlmConfig(config: LlmConfig): void {
  configContext.enterWith(config);
}

/** The ambient config, or null outside any run that entered one. */
export function currentLlmConfig(): LlmConfig | null {
  return configContext.getStore() ?? null;
}

/**
 * The credential fingerprint to mix into a cache key — "env" when no per-org config is active.
 *
 * A single helper rather than each call site reaching into the config, because every cache key in
 * the codebase has to agree on this. A site that forgets it is a site that serves one
 * organisation's answers to another, permanently and silently.
 */
export function llmCacheDimension(): string {
  const c = currentLlmConfig();
  return c ? c.keyFingerprint : "env";
}

/** The model a cache key must record: the one that will actually be used, not the env default. */
export function resolvedModel(): string {
  return currentLlmConfig()?.model
    ?? process.env.GEMINI_MODEL
    ?? "gemini-3.6-flash";
}

/** As `resolvedModel`, for the cheap-model stages. Mirrors gemini()'s own fallback order. */
export function resolvedModelLite(): string {
  const c = currentLlmConfig();
  return c?.modelLite
    ?? c?.model
    ?? process.env.GEMINI_MODEL_LITE
    ?? process.env.GEMINI_MODEL
    ?? "gemini-3.6-flash";
}

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
 *
 * PROVIDER SELECTION is orthogonal and lives in this file because every consumer has to agree on
 * it (`resolvedProvider`/`resolvedDeployment` below). One role ('main' or 'lite'), chosen at the
 * call site, resolves to a provider via LLM_PROVIDER / LLM_PROVIDER_LITE. The per-organisation
 * configuration in `orgLlmConfig.ts` is GEMINI-ONLY by name and by shape: it applies only when the
 * resolved provider for a role is `gemini`. When the role's provider is `azure`, the org's stored
 * key/model/budget are ignored entirely — the request is built purely from the process-wide
 * `AZURE_OPENAI_*` env, and the cache key carries the `azure` provider so an org fingerprint under
 * gemini and under azure can never collide (TD-22 / D-10).
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

/** Which "lane" of model a call runs on — 'lite' for the cheap stages, 'main' for the rest. */
export type LlmRole = "main" | "lite";

/**
 * The credential fingerprint to mix into a cache key — "env" when no per-org config is active,
 * prefixed with the role's resolved provider so a gemini run and an azure run can never share a
 * cache entry (TD-22 / D-10: the disk half never expires, and "same prompt, different provider"
 * is exactly the kind of missing dimension that shaves wrong answers forever).
 *
 * Under azure the fingerprint is ALWAYS "env", even when a per-org config is active in this run:
 * the org config is Gemini-only, so an azure run's credentials/deployment are process-wide no
 * matter which org is paying. Using the org fingerprint anyway would split the azure cache by
 * tenant even though every tenant shares the same env credentials — same deployment, same key —
 * which is the exact opposite of the TD-22 rule. (The provider prefix already guarantees a gemini
 * run and an azure run never collide; this is about azure runs not colliding with *each other*
 * for no reason.)
 *
 * A single helper rather than each call site reaching into the config, because every cache key in
 * the codebase has to agree on this. A site that forgets it is a site that serves one
 * organisation's answers to another, permanently and silently.
 */
export function llmCacheDimension(role: LlmRole): string {
  const provider = resolvedProvider(role);
  if (provider === "azure") return `${provider}:env`;
  return `${provider}:${currentLlmConfig()?.keyFingerprint ?? "env"}`;
}

/** The provider for a role: `LLM_PROVIDER_LITE` for 'lite' (default = `LLM_PROVIDER`),
 *  `LLM_PROVIDER` for 'main', both defaulting to "gemini". The startup guard in
 *  `server/index.ts` rejects any other value; a caller that reaches this with garbage sees it. */
export function resolvedProvider(role: LlmRole): string {
  if (role === "lite") {
    return process.env.LLM_PROVIDER_LITE || process.env.LLM_PROVIDER || "gemini";
  }
  return process.env.LLM_PROVIDER || "gemini";
}

/** The Azure deployment name for a role: `AZURE_OPENAI_DEPLOYMENT_LITE` for 'lite' (default =
 *  `AZURE_OPENAI_DEPLOYMENT`), `AZURE_OPENAI_DEPLOYMENT` for 'main'. Empty when unset — the
 *  caller that needs it (azureOpenAI) refuses with a naming message. Not org-configurable: per-org
 *  config is Gemini-only. */
export function resolvedDeployment(role: LlmRole): string {
  if (role === "lite") {
    return process.env.AZURE_OPENAI_DEPLOYMENT_LITE
      || process.env.AZURE_OPENAI_DEPLOYMENT
      || "";
  }
  return process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
}

/**
 * The `reasoning_effort` to send to Azure for a role, or undefined when the parameter must NOT be
 * sent.
 *
 * 'main' ALWAYS sends it — `AZURE_OPENAI_REASONING_EFFORT` defaults to "low" (the gpt-5 family is
 * a reasoning model and its default effort is the one knob the pipeline has over completion cost).
 * 'lite' sends it ONLY when `AZURE_OPENAI_REASONING_EFFORT_LITE` is set, and NEVER falls back to
 * the main variable: the lite deployment is gpt-4.1-mini, which rejects the parameter outright
 * (it is not a reasoning model). Undefined means "omit the key from the request body entirely".
 */
export function resolvedReasoningEffort(role: LlmRole): string | undefined {
  if (role === "lite") {
    return process.env.AZURE_OPENAI_REASONING_EFFORT_LITE || undefined;
  }
  return process.env.AZURE_OPENAI_REASONING_EFFORT || "low";
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

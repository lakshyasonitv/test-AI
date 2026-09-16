import { gemini, type GeminiOpts, type GeminiResult } from "./gemini.js";
import { azureOpenAI } from "./azureOpenAI.js";
import {
  resolvedDeployment, resolvedModel, resolvedModelLite, resolvedProvider,
  resolvedReasoningEffort, type LlmRole,
} from "./llmContext.js";

/**
 * The single entry point for every LLM call in the pipeline.
 *
 * One function, one return shape `{content, usage}`, provider chosen by ROLE at the call site —
 * the nine call sites across seven files that used to import `gemini()` now import `llm` and say
 * `role: 'main' | 'lite'` instead of naming a model. The role resolves to a provider via
 * `LLM_PROVIDER`/`LLM_PROVIDER_LITE` (both defaulting to "gemini"), and then to gemini() (existing,
 * unchanged) or azureOpenAI() (a mirror with the same contract).
 *
 * NO FALLBACK BETWEEN PROVIDERS: a role is bound to one provider for the whole request, and a
 * failure is reported as the failing provider's own error. Unset LLM_PROVIDER means every path is
 * byte-identical to before this file existed — `gemini()` is called with exactly the resolved
 * model it would have used anyway.
 *
 * THE PER-ORGANISATION CONFIG (orgLlmConfig.ts) IS GEMINI-ONLY, by name and by shape. It is folded
 * in only when the resolved provider for the role is "gemini" (via `resolvedModel()` reading the
 * ambient LlmConfig); when the role's provider is "azure" it is ignored entirely — see the comment
 * on LlmConfig in llmContext.ts. This is the resolution point the design names.
 */

export type { LlmRole } from "./llmContext.js";

export type LlmOpts = Omit<GeminiOpts, "model"> & { role: LlmRole };

/** The provider a role resolves to, narrowed to the two this build can serve. Throws on garbage —
 *  the startup guard in server/index.ts should have rejected it before a request ever ran. */
export function providerFor(role: LlmRole): "gemini" | "azure" {
  const raw = resolvedProvider(role);
  if (raw === "gemini" || raw === "azure") return raw;
  throw new Error(
    `LLM_PROVIDER${role === "lite" ? "_LITE" : ""} must be "gemini" or "azure" — found ${JSON.stringify(raw)}`,
  );
}

/**
 * The model/deployment dimension for a cache key: `<provider>:<resolved model or deployment>` for
 * the role. Replaces the old `resolvedModel()/resolvedModelLite()` part of every cache key, so the
 * key never silently serves a gemini answer to an azure run or vice versa (TD-22 / D-10). Under
 * gemini this is `gemini:<same model as before>` — a one-time cache miss, recorded in DECISIONS.md.
 */
export function cacheModelDimension(role: LlmRole): string {
  const provider = providerFor(role);
  const modelOrDeployment = provider === "azure"
    ? resolvedDeployment(role)
    : role === "lite" ? resolvedModelLite() : resolvedModel();
  return `${provider}:${modelOrDeployment}`;
}

export async function llm(prompt: string, opts: LlmOpts): Promise<GeminiResult> {
  const { role, ...rest } = opts;
  if (providerFor(role) === "azure") {
    // temperature (from a shared call site, e.g. ir.ts:1592) is deliberately NOT forwarded to the
    // azure body — azureOpenAI never sends it. reasoning effort is resolved per role here: 'main'
    // always sends (default "low"), 'lite' only when AZURE_OPENAI_REASONING_EFFORT_LITE is set.
    return azureOpenAI(prompt, {
      ...rest, deployment: resolvedDeployment(role), reasoningEffort: resolvedReasoningEffort(role),
    });
  }
  // The model is passed explicitly (rather than relying on gemini()'s internal fallback) so the
  // cache dimension and this actual call can never disagree about which model ran. Per-org config
  // is folded in by resolvedModel/resolvedModelLite.
  return gemini(prompt, { ...rest, model: role === "lite" ? resolvedModelLite() : resolvedModel() });
}
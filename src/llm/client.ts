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

export type LlmOpts = Omit<GeminiOpts, "model"> & {
  role: LlmRole;
  /**
   * The envelope key a stage expecting a top-level JSON ARRAY asks for. OpenAI's `json_object`
   * mode can only return a top-level OBJECT, so a prompt demanding "return a JSON array" and
   * `json_object` contradict each other — Azure literally answers `Assistant must output only a
   * JSON array. Please retry.` (run `2026-09-16T10-14-09-905Z-0bb5a291`). When set, the azure
   * provider's added instruction demands the array arrive wrapped: `{"<key>": [ ... ]}`, which
   * `unwrapArray` recovers deterministically. Gemini's JSON mode accepts a bare array, so this
   * option is deliberately NOT forwarded to gemini — the bare-array prompt stays verbatim.
   * See `TECH_DEBT.md` TD-94 / `DECISIONS.md` D-31. The general rule: any stage whose prompt
   * asks for a top-level array must pass `jsonEnvelope`.
   */
  jsonEnvelope?: string;
};

/**
 * The shared result shape every stage reads.  gemini returns `{content, usage}` with no extra
 * fields; azure adds OpenAI-style `finishReason` and `refusal`.  Both are optional and left as
 * `undefined` by gemini.ts — callers that do not care about them never see a type error, and
 * callers that need them (testCases.ts for the `NoTestCasesError` finish-reason path) can read
 * them from the same return type on either provider.
 */
export type LlmResult = GeminiResult & {
  finishReason?: string;
  refusal?: string | null;
};

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

export async function llm(prompt: string, opts: LlmOpts): Promise<LlmResult> {
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
  //
  // jsonEnvelope is deliberately NOT forwarded — Gemini can return a bare JSON array, so the
  // prompt's array instruction stays verbatim and unwrapArray recovers it as-is (see D-31).
  const { jsonEnvelope: _jsonEnvelope, ...geminiRest } = rest;
  return gemini(prompt, { ...geminiRest, model: role === "lite" ? resolvedModelLite() : resolvedModel() });
}
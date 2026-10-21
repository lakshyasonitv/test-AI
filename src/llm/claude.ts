import Anthropic from "@anthropic-ai/sdk";
import { KeyPool, poolFromEnv } from "./keyPool.js";
import { callWithPool, boundErrorBody } from "./backoff.js";
import { recordAmbient } from "./llmBudget.js";

/**
 * The third LLM provider: Anthropic Claude, through the official `@anthropic-ai/sdk` Messages API.
 *
 * The mirror of `azureOpenAI.ts`'s contract on purpose — `{content, usage}` return, spend recorded
 * via `recordAmbient`, the same `stage` label — so `client.ts` can pick it per role and every
 * caller downstream is untouched. Selected only by `LLM_PROVIDER=claude` / `LLM_PROVIDER_LITE=claude`;
 * with both unset nothing in this file ever runs (DECISIONS.md D-58).
 *
 * Contrasts worth knowing:
 *  - Retries stay in ONE place. The SDK client is built with `maxRetries: 0` and `callWithPool`
 *    keeps doing key rotation + backoff + the per-attempt timeout, exactly as for the other two
 *    providers. The SDK's typed `APIError` is re-thrown as a plain Error carrying `.status` and
 *    `.retryAfter`, so `backoff.ts` classifies a 429/503 here the same way it does for Azure. A
 *    529 ("overloaded") is mapped to 503 so it is retried rather than thrown through.
 *  - Keys: `ANTHROPIC_API_KEYS` (comma-separated, rotated) or `ANTHROPIC_API_KEY`, read through
 *    the same `poolFromEnv` Gemini uses. Never a literal in code, never logged.
 *  - `temperature` is NEVER sent: the current Claude models reject sampling parameters. A shared
 *    call site may still pass one (ir.ts sets 0.2); it is dropped here, like azureOpenAI does.
 *  - `thinking` is not sent: the default Claude models think adaptively on their own. Depth and
 *    spend are controlled by `output_config.effort` (`ANTHROPIC_EFFORT[_LITE]`), sent only when set.
 *  - JSON: there is no json mode flag on this API and no assistant prefill on current models, so
 *    `json: true` appends a one-line instruction to the system prompt, and the stage's own
 *    `parseJson`/`unwrapArray` recover the value (fences and all). Claude can return a bare JSON
 *    array, so `jsonEnvelope` is not needed and is ignored — the same reasoning as gemini (D-31).
 *  - `stop_reason: "refusal"` and `"max_tokens"` are thrown as plain Errors with no `.status`, so
 *    the retry loop throws them straight through — the same blocked or clipped prompt re-billed is
 *    not a retry.
 *  - The per-organisation config in `orgLlmConfig.ts` is Gemini-only and is never consulted here.
 */

export interface ClaudeOpts {
  /** Model id — `ANTHROPIC_MODEL` / `_LITE`, resolved in llmContext.ts. */
  model?: string;
  json?: boolean;
  systemInstruction?: string;
  imageBase64?: string;
  imageMime?: string;
  /** A document part (Pro intake's PDF). Sent as a base64 `document` block. */
  fileBase64?: string;
  fileMime?: string;
  /** `output_config.effort`, or undefined to omit it and take the model's own default. */
  effort?: string;
  /** `max_tokens` (required by this API). Defaults to CLAUDE_DEFAULT_MAX_TOKENS. */
  maxOutputTokens?: number;
  stage?: string;
}

export interface ClaudeResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Claude's `stop_reason` ("end_turn", ...). `max_tokens`/`refusal` are thrown, never returned. */
  finishReason?: string;
  refusal?: string | null;
}

/** Non-streaming ceiling: room for a full IR or case list, small enough to stay well inside the
 *  SDK's non-streaming request limits. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 16000;

// Built on first use, not at import — KeyPool throws on a missing key, and importing client.ts
// must not fail on a gemini-only deployment. Same lazy pattern as gemini.ts / azureOpenAI.ts.
let pool: KeyPool | undefined;
const getPool = (): KeyPool => (pool ??= poolFromEnv("ANTHROPIC_API_KEYS", "claude"));

/** Test seam: forget the cached pool so a test can change the key env between cases. */
export function resetClaudePoolForTests(): void { pool = undefined; }

/** Re-throw an SDK error in the shape `backoff.ts` already understands. Bounded message: provider
 *  prose of uncontrolled length must not ride an Error into ir.ts's logs whole. */
function normalizeError(err: unknown): unknown {
  // A connection failure / abort is left as-is: backoff.ts recognises transport errors and its own
  // timeout by their own signals, and must not see them as rate limits.
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status === 529 ? 503 : err.status;
    const e: any = new Error(`Claude ${err.status ?? "error"}: ${boundErrorBody(err.message)}`);
    e.status = status;
    e.retryAfter = err.headers?.get?.("retry-after") ?? undefined;
    return e;
  }
  return err;
}

export async function claude(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  const stage = opts.stage ?? "unknown";
  const model = opts.model?.trim();
  if (!model) {
    throw new Error("Claude: no model is configured — set ANTHROPIC_MODEL before selecting the claude provider");
  }
  console.log("[claude] calling model:", model, "| prompt length:", prompt.length);

  const system = opts.json
    ? `${opts.systemInstruction ? opts.systemInstruction + "\n\n" : ""}Respond with valid JSON only — no prose, no code fences.`
    : opts.systemInstruction;

  const content: Anthropic.ContentBlockParam[] = [];
  if (opts.fileBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: opts.fileBase64 },
    });
  }
  if (opts.imageBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: (opts.imageMime ?? "image/png") as Anthropic.Base64ImageSource["media_type"],
        data: opts.imageBase64,
      },
    });
  }
  content.push({ type: "text", text: prompt });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: opts.maxOutputTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content }],
  };
  if (system) params.system = system;
  if (opts.effort) params.output_config = { effort: opts.effort as Anthropic.OutputConfig["effort"] };

  try {
    const result = await callWithPool(getPool(), async (apiKey, signal) => {
      const client = new Anthropic({ apiKey, maxRetries: 0 });
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(params, { signal });
      } catch (err) {
        throw normalizeError(err);
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const u = message.usage;
      const promptTokens = (u.input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const usage = { promptTokens, completionTokens: u.output_tokens ?? 0, totalTokens: promptTokens + (u.output_tokens ?? 0) };
      if (message.stop_reason === "refusal") {
        throw new Error(`Claude refusal: ${boundErrorBody(text || "the model declined this request")}`);
      }
      if (message.stop_reason === "max_tokens") {
        throw new Error(`Claude truncated: ${text.slice(0, 300)}`);
      }
      return { content: text, usage, finishReason: message.stop_reason ?? undefined, refusal: null };
    });
    recordAmbient(stage, result.usage, "claude");
    return result;
  } catch (err) {
    recordAmbient(stage, undefined, "claude");
    throw err;
  }
}

import { KeyPool } from "./keyPool.js";
import { callWithPool } from "./backoff.js";
import { recordAmbient } from "./llmBudget.js";

/**
 * The second LLM provider: an Azure OpenAI `chat/completions` call.
 *
 * The mirror of `gemini.ts`'s public contract on purpose — `{content, usage}` return, spend
 * recorded via `recordAmbient` the same way, the same `stage` label — so `client.ts` can pick a
 * provider per role and every caller downstream is untouched. `callWithPool` is reused unchanged
 * (key rotation + exponential backoff + per-attempt timeout): a single key becomes a one-key
 * `KeyPool`, so retries on 429/503/transport exactly reproduce what a one-key gemini setup does.
 * There is deliberately no second retry loop here.
 *
 * Contrasts with gemini.ts worth noting:
 *  - The request goes to `{AZURE_OPENAI_ENDPOINT}/openai/v1/chat/completions` with an `api-key`
 *    header (no OAuth, no bearer flow), and `body.model` is the DEPLOYMENT name, not a model id.
 *  - OpenAI's chat-completions request shape is message-array based, not `contents[{parts}]`.
 *  - `json: true` needs `response_format: {type:"json_object"}` AND the word "json" to appear in
 *    the messages or OpenAI rejects the request, so the one-line "Respond with valid JSON only."
 *    instruction is appended to the system message whenever json output is requested.
 *  - A 400 whose body names `content_filter` is a REFUSAL, not a retryable rate limit: it is
 *    surfaced as its own error class (`Azure OpenAI content_filter: <reason>`) so `backoff.ts`
 *    throws it straight through (`rateLimited` returns null for it).
 *  - The per-organisation config in `orgLlmConfig.ts` is Gemini-only and is never consulted here.
 *  - Parameter rules specific to Azure's model family: temperature is NEVER sent (gpt-5 family
 *    rejects it — dropping it is safe on both deployments); an output cap maps to
 *    `max_completion_tokens`, never `max_tokens`; `reasoning_effort` is sent per role (main always,
 *    lite only when configured), and `usage.completion_tokens_details.reasoning_tokens` is read
 *    when present so reasoning spend is visible in 08-llm-usage.json instead of hidden.
 */

export interface AzureOpenAIOpts {
  /** Deployment name — `AZURE_OPENAI_DEPLOYMENT` / `_LITE`, resolved in llmContext.ts. */
  deployment?: string;
  json?: boolean;             // request structured JSON output
  systemInstruction?: string;
  imageBase64?: string;       // optional vision input
  imageMime?: string;         // default image/png
  /**
   * `reasoning_effort` for a reasoning model. Resolved per role in llmContext.ts: 'main' always
   * sends it (default "low"), 'lite' only when AZURE_OPENAI_REASONING_EFFORT_LITE is set — the
   * lite deployment is gpt-4.1-mini, which rejects the parameter outright. Undefined = omit the
   * key from the body.
   */
  reasoningEffort?: string;
  /** Optional cap on output tokens, mapped to `max_completion_tokens` (NEVER `max_tokens` — the
   *  two count differently on the gpt-5 family). No call site sets it today; see GeminiOpts. */
  maxOutputTokens?: number;
  /** Short label for the ambient budget's per-stage breakdown — same convention as gemini.ts. */
  stage?: string;
}

export interface AzureOpenAIUsage {
  promptTokens: number; completionTokens: number; totalTokens: number;
  /** Reasoning-model reasoning tokens, when the provider reports them
   *  (usage.completion_tokens_details.reasoning_tokens). Absent on a non-reasoning model. */
  reasoningTokens?: number;
}
export interface AzureOpenAIResult { content: string; usage: AzureOpenAIUsage; }

// Built on first use, not at import — the KeyPool constructor throws on a missing key, and module
// scope would make merely importing client.ts fail without the azure env configured, even when the
// provider is gemini (the default). Same lazy pattern gemini.ts uses for exactly this reason.
let pool: KeyPool | undefined;
const getPool = (): KeyPool => {
  const key = (process.env.AZURE_OPENAI_API_KEY ?? "").trim();
  return (pool ??= new KeyPool(key ? [key] : []));
};

/** Extract a short human reason from an OpenAI error body, for error messages and logs. */
function errorReason(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return parsed.error?.message ?? parsed.error?.code ?? text;
  } catch {
    return text;
  }
}

export async function azureOpenAI(prompt: string, opts: AzureOpenAIOpts = {}): Promise<AzureOpenAIResult> {
  const stage = opts.stage ?? "unknown";
  const deployment = opts.deployment?.trim();
  if (!deployment) {
    throw new Error(
      "Azure OpenAI: no deployment name is configured — set AZURE_OPENAI_DEPLOYMENT " +
      `(and AZURE_OPENAI_DEPLOYMENT_LITE for the cheap-model stages) before selecting the azure provider`,
    );
  }
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error("Azure OpenAI: AZURE_OPENAI_ENDPOINT is not set");
  }

  // One-line JSON instruction when json output is requested — OpenAI refuses json_object mode
  // unless the word "json" actually appears somewhere in the messages. Appended to the system
  // message so the caller's own instruction (if any) stays untouched.
  const system = opts.json
    ? `${opts.systemInstruction ? opts.systemInstruction + "\n\n" : ""}Respond with valid JSON only.`
    : opts.systemInstruction;

  const messages: any[] = [];
  if (system) messages.push({ role: "system", content: system });
  const userContent = opts.imageBase64
    ? [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: `data:${opts.imageMime ?? "image/png"};base64,${opts.imageBase64}` },
        },
      ]
    : prompt;
  messages.push({ role: "user", content: userContent });

  const body: any = { model: deployment, messages };
  if (opts.json) body.response_format = { type: "json_object" };
  // NEVER temperature: the gpt-5 family rejects the parameter outright, and dropping it is safe
  // for both deployments (each model's own default sampling applies). temperature may still reach
  // this object from a shared call site (ir.ts sets 0.2) — it is deliberately never mapped into
  // the body here, on any path.
  if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
  // max_completion_tokens, never max_tokens: the count is inclusive of reasoning tokens on the
  // gpt-5 family, where max_tokens is not a supported alias.
  if (opts.maxOutputTokens !== undefined) body.max_completion_tokens = opts.maxOutputTokens;

  try {
    const result = await callWithPool(getPool(), async (apiKey, signal) => {
      const res = await fetch(`${endpoint}/openai/v1/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("[azureOpenAI] error body:", text.slice(0, 200));
        // A refusal, not a rate limit: Azure reports it as a 400 carrying `code: content_filter`
        // (in the body) or the words in the message. No e.status / e.retryAfter is set, so
        // backoff.ts's rateLimited() sees no 429/503 and throws this straight through with zero
        // retries — a content_filter refusal is exactly the same blocked prompt re-billed.
        const code = (() => { try { return (JSON.parse(text) as any)?.error?.code; } catch { return undefined; } })();
        if (code === "content_filter" || text.includes("content_filter")) {
          const e: any = new Error(`Azure OpenAI content_filter: ${errorReason(text)}`);
          e.contentFilter = true;
          throw e;
        }
        const e: any = new Error(`Azure OpenAI ${res.status}: ${text}`);
        e.status = res.status;
        e.retryAfter = res.headers.get("retry-after");
        if (res.status === 429) {
          console.warn("[azureOpenAI] quota exceeded — will retry after backoff (status 429)");
        }
        throw e;
      }
      const data = await res.json();
      const content = (data.choices?.[0]?.message?.content ?? "") as string;
      const u = data.usage ?? {};
      // totalTokens read directly (not prompt+completion summed), mirroring gemini.ts — Azure's
      // own total can include reasoning tokens the split doesn't otherwise surface.
      const usage: AzureOpenAIUsage = {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0,
      };
      // Reasoning tokens ride in usage.completion_tokens_details.reasoning_tokens when the model
      // reasons (gpt-5 family); gpt-4.1-mini does not send the field at all. Captured so
      // 08-llm-usage.json can show "X reasoning" per stage instead of silently folding them into
      // completion totals nobody can decompose.
      const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
      if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
      return { content, usage };
    });
    recordAmbient(stage, result.usage, "azure");
    return result;
  } catch (err) {
    // Counted even on failure — a rejected call already spent the request, exactly as gemini.ts's
    // own catch path does.
    recordAmbient(stage, undefined, "azure");
    throw err;
  }
}
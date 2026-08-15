import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";

// Built on first use, not at import — see the note in gemini.ts.
let pool: ReturnType<typeof poolFromEnv> | undefined;
const getPool = () => (pool ??= poolFromEnv("GROQ_API_KEYS"));

export interface GroqOpts { model?: string; json?: boolean; system?: string; temperature?: number; }

export interface GroqUsage { promptTokens: number; completionTokens: number; totalTokens: number; }
export interface GroqResult { content: string; usage: GroqUsage; }

export async function groq(prompt: string, opts: GroqOpts = {}): Promise<GroqResult> {
  const model = opts.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
  console.log("[groq] calling model:", model, "| prompt length:", prompt.length);

  // gpt-oss models are reasoning models; "low" keeps this schema-constrained task from
  // burning billed tokens on deep reasoning it doesn't need. Gated on the model name so a
  // future non-reasoning fallback isn't sent a param it might reject.
  const isGptOss = model.startsWith("openai/gpt-oss");

  // Tighter than backoff.ts's shared default of 6: Groq has a single non-rotating key
  // here (org-level rate limit), so a retry doesn't get a fresh key — it just waits on
  // the same wall. ir.ts's own MAX_ATTEMPTS loop is the outer retry, but that outer loop
  // re-sends the FULL prompt (costing more tokens against the very TPM budget that just
  // rejected it) with no delay — so a real TPM squeeze should be absorbed here, inside a
  // single logical IR attempt, whenever the wait is short. 4, not 2: now that
  // parseRetryDelay (backoff.ts) actually recognizes Groq's real "try again in Nms" wording
  // instead of silently discarding it, a short wait (seen in practice: 495ms) gets honored
  // correctly and is worth one or two extra local retries before giving up and paying the
  // much larger cost of a whole new IR attempt. See TECH_DEBT.md TD-03.
  return callWithPool(getPool(), async (apiKey, signal) => {
    console.log("[groq] sending request...");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.2,
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: prompt },
        ],
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        ...(isGptOss ? { reasoning_effort: "low" } : {}),
      }),
    });
    console.log("[groq] response status:", res.status);
    if (!res.ok) {
      const text = await res.text();
      console.error("[groq] error body:", text.slice(0, 200));
      const e: any = new Error(`Groq ${res.status}: ${text}`);
      e.status = res.status;
      e.retryAfter = res.headers.get("retry-after");
      throw e;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log("[groq] response length:", content.length, "| usage:", data.usage);
    return {
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }, { maxRetries: 4 });
}

import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";

const pool = poolFromEnv("GROQ_API_KEYS");

export interface GroqOpts { model?: string; json?: boolean; system?: string; }

export async function groq(prompt: string, opts: GroqOpts = {}): Promise<string> {
  const model = opts.model ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  console.log("[groq] calling model:", model, "| prompt length:", prompt.length);

  return callWithPool(pool, async (apiKey) => {
    console.log("[groq] sending request...");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: prompt },
        ],
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
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
    console.log("[groq] response length:", (data.choices?.[0]?.message?.content ?? "").length);
    return data.choices?.[0]?.message?.content ?? "";
  });
}

import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";

const pool = poolFromEnv("GROQ_API_KEYS");

export interface GroqOpts { model?: string; json?: boolean; system?: string; }

export async function groq(prompt: string, opts: GroqOpts = {}): Promise<string> {
  const model = opts.model ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

  return callWithPool(pool, async (apiKey) => {
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
    if (!res.ok) {
      const text = await res.text();
      const e: any = new Error(`Groq ${res.status}: ${text}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  });
}

import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";

const pool = poolFromEnv("GEMINI_API_KEYS");

export interface GeminiOpts {
  model?: string;
  json?: boolean;             // request application/json output
  systemInstruction?: string;
  imageBase64?: string;       // optional vision input
  imageMime?: string;         // default image/png
}

export async function gemini(prompt: string, opts: GeminiOpts = {}): Promise<string> {
  const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  console.log("[gemini] calling model:", model, "| prompt length:", prompt.length);

  return callWithPool(pool, async (apiKey) => {
    const parts: any[] = [{ text: prompt }];
    if (opts.imageBase64) {
      parts.push({ inline_data: { mime_type: opts.imageMime ?? "image/png", data: opts.imageBase64 } });
    }
    const body: any = { contents: [{ role: "user", parts }] };
    if (opts.systemInstruction) body.system_instruction = { parts: [{ text: opts.systemInstruction }] };
    if (opts.json) body.generationConfig = { responseMimeType: "application/json" };

    console.log("[gemini] sending request...");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      }
    );
    console.log("[gemini] response status:", res.status);
    if (!res.ok) {
      const text = await res.text();
      console.error("[gemini] error body:", text.slice(0, 200));
      const e: any = new Error(`Gemini ${res.status}: ${text}`);
      e.status = res.status;
      e.retryAfter = res.headers.get("retry-after");
      if (res.status === 429) {
        console.warn("[gemini] quota exceeded — will retry after backoff (status 429)");
      }
      throw e;
    }
    const data = await res.json();
    const content = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "").join("");
    console.log("[gemini] response length:", content.length);
    return content;
  });
}

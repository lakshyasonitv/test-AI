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
  const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

  return callWithPool(pool, async (apiKey) => {
    const parts: any[] = [{ text: prompt }];
    if (opts.imageBase64) {
      parts.push({ inline_data: { mime_type: opts.imageMime ?? "image/png", data: opts.imageBase64 } });
    }
    const body: any = { contents: [{ role: "user", parts }] };
    if (opts.systemInstruction) body.system_instruction = { parts: [{ text: opts.systemInstruction }] };
    if (opts.json) body.generationConfig = { responseMimeType: "application/json" };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      const e: any = new Error(`Gemini ${res.status}: ${text}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "").join("");
  });
}

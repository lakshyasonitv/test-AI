import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";
import { recordAmbient } from "./llmBudget.js";

// Built on first use, not at import. KeyPool throws when no keys are configured, and at
// module scope that made merely *importing* anything downstream of this file fail — so pure
// functions in ir.ts / generator.ts could not be unit-tested without live credentials.
let pool: ReturnType<typeof poolFromEnv> | undefined;
const getPool = () => (pool ??= poolFromEnv("GEMINI_API_KEYS"));

export interface GeminiOpts {
  model?: string;
  json?: boolean;             // request application/json output
  systemInstruction?: string;
  imageBase64?: string;       // optional vision input
  imageMime?: string;         // default image/png
  /** No provider default here (unlike Groq's 0.2) — omitted entirely means Gemini's own
   *  default applies. IR generation sets this explicitly; every other stage is unaffected by
   *  this option existing. */
  temperature?: number;
  /** Short label for the ambient budget's per-stage breakdown (llmBudget.ts's `recordAmbient`)
   *  — the StageName convention ("plan", "discovery", "testcases", "failure_analysis"), or
   *  omitted for a call made outside `runWithBudget` (a direct unit test, a one-off script). */
  stage?: string;
}

export interface GeminiUsage { promptTokens: number; completionTokens: number; totalTokens: number; }
export interface GeminiResult { content: string; usage: GeminiUsage; }

export async function gemini(prompt: string, opts: GeminiOpts = {}): Promise<GeminiResult> {
  let model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  console.log("[gemini] calling model:", model, "| prompt length:", prompt.length);
  const stage = opts.stage ?? "unknown";

  try {
    const result = await callWithPool(getPool(), async (apiKey, signal) => {
      const parts: any[] = [{ text: prompt }];
      if (opts.imageBase64) {
        parts.push({ inline_data: { mime_type: opts.imageMime ?? "image/png", data: opts.imageBase64 } });
      }
      const body: any = { contents: [{ role: "user", parts }] };
      if (opts.systemInstruction) body.system_instruction = { parts: [{ text: opts.systemInstruction }] };
      if (opts.json || opts.temperature !== undefined) {
        body.generationConfig = {
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        };
      }

      console.log("[gemini] sending request...");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal,
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
      console.log("[gemini] response length:", content.length, "| usage:", data.usageMetadata);
      return {
        content,
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
          // Read directly rather than summed from prompt+completion — Gemini's total also
          // includes thoughtsTokenCount (reasoning tokens), which the prompt/completion split
          // doesn't otherwise surface at all. Summing the two would silently undercount actual
          // spend on any model that does internal reasoning.
          totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
        },
      };
    });
    recordAmbient(stage, result.usage);
    return result;
  } catch (err) {
    // Counted even on failure — a rejected call already spent the request. Mirrors the
    // explicit `budget?.record()` on the catch path in ir.ts's own retry loop. A no-op outside
    // `runWithBudget` (recordAmbient itself is the optional part), so this never breaks a
    // caller that doesn't care about budgeting.
    recordAmbient(stage);
    throw err;
  }
}

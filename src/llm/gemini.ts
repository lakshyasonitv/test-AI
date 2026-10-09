import { poolFromEnv } from "./keyPool.js";
import { callWithPool, boundErrorBody, retryAfterFromBody } from "./backoff.js";
import { recordAmbient } from "./llmBudget.js";
import { currentLlmConfig } from "./llmContext.js";

/**
 * The models this server offers in the admin panel's dropdown.
 *
 * ONE list, exported, so the UI, the validator and the documentation cannot drift apart — a
 * second hand-maintained copy of this is `DECISIONS.md` D-01's failure mode reappearing as code.
 *
 * It is a convenience, NOT the authority: a hardcoded list goes stale every time Google ships a
 * model, so `verifyGeminiCredentials` below asks the provider what THIS key can actually use and
 * refuses a save that the provider would reject. The list stops typos; the live check stops the
 * list from lying. That is this project's standing rule — a stated preference always has a
 * deterministic check behind it (`CLAUDE.md`, D-02/D-03).
 */
export const GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

// Built on first use, not at import. KeyPool throws when no keys are configured, and at
// module scope that made merely *importing* anything downstream of this file fail — so pure
// functions in ir.ts / generator.ts could not be unit-tested without live credentials.
let pool: ReturnType<typeof poolFromEnv> | undefined;
const getPool = () => (pool ??= poolFromEnv("GEMINI_API_KEYS", "gemini"));

export interface GeminiOpts {
  model?: string;
  json?: boolean;             // request application/json output
  systemInstruction?: string;
  imageBase64?: string;       // optional vision input
  imageMime?: string;         // default image/png
  /** No provider default here (unlike Groq's 0.2) — omitted entirely means Gemini's own
   *  default applies. IR generation sets this explicitly; every other stage is unaffected by
   *  this option existing. (azureOpenAI never sends temperature regardless — the gpt-5 family
   *  rejects it — so dropping it is safe on BOTH providers; see client.ts.) */
  temperature?: number;
  /** Optional cap on generated tokens. No call site sets it today; it exists so the shared
   *  opts type can carry an output cap to whichever provider runs, and each provider maps it to
   *  ITS OWN field name (gemini: generationConfig.maxOutputTokens; azureOpenAI:
   *  max_completion_tokens, NEVER max_tokens — the token-counting APIs differ). */
  maxOutputTokens?: number;
  /** Short label for the ambient budget's per-stage breakdown (llmBudget.ts's `recordAmbient`)
   *  — the StageName convention ("plan", "discovery", "testcases", "failure_analysis"), or
   *  omitted for a call made outside `runWithBudget` (a direct unit test, a one-off script). */
  stage?: string;
}

export interface GeminiUsage { promptTokens: number; completionTokens: number; totalTokens: number; }
export interface GeminiResult { content: string; usage: GeminiUsage; }

/**
 * Raised when a single prompt exceeds `LLM_MAX_PROMPT_CHARS`. Typed so callers can tell a
 * refusal-before-sending apart from a provider error: nothing was spent, and retrying the same
 * prompt cannot help.
 */
export class PromptTooLargeError extends Error {
  readonly isPromptTooLarge = true;
  constructor(readonly stage: string, readonly chars: number, readonly limit: number) {
    super(
      `The ${stage} stage tried to send a prompt of ${chars.toLocaleString()} characters, over the ` +
      `${limit.toLocaleString()} limit, so it was refused before being sent. This is a bug in how ` +
      `that prompt is built — usually one page element whose text ran away — not something wrong ` +
      `with the site under test. Raise LLM_MAX_PROMPT_CHARS only if you know why the prompt is ` +
      `this big.`,
    );
    this.name = "PromptTooLargeError";
  }
}

/**
 * Last line of defence against a runaway prompt, checked before anything is sent.
 *
 * Every stage caps its own inputs, and every one of those caps is a place a new input dimension
 * can be added without anyone remembering to bound it. That happened: a single `discovery` call on
 * run `2026-09-03T11-49-04-132Z-f568ba48` sent **514,427 prompt tokens** — 40% of all prompt tokens
 * across every run on disk — because one element's accessible name was an inlined stylesheet
 * (648,107 characters). No per-stage cap caught it because none of them looked at that dimension.
 *
 * So the bound lives here too, where every stage passes through exactly once. Generous by design:
 * it is not a tuning knob, it is a tripwire. `TECH_DEBT.md` TD-73.
 */
const DEFAULT_MAX_PROMPT_CHARS = 200_000;
const maxPromptChars = (): number => {
  const raw = Number(process.env.LLM_MAX_PROMPT_CHARS ?? DEFAULT_MAX_PROMPT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROMPT_CHARS;
};

export async function gemini(prompt: string, opts: GeminiOpts = {}): Promise<GeminiResult> {
  // Per-run configuration, if this call is inside a run that entered one. Absent (CLI, unit test,
  // feature flag off) means the process-wide env pool and GEMINI_MODEL, exactly as before.
  const runConfig = currentLlmConfig();
  let model = opts.model ?? runConfig?.model ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  console.log("[gemini] calling model:", model, "| prompt length:", prompt.length);
  const stage = opts.stage ?? "unknown";

  // Before the pool, before the budget: a refused call spends nothing, so it must not be
  // recorded as a call either.
  const limit = maxPromptChars();
  if (prompt.length > limit) {
    console.error(
      `[gemini] REFUSED: ${stage} prompt is ${prompt.length} chars, over the ${limit} limit. ` +
      `Nothing was sent. See TECH_DEBT.md TD-73.`,
    );
    throw new PromptTooLargeError(stage, prompt.length, limit);
  }

  try {
    const result = await callWithPool(runConfig?.pool ?? getPool(), async (apiKey, signal) => {
      const parts: any[] = [{ text: prompt }];
      if (opts.imageBase64) {
        parts.push({ inline_data: { mime_type: opts.imageMime ?? "image/png", data: opts.imageBase64 } });
      }
      const body: any = { contents: [{ role: "user", parts }] };
      if (opts.systemInstruction) body.system_instruction = { parts: [{ text: opts.systemInstruction }] };
      if (opts.json || opts.temperature !== undefined || opts.maxOutputTokens !== undefined) {
        body.generationConfig = {
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
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
        console.error("[gemini] error body:", boundErrorBody(text));
        // Bounded HERE, not at the console line above: `.message` is what ir.ts:1656/1665/1670
        // and backoff.ts print whole, so the construction site is the only place that bounds
        // every downstream printer at once. `retryAfter` is lifted from the raw body first, for
        // the same reason — a bounded message can no longer carry `Please retry after Ns` to
        // parseRetryDelay.
        const e: any = new Error(`Gemini ${res.status}: ${boundErrorBody(text)}`);
        e.status = res.status;
        e.retryAfter = res.headers.get("retry-after") ?? retryAfterFromBody(text);
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
    recordAmbient(stage, result.usage, "gemini");
    return result;
  } catch (err) {
    // Counted even on failure — a rejected call already spent the request. Mirrors the
    // explicit `budget?.record()` on the catch path in ir.ts's own retry loop. A no-op outside
    // `runWithBudget` (recordAmbient itself is the optional part), so this never breaks a
    // caller that doesn't care about budgeting.
    recordAmbient(stage, undefined, "gemini");
    throw err;
  }
}

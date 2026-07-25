import { poolFromEnv } from "./keyPool.js";
import { callWithPool } from "./backoff.js";

const pool = poolFromEnv("GEMINI_API_KEYS");

const MODEL =
  process.env.GEMINI_EMBED_MODEL ??
  "text-embedding-004";

// Simple in-memory cache
const cache = new Map<string, number[]>();

export async function embedText(text: string): Promise<number[]> {
  const key = text.trim();

  const cached = cache.get(key);
  if (cached) return cached;

  const embedding = await callWithPool(pool, async (apiKey) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: {
            parts: [
              {
                text: key,
              },
            ],
          },
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      const e: any = new Error(`Gemini Embedding ${res.status}: ${text}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();

    return data.embedding.values as number[];
  });

  cache.set(key, embedding);

  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length)
    throw new Error("Embedding dimensions differ.");

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0)
    return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

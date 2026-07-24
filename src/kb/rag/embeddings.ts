import { setTimeout as sleep } from "node:timers/promises";

const MODEL = "gemini-embedding-001";
const API_URL = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents?key=${key}`;

function getKey(): string {
  // Reuses the same GEMINI_API_KEY your llm/gemini.ts already reads.
  const key = process.env.GEMINI_API_KEYS;
  if (!key) throw new Error("GEMINI_API_KEYs is not set (needed for RAG embeddings)");
  return key;
}

async function embedBatchOnce(texts: string[]): Promise<number[][]> {
  const body = {
    requests: texts.map(text => ({
      model: `models/${MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    })),
  };

  const res = await fetch(API_URL(getKey()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as { embeddings: { values: number[] }[] };
  return data.embeddings.map(e => e.values);
}

/** Batches of 100 (batchEmbedContents limit), with simple exponential backoff on failure. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const BATCH = 100;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    let attempt = 0;
    for (;;) {
      try {
        out.push(...await embedBatchOnce(batch));
        break;
      } catch (err) {
        attempt++;
        if (attempt >= 4) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

export const EMBEDDING_MODEL = MODEL;
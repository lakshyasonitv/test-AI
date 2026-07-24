import { loadIndex, topKByScore } from "./vectorStore.js";
import { embedQuery } from "./embeddings.js";
import type { RetrievalQuery, RetrievedChunk } from "./types.js";

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K ?? 6);
const PER_CONCEPT_K = Number(process.env.RAG_PER_CONCEPT_K ?? 3);

let indexCache: ReturnType<typeof loadIndex> = undefined as any;
function getIndex() {
  if (indexCache === undefined) indexCache = loadIndex();
  return indexCache;
}

async function retrieveFor(text: string, k: number, index: NonNullable<ReturnType<typeof loadIndex>>) {
  const embedding = await embedQuery(text);
  return topKByScore(embedding, index.chunks, k);
}

/** Retrieves relevant knowledge for a URL + prompt + page concepts. Runs one retrieval pass
 *  per detected concept (so every concept — Login, SignUp, Checkout, ... — is guaranteed some
 *  representation) PLUS one pass on the overall prompt (for cross-cutting things like security/
 *  accessibility/best-practices that aren't tied to a single concept), then merges and dedupes.
 *  This avoids a single dominant concept starving the others out of a combined top-K ranking. */
export async function retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
  const index = getIndex();
  if (!index || index.chunks.length === 0) {
    console.warn("kb/rag: no index found — run `node --import tsx src/kb/rag/ingest.ts` first");
    return [];
  }

  const concepts = query.concepts ?? [];
  const overallText = [
    query.url ? `Site: ${query.url}` : "",
    `Task: ${query.userPrompt}`,
    concepts.length ? `Page concepts: ${concepts.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  // One pass on the whole prompt — catches cross-cutting knowledge (security, accessibility,
  // best-practices, playwright) not tied to any single concept.
  const passes = [retrieveFor(overallText, query.topK ?? DEFAULT_TOP_K, index)];

  // One pass per concept — guarantees every detected page type gets its own dedicated
  // retrieval, so e.g. SignUp doesn't get crowded out by a stronger Login match.
  for (const concept of concepts) {
    passes.push(retrieveFor(`${concept} page testing scenarios`, PER_CONCEPT_K, index));
  }

  const results = (await Promise.all(passes)).flat();

  // Merge + dedupe by chunk id, keeping the highest score seen for each chunk across passes.
  const byId = new Map<string, typeof results[number]>();
  for (const r of results) {
    const existing = byId.get(r.id);
    if (!existing || r.score > existing.score) byId.set(r.id, r);
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ embedding, ...rest }) => rest);
}
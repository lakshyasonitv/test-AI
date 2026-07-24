import { chunkKnowledgeBase } from "./chunker.js";
import { embedTexts, EMBEDDING_MODEL } from "./embeddings.js";
import { loadIndex, saveIndex } from "./vectorStore.js";
import type { EmbeddedChunk } from "./types.js";

/** Rebuilds the RAG index: re-chunks every .md file under kb/knowledge, embeds only chunks
 *  whose content changed since the last run, and reuses cached embeddings for everything else.
 *  Run after editing/adding knowledge files:
 *    node --import tsx src/kb/rag/ingest.ts
 */
export async function ingest(): Promise<void> {
  const chunks = chunkKnowledgeBase();
  const existing = loadIndex();
  const cached = new Map((existing?.chunks ?? []).map(c => [c.id, c]));

  const toEmbed = chunks.filter(c => cached.get(c.id)?.contentHash !== c.contentHash);
  console.log(`kb/rag: ${chunks.length} chunks total, ${toEmbed.length} need (re)embedding`);

  let embedded: EmbeddedChunk[] = [];
  if (toEmbed.length > 0) {
    const vectors = await embedTexts(toEmbed.map(c => c.text));
    embedded = toEmbed.map((c, i) => ({ ...c, embedding: vectors[i] }));
  }

  const embeddedById = new Map(embedded.map(c => [c.id, c]));
  const finalChunks: EmbeddedChunk[] = chunks.map(c =>
    embeddedById.get(c.id) ?? (cached.get(c.id) as EmbeddedChunk));

  saveIndex({ model: EMBEDDING_MODEL, builtAt: new Date().toISOString(), chunks: finalChunks });
  console.log(`kb/rag: index written (${finalChunks.length} chunks)`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/kb/rag/ingest.ts")) {
  ingest().catch(err => { console.error(err); process.exit(1); });
}
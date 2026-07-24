export interface KnowledgeChunk {
  id: string;          // stable id: sha1(source + heading + index)
  source: string;       // relative path under kb/knowledge, e.g. "page-scenarios/login.md"
  category: string;      // "best-practice" | "accessibility" | "security" | "edge-case"
                         // | "validation" | "playwright" | "page-scenario:<name>" | "custom"
  heading: string;
  text: string;
  contentHash: string;  // sha1(text) — used to skip re-embedding unchanged chunks
}

export interface EmbeddedChunk extends KnowledgeChunk {
  embedding: number[];
}

export interface RagIndex {
  model: string;
  builtAt: string;
  chunks: EmbeddedChunk[];
}

export interface RetrievalQuery {
  url?: string;
  userPrompt: string;
  concepts?: string[];   // page concepts from discovery/crawl, e.g. ["Login", "Search"]
  topK?: number;
}

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
}
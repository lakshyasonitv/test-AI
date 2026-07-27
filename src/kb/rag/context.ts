import { retrieve } from "./retriever.js";
import type { RetrievalQuery } from "./types.js";

const MAX_CONTEXT_CHARS = 6000;

/** Assembles retrieved chunks into a markdown block ready to prepend to the LLM prompt for
 *  test generation. Dedupes by source+heading, stops once the char budget is spent. */
export async function buildRagContext(query: RetrievalQuery): Promise<string> {
  const chunks = await retrieve(query);
  if (chunks.length === 0) return "";

  const seen = new Set<string>();
  const parts: string[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const c of chunks) {
    const key = `${c.source}::${c.heading}`;
    if (seen.has(key)) continue;
    const block = `### [${c.category}] ${c.heading}\n${c.text}`;
    if (block.length > budget) continue;
    seen.add(key);
    parts.push(block);
    budget -= block.length;
  }

 if (parts.length === 0) return "";
return `## Behavioral expectations for the named feature(s) (background only — do NOT turn these into separate test cases)\n\n${parts.join("\n\n")}`;
}
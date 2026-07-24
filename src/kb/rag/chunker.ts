import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { KnowledgeChunk } from "./types.js";

const KB_ROOT = path.join("src", "kb", "knowledge");
const MAX_CHUNK_CHARS = 1400; // keeps each chunk small enough to be a focused retrieval unit

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

/** category is derived from the file's location: page-scenarios/login.md -> "page-scenario:login",
 *  custom/anything.md -> "custom", everything else -> the filename stem. */
function categoryFor(relPath: string): string {
  const parts = relPath.split(path.sep);
  if (parts[0] === "page-scenarios") return `page-scenario:${path.basename(parts[1], ".md")}`;
  if (parts[0] === "custom") return "custom";
  return path.basename(relPath, ".md");
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else if (entry.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

/** Splits further if a section is too long, on paragraph boundaries — never mid-sentence. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > MAX_CHUNK_CHARS && cur) { out.push(cur.trim()); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Chunks every .md file under kb/knowledge by "## " heading. Each heading section becomes
 *  one retrievable unit (further split if it's too long). Heading-based chunking keeps each
 *  chunk topically coherent, which matters more for retrieval quality here than a fixed
 *  token-window strategy would. */
export function chunkKnowledgeBase(): KnowledgeChunk[] {
  const files = walk(KB_ROOT);
  const chunks: KnowledgeChunk[] = [];

  for (const rel of files) {
    const raw = readFileSync(path.join(KB_ROOT, rel), "utf8");
    const category = categoryFor(rel);
    const sections = raw.split(/\n(?=## )/g).map(s => s.trim()).filter(Boolean);

    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(.+)$/m);
      const heading = headingMatch?.[1]?.trim() ?? rel;
      const pieces = splitLong(section);

      pieces.forEach((text, i) => {
        chunks.push({
          id: sha1(`${rel}::${heading}::${i}`),
          source: rel,
          category,
          heading,
          text,
          contentHash: sha1(text),
        });
      });
    }
  }
  return chunks;
}
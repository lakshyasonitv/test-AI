/**
 * Atlassian Document Format (ADF) -> plain text, for reading a Jira story into the prompt box (D-71).
 *
 * REST API v3 returns `description` as an ADF tree, never as a string. Atlassian's structure page
 * says a document has a single sequential path: walking the nodes in order and joining their text
 * yields the content. That is all this does, plus the line breaks a reader expects (paragraphs,
 * list items, table rows). Anything we don't render — images, files, extensions — is skipped, and
 * an unknown node is walked for its children rather than dropped, so a new node type Atlassian adds
 * later still yields its text.
 *
 * Pure: no I/O, no model. The output is still UNTRUSTED (anyone who can edit the story wrote it) —
 * the caller caps its length and the user sees it in the prompt box before anything runs.
 */

interface AdfNode {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
}

const BLOCK_GAP = "\n\n";

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]).filter((c) => c && typeof c === "object") : [];
}

function inline(node: AdfNode): string {
  return children(node).map((c) => render(c, 0)).join("");
}

function attr(node: AdfNode, name: string): string {
  const v = node.attrs?.[name];
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function list(node: AdfNode, depth: number, ordered: boolean): string {
  const start = ordered ? Number(attr(node, "order")) || 1 : 1;
  return children(node)
    .map((item, i) => {
      const bullet = ordered ? `${start + i}.` : "-";
      const body = children(item).map((c) => render(c, depth + 1).trim()).filter(Boolean).join("\n");
      return `${"  ".repeat(depth)}${bullet} ${body}`;
    })
    .join("\n");
}

function render(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? node.text : "";
    case "hardBreak":
      return "\n";
    case "mention":
    case "status":
      return attr(node, "text");
    case "emoji":
      return attr(node, "text") || attr(node, "shortName");
    case "date": {
      const ms = Number(attr(node, "timestamp"));
      return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return attr(node, "url");
    case "paragraph":
    case "heading":
      return inline(node);
    case "codeBlock":
      return inline(node);
    case "bulletList":
      return list(node, depth, false);
    case "orderedList":
      return list(node, depth, true);
    case "taskList":
    case "decisionList":
      return children(node).map((c) => `${"  ".repeat(depth)}- ${render(c, depth + 1).trim()}`).join("\n");
    case "taskItem":
    case "blockTaskItem":
    case "decisionItem":
      return inline(node);
    case "table":
      return children(node).map((row) => render(row, depth)).join("\n");
    case "tableRow":
      return children(node).map((cell) => render(cell, depth).replace(/\s*\n+\s*/g, " ").trim()).join(" | ");
    case "rule":
      return "---";
    // Pictures and files have no text a test prompt can use.
    case "media":
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      return "";
    default:
      // doc, blockquote, panel, expand, nestedExpand, tableCell, tableHeader, listItem, and any
      // node type added after this was written: its children are the content.
      return children(node).map((c) => render(c, depth)).filter((s) => s.trim() !== "").join(BLOCK_GAP);
  }
}

/** Plain text of an ADF document. Anything that isn't an ADF object (null, a string) is "" or itself. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  return render(doc as AdfNode, 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

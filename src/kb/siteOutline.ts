import type { SiteGraph } from "../schema/siteGraph.js";

const MAX_LINES = 40;

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

function labelOf(url: string, graph: SiteGraph): string {
  const page = graph.pages[url];
  const title = page?.raw.title;
  const path = pathOf(url);
  return title ? `${path} (${title})` : path;
}

export function buildSiteOutline(graph: SiteGraph): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  function visit(url: string, depth: number): void {
    if (lines.length >= MAX_LINES) return;
    if (seen.has(url)) return;
    seen.add(url);

    lines.push(`${"  ".repeat(depth)}${labelOf(url, graph)}`);

    const page = graph.pages[url];
    if (!page) return;

    for (const target of page.outboundTargets) {
      if (lines.length >= MAX_LINES) return;
      if (graph.pages[target]) {
        visit(target, depth + 1);
      }
    }
  }

  visit(graph.entryUrl, 0);

  if (graph.truncatedByScope && lines.length < MAX_LINES) {
    lines.push(`${"  ".repeat(0)}(truncated — additional pages exist beyond crawl limits)`);
  }

  return lines.join("\n");
}

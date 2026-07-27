import { chromium } from "playwright";
import { SiteGraph, type SiteGraphPage } from "../schema/siteGraph.js";
import type { CrawlDirective } from "../schema/crawlDirective.js";
import { modelFromAria } from "./discovery.js";
import { cacheGet, cacheSet } from "../kb/cache.js";

interface QueueEntry {
  url: string;
  depth: number;
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Deterministic crawler that wraps existing Discovery (modelFromAria) and cache logic
 * to produce a SiteGraph of a multi-page site. Uses a single browser instance and
 * traverses pages in the order their outbound links were found (BFS by link order).
 *
 * Does NOT wire into orchestrator.ts — this is independently testable via its own
 * entry point or direct invocation.
 */
export async function crawlSite(
  directive: CrawlDirective,
): Promise<typeof SiteGraph._type> {
  const { entryUrl, scope } = directive;
  const { sameOriginOnly, maxDepth, maxPages } = scope;

  const visited = new Set<string>();
  const pages: Record<string, SiteGraphPage> = {};
  let truncatedByScope = false;

  const queue: QueueEntry[] = [{ url: entryUrl, depth: 0 }];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const normalized = normalizeUrl(current.url, entryUrl);
      if (!normalized || visited.has(normalized)) continue;

      // Respect maxPages: stop visiting new pages once the limit is reached.
      if (Object.keys(pages).length >= maxPages) {
        truncatedByScope = true;
        break;
      }

      // Respect maxDepth: pages beyond maxDepth are not visited.
      if (current.depth > maxDepth) {
        truncatedByScope = true;
        continue;
      }

      visited.add(normalized);

      // Navigate and capture raw per-page signal (title + aria snapshot) — no
      // Gemini call, no labeling. labelPage() handles that lazily on demand.
      let raw: SiteGraphPage["raw"] = { title: "", ariaSnapshot: "" };

      try {
        const response = await page.goto(normalized, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1000);

        const status = response?.status() ?? 0;
        if (!response || status >= 400) {
          pages[normalized] = {
            raw,
            outboundTargets: [],
            visited: true,
          };
          continue;
        }

        raw = {
          title: await page.title(),
          ariaSnapshot: await page.locator("body").ariaSnapshot(),
        };
      } catch {
        pages[normalized] = {
          raw,
          outboundTargets: [],
          visited: true,
        };
        continue;
      }

      // Extract outbound link URLs from the DOM (deterministic DOM order = link order).
      const rawHrefs: string[] = await page
        .locator("a[href]")
        .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href));

      // Filter to in-scope URLs and normalize.
      const outboundTargets: string[] = [];
      const seenTargets = new Set<string>();
      for (const href of rawHrefs) {
        const target = normalizeUrl(href, normalized);
        if (!target) continue;
        if (sameOriginOnly && !sameOrigin(target, entryUrl)) continue;
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        outboundTargets.push(target);

        // Queue unvisited targets for next iteration if depth allows.
        if (
          current.depth < maxDepth &&
          !visited.has(target) &&
          Object.keys(pages).length < maxPages
        ) {
          queue.push({ url: target, depth: current.depth + 1 });
        }
      }

      pages[normalized] = {
        raw,
        outboundTargets,
        visited: true,
      };
    }
  } finally {
    await browser.close();
  }

  return SiteGraph.parse({
    entryUrl,
    pages,
    truncatedByScope,
  });
}

/**
 * Label a crawled page on demand — calls modelFromAria() using the stored raw
 * data (title + ariaSnapshot) to produce an AppModel. Respects the existing
 * cache so repeated calls for the same URL are free.
 */
export async function labelPage(
  crawledPage: SiteGraphPage,
  url: string,
  siteOutline?: string,
): Promise<Awaited<ReturnType<typeof modelFromAria>>> {
  const cached = cacheGet(url);
  if (cached) return cached;

  const model = await modelFromAria(url, crawledPage.raw.title, crawledPage.raw.ariaSnapshot, undefined, siteOutline);
  cacheSet(url, model);
  return model;
}

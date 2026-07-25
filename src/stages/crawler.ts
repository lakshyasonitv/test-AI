import { chromium } from "playwright";
import { SiteGraph, type SiteGraphPage } from "../schema/siteGraph.js";
import type { CrawlDirective } from "../schema/crawlDirective.js";
import { modelFromAria } from "./discovery.js";
import { discoverUsingCrawler } from "./domDiscovery.js";
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

      // Try cache first — avoids re-paying the Gemini labeling call.
      let appModel = cacheGet(normalized);

      if (!appModel) {
        // Try DOM-based discovery first (fast, deterministic, no LLM needed for structure)
        try {
          appModel = await discoverUsingCrawler(normalized);
        } catch {
          // DOM discovery failed — try vision fallback
        }

        if (!appModel) {
          // DOM failed — fall back to Playwright + Gemini vision
          try {
            const response = await page.goto(normalized, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1000);

            const status = response?.status() ?? 0;
            if (!response || status >= 400) {
              pages[normalized] = {
                appModel: { baseUrl: normalized, pages: [] },
                outboundTargets: [],
                visited: true,
              };
              continue;
            }

            const aria = await page.locator("body").ariaSnapshot();
            const title = await page.title();
            const screenshotBase64 = (await page.screenshot()).toString("base64");

            appModel = await modelFromAria(normalized, title, aria, screenshotBase64);
          } catch {
            pages[normalized] = {
              appModel: { baseUrl: normalized, pages: [] },
              outboundTargets: [],
              visited: true,
            };
            continue;
          }
        }

        cacheSet(normalized, appModel);
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
        appModel,
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

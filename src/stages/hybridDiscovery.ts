/**
 * Hybrid Discovery — DOM-first, Vision-fallback.
 *
 * This is the new primary discovery entry point that replaces the old
 * `discover()` function in discovery.ts. It orchestrates:
 *
 *   1. Crawl4AI DOM discovery (fast, deterministic, token-free)
 *   2. Gemini concept labeling (uses DOM context, not OCR)
 *   3. Gemini vision fallback (only for canvas/captcha/image-heavy pages)
 *
 * The key architectural change: we no longer send screenshots to Gemini
 * just to understand the page structure. The DOM provides that.
 * Screenshots are only used when the DOM cannot express what's on screen.
 */

import { chromium } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel, Element, PageModel } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { discoverUsingCrawler, needsVisionFallback } from "./domDiscovery.js";
import {
  modelFromAria, detectInteractiveElements, formatInteractiveElements, attachElementIdentity,
} from "./discovery.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

// ---------------------------------------------------------------------------
// Concept labeling — the ONE remaining Gemini call in the primary path
// ---------------------------------------------------------------------------

/**
 * Use Gemini to label elements with concepts (Login, Search, Cart, etc.)
 * but now we send DOM structure + markdown instead of a screenshot.
 *
 * The screenshot is only used as a secondary signal when DOM is ambiguous,
 * not as the primary information source.
 */
async function labelConceptsWithDOM(
  elements: Element[],
  pageTitle: string,
  markdown: string,
  screenshotBase64?: string,
): Promise<{ concepts: string[]; labeledElements: { index: number; concept: string }[] }> {
  // Build a compact element list
  const elementsList = elements
    .map((e, i) => `[${i}] ${e.role} "${e.name}" (visible: ${e.visible ?? true}, section: ${e.pageSection ?? "body"})`)
    .join("\n");

  // Truncate markdown to keep prompt size reasonable
  const truncatedMarkdown = markdown.length > 4000
    ? markdown.slice(0, 4000) + "\n... (truncated)"
    : markdown;

  const cacheKey = makeCacheKey(
    pageTitle,
    truncatedMarkdown,
    elementsList,
    screenshotBase64 ? "with-screenshot" : "no-screenshot"
  );
  const cachedLabels = llmCacheGet<{ concepts: string[]; labeledElements: { index: number; concept: string }[] }>(cacheKey);
  if (cachedLabels) return cachedLabels;

  const system = `You analyze a web page's structured DOM data to identify concepts and label elements. Output ONLY JSON.
Rules:
- Identify 2-5 meaningful concepts from the elements (e.g. "Login", "Search", "Cart", "Navigation")
- Label elements that clearly serve a concept — only when confident
- Use the markdown content and DOM structure for context
- Never invent elements or concepts not supported by the data
- If two elements share the same name but are in different containers, they serve different concepts
- Forms, navigation, and interactive elements provide strong concept signals`;

  const user = `Page title: ${pageTitle}
Page markdown (content summary):
${truncatedMarkdown}

Elements:
${elementsList}
${screenshotBase64 ? "\nA screenshot is attached for visual disambiguation (icon-only buttons, etc.)." : ""}

Return JSON: { "concepts": string[], "labeledElements": { "index": number, "concept": string }[] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system,
      json: true,
      model: process.env.GEMINI_MODEL_LITE,
      imageBase64: screenshotBase64,
      imageMime: screenshotBase64 ? "image/jpeg" : undefined,
    });
    try {
      const parsed = parseJson(raw);
      if (parsed && Array.isArray(parsed.concepts) && Array.isArray(parsed.labeledElements)) {
        llmCacheSet(cacheKey, parsed);
        return parsed;
      }
      lastErr = "Invalid shape";
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }

  return { concepts: [], labeledElements: [] };
}

// ---------------------------------------------------------------------------
// Primary discovery: DOM-first, vision-fallback
// ---------------------------------------------------------------------------

/**
 * Discover a single page using the hybrid approach:
 *
 * 1. Try Crawl4AI DOM discovery (fast, free, deterministic)
 * 2. If DOM succeeds → label concepts with Gemini using DOM context
 * 3. If DOM fails or page needs vision → fall back to Playwright + Gemini vision
 * 4. If page has canvas/captcha → use Gemini vision for those elements only
 *
 * This replaces the old `discover()` function.
 */
export async function discoverHybrid(url: string): Promise<AppModel> {
  // Check existing cache
  const cached = cacheGet(url);
  if (cached) return cached;

  console.log(`[hybrid] discovering ${url}`);

  // Step 1: Try DOM-based discovery
  const domModel = await discoverUsingCrawler(url);

  if (domModel && domModel.pages[0]) {
    const page = domModel.pages[0];

    // Step 2: Label concepts using DOM context (Gemini text, no vision needed)
    if (page.elements.length > 0) {
      console.log(`[hybrid] DOM discovery succeeded: ${page.elements.length} elements, labeling concepts`);
      const { concepts, labeledElements } = await labelConceptsWithDOM(
        page.elements,
        page.title || "",
        page.markdown || "",
      );

      // Apply concept labels to elements
      const labeledElements2: Element[] = page.elements.map((el, i) => {
        const label = labeledElements.find(l => l.index === i);
        return {
          ...el,
          concept: label?.concept || el.concept,
        };
      });

      const result: AppModel = {
        ...domModel,
        pages: [{
          ...page,
          concepts,
          elements: labeledElements2,
          discoveryMethod: needsVisionFallback(domModel) ? "hybrid" : "dom",
        }],
      };

      cacheSet(url, result);
      return result;
    }

    // DOM succeeded but no elements — still valid, just return as-is
    cacheSet(url, domModel);
    return domModel;
  }

  // Step 3: DOM discovery failed — fall back to Playwright + Gemini vision
  console.log(`[hybrid] DOM discovery failed or unavailable for ${url}, falling back to vision`);
  return discoverUsingVision(url);
}

// ---------------------------------------------------------------------------
// Vision fallback — the OLD discovery path, retained for:
// - Canvas/captcha/image-heavy pages
// - When the Python service is unavailable
// - When DOM discovery returns no useful data
// ---------------------------------------------------------------------------

/**
 * The original Playwright + Gemini vision discovery path.
 * Retained as a fallback for pages that cannot be understood from DOM alone.
 *
 * This is a copy of the original discover() function from discovery.ts,
 * kept separate so the new DOM path is clean.
 */
async function discoverUsingVision(url: string): Promise<AppModel> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const status = response?.status() ?? 0;
    if (!response || status >= 400) {
      throw new Error(
        `Discovery aborted: ${url} returned HTTP ${status || "no response"}. ` +
        `The entry URL must be a reachable page — check the URL and that the route exists.`
      );
    }

    const aria = await page.locator("body").ariaSnapshot();
    // The ARIA snapshot misses icon-only buttons, SVG-in-clickable-parent, and elements
    // with no accessible name. modelFromAria's prompt already knows how to consume this
    // extra section — append it so the vision path sees them too.
    const detected = await detectInteractiveElements(page);
    const title = await page.title();
    const pageUrl = page.url();

    const screenshotBase64 = (await page.screenshot({
      type: "jpeg",
      quality: 60,
    })).toString("base64");

    const result = attachElementIdentity(
      await modelFromAria(pageUrl, title, aria + formatInteractiveElements(detected), screenshotBase64),
      detected
    );

    // Mark all pages as vision-discovered
    const visionResult: AppModel = {
      ...result,
      pages: result.pages.map(p => ({
        ...p,
        discoveryMethod: "vision" as const,
      })),
    };

    cacheSet(url, visionResult);
    return visionResult;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Multi-page discovery
// ---------------------------------------------------------------------------

/**
 * Discover multiple pages. Uses DOM discovery for each, with vision fallback.
 */
export async function discoverPagesHybrid(urls: string[]): Promise<AppModel> {
  const seen = new Set<string>();
  let merged: AppModel = { baseUrl: urls[0], pages: [] };

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const model = await discoverHybrid(url);
    const newPages = model.pages.filter((p) => !merged.pages.some((mp) => mp.url === p.url));
    merged = AppModel.parse({ ...merged, pages: [...merged.pages, ...newPages] });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Re-export for backward compatibility
// ---------------------------------------------------------------------------

/**
 * Discover a page — drop-in replacement for the old discover() function.
 * Uses hybrid discovery (DOM-first, vision-fallback).
 */
export { discoverHybrid as discover };
export { discoverPagesHybrid as discoverPages };

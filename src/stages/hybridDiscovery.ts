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

import { chromium, type Browser, type Page } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel, Element, PageModel } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { discoverUsingCrawler, extractDomModelFromPage, needsVisionFallback } from "./domDiscovery.js";
import {
  modelFromAria, detectInteractiveElements, formatInteractiveElements, attachElementIdentity,
} from "./discovery.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";
import { cutAtBoundary } from "../text.js";

// ---------------------------------------------------------------------------
// Concept labeling — the ONE remaining Gemini call in the primary path
// ---------------------------------------------------------------------------

// Module-level so the cache key can hash it: the key is built before the request is
// assembled, and a prompt declared inside the function wouldn't exist yet.
const LABEL_SYSTEM = `You analyze a web page's structured DOM data to identify concepts and label elements. Output ONLY JSON.
Rules:
- Identify 2-5 meaningful concepts from the elements (e.g. "Login", "Search", "Cart", "Navigation")
- Label elements that clearly serve a concept — only when confident
- Use the markdown content and DOM structure for context
- Never invent elements or concepts not supported by the data
- If two elements share the same name but are in different containers, they serve different concepts
- Forms, navigation, and interactive elements provide strong concept signals`;

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

  // Trim markdown at a line boundary so the concept-labeling prompt stays small
  // without cutting a sentence or heading in half.
  const truncatedMarkdown = cutAtBoundary(markdown, 4000);

  const cacheKey = makeCacheKey(
    pageTitle,
    truncatedMarkdown,
    elementsList,
    screenshotBase64 ? "with-screenshot" : "no-screenshot",
    // The prompt and model are real inputs too, and the disk cache never expires — leaving
    // them out means a labeling-rule change never reaches a page already seen.
    LABEL_SYSTEM,
    process.env.GEMINI_MODEL_LITE ?? "default"
  );
  const cachedLabels = llmCacheGet<{ concepts: string[]; labeledElements: { index: number; concept: string }[] }>(cacheKey);
  if (cachedLabels) return cachedLabels;

  const system = LABEL_SYSTEM;

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
// Site discovery — follow the entry page's own links to reach more of the app
// ---------------------------------------------------------------------------

/**
 * Upper bound on pages a single discovery may collect (entry + followed links).
 * Bounded on purpose: every extra page costs a Chromium visit and a concept-label
 * call, and selection budgets the final case count anyway.
 */
export const MAX_DISCOVERY_PAGES = Number(process.env.MAX_DISCOVERY_PAGES ?? 5);

/** Hash is navigation state, not a new page — a link like /cart#top is the same page. */
function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href;
  } catch {
    return u;
  }
}

/** Paths that are never page-crawl-worthy: assets and file downloads. */
const SKIP_CRAWL_PATH = /\.(pdf|zip|tar|gz|rar|7z|exe|msi|dmg|apk|mp3|mp4|mov|avi|mkv|jpe?g|png|gif|webp|svg|ico|css|js|m?jsx|json|xml|woff2?|ttf|eot|wasm)$/i;

/**
 * Turn a page's internal link URLs into the bounded, de-duplicated set of crawl
 * targets for the NEXT hop. Pure and testable: same-origin http(s) only, assets and
 * file downloads skipped, hash stripped, nothing visited twice. Every URL that
 * passes is marked in `visited` as it is queued, so it can never be queued twice.
 */
export function collectCrawlTargets(candidateUrls: string[], entryUrl: string, visited: Set<string>): string[] {
  let entryHost = "";
  try {
    entryHost = new URL(entryUrl).host;
  } catch {
    return [];
  }

  const targets: string[] = [];
  for (const raw of candidateUrls) {
    if (!raw || !raw.trim()) continue;
    let u: URL;
    try {
      u = new URL(raw, entryUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.host !== entryHost) continue;
    u.hash = "";
    const key = u.href;
    if (visited.has(key)) continue;
    if (SKIP_CRAWL_PATH.test(u.pathname)) continue;
    visited.add(key);
    targets.push(key);
  }
  return targets;
}

// Own cache namespace, separate from discoverHybrid's bare-URL key: discoverSiteHybrid's
// result is a different shape (possibly many pages) for the same URL, and sharing a key
// would let either function silently hand back the other's cached result.
const siteCacheKey = (url: string) => `site:${url}`;

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h.startsWith("127.")) return true; // whole 127.0.0.0/8 is loopback, not just 127.0.0.1
  if (h === "::1" || h === "[::1]") return true; // Node's URL keeps the brackets in .hostname
  if (h.startsWith("169.254.")) return true; // IMDS / link-local
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true; // RFC1918 private
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

export function isAllowedEntryUrl(urlStr: string): { ok: boolean; reason?: string } {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `URL scheme "${u.protocol}" is not allowed. Use http:// or https://` };
    }
    if (isPrivateOrLoopbackHost(u.hostname)) {
      return { ok: false, reason: `Access to private/loopback host "${u.hostname}" is restricted` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `Invalid URL "${urlStr}": ${err?.message ?? err}` };
  }
}

/**
 * Discover a whole site, not just the entry page: crawl the entry page's own
 * internal links (same origin, bounded by MAX_DISCOVERY_PAGES) and merge every
 * reachable page into one AppModel. This is what lets a later "not satisfied,
 * focus on X" refinement actually steer — the target feature (Cart, Checkout, ...)
 * is only groundable once its page is in the model.
 *
 * Behavior is unchanged for a site whose entry page exposes no crawlable internal
 * links (auth walls, single-page apps): the result is a one-page model, exactly
 * what the old single-page discovery produced.
 */
export async function discoverSiteHybrid(url: string): Promise<AppModel> {
  const cached = cacheGet(siteCacheKey(url));
  if (cached) return cached;

  const urlCheck = isAllowedEntryUrl(url);
  if (!urlCheck.ok) {
    throw new Error(urlCheck.reason);
  }

  console.log(`[hybrid] discovering site ${url}`);
  const entryOrigin = new URL(url).origin;
  const maxPages = Math.max(1, MAX_DISCOVERY_PAGES);
  const visited = new Set<string>([normUrl(url)]);
  // Object property (not a bare variable) so TS doesn't narrow it to `never` after the
  // closure below reassigns it — the finally block still needs to read it.
  const state: { browser?: Browser } = {};

  const snapshot = async (targetUrl: string): Promise<{ appModel: AppModel; finalUrl: string } | null> => {
    state.browser ??= await chromium.launch();
    const page: Page = await state.browser.newPage();
    try {
      const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const status = response?.status() ?? 0;
      if (!response || status >= 400) return null;
      await page.waitForTimeout(800);
      const finalUrl = page.url();
      const appModel = await extractDomModelFromPage(page, finalUrl);
      return appModel ? { appModel, finalUrl } : null;
    } catch (err: any) {
      console.warn(`[hybrid] crawl error for ${targetUrl}: ${err?.message ?? err}`);
      return null;
    } finally {
      await page.close().catch(() => { });
    }
  };

  const labelPage = async (page: PageModel): Promise<PageModel> => {
    if (page.elements.length === 0) return page;
    const { concepts, labeledElements } = await labelConceptsWithDOM(
      page.elements, page.title ?? "", page.markdown ?? "",
    );
    return {
      ...page,
      concepts,
      elements: page.elements.map((el, i) => ({
        ...el,
        concept: labeledElements.find((l) => l.index === i)?.concept || el.concept,
      })),
      discoveryMethod: "dom",
    };
  };

  try {
    const entrySnapshot = await snapshot(url);
    if (!entrySnapshot) {
      // DOM failed even at the entry page — the old single-page vision fallback. Nothing
      // to crawl from a page we couldn't read, so return that result unchanged.
      console.log(`[hybrid] DOM discovery failed or unavailable for ${url}, falling back to vision`);
      return discoverUsingVision(url);
    }

    const entry = await labelPage(entrySnapshot.appModel.pages[0]);
    if (entry.elements.length === 0) {
      // DOM succeeded but found no elements (auth wall, not-yet-hydrated) — still a valid,
      // cacheable result. Without this, every call re-launches Chromium and re-crawls instead
      // of hitting the cache, unlike discoverHybrid's equivalent case.
      cacheSet(siteCacheKey(url), entrySnapshot.appModel);
      return entrySnapshot.appModel;
    }
    const pages: PageModel[] = [entry];
    visited.add(normUrl(entrySnapshot.finalUrl));

    const queue = collectCrawlTargets(entry.internalUrls ?? [], url, visited);
    while (queue.length > 0 && pages.length < maxPages) {
      const target = queue.shift()!;
      const snap = await snapshot(target);
      if (!snap) continue;
      const finalKey = normUrl(snap.finalUrl);
      if (visited.has(finalKey)) continue; // redirected somewhere already seen (auth wall)
      visited.add(finalKey);

      const rawPage = snap.appModel.pages[0];
      if (!rawPage || rawPage.elements.length === 0) continue;
      const labeled = await labelPage(rawPage);
      pages.push({ ...labeled, url: rawPage.url || snap.finalUrl });

      if (pages.length < maxPages) {
        queue.push(...collectCrawlTargets(labeled.internalUrls ?? [], url, visited));
      }
    }

    const result = AppModel.parse({ baseUrl: entryOrigin, pages });
    cacheSet(siteCacheKey(url), result);
    return result;
  } finally {
    await state.browser?.close();
  }
}


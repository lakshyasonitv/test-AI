import { chromium } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel, Element, PageModel } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import crypto from "node:crypto";

interface RawElement {
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  containerRole: string | null;
  containerName: string | null;
  pageSection: string;
  path: string[];
  order: number;
  concept?: string;
}

interface EnrichedElement extends RawElement {
  id: string;
}

function computeAriaHash(aria: string): string {
  return crypto.createHash('md5').update(aria).digest('hex').slice(0, 8);
}

async function collectElementMetadata(page: any, ariaElements: any[]): Promise<RawElement[]> {
  const enriched: RawElement[] = [];
  let order = 0;

  for (const el of ariaElements) {
    if (!el.role || el.role === 'none' || el.role === 'presentation') continue;

    try {
      const locator = page.getByRole(el.role, { name: el.name });
      const count = await locator.count();
      
      if (count === 0) continue;

      for (let i = 0; i < count; i++) {
        const handle = locator.nth(i);
        const visible = await handle.isVisible().catch(() => false);
        const enabled = await handle.isEnabled().catch(() => false);

        const containerInfo = await handle.evaluate((node: any) => {
          let parent = node.parentElement;
          let containerRole: string | null = null;
          let containerName: string | null = null;
          const path: string[] = [];

          while (parent && path.length < 10) {
            const role = parent.getAttribute('role') || parent.tagName.toLowerCase();
            const name = parent.getAttribute('aria-label') || 
                        parent.getAttribute('name') || 
                        parent.textContent?.trim().slice(0, 50) || null;
            
            if (['form', 'nav', 'main', 'header', 'footer', 'dialog', 'section', 'article', 'aside'].includes(role)) {
              containerRole = containerRole || role;
              containerName = containerName || name;
            }
            
            path.unshift(role);
            parent = parent.parentElement;
          }

          const pageSection = path.includes('main') ? 'main' :
                             path.includes('nav') ? 'nav' :
                             path.includes('header') ? 'header' :
                             path.includes('footer') ? 'footer' :
                             path.includes('dialog') ? 'dialog' : 'body';

          return { containerRole, containerName, path, pageSection };
        });

        enriched.push({
          role: el.role,
          name: el.name || '',
          visible,
          enabled,
          containerRole: containerInfo.containerRole,
          containerName: containerInfo.containerName,
          pageSection: containerInfo.pageSection,
          path: containerInfo.path,
          order: order++,
        });
      }
    } catch (err) {
      continue;
    }
  }

  return enriched;
}

function parseAriaStructure(aria: string): any[] {
  const elements: any[] = [];
  const lines = aria.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^\s*(?:- )?(button|textbox|link|heading|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|spinbutton|searchbox|img|list|listitem|table|row|cell|dialog|alert|navigation|banner|main|contentinfo|form|region|group|generic|article|figure)(?:\s+"([^"]*)")?/i);
    
    if (match) {
      elements.push({
        role: match[1].toLowerCase(),
        name: match[2] || '',
      });
    }
  }
  
  return elements;
}


async function labelConcepts(
  elements: RawElement[],
  pageTitle: string,
  screenshotBase64?: string
): Promise<{ concepts: string[]; labeledElements: { index: number; concept: string }[] }> {
  const elementsList = elements
    .map((e, i) => `[${i}] ${e.role} "${e.name}" (visible: ${e.visible}, section: ${e.pageSection}${e.containerName ? `, container: ${e.containerRole} "${e.containerName}"` : ''})`)
    .join('\n');

  const system = `You analyze web page elements to identify concepts and label elements. Output ONLY JSON.
Rules:
- Identify 2-5 meaningful concepts from the elements (e.g. "Login", "Search", "Cart", "Navigation")
- Label elements that clearly serve a concept — only when confident
- Use visual context from screenshot if provided
- Never invent elements or concepts not supported by the element list
- If two elements share the same name but are in different containers, they serve different concepts`;

  const user = `Page title: ${pageTitle}
Elements:
${elementsList}
${screenshotBase64 ? "\nScreenshot attached for visual context." : ""}

Return JSON: { "concepts": string[], "labeledElements": { "index": number, "concept": string }[] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system, 
      json: true, 
      model: process.env.GEMINI_MODEL_LITE,
      imageBase64: screenshotBase64, 
      imageMime: "image/png",
    });
    try {
      const parsed = parseJson(raw);
      if (parsed && Array.isArray(parsed.concepts) && Array.isArray(parsed.labeledElements)) {
        return parsed;
      }
      lastErr = "Invalid shape";
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  
  return { concepts: [], labeledElements: [] };
}

/**
 * Discover multiple explicit pages and merge them into one AppModel.
 * Calls discover() once per URL (reusing its cache and modelFromAria labeling),
 * then merges using the same spread-append pattern as liveExtend.ts's extendAppModel.
 * Deduplicates by URL — if the same URL appears twice, it's only modeled once.
 */
export async function discoverPages(urls: string[]): Promise<AppModel> {
  const seen = new Set<string>();
  let merged: AppModel = { baseUrl: urls[0], pages: [] };

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const model = await discover(url);
    // Merge pattern from liveExtend.ts extendAppModel — append new pages to existing.
    const newPages = model.pages.filter((p) => !merged.pages.some((mp) => mp.url === p.url));
    merged = AppModel.parse({ ...merged, pages: [...merged.pages, ...newPages] });
  }

  return merged;
}

export async function discover(url: string): Promise<AppModel> {
  const cached = cacheGet(url);
  if (cached) return cached;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });

    // Fail fast on a dead entry URL. Without this, a 404/500 page becomes a valid-looking
    // AppModel and the downstream LLMs hallucinate a UI on top of an error page (seen in
    // practice: a /login that 404s produced a fictional login-form test). Catching it here
    // gives a clear message and skips wasted LLM calls. Soft 404s (200 + "not found" body)
    // are caught later by the grounding guard, not here.
    const status = response?.status() ?? 0;
    if (!response || status >= 400) {
      throw new Error(
        `Discovery aborted: ${url} returned HTTP ${status || "no response"}. ` +
        `The entry URL must be a reachable page — check the URL and that the route exists.`
      );
    }

    const aria = await page.locator("body").ariaSnapshot();
    const title = await page.title();
    const pageUrl = page.url();
    
    const ariaHash = computeAriaHash(aria);
    const cacheKey = `${url}|||${title}|||${ariaHash}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const ariaElements = parseAriaStructure(aria);
    
    const enrichedElements = await collectElementMetadata(page, ariaElements);
    
    const screenshotBase64 = (await page.screenshot({
      type: "jpeg",
      quality: 60
    })).toString("base64");

    const { concepts, labeledElements } = await labelConcepts(enrichedElements, title, screenshotBase64);
    
    const elements: Element[] = enrichedElements.map((el, i) => {
      const label = labeledElements.find(l => l.index === i);
      return {
        role: el.role,
        name: el.name,
        concept: label?.concept || el.concept,
        visible: el.visible,
        enabled: el.enabled,
        containerRole: el.containerRole || undefined,
        containerName: el.containerName || undefined,
        pageSection: el.pageSection,
        path: el.path,
        order: el.order,
        id: `${el.role}_${el.order}`,
      } as Element;
    });

    const pageModel: PageModel = {
      url: pageUrl,
      title,
      concepts,
      elements,
    };

    const appModel: AppModel = {
      baseUrl: new URL(url).origin,
      pages: [pageModel],
    };

    cacheSet(cacheKey, appModel);
    return appModel;
  } finally {
    await browser.close();
  }
}

/**
 * Turn an accessibility snapshot of a single page into an AppModel via the LLM. Shared by
 * discover() (fresh page load) and the live-replay extender (a page reached only after
 * replaying a login/prefix), so both label pages with the exact same anti-hallucination
 * prompt. Retries once on schema-validation failure, same as the original discovery loop.
 *
 * screenshotBase64 is optional and, when given, rides the SAME call (Gemini is natively
 * multimodal) — it does not add a request. It exists to improve LABELING of elements that
 * are already in the aria snapshot (disambiguate icon-only buttons, tell apart multiple
 * same-named controls via visual context) — never to add elements the snapshot doesn't
 * contain. The grounding guard downstream (ir.ts's groundingError) and everything built on
 * it assumes every element traces to the real snapshot; vision must not become a second,
 * looser path to inventing one.
 */
export async function modelFromAria(url: string, title: string, aria: string, screenshotBase64?: string): Promise<AppModel> {
  const system =
`You analyze a web page's accessibility snapshot for test generation. Output ONLY the JSON object, no prose, no markdown fences.

Rules, follow exactly:
- Every element you output must come from the accessibility snapshot text given to you. Never invent an element, role, or name that isn't literally present in that snapshot — a screenshot, if given, is ONLY for identifying which element is which; it is never a basis for adding an element the snapshot doesn't contain.
- "concepts" for a page is a short list of meaningful features actually observable on that page (e.g. "Login", "Search", "Cart") — infer them only from elements that are actually there, never from what a page like this "usually" has.
- Each element's "concept" is optional — set it only when the element clearly serves one of the page's concepts; leave it unset rather than guessing. If a screenshot is given, use its visual context (icon meaning, position, nearby text) to make this labeling more accurate — e.g. an icon-only button next to a product row is more confidently "Cart" or "Delete" once you can see it.
- "role" must be the element's real ARIA role exactly as given in the snapshot (button, textbox, link, heading, checkbox, ...); do not normalize or invent roles.
- "name" must be the element's actual accessible name from the snapshot, verbatim — never paraphrase or guess it.

Example of the exact shape required:
{ "baseUrl": "https://example.com",
  "pages": [ { "url": "https://example.com/login", "title": "Login",
    "concepts": ["Login"],
    "elements": [
      { "role": "textbox", "name": "Username", "concept": "Login" },
      { "role": "button", "name": "Log in", "concept": "Login" }
    ] } ] }`;
  const user =
`Base URL: ${url}
Page title: ${title}
Accessibility snapshot:
${aria}
${screenshotBase64 ? "\nA screenshot of this exact page is attached — use it only to label the snapshot's elements more accurately, per the rules above." : ""}

Return ONLY JSON:
{ "baseUrl": string,
  "pages": [ { "url": string, "title": string, "concepts": string[],
    "elements": [ { "role": string, "name": string, "concept": string } ] } ] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system, json: true, model: process.env.GEMINI_MODEL_LITE,
      imageBase64: screenshotBase64, imageMime: "image/png",
    });
    try {
      const result = AppModel.safeParse(parseJson(raw));
      if (result.success) return result.data;
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Application model failed schema validation after retry: ${lastErr}`);
}

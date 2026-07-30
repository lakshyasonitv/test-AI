/**
 * DOM-based page discovery — the primary discovery path, no LLM needed for standard pages.
 * Gemini vision (hybridDiscovery.ts's fallback) is used only when this can't understand the
 * page (canvas/captcha/image-heavy) or throws.
 *
 * Was a TypeScript client for a Python FastAPI service (Crawl4AI + BeautifulSoup); that
 * service and its Python dependency are gone. `extractCrawlResponse` in domExtract.ts is
 * the same extraction logic ported to Node/cheerio, so `crawlResponseToAppModel` below is
 * unchanged — only the SOURCE of the HTML changed, from an HTTP round-trip to a Python
 * subprocess to a `page.content()` call on the Playwright browser this module now owns.
 */

import { chromium } from "playwright";
import { AppModel, PageModel, Element } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { extractCrawlResponse, type CrawlResponse } from "./domExtract.js";

const REQUEST_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Conversion: CrawlResponse → AppModel
// ---------------------------------------------------------------------------

/**
 * Convert the structured DOM extraction into the existing AppModel format that the rest of
 * the pipeline expects.
 *
 * The key insight: we populate BOTH the legacy `elements` array (for
 * backward compatibility with IR generation and test case generation)
 * AND the new structured DOM fields (forms, navigation, buttons, etc.)
 * so that the LLM gets richer context.
 */
function crawlResponseToAppModel(crawl: CrawlResponse): AppModel {
  const elements: Element[] = [];
  let order = 0;

  // Convert interactive elements to legacy Element format
  // These come directly from the DOM — no LLM needed to identify them
  for (const ie of crawl.interactive_elements) {
    elements.push({
      role: ie.aria_role || ie.role || inferRole(ie.tag, ie),
      name: ie.name || ie.text || "",
      visible: ie.visible,
      enabled: ie.enabled,
      id: ie.id || `${ie.role}_${order}`,
      // Carry the deterministic selector through. For an element whose name was DERIVED
      // from attributes (icon-only cart/close/search), this is the only thing that can
      // locate it — getByRole with a synthetic name matches nothing.
      ...(ie.test_id ? { testId: ie.test_id } : {}),
      ...(ie.css ? { css: ie.css } : {}),
      order: order++,
    });
  }

  // Also convert buttons (they may not all appear in interactive_elements)
  const seenNames = new Set(elements.map(e => `${e.role}:${e.name}`));
  for (const btn of crawl.buttons) {
    const name = btn.text || btn.aria_label;
    if (!name) continue;
    const key = `button:${name}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    elements.push({
      role: "button",
      name,
      visible: true,
      enabled: !btn.disabled,
      id: btn.id || `btn_${order}`,
      order: order++,
    });
  }

  // Convert form fields to elements.
  //
  // `name` here MUST be the element's ACCESSIBLE name, because that is what the whole
  // downstream pipeline resolves against: ir.ts grounds role+name against this model, and
  // generator.ts emits getByRole(role, { name }), which matches the accessible name only.
  // The HTML `name` attribute plays no part in accessible-name computation — preferring it
  // produced elements that could never be located. Seen in practice on saucedemo, whose
  // input is <input name="user-name" placeholder="Username">: discovery emitted
  // "user-name", every generated locator missed, and five test cases failed at the fill
  // step against a perfectly working page.
  //
  // Precedence follows accname: aria-label -> associated <label> -> placeholder -> title.
  // The HTML name attribute stays only as a last resort so a field with no accessible name
  // at all still appears in the model rather than vanishing.
  for (const form of crawl.forms) {
    for (const field of form.fields) {
      const name = field.aria_label || field.label || field.placeholder || field.name;
      if (!name) continue;
      const fieldRole = roleForField(field.tag, field.input_type);
      if (!fieldRole) continue;   // hidden inputs and the like
      const key = `${fieldRole}:${name}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      elements.push({
        role: fieldRole,
        name,
        visible: true,
        enabled: true,
        id: field.id || `field_${order}`,
        order: order++,
      });
    }
  }

  // Convert navigation links to elements
  const flattenNav = (items: CrawlResponse["navigation"]): CrawlResponse["navigation"] => {
    const result: CrawlResponse["navigation"] = [];
    for (const item of items) {
      result.push(item);
      if (item.children?.length) {
        result.push(...flattenNav(item.children));
      }
    }
    return result;
  };
  const allNav = flattenNav(crawl.navigation);
  for (const nav of allNav) {
    const name = nav.text;
    if (!name) continue;
    const key = `link:${name}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    elements.push({
      role: "link",
      name,
      visible: true,
      enabled: true,
      order: order++,
    });
  }

  // Convert headings to elements (headings are important for assertions)
  for (const h of crawl.headings) {
    const key = `heading:${h.text}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    elements.push({
      role: "heading",
      name: h.text,
      visible: true,
      enabled: true,
      order: order++,
    });
  }

  // Add links as elements
  for (const link of crawl.links) {
    if (link.is_external) continue;
    const name = link.text || link.aria_label;
    if (!name) continue;
    const key = `link:${name}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    elements.push({
      role: "link",
      name,
      visible: true,
      enabled: true,
      order: order++,
    });
  }

  const pageModel: PageModel = {
    url: crawl.url,
    title: crawl.title,
    concepts: [], // Will be populated by the LLM labeling step
    elements,

    // Structured DOM fields
    markdown: crawl.markdown,
    cleanedHtml: crawl.cleaned_html,
    metadata: crawl.metadata ? {
      title: crawl.metadata.title,
      description: crawl.metadata.description,
      keywords: crawl.metadata.keywords,
      author: "",
      ogTitle: crawl.metadata.og_title,
      ogDescription: crawl.metadata.og_description,
      ogImage: "",
      canonical: crawl.metadata.canonical,
      charset: "",
      viewport: "",
      favicon: crawl.metadata.favicon,
    } : undefined,
    forms: crawl.forms?.map(f => ({
      action: f.action,
      method: f.method,
      id: f.id,
      name: f.name,
      ariaLabel: f.aria_label,
      fields: f.fields.map(ff => ({
        tag: ff.tag,
        inputType: ff.input_type,
        name: ff.name,
        placeholder: ff.placeholder,
        label: ff.label,
        required: ff.required,
        value: ff.value,
        options: ff.options,
        id: ff.id,
        ariaLabel: ff.aria_label,
      })),
    })),
    navigation: crawl.navigation,
    domLinks: crawl.links?.filter(l => !l.is_external).map(l => ({
      text: l.text,
      href: l.href,
      title: l.title,
      ariaLabel: l.aria_label,
      isExternal: l.is_external,
      role: l.role,
    })),
    buttons: crawl.buttons?.map(b => ({
      text: b.text,
      buttonType: b.button_type,
      ariaLabel: b.aria_label,
      disabled: b.disabled,
      id: b.id,
      role: b.role,
    })),
    headings: crawl.headings?.map(h => ({
      level: h.level,
      text: h.text,
      id: h.id,
    })),
    tables: crawl.tables?.map(t => ({
      headers: t.headers,
      rows: t.rows,
      caption: t.caption,
      ariaLabel: t.aria_label,
      id: t.id,
    })),
    images: crawl.images?.map(i => ({
      src: i.src,
      alt: i.alt,
      title: i.title,
      width: i.width,
      height: i.height,
    })),
    internalUrls: crawl.internal_urls,
    externalUrls: crawl.external_urls,
    breadcrumbs: crawl.breadcrumbs,
    hasSearch: crawl.has_search,
    hasPagination: crawl.has_pagination,
    hasModal: crawl.has_modal,
    hasTabs: crawl.has_tabs,
    hasAccordion: crawl.has_accordion,
    domDepth: crawl.dom_depth,
    accessibility: crawl.accessibility ? {
      lang: crawl.accessibility.lang,
      title: crawl.accessibility.title,
      landmarkRoles: crawl.accessibility.landmark_roles,
      ariaLandmarks: crawl.accessibility.aria_landmarks,
      skipLinks: crawl.accessibility.skip_links,
      formsWithLabels: crawl.accessibility.forms_with_labels,
      imagesWithAlt: crawl.accessibility.images_with_alt,
      imagesTotal: crawl.accessibility.images_total,
      headingOrder: crawl.accessibility.heading_order,
    } : undefined,
    needsVision: crawl.needs_vision,
    visionReason: crawl.vision_reason,
    crawlTimeMs: crawl.crawl_time_ms,
    discoveryMethod: "dom",
  };

  return {
    baseUrl: new URL(crawl.url).origin,
    pages: [pageModel],
  };
}

/**
 * ARIA role for a form field. Previously every non-select field was called a "textbox",
 * which turned <input type="submit"> into a phantom textbox the IR could try to fill, and
 * lost the distinction the assertion/action vocabulary depends on (check vs fill vs click).
 * Returns null for fields that should not appear in the model at all.
 */
function roleForField(tag: string, inputType: string): string | null {
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  switch ((inputType || "text").toLowerCase()) {
    case "hidden": return null;
    case "submit": case "button": case "reset": case "image": return "button";
    case "checkbox": return "checkbox";
    case "radio": return "radio";
    case "range": return "slider";
    case "number": return "spinbutton";
    case "search": return "searchbox";
    // text, email, password, tel, url, date, ... all expose as textbox
    default: return "textbox";
  }
}

/**
 * Infer ARIA role from HTML tag and element properties.
 */
function inferRole(tag: string, el: { aria_role?: string; aria_label?: string; css_classes?: string[] }): string {
  const roleMap: Record<string, string> = {
    a: "link",
    button: "button",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    img: "img",
    nav: "navigation",
    table: "table",
  };
  return el.aria_role || roleMap[tag] || "generic";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover a page's structure directly from the rendered DOM. This is the PRIMARY discovery
 * path — no Gemini vision needed for standard pages.
 *
 * Returns null (never throws) on navigation failure or a genuinely empty extraction, so the
 * caller (hybridDiscovery.ts) falls back to vision-based discovery.
 */
export async function discoverUsingCrawler(url: string): Promise<AppModel | null> {
  const cached = cacheGet(`dom:${url}`);
  if (cached) {
    console.log(`[domDiscovery] cache hit for ${url}`);
    return cached;
  }

  let browser;
  try {
    console.log(`[domDiscovery] extracting DOM structure for ${url}`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });

    const statusCode = response?.status() ?? 0;
    if (!response || statusCode >= 400) {
      console.warn(`[domDiscovery] HTTP ${statusCode || "no response"} for ${url}`);
      return null;
    }

    // Give client-rendered content a moment to mount (React/Next/etc — the raw HTML for an
    // SPA is close to empty pre-hydration). Not `networkidle`: generator.ts strips that
    // from generated specs because it hangs on real sites with long-lived connections, so
    // it's avoided here for the same reason. Mirrors the old service's `wait_after_load`.
    await page.waitForTimeout(800);

    const html = await page.content();
    const finalUrl = page.url();   // reflects any redirect the navigation followed
    const crawlResult = extractCrawlResponse(html, finalUrl, statusCode);

    const appModel = crawlResponseToAppModel(crawlResult);
    console.log(
      `[domDiscovery] extracted ${url}: ${appModel.pages[0]?.elements.length ?? 0} elements, ` +
      `${crawlResult.forms.length} forms, ${crawlResult.navigation.length} nav items, ` +
      `${crawlResult.buttons.length} buttons, needs_vision=${crawlResult.needs_vision}`
    );

    cacheSet(`dom:${url}`, appModel);
    return appModel;
  } catch (err: any) {
    console.warn(`[domDiscovery] error for ${url}: ${err?.message ?? err}`);
    return null;
  } finally {
    await browser?.close();
  }
}

/**
 * Check if a page needs vision fallback based on the crawl result.
 * This is used by the hybrid discovery to decide whether to also
 * capture a screenshot and send it to Gemini.
 */
export function needsVisionFallback(appModel: AppModel): boolean {
  const page = appModel.pages[0];
  if (!page) return false;
  return page.needsVision === true;
}

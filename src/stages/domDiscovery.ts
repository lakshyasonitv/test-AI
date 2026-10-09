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

import { chromium, type Page } from "playwright";
import { chromiumLaunchOptions, browserContextOptions } from "../browserLaunch.js";
import { AppModel, PageModel, Element } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { extractCrawlResponse, type CrawlResponse } from "./domExtract.js";
import { stableSelector } from "./discovery.js";
import { enumerateLiveElements } from "./liveDomDiscovery.js";
import { currentRunTargetApp } from "../runTarget.js";

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
      // Same idea one step further: a proximity-inferred name isn't in the DOM at all, so
      // the resolver has to locate the field by its position relative to that text.
      ...(ie.name_from_proximity ? { nameFromProximity: true } : {}),
      ...(ie.generic_path ? { genericPath: ie.generic_path } : {}),
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

  const landmarkSections = tagLandmarks(elements);

  const pageModel: PageModel = {
    url: crawl.url,
    title: crawl.title,
    concepts: [], // Will be populated by the LLM labeling step
    elements,
    ...(landmarkSections.length > 0 ? { landmarkSections } : {}),

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
 * Landmark tagging from genericPath (since we don't have Cheerio here): set `landmark` on every
 * element whose path passes through one, innermost wins, and return the per-landmark counts.
 * Factored out of crawlResponseToAppModel unchanged so the live element list (Phase 5 strategy
 * switch) is tagged by exactly the same rule.
 */
function tagLandmarks(elements: Element[]): Array<{ landmark: string; label: string; elementCount: number }> {
  const landmarkCounts = new Map<string, number>();
  const LANDMARKS = new Set(["main", "nav", "header", "footer", "aside", "form"]);
  for (const el of elements) {
    if (!el.genericPath) continue;
    const parts = el.genericPath.split(">");
    for (let i = parts.length - 1; i >= 0; i--) {
      if (LANDMARKS.has(parts[i])) {
        el.landmark = parts[i];
        landmarkCounts.set(parts[i], (landmarkCounts.get(parts[i]) || 0) + 1);
        break;
      }
    }
  }

  return Array.from(landmarkCounts.entries()).map(([landmark, count]) => ({
    landmark,
    label: "",
    elementCount: count,
  }));
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
// Element strategy: DISCOVERY_LIVE_DOM
// ---------------------------------------------------------------------------

/**
 * Where a page's `elements` come from. `"cheerio"` — the static `page.content()` parse, the
 * behaviour before live-DOM discovery existed and still the default. `"live"` — the live-DOM walker
 * (liveDomDiscovery.ts): real visibility, a verified css on every element, open shadow roots and
 * same-origin iframes. Every other AppModel field (forms, navigation, markdown, headings…) comes
 * from the cheerio parse in BOTH modes; only the element list is swapped.
 */
export type ElementStrategy = "cheerio" | "live";

/**
 * `DISCOVERY_LIVE_DOM`, read in exactly one place. Default OFF (`CLAUDE.md` rule 2).
 *
 * A Salesforce run (the person ticked "This URL is a Salesforce org", D-50) ALWAYS takes the live
 * walker, whatever the global flag says: Lightning renders inside shadow roots and frames and
 * hides mirror inputs that the static parse cannot see (D-51). `currentRunTargetApp()` is null for
 * every other run, outside a run, and whenever SALESFORCE_ENABLED is off — so those are unchanged.
 */
export function elementStrategy(): ElementStrategy {
  if (currentRunTargetApp() === "salesforce") return "live";
  return process.env.DISCOVERY_LIVE_DOM === "true" ? "live" : "cheerio";
}

/**
 * The element list for one extraction, by strategy. CALLED IN BOTH MODES (`CLAUDE.md` rule 7):
 * with the flag off it returns the cheerio list — the very array the model already holds — so the
 * flag-off path runs this switch rather than bypassing it, and the switch is exercised everywhere,
 * not only in production.
 *
 * A live walk that throws (a page navigating mid-walk, most often) falls back to the cheerio list
 * for that one call rather than failing discovery outright.
 */
async function elementsFor(strategy: ElementStrategy, page: Page, model: AppModel): Promise<Element[]> {
  const cheerioElements = model.pages[0]?.elements ?? [];
  if (strategy === "cheerio") return cheerioElements;
  try {
    return await enumerateLiveElements(page);
  } catch (err: any) {
    console.warn(`[domDiscovery] live-DOM walk failed, using the static parse: ${err?.message ?? err}`);
    return cheerioElements;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A clickable element found ONLY by the live in-page scan below — no semantic tag, no
 *  role attribute, so the cheerio pass over the HTML string could never have found it. */
interface GenericClickable {
  name: string;
  id: string;
  testId: string;
}

// Skip anything bigger than a generous "this is a real control, not a section wrapper"
// threshold — a large container commonly inherits `cursor: pointer` from a parent or a
// global CSS reset without itself being the intended click target.
const MAX_CLICKABLE_WIDTH = 500;
const MAX_CLICKABLE_HEIGHT = 200;
// Hard cap so a noisy/animated page (hundreds of hover-styled elements) can't flood the
// AppModel with junk — the far more common case (a handful of custom "buttons") is well
// under this either way.
const MAX_GENERIC_CLICKABLES = 40;

/**
 * Find elements that are clickable in practice but invisible to tag/role-based extraction:
 * a `<div onClick={...}>Submit</div>` styled as a button by a component library, with no
 * semantic tag and no `role` attribute. Cheerio (extractCrawlResponse) operates on an HTML
 * *string* and has no access to computed styles or layout, so this has to run in the live
 * page instead. Runs alongside `page.content()` in `extractDomModelFromPage` below, the one
 * function every discovery path (primary crawl, live-extend replay, site crawl) already
 * shares — so every caller gets this for free from one change.
 */
async function detectGenericClickables(page: Page): Promise<GenericClickable[]> {
  try {
    return await page.evaluate(
      ({ maxWidth, maxHeight, maxCount }) => {
        const SEMANTIC_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
        const out: { name: string; id: string; testId: string }[] = [];
        const candidates = document.querySelectorAll("div, span, li, p");
        for (const el of Array.from(candidates)) {
          if (out.length >= maxCount) break;
          if (SEMANTIC_TAGS.has(el.tagName)) continue;
          if (el.getAttribute("role")) continue; // already covered by the [role] cheerio pass

          const tabindexAttr = el.getAttribute("tabindex");
          const hasTabIndex = tabindexAttr !== null && tabindexAttr !== "-1";
          const hasOnClickAttr = el.hasAttribute("onclick");
          const cursorPointer = window.getComputedStyle(el).cursor === "pointer";
          if (!hasTabIndex && !hasOnClickAttr && !cursorPointer) continue;

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue; // not actually visible
          if (rect.width > maxWidth || rect.height > maxHeight) continue;

          const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80);
          if (!name) continue;

          out.push({
            name,
            id: el.id || "",
            testId: el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || "",
          });
        }
        return out;
      },
      { maxWidth: MAX_CLICKABLE_WIDTH, maxHeight: MAX_CLICKABLE_HEIGHT, maxCount: MAX_GENERIC_CLICKABLES }
    );
  } catch (err: any) {
    console.warn(`[domDiscovery] generic-clickable scan failed: ${err?.message ?? err}`);
    return [];
  }
}

/** Re-check real visibility for every element discovery gave a `css` selector — cheerio (the
 *  primary extraction path) has no computed-style access, so `visible` arrives hardcoded true.
 *  Only elements with a css selector are worth re-checking here: those are exactly the ones
 *  eligible for ir.ts's grounding-time auto-css-attach (matched?.css && !t.css), so an
 *  inaccurate `true` here is what lets a viewport-hidden control (a hamburger menu-toggle,
 *  most commonly) become a raw-selector assertion target that times out at execution. One
 *  batched page.evaluate() — not N locator round-trips — reusing the same
 *  geometry+computed-style predicate already proven correct in discovery.ts's vision-fallback
 *  scan (deliberately NOT offsetParent, which returns null for position:fixed and would wrongly
 *  flag fixed headers as hidden). */
async function recheckVisibility(page: Page, elements: Element[]): Promise<void> {
  // An element the live walker already MEASURED is skipped: its css may be a shadow `>>` chain or
  // live inside an iframe, and document.querySelector on the top page would then test a different
  // element (or none) and overwrite a correct value. Cheerio elements never carry visibleSource,
  // so with DISCOVERY_LIVE_DOM off this filter removes nothing.
  const selectors = [...new Set(elements.filter(e => e.css && e.visibleSource !== "computed").map(e => e.css!))];
  if (!selectors.length) return;
  const results = await page.evaluate((sels: string[]) => {
    const out: Record<string, boolean> = {};
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) { out[sel] = true; continue; } // can't disprove visibility, leave as-is
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out[sel] = r.width > 0 && r.height > 0 &&
          cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
      } catch { out[sel] = true; }
    }
    return out;
  }, selectors).catch(() => ({} as Record<string, boolean>));
  for (const e of elements) {
    if (e.css && e.visibleSource !== "computed" && results[e.css] !== undefined) e.visible = results[e.css];
  }
}

/**
 * Extract a page's DOM model from an ALREADY-OPEN Playwright page — no browser launch, no
 * navigation, no cache write. This is what live-extend uses to snapshot a replayed page, so
 * the page's real session/credentials are intact when it is modeled. (discoverUsingCrawler
 * would start a fresh, session-less browser, which hits the login redirect for an
 * authenticated URL and models the LOGIN page instead — and caches that wrong snapshot.)
 */
export async function extractDomModelFromPage(page: Page, url: string): Promise<AppModel | null> {
  try {
    const strategy = elementStrategy();
    let html = await page.content();
    let crawlResult = extractCrawlResponse(html, url, 200);
    let model = crawlResponseToAppModel(crawlResult);
    let elements = await elementsFor(strategy, page, model);

    // Zero elements here is ambiguous — a genuine auth wall (nothing to extract, ever) and a
    // not-yet-hydrated JS-rendered page (elements exist, just not painted into the DOM this
    // `page.content()` call caught) produce an identical result at this point. The caller's
    // own settle wait before invoking this function (800ms, at every call site) was measured
    // directly against a real heavy page and found nowhere near enough: 0 elements at +800ms,
    // 347 at +2.8s, 576 (stable) by +4s. Poll briefly rather than accept 0 outright — an auth
    // wall costs nothing extra, since it's still correctly 0 after polling; a page that only
    // needed more time now gets it. See TECH_DEBT.md TD-31.
    //
    // MUST also check generic (non-semantic) clickables here, not just role-bearing elements —
    // a page whose only interactive content is a cursor:pointer <div> (no ARIA role at all)
    // would otherwise show 0 "real" elements forever and poll for the full budget on every
    // single call, despite having real, immediately-available content the whole time.
    let generic = await detectGenericClickables(page);
    const pollBudgetMs = Number(process.env.DISCOVERY_HYDRATION_POLL_MS ?? 6000);
    const pollIntervalMs = 1000;
    const deadline = Date.now() + pollBudgetMs;
    // `elements` is the strategy's list, so a live walk that already sees shadow-DOM content the
    // static parse cannot does not wait out the whole budget for nothing.
    while (elements.length === 0 && generic.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(pollIntervalMs);
      html = await page.content();
      crawlResult = extractCrawlResponse(html, url, 200);
      model = crawlResponseToAppModel(crawlResult);
      elements = await elementsFor(strategy, page, model);
      generic = await detectGenericClickables(page);
    }

    // Live strategy: swap in the walker's elements and re-tag landmarks by the same rule. With the
    // flag off, `elements` IS the model's own array, so there is nothing to swap.
    if (strategy === "live" && model.pages[0]) {
      model.pages[0].elements = elements;
      const sections = tagLandmarks(elements);
      if (sections.length) model.pages[0].landmarkSections = sections;
      else delete model.pages[0].landmarkSections;
    }

    if (generic.length && model.pages[0]) {
      const seen = new Set(model.pages[0].elements.map(e => `${e.role}:${e.name}`.toLowerCase()));
      let order = model.pages[0].elements.length;
      for (const g of generic) {
        const key = `button:${g.name}`.toLowerCase();
        if (seen.has(key)) continue; // defensive: shouldn't happen, the evaluate() pass already excludes [role]
        seen.add(key);
        // role: "button" — the closest real fit, and the one ir.ts's buildUser() keeps in its
        // INTERACTIVE_ROLES allow-list; an unlisted role like "generic" would make the LLM
        // never even see the element. Whether the real accessibility tree agrees with this
        // guess doesn't matter: targetResolver.ts's locate() already falls back from
        // getByRole to a CSS text-match to getByText at execution time.
        model.pages[0].elements.push({
          role: "button",
          name: g.name,
          ...(g.testId ? { testId: g.testId } : {}),
          // Through stableSelector, not a bare `#${id}`: an id like "a.b" or "1x" is not a valid
          // bare identifier (LS-4) — unescaped it matched a different element, or threw.
          ...(g.id ? { css: stableSelector({ id: g.id }) } : {}),
          visible: true,
          enabled: true,
          order: order++,
        });
      }
    }

    if (model.pages[0]) await recheckVisibility(page, model.pages[0].elements);

    return model;
  } catch (err: any) {
    console.warn(`[domDiscovery] DOM extraction error for ${url}: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Cache key for `discoverUsingCrawler`. The strategy is a real input to the model it caches, so it
 * is part of the key (`CLAUDE.md`: a key missing a dimension serves a wrong answer — TD-22, D-10).
 * Flag off keeps the original `dom:${url}`, so existing cache entries stay valid.
 */
export function domCacheKey(url: string): string {
  return elementStrategy() === "live" ? `dom-live:${url}` : `dom:${url}`;
}

/**
 * Discover a page's structure directly from the rendered DOM. This is the PRIMARY discovery
 * path — no Gemini vision needed for standard pages.
 *
 * Returns null (never throws) on navigation failure or a genuinely empty extraction, so the
 * caller (hybridDiscovery.ts) falls back to vision-based discovery.
 */
export async function discoverUsingCrawler(url: string): Promise<AppModel | null> {
  const cacheKey = domCacheKey(url);
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[domDiscovery] cache hit for ${url}`);
    return cached;
  }

  let browser;
  try {
    console.log(`[domDiscovery] extracting DOM structure for ${url}`);
    browser = await chromium.launch(chromiumLaunchOptions());
    // Locale/timezone are CONTEXT options, not launch options, and `browser.newPage(options)`
    // takes the full context option set (verified against the pinned 1.49.0 types, D-19). Passed
    // here rather than by promoting this to newContext() + context.newPage(): a second page on a
    // context does not carry sessionStorage (TD-41 / D-23), and this path needs no extra page.
    const page = await browser.newPage(browserContextOptions());
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

    const finalUrl = page.url();   // reflects any redirect the navigation followed
    const appModel = await extractDomModelFromPage(page, finalUrl);
    if (!appModel) return null;

    console.log(
      `[domDiscovery] extracted ${url}: ${appModel.pages[0]?.elements.length ?? 0} elements, ` +
      `needs_vision=${appModel.pages[0]?.needsVision}`
    );

    cacheSet(cacheKey, appModel);
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

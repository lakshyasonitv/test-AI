/**
 * Structured DOM extraction — the Node port of discovery-service/crawler.py.
 *
 * Ported 1:1 from the Python/BeautifulSoup implementation so the CrawlResponse shape
 * domDiscovery.ts's crawlResponseToAppModel() already consumes doesn't have to change.
 * Only the SOURCE of the HTML changes: domDiscovery.ts now gets it from the Playwright
 * page it already launches for vision fallback, instead of a second browser (Crawl4AI's,
 * via a Python subprocess and HTTP round-trip) or an httpx-only fallback with no rendering.
 *
 * Element-naming logic (stableSelector / deriveElementName / humaniseIdentifier) is NOT
 * duplicated here — it's imported from discovery.ts, which already has it for the
 * Playwright-side interactive-element detector. Same rules, one implementation.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element as DomElement } from "domhandler";
import { deriveElementName, stableSelector } from "./discovery.js";

type CQ = cheerio.CheerioAPI;

// ---------------------------------------------------------------------------
// Response shape — exported so domDiscovery.ts can import instead of redeclaring it
// ---------------------------------------------------------------------------

export interface CrawlResponse {
  url: string;
  title: string;
  status_code: number;
  metadata: {
    title: string; description: string; keywords: string; author: string;
    og_title: string; og_description: string; og_image: string;
    canonical: string; charset: string; viewport: string; favicon: string;
  };
  markdown: string;
  cleaned_html: string;
  forms: Array<{
    action: string; method: string; id: string; name: string; aria_label: string;
    fields: Array<{
      tag: string; input_type: string; name: string; placeholder: string; label: string;
      required: boolean; value: string; options: string[]; id: string; aria_label: string;
    }>;
  }>;
  navigation: NavigationItem[];
  links: Array<{ text: string; href: string; title: string; aria_label: string; is_external: boolean; role: string }>;
  buttons: Array<{ text: string; button_type: string; aria_label: string; disabled: boolean; id: string; role: string }>;
  headings: Array<{ level: number; text: string; id: string }>;
  tables: Array<{ headers: string[]; rows: string[][]; caption: string; aria_label: string; id: string }>;
  images: Array<{ src: string; alt: string; title: string; width: number; height: number }>;
  interactive_elements: Array<{
    tag: string; role: string; name: string; text: string; href: string; id: string;
    css_classes: string[]; aria_label: string; aria_role: string; visible: boolean; enabled: boolean;
    test_id: string; css: string; derived_name: boolean;
    /** `name` is visible text beside the control, not its accessible name — see proximityLabel. */
    name_from_proximity?: boolean;
    generic_path: string;
  }>;
  internal_urls: string[];
  external_urls: string[];
  breadcrumbs: string[];
  has_search: boolean; has_pagination: boolean; has_modal: boolean; has_tabs: boolean; has_accordion: boolean;
  dom_depth: number;
  accessibility: {
    lang: string; title: string; landmark_roles: string[]; aria_landmarks: Array<Record<string, string>>;
    skip_links: string[]; forms_with_labels: number; images_with_alt: number; images_total: number;
    heading_order: number[];
  };
  needs_vision: boolean;
  vision_reason: string;
  crawl_time_ms: number;
  error: string;
}

interface NavigationItem {
  text: string; href: string; children: NavigationItem[]; is_dropdown: boolean;
  aria_label: string; role: string;
}

// ---------------------------------------------------------------------------
// HTML helpers (mirrors _text / _attr / _abs_url / _is_external / _origin)
// ---------------------------------------------------------------------------

const text = ($el: cheerio.Cheerio<AnyNode>): string => $el.text().replace(/\s+/g, " ").trim();

const attr = ($el: cheerio.Cheerio<AnyNode>, name: string, fallback = ""): string => {
  const v = $el.attr(name);
  return v === undefined ? fallback : v.trim();
};

const has = ($el: cheerio.Cheerio<AnyNode>, name: string): boolean => $el.attr(name) !== undefined;

function absUrl(href: string, base: string): string {
  if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) return "";
  try {
    return new URL(href, base).href;
  } catch {
    return "";
  }
}

function isExternal(url: string, baseOrigin: string): boolean {
  try {
    const origin = new URL(url).origin;
    return origin !== baseOrigin;
  } catch {
    return false;
  }
}

/** Walk up from an element to <body>, recording only tag names.
 *  Result: "body>main>div>ul>li>button" — no IDs, no classes, no indices.
 *  Identical for all 48 product cards in a grid. */
function computeGenericPath($: CQ, el: AnyNode): string {
  const parts: string[] = [];
  let node: AnyNode | null = el;
  while (node && (node as DomElement).tagName) {
    parts.unshift((node as DomElement).tagName.toLowerCase());
    node = (node as any).parent ?? null;
  }
  return parts.join(">");
}

const classesOf = ($el: cheerio.Cheerio<AnyNode>): string[] => attr($el, "class").split(/\s+/).filter(Boolean);

// Class-attribute substring match — BeautifulSoup's `class_=lambda c: "x" in c` pattern.
function findByClassSubstring($: CQ, needle: string): cheerio.Cheerio<AnyNode> {
  return $("[class]").filter((_, el) => attr($(el), "class").toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Extractors — one function per Python `_extract_*`
// ---------------------------------------------------------------------------

function extractMetadata($: CQ, pageTitle: string): CrawlResponse["metadata"] {
  const meta: CrawlResponse["metadata"] = {
    title: pageTitle, description: "", keywords: "", author: "",
    og_title: "", og_description: "", og_image: "", canonical: "", charset: "", viewport: "", favicon: "",
  };
  $("meta").each((_, el) => {
    const $el = $(el);
    const name = attr($el, "name").toLowerCase();
    const prop = attr($el, "property").toLowerCase();
    const content = attr($el, "content");
    if (name === "description") meta.description = content;
    else if (name === "keywords") meta.keywords = content;
    else if (name === "author") meta.author = content;
    else if (name === "viewport") meta.viewport = content;
    else if (prop === "og:title") meta.og_title = content;
    else if (prop === "og:description") meta.og_description = content;
    else if (prop === "og:image") meta.og_image = content;
  });
  const canonical = $('link[rel="canonical"]').first();
  if (canonical.length) meta.canonical = attr(canonical, "href");
  const favicon = $("link[rel]").filter((_, el) => attr($(el), "rel").toLowerCase().includes("icon")).first();
  if (favicon.length) meta.favicon = attr(favicon, "href");
  const charsetTag = $("meta[charset]").first();
  if (charsetTag.length) meta.charset = attr(charsetTag, "charset");
  return meta;
}

function extractHeadings($: CQ): CrawlResponse["headings"] {
  const out: CrawlResponse["headings"] = [];
  for (let level = 1; level <= 6; level++) {
    $(`h${level}`).each((_, el) => {
      const $el = $(el);
      out.push({ level, text: text($el), id: attr($el, "id") });
    });
  }
  return out;
}

/**
 * The visible text that labels a form control which has no PROGRAMMATIC label.
 *
 * `<div>Full Name</div><input>` is the standard React/Tailwind form shape: the field is
 * labelled to a human, and completely anonymous to everything else — no `for`/`id` pair, no
 * wrapping `<label>`, no `aria-label`, no placeholder, no name attribute. Before this existed
 * such a control reached `deriveElementName`, found nothing there either (a styled-inline app
 * has no usable class name), and was dropped from the model as "genuinely unaddressable".
 * Confirmed on learnvibes' Add-New-user modal: its Full Name and Email inputs were absent from
 * a 49-element page model, so no step could ever target them and the IR fell back to
 * `{ text: "Name" }`, which resolves to the <label> itself and cannot be filled.
 *
 * Deliberately shallow — the immediately preceding sibling, then the wrapper's preceding
 * sibling. Anything further away stops being a label and starts being unrelated page copy.
 */
function proximityLabel($: CQ, $el: cheerio.Cheerio<AnyNode>): string {
  const candidates = [$el.prev(), $el.parent().prev()];
  for (const $c of candidates) {
    if (!$c.length) continue;
    // A preceding control is a sibling FIELD, not this field's label.
    if ($c.is("input, select, textarea, button, a, form")) continue;
    const t = text($c);
    // A label is short. Anything longer is a paragraph that happens to sit above the input.
    if (t && t.length <= MAX_PROXIMITY_LABEL) return t;
  }
  return "";
}

const MAX_PROXIMITY_LABEL = 60;

function extractForms($: CQ, baseUrl: string): CrawlResponse["forms"] {
  const forms: CrawlResponse["forms"] = [];
  $("form").each((_, formEl) => {
    const $form = $(formEl);
    const fields: CrawlResponse["forms"][number]["fields"] = [];
    $form.find("input, select, textarea").each((__, inputEl) => {
      const $in = $(inputEl);
      const tag = (inputEl as DomElement).tagName.toLowerCase();
      const inputType = attr($in, "type", tag === "input" ? "text" : "");
      const fieldId = attr($in, "id");

      let labelText = "";
      if (fieldId) labelText = text($(`label[for="${fieldId.replace(/"/g, '\\"')}"]`).first());
      if (!labelText) {
        const parentLabel = $in.closest("label");
        if (parentLabel.length) labelText = text(parentLabel);
      }
      // Last resort, and ONLY for a field that would otherwise contribute no name at all:
      // the visible text sitting next to it. Guarded on placeholder/aria-label because
      // crawlResponseToAppModel ranks `label` ABOVE `placeholder` — inferring one for a field
      // that already had a real accessible name emitted the same control twice, once as
      // `textbox "you@thinkvibes.com"` and once as `textbox "Email"`, and the IR then targeted
      // the name that is not in the DOM.
      if (!labelText && !attr($in, "placeholder") && !attr($in, "aria-label")) {
        labelText = proximityLabel($, $in);
      }

      const options: string[] = [];
      if (tag === "select") {
        $in.find("option").each((___, opt) => {
          const t = text($(opt));
          if (t) options.push(t);
        });
      }

      fields.push({
        tag, input_type: inputType, name: attr($in, "name"), placeholder: attr($in, "placeholder"),
        label: labelText, required: has($in, "required"),
        // A hidden input's value is never read by anything downstream — no step fills it, nothing
        // grounds against it, and `promptFormFields` strips the whole field before any prompt —
        // but it IS whatever the server put there. On a real crawl of amazon.in that was
        // `anti-csrftoken-a2z` carrying a live CSRF token, which then reached `02-appmodel.json`
        // and `events.ndjson`, both served publicly (TD-14). Not recording it closes the artifact,
        // both caches and both prompts at once, because everything downstream reads this field.
        // TD-64.
        value: inputType === "hidden" ? "" : attr($in, "value"),
        options, id: fieldId, aria_label: attr($in, "aria-label"),
      });
    });
    forms.push({
      action: absUrl(attr($form, "action"), baseUrl), method: attr($form, "method", "GET").toUpperCase(),
      id: attr($form, "id"), name: attr($form, "name"), fields, aria_label: attr($form, "aria-label"),
    });
  });
  return forms;
}

function extractLinks($: CQ, baseUrl: string, baseOrigin: string): CrawlResponse["links"] {
  const links: CrawlResponse["links"] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = absUrl(attr($el, "href"), baseUrl);
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push({
      text: text($el), href, title: attr($el, "title"), aria_label: attr($el, "aria-label"),
      is_external: isExternal(href, baseOrigin), role: "link",
    });
  });
  return links;
}

function extractButtons($: CQ): CrawlResponse["buttons"] {
  const buttons: CrawlResponse["buttons"] = [];
  $("button, input").each((_, el) => {
    const $el = $(el);
    const tag = (el as DomElement).tagName.toLowerCase();
    if (tag === "input") {
      const inputType = attr($el, "type", "submit");
      if (!["submit", "button", "reset"].includes(inputType)) return;
    }
    const btnType = tag === "button" ? attr($el, "type", "button") : attr($el, "type", "submit");
    const btnText = tag === "button" ? text($el) : attr($el, "value");
    buttons.push({
      text: btnText, button_type: btnType, aria_label: attr($el, "aria-label"),
      disabled: has($el, "disabled"), id: attr($el, "id"), role: attr($el, "role", "button"),
    });
  });
  $('[role="button"]').each((_, el) => {
    const tag = (el as DomElement).tagName.toLowerCase();
    if (tag === "button" || tag === "input") return;
    const $el = $(el);
    buttons.push({
      text: text($el), button_type: "button", aria_label: attr($el, "aria-label"),
      disabled: has($el, "aria-disabled"), id: attr($el, "id"), role: "button",
    });
  });
  return buttons;
}

function extractNavigation($: CQ, baseUrl: string): CrawlResponse["navigation"] {
  function parseNavElement($el: cheerio.Cheerio<AnyNode>): NavigationItem[] {
    const items: NavigationItem[] = [];
    $el.children("li").each((_, liEl) => {
      const $li = $(liEl);
      const $a = $li.find("a[href]").first();
      if (!$a.length) return;

      const dropdownClass = $li.children("ul, ol, div").filter((__, c) => {
        const cls = attr($(c), "class").toLowerCase();
        return cls.includes("dropdown") || cls.includes("submenu") || cls.includes("menu");
      }).first();

      let children: NavigationItem[] = [];
      let isDropdown = false;
      if (dropdownClass.length) {
        children = parseNavElement(dropdownClass);
        isDropdown = true;
      }

      items.push({
        text: text($a), href: absUrl(attr($a, "href"), baseUrl), children,
        is_dropdown: isDropdown, aria_label: attr($a, "aria-label"), role: attr($a, "role", "link"),
      });
    });
    return items;
  }

  let navItems: NavigationItem[] = [];
  $("nav, header").each((_, navEl) => {
    const $ul = $(navEl).find("ul, ol").first();
    if ($ul.length) {
      const items = parseNavElement($ul);
      if (items.length) navItems = navItems.concat(items);
    }
  });

  if (!navItems.length) {
    const navLike = $("[class]").filter((_, el) => {
      const cls = attr($(el), "class").toLowerCase();
      return ["navbar", "nav-menu", "main-menu", "navigation"].some(kw => cls.includes(kw));
    });
    navLike.each((_, el) => {
      $(el).find("a[href]").each((__, a) => {
        const $a = $(a);
        navItems.push({
          text: text($a), href: absUrl(attr($a, "href"), baseUrl), children: [],
          is_dropdown: false, aria_label: attr($a, "aria-label"), role: "link",
        });
      });
    });
  }
  return navItems;
}

function extractTables($: CQ): CrawlResponse["tables"] {
  const tables: CrawlResponse["tables"] = [];
  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    const headers: string[] = [];
    const $thead = $table.find("thead").first();
    if ($thead.length) $thead.find("th").each((__, th) => { headers.push(text($(th))); });

    const rows: string[][] = [];
    const $tbody = $table.find("tbody").first();
    const rowScope = $tbody.length ? $tbody : $table;
    rowScope.find("tr").each((__, tr) => {
      const cells: string[] = [];
      $(tr).find("td, th").each((___, cell) => { cells.push(text($(cell))); });
      if (cells.length) rows.push(cells);
    });

    const $caption = $table.find("caption").first();
    tables.push({
      headers, rows, caption: $caption.length ? text($caption) : "",
      aria_label: attr($table, "aria-label"), id: attr($table, "id"),
    });
  });
  return tables;
}

function extractImages($: CQ, baseUrl: string): CrawlResponse["images"] {
  const images: CrawlResponse["images"] = [];
  const parseDim = (v: string): number => {
    const n = parseInt(v.replace(/px|em|%/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  };
  $("img").each((_, el) => {
    const $el = $(el);
    const src = absUrl(attr($el, "src"), baseUrl);
    if (!src) return;
    images.push({
      src, alt: attr($el, "alt"), title: attr($el, "title"),
      width: parseDim(attr($el, "width", "0")), height: parseDim(attr($el, "height", "0")),
    });
  });
  return images;
}

function extractInteractiveElements($: CQ, baseUrl: string): CrawlResponse["interactive_elements"] {
  const elements: CrawlResponse["interactive_elements"] = [];
  const seen = new Set<string>();

  $("a, button, input, select, textarea").each((_, el) => {
    const $el = $(el);
    const tag = (el as DomElement).tagName.toLowerCase();
    let role = attr($el, "role");
    if (tag === "a") role = role || "link";
    else if (tag === "button") role = role || "button";
    else if (["input", "select", "textarea"].includes(tag)) {
      const inputType = attr($el, "type", "text");
      const roleMap: Record<string, string> = {
        checkbox: "checkbox", radio: "radio", submit: "button", button: "button", search: "searchbox",
      };
      // A <select> is a combobox, not a textbox. roleForField (domDiscovery.ts) has always
      // said so for the same element arriving via forms[].fields[]; this loop disagreed, so
      // the same control was emitted twice under two roles once both paths could name it.
      role = role || (tag === "select" ? "combobox" : roleMap[inputType]) || "textbox";
    }

    const isField = ["input", "select", "textarea"].includes(tag);
    // `text()` is a real accessible name for an <a>/<button> and never for a form control:
    // on a <select> it returns every option concatenated ("Select...LearnerTrainerManager"),
    // which is not a name anyone — model or human — would ever target by. Seen in production.
    const ownText = isField ? "" : text($el);
    // The visible text labelling an otherwise-anonymous field. Sits after the real
    // programmatic sources and before the attribute-derived guesses, because it is what a
    // user actually sees and therefore what a test prompt will call the field.
    const nearby = isField ? proximityLabel($, $el) : "";

    // Accessible name in accname precedence order — see roleForField's comment in
    // domDiscovery.ts for why the HTML `name` attribute must come last, not first.
    // A `type=hidden` input is not in the accessibility tree, so it has no accessible name to
    // derive — and using its `value` as one is how a CSRF token ended up as an element's NAME in
    // a publicly-served artifact (TD-64). Its `name` attribute still applies; only the value is
    // withheld.
    const isHiddenField = (attr($el, "type") || "").toLowerCase() === "hidden";
    const name0 =
      attr($el, "aria-label") || attr($el, "placeholder") || ownText
      || (isHiddenField ? "" : attr($el, "value")) || attr($el, "title") || attr($el, "name");

    const testId = attr($el, "data-test") || attr($el, "data-testid") || attr($el, "data-qa");
    const id = attr($el, "id");
    const classes = classesOf($el);
    const href = attr($el, "href");

    let name = name0;
    let derivedName = false;
    // True when `name` is visible text next to the control rather than its accessible name.
    // Load-bearing downstream: getByRole(role, { name }) can NEVER match an inferred name —
    // the DOM has no such name — so the resolver has to reach the field another way.
    let nameFromProximity = false;
    if (!name && nearby) {
      name = nearby;
      nameFromProximity = true;
    }
    if (!name) {
      name = deriveElementName({
        dataTest: attr($el, "data-test"), dataTestid: attr($el, "data-testid"),
        dataQa: attr($el, "data-qa"), id, classes, href
      });
      if (!name) return;   // genuinely unaddressable, matches Python's `continue`
      derivedName = true;
    }

    const selector = stableSelector({
      dataTest: attr($el, "data-test"), dataTestid: attr($el, "data-testid"),
      dataQa: attr($el, "data-qa"), id
    });
    const key = selector || `${role}:${name}:${elements.length}`;
    if (seen.has(key)) return;
    seen.add(key);

    elements.push({
      tag, role, name, text: text($el).slice(0, 100),
      href: tag === "a" ? absUrl(href, baseUrl) : "",
      id, css_classes: classes, test_id: testId, css: selector, derived_name: derivedName,
      name_from_proximity: nameFromProximity,
      aria_label: attr($el, "aria-label"), aria_role: attr($el, "role"),
      visible: true, enabled: !has($el, "disabled"),
      generic_path: computeGenericPath($, el),
    });
  });

  $("[role]").each((_, el) => {
    const $el = $(el);
    const role = attr($el, "role");
    const name = attr($el, "aria-label") || text($el);
    if (!name || ["presentation", "none", "img"].includes(role)) return;
    // The loop above already emits every a/button/input/select/textarea — with the same
    // role+name — but keyed as `selector || role:name:index`, which never collides with
    // the `role:name` key here. So without this skip, `<a role="tab">` (or any control
    // carrying a role) was emitted twice with identical role+name, producing duplicate
    // AppModel elements and strict-mode "matched 2 elements" failures in generated tests.
    const tag = (el as DomElement).tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea"].includes(tag)) return;
    const key = `${role}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    elements.push({
      tag: (el as DomElement).tagName.toLowerCase(), role, name, text: text($el).slice(0, 100), href: "",
      id: attr($el, "id"), css_classes: classesOf($el), test_id: "", css: "", derived_name: false,
      aria_label: attr($el, "aria-label"), aria_role: role,
      visible: true, enabled: !has($el, "aria-disabled"),
      generic_path: computeGenericPath($, el),
    });
  });

  return elements;
}

function extractAccessibility(
  $: CQ, images: CrawlResponse["images"], headings: CrawlResponse["headings"]
): CrawlResponse["accessibility"] {
  const lang = attr($("html").first(), "lang");
  const title = text($("title").first());

  const landmarkRoles = new Set<string>();
  const ariaLandmarks: Array<Record<string, string>> = [];
  const LANDMARK = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region"]);
  $("[role]").each((_, el) => {
    const $el = $(el);
    const role = attr($el, "role");
    if (LANDMARK.has(role)) {
      landmarkRoles.add(role);
      ariaLandmarks.push({ role, label: attr($el, "aria-label") });
    }
  });

  const skipLinks: string[] = [];
  $("a").each((_, el) => {
    const $el = $(el);
    const href = attr($el, "href");
    const t = text($el).toLowerCase();
    if (href.startsWith("#") && (t.includes("skip") || t.includes("jump"))) skipLinks.push(text($el));
  });

  return {
    lang, title, landmark_roles: [...landmarkRoles].sort(), aria_landmarks: ariaLandmarks, skip_links: skipLinks,
    forms_with_labels: 0, images_with_alt: images.filter(i => i.alt).length, images_total: images.length,
    heading_order: headings.map(h => h.level),
  };
}

function detectUiPatterns($: CQ): { has_modal: boolean; has_tabs: boolean; has_accordion: boolean; has_search: boolean; has_pagination: boolean } {
  const hasModal = $('[role="dialog"]').length > 0 || findByClassSubstring($, "modal").length > 0
    || $("[id]").filter((_, el) => attr($(el), "id").toLowerCase().includes("modal")).length > 0;
  const hasTabs = $('[role="tablist"]').length > 0 || findByClassSubstring($, "tab").length > 0;
  const hasAccordion =
    ["accordion", "collapsible", "expandable"].some(kw => findByClassSubstring($, kw).length > 0)
    || $("[aria-expanded]").length > 0;
  const hasSearch = $('[role="search"]').length > 0 || $('input[type="search"]').length > 0
    || findByClassSubstring($, "search").length > 0;
  const hasPagination = findByClassSubstring($, "pagination").length > 0
    || $('[role="navigation"]').filter((_, el) => attr($(el), "aria-label").toLowerCase().includes("pagination")).length > 0;
  return { has_modal: hasModal, has_tabs: hasTabs, has_accordion: hasAccordion, has_search: hasSearch, has_pagination: hasPagination };
}

function computeDomDepth($: CQ): number {
  let maxDepth = 0;
  function walk(node: AnyNode, depth: number): void {
    if (depth > maxDepth) maxDepth = depth;
    const children = (node as DomElement).children ?? [];
    for (const child of children) {
      if ((child as DomElement).type === "tag") walk(child, depth + 1);
    }
  }
  const body = $("body").get(0);
  if (body) walk(body, 0);
  return maxDepth;
}

function needsVision($: CQ): { needs: boolean; reason: string } {
  if ($("canvas").length) return { needs: true, reason: "Page contains canvas element" };
  if ($("embed, object").length) return { needs: true, reason: "Page contains embedded content" };
  const interactive = $("a, button, input, select, textarea").length;
  const images = $("img").length;
  if (interactive < 3 && images > 10) return { needs: true, reason: "Image-heavy page with few interactive elements" };
  const pageText = text($("body")).toLowerCase();
  if (["captcha", "recaptcha", "hcaptcha"].some(ind => pageText.includes(ind))) {
    return { needs: true, reason: "CAPTCHA detected" };
  }
  return { needs: false, reason: "" };
}

function htmlToMarkdown($: CQ): string {
  const lines: string[] = [];
  const SKIP_TAGS = new Set(["script", "style", "noscript"]);

  function walk(node: AnyNode): void {
    // Text nodes are a distinct domhandler class (Text), not Element — check before
    // casting, since Element's own `.type` can never be "text".
    if (node.type === "text") {
      const t = (("data" in node ? (node as any).data : "") as string).trim();
      if (t) lines.push(t);
      return;
    }
    if (node.type !== "tag") return;
    const n = node as DomElement;
    const tag = n.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      lines.push(`\n${"#".repeat(level)} ${text($(n))}\n`);
      return;
    }
    if (tag === "p") { lines.push(`\n${text($(n))}\n`); return; }
    if (tag === "a") {
      const href = attr($(n), "href");
      const t = text($(n));
      if (t && href) lines.push(`[${t}](${href})`);
      else if (t) lines.push(t);
      return;
    }
    if (tag === "img") {
      const alt = attr($(n), "alt", "image");
      const src = attr($(n), "src");
      lines.push(`![${alt}](${src})`);
      return;
    }
    if (tag === "ul" || tag === "ol") {
      $(n).children("li").each((i, li) => {
        const prefix = tag === "ol" ? `${i + 1}.` : "-";
        lines.push(`  ${prefix} ${text($(li))}`);
      });
      return;
    }
    if (tag === "table") {
      $(n).find("tr").each((_, tr) => {
        const cells: string[] = [];
        $(tr).find("th, td").each((__, c) => { cells.push(text($(c))); });
        if (cells.length) lines.push("| " + cells.join(" | ") + " |");
      });
      lines.push("");
      return;
    }
    if (tag === "br") { lines.push(""); return; }
    if (tag === "hr") { lines.push("---"); return; }

    for (const child of n.children ?? []) walk(child);
  }

  const body = $("body").get(0);
  if (!body) return "";
  for (const child of (body as DomElement).children ?? []) walk(child);
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Orchestration — mirrors the extraction half of Python's crawl()
// ---------------------------------------------------------------------------

/**
 * Turn raw page HTML into the same structured CrawlResponse shape the Python service used
 * to return. Pure function — no network, no browser; the caller (domDiscovery.ts) is
 * responsible for fetching `html` (via a Playwright page.content() call) and passing in the
 * final URL and HTTP status after any redirects.
 */
export function extractCrawlResponse(html: string, url: string, statusCode: number): CrawlResponse {
  const start = Date.now();
  const $ = cheerio.load(html);
  const baseOrigin = new URL(url).origin;

  const pageTitle = text($("title").first());
  const headings = extractHeadings($);
  const forms = extractForms($, url);
  const links = extractLinks($, url, baseOrigin);
  const buttons = extractButtons($);
  const navigation = extractNavigation($, url);
  const tables = extractTables($);
  const images = extractImages($, url);
  const interactiveElements = extractInteractiveElements($, url);

  const allUrls = new Set<string>();
  for (const l of links) allUrls.add(l.href);
  for (const n of navigation) if (n.href) allUrls.add(n.href);
  const internalUrls: string[] = [];
  const externalUrls: string[] = [];
  for (const u of allUrls) (isExternal(u, baseOrigin) ? externalUrls : internalUrls).push(u);

  const patterns = detectUiPatterns($);

  const breadcrumbEl = findByClassSubstring($, "breadcrumb").first();
  const breadcrumbs = breadcrumbEl.length
    ? breadcrumbEl.find("a").toArray().map(a => text($(a)))
    : [];

  const domDepth = computeDomDepth($);
  const accessibility = extractAccessibility($, images, headings);
  const markdown = htmlToMarkdown($);
  const vision = needsVision($);

  return {
    url, title: pageTitle, status_code: statusCode,
    metadata: extractMetadata($, pageTitle),
    markdown, cleaned_html: html,
    forms, navigation, links, buttons, headings, tables, images,
    interactive_elements: interactiveElements,
    internal_urls: internalUrls, external_urls: externalUrls, breadcrumbs,
    has_search: patterns.has_search, has_pagination: patterns.has_pagination,
    has_modal: patterns.has_modal, has_tabs: patterns.has_tabs, has_accordion: patterns.has_accordion,
    dom_depth: domDepth, accessibility,
    needs_vision: vision.needs, vision_reason: vision.reason,
    crawl_time_ms: Date.now() - start, error: "",
  };
}

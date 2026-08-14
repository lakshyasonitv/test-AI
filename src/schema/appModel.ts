import { z } from "zod";

// ---------------------------------------------------------------------------
// Element (unchanged — backward compatible)
// ---------------------------------------------------------------------------

export const Element = z.object({
  role: z.string(),
  name: z.string(),
  concept: z.string().optional(),   // e.g. "login-email", "search-box"
  testId: z.string().optional(),
  id: z.string().optional(),
  // Deterministic selector captured by discovery (never invented by an LLM). Set for
  // elements whose accessible name is empty or synthetic — an icon-only cart/close/search
  // control can only be located this way.
  css: z.string().optional(),
  // True when `name` is the visible text sitting next to the control rather than its real
  // accessible name — the `<div>Full Name</div><input>` shape, where the field is labelled
  // to a human and anonymous to the DOM. getByRole(role, { name }) can never match such a
  // name, so the resolver must reach it positionally instead. See domExtract's proximityLabel.
  nameFromProximity: z.boolean().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  containerRole: z.string().optional(),
  containerName: z.string().optional(),
  pageSection: z.string().optional(), // "main", "nav", "header", "footer", "dialog"
  path: z.array(z.string()).optional(), // ["body", "main", "form", "button"]
  genericPath: z.string().optional(),
  compressed: z.boolean().optional(),
  count: z.number().optional(),
  landmark: z.string().optional(),
  order: z.number().optional(),
});
export type Element = z.infer<typeof Element>;

// ---------------------------------------------------------------------------
// DOM-extracted structured types (new — all optional for backward compat)
// ---------------------------------------------------------------------------

export const FormField = z.object({
  tag: z.string(),
  inputType: z.string().default("text"),
  name: z.string().default(""),
  placeholder: z.string().default(""),
  label: z.string().default(""),
  required: z.boolean().default(false),
  value: z.string().default(""),
  options: z.array(z.string()).default([]),
  id: z.string().default(""),
  ariaLabel: z.string().default(""),
});
export type FormField = z.infer<typeof FormField>;

export const DomForm = z.object({
  action: z.string().default(""),
  method: z.string().default("GET"),
  id: z.string().default(""),
  name: z.string().default(""),
  fields: z.array(FormField).default([]),
  ariaLabel: z.string().default(""),
});
export type DomForm = z.infer<typeof DomForm>;

export const NavigationItem: z.ZodType<any> = z.lazy(() => z.object({
  text: z.string(),
  href: z.string().default(""),
  children: z.array(NavigationItem).default([]),
  isDropdown: z.boolean().default(false),
  ariaLabel: z.string().default(""),
  role: z.string().default("link"),
}));
export type NavigationItem = z.infer<typeof NavigationItem>;

export const DomLink = z.object({
  text: z.string(),
  href: z.string(),
  title: z.string().default(""),
  ariaLabel: z.string().default(""),
  isExternal: z.boolean().default(false),
  role: z.string().default("link"),
});
export type DomLink = z.infer<typeof DomLink>;

export const DomButton = z.object({
  text: z.string(),
  buttonType: z.string().default("button"),
  ariaLabel: z.string().default(""),
  disabled: z.boolean().default(false),
  id: z.string().default(""),
  role: z.string().default("button"),
});
export type DomButton = z.infer<typeof DomButton>;

export const DomHeading = z.object({
  level: z.number(),
  text: z.string(),
  id: z.string().default(""),
});
export type DomHeading = z.infer<typeof DomHeading>;

export const DomTable = z.object({
  headers: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
  caption: z.string().default(""),
  ariaLabel: z.string().default(""),
  id: z.string().default(""),
});
export type DomTable = z.infer<typeof DomTable>;

export const DomImage = z.object({
  src: z.string(),
  alt: z.string().default(""),
  title: z.string().default(""),
  width: z.number().default(0),
  height: z.number().default(0),
});
export type DomImage = z.infer<typeof DomImage>;

export const InteractiveElement = z.object({
  tag: z.string(),
  role: z.string().default(""),
  name: z.string().default(""),
  text: z.string().default(""),
  href: z.string().default(""),
  id: z.string().default(""),
  cssClasses: z.array(z.string()).default([]),
  xpath: z.string().default(""),
  ariaLabel: z.string().default(""),
  ariaRole: z.string().default(""),
  visible: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type InteractiveElement = z.infer<typeof InteractiveElement>;

export const DomMetadata = z.object({
  title: z.string().default(""),
  description: z.string().default(""),
  keywords: z.string().default(""),
  author: z.string().default(""),
  ogTitle: z.string().default(""),
  ogDescription: z.string().default(""),
  ogImage: z.string().default(""),
  canonical: z.string().default(""),
  charset: z.string().default(""),
  viewport: z.string().default(""),
  favicon: z.string().default(""),
});
export type DomMetadata = z.infer<typeof DomMetadata>;

export const AccessibilityInfo = z.object({
  lang: z.string().default(""),
  title: z.string().default(""),
  landmarkRoles: z.array(z.string()).default([]),
  ariaLandmarks: z.array(z.record(z.string())).default([]),
  skipLinks: z.array(z.string()).default([]),
  formsWithLabels: z.number().default(0),
  imagesWithAlt: z.number().default(0),
  imagesTotal: z.number().default(0),
  headingOrder: z.array(z.number()).default([]),
});
export type AccessibilityInfo = z.infer<typeof AccessibilityInfo>;

// ---------------------------------------------------------------------------
// PageModel — extended with optional DOM fields
// ---------------------------------------------------------------------------

export const PageModel = z.object({
  url: z.string(),
  title: z.string().optional(),
  concepts: z.array(z.string()),    // e.g. ["Login","Search"]
  elements: z.array(Element),

  // --- New DOM-extracted fields (all optional for backward compat) ---
  landmarkSections: z.array(z.object({
    landmark: z.string(),
    label: z.string().default(""),
    elementCount: z.number(),
  })).optional(),
  markdown: z.string().optional(),
  cleanedHtml: z.string().optional(),
  metadata: DomMetadata.optional(),
  forms: z.array(DomForm).optional(),
  navigation: z.array(NavigationItem).optional(),
  domLinks: z.array(DomLink).optional(),
  buttons: z.array(DomButton).optional(),
  headings: z.array(DomHeading).optional(),
  tables: z.array(DomTable).optional(),
  images: z.array(DomImage).optional(),
  interactiveElements: z.array(InteractiveElement).optional(),
  internalUrls: z.array(z.string()).optional(),
  externalUrls: z.array(z.string()).optional(),
  breadcrumbs: z.array(z.string()).optional(),
  hasSearch: z.boolean().optional(),
  hasPagination: z.boolean().optional(),
  hasModal: z.boolean().optional(),
  hasTabs: z.boolean().optional(),
  hasAccordion: z.boolean().optional(),
  domDepth: z.number().optional(),
  accessibility: AccessibilityInfo.optional(),
  needsVision: z.boolean().optional(),
  visionReason: z.string().optional(),
  crawlTimeMs: z.number().optional(),
  discoveryMethod: z.enum(["dom", "vision", "hybrid"]).optional(),
});
export type PageModel = z.infer<typeof PageModel>;

// ---------------------------------------------------------------------------
// AppModel — unchanged structure, extended PageModel
// ---------------------------------------------------------------------------

export const AppModel = z.object({
  baseUrl: z.string(),
  pages: z.array(PageModel),
});
export type AppModel = z.infer<typeof AppModel>;

/** Roles worth keeping when a page has more named elements than the lite-model budget allows.
 *  Shared with ir.ts's own element-relevance filter — previously duplicated there. */
export const INTERACTIVE_ROLES = new Set([
  "link", "button", "menuitem", "textbox", "checkbox", "radio",
  "combobox", "listbox", "option", "tab", "switch", "heading",
  "searchbox", "spinbutton", "slider",
]);

// Read lazily, per call, NOT as module-level constants — a module-level `const X =
// Number(process.env.X ?? d)` caches the value at first import, so a test that sets the env var
// afterward would silently have no effect without vi.resetModules()+re-import. This mirrors
// ir.ts's own MAX_ATTEMPTS/MAX_EXTENSIONS, which are read inside toIR() per call for the same
// reason (tests/irExtensionBudget.test.ts sets process.env.MAX_IR_ATTEMPTS directly, no
// resetModules needed, because of it).
function liteCaps() {
  return {
    elements: Number(process.env.MAX_LITE_ELEMENTS_PER_PAGE ?? 150),
    forms: Number(process.env.MAX_LITE_FORMS_PER_PAGE ?? 5),
    formFields: Number(process.env.MAX_LITE_FORM_FIELDS ?? 20),
    navNodes: Number(process.env.MAX_LITE_NAV_NODES_PER_PAGE ?? 60),
    navDepth: Number(process.env.MAX_LITE_NAV_DEPTH ?? 3),
    buttons: Number(process.env.MAX_LITE_BUTTONS_PER_PAGE ?? 40),
    headings: Number(process.env.MAX_LITE_HEADINGS_PER_PAGE ?? 40),
  };
}

/** Named, interactive-role elements first, then whatever's left fills the remaining budget — a
 *  raw positional slice can silently drop the very login form a case needs to reference if a
 *  large table or content block sits above it in DOM order. */
function capElements(elements: Element[], max: number): Element[] {
  if (elements.length <= max) return elements;
  const isNamed = (e: Element) => !!e.name?.trim() && INTERACTIVE_ROLES.has(e.role?.toLowerCase() ?? "");
  const named = elements.filter(isNamed);
  if (named.length >= max) return named.slice(0, max);
  return [...named, ...elements.filter((e) => !isNamed(e)).slice(0, max - named.length)];
}

/** Breadth AND depth capped via one shared node budget across the whole tree — a flat per-level
 *  breadth cap alone still allows exponential blowup on a deep tree. */
function capNavTree(
  items: NavigationItem[], depth: number, maxDepth: number, budget: { remaining: number },
): NavigationItem[] {
  const out: NavigationItem[] = [];
  for (const item of items) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    out.push({
      ...item,
      children: depth < maxDepth ? capNavTree(item.children ?? [], depth + 1, maxDepth, budget) : [],
    });
  }
  return out;
}

/** Strip elements to role/name/concept only — reduces prompt size 70-90%. Array-length caps on
 *  elements/forms/navigation/buttons/headings keep a rich site (large tables, deep mega-menus)
 *  from producing a 17,000+ line JSON that trips an LLM's context/payload limit — see
 *  ARCHITECTURE.md's "AppModel context explosion" gap. Defaults are calibrated well above every
 *  page observed in this project's own sampled runs, so an ordinary site is unaffected. */
export function toLiteModel(model: AppModel): AppModel {
  const caps = liteCaps();
  return {
    ...model,
    pages: model.pages.map(p => ({
      url: p.url,
      title: p.title,
      concepts: p.concepts,
      elements: capElements(p.elements, caps.elements).map(({ role, name, concept }) => ({ role, name, concept })),
      // Preserve DOM summary fields even in lite model — they're small and useful
      ...(p.forms && p.forms.length > 0 ? {
        forms: p.forms.slice(0, caps.forms).map((f) => ({ ...f, fields: f.fields.slice(0, caps.formFields) })),
      } : {}),
      ...(p.navigation && p.navigation.length > 0 ? {
        navigation: capNavTree(p.navigation, 0, caps.navDepth, { remaining: caps.navNodes }),
      } : {}),
      ...(p.buttons && p.buttons.length > 0 ? { buttons: p.buttons.slice(0, caps.buttons) } : {}),
      ...(p.headings && p.headings.length > 0 ? { headings: p.headings.slice(0, caps.headings) } : {}),
      ...(p.hasSearch !== undefined ? { hasSearch: p.hasSearch } : {}),
      ...(p.hasPagination !== undefined ? { hasPagination: p.hasPagination } : {}),
      ...(p.breadcrumbs && p.breadcrumbs.length > 0 ? { breadcrumbs: p.breadcrumbs } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// MicroModel — strictly compressed context for zero-temperature generation
// ---------------------------------------------------------------------------

export function compressRepetitiveSiblings(elements: Element[]): Element[] {
  const groups = new Map<string, Element[]>();
  const ungrouped: Element[] = [];

  for (const el of elements) {
    if (!el.genericPath) { ungrouped.push(el); continue; }
    // Include name so "Nike Air Max" and "Adidas Ultraboost" stay separate
    const key = `${(el.role ?? "").toLowerCase()}|${el.genericPath}|${(el.name ?? "").toLowerCase().trim()}`;
    const g = groups.get(key);
    if (g) g.push(el); else groups.set(key, [el]);
  }

  const result: Element[] = [...ungrouped];
  for (const [, group] of groups) {
    if (group.length > 5) {
      result.push({
        role: group[0].role,
        name: group[0].name || "items",
        count: group.length,
        compressed: true,
        genericPath: group[0].genericPath,
        pageSection: group[0].pageSection,
      });
    } else {
      result.push(...group);
    }
  }
  return result;
}

/** Origin + path, ignoring query/hash — same as ir.ts pageKey */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname.replace(/\/+$/, "") || "/");
  } catch { return url; }
}

export function toMicroModel(
  model: AppModel,
  opts: { currentPageUrl?: string } = {}
): AppModel {
  const targetPage = opts.currentPageUrl
    ? model.pages.find(p => pageKey(p.url) === pageKey(opts.currentPageUrl!)) ?? model.pages[0]
    : model.pages[0];
  if (!targetPage) return { ...model, pages: [] };

  const compressed = compressRepetitiveSiblings(targetPage.elements);
  const capped = capElements(compressed, 30);

  return {
    baseUrl: model.baseUrl,
    pages: [{
      url: targetPage.url,
      title: targetPage.title,
      concepts: targetPage.concepts,
      elements: capped.map(({ role, name, concept, compressed: c, count }) =>
        ({ role, name, concept, ...(c ? { compressed: c, count } : {}) })),
      ...(targetPage.forms && targetPage.forms.length > 0 ? {
        forms: targetPage.forms.slice(0, 2).map(f => ({
          ...f, fields: f.fields.slice(0, 20),
        })),
      } : {}),
      ...(targetPage.navigation && targetPage.navigation.length > 0 ? {
        navigation: capNavTree(targetPage.navigation, 0, 2, { remaining: 10 }),
      } : {}),
      ...(targetPage.hasSearch !== undefined ? { hasSearch: targetPage.hasSearch } : {}),
    }],
  };
}


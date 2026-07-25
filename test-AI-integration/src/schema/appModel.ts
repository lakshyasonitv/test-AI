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
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  containerRole: z.string().optional(),
  containerName: z.string().optional(),
  pageSection: z.string().optional(), // "main", "nav", "header", "footer", "dialog"
  path: z.array(z.string()).optional(), // ["body", "main", "form", "button"]
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

/** Strip elements to role/name/concept only — reduces prompt size 70-90%. */
export function toLiteModel(model: AppModel): AppModel {
  return {
    ...model,
    pages: model.pages.map(p => ({
      url: p.url,
      title: p.title,
      concepts: p.concepts,
      elements: p.elements.map(({ role, name, concept }) => ({ role, name, concept })),
      // Preserve DOM summary fields even in lite model — they're small and useful
      ...(p.forms && p.forms.length > 0 ? { forms: p.forms } : {}),
      ...(p.navigation && p.navigation.length > 0 ? { navigation: p.navigation } : {}),
      ...(p.buttons && p.buttons.length > 0 ? { buttons: p.buttons } : {}),
      ...(p.headings && p.headings.length > 0 ? { headings: p.headings } : {}),
      ...(p.hasSearch !== undefined ? { hasSearch: p.hasSearch } : {}),
      ...(p.hasPagination !== undefined ? { hasPagination: p.hasPagination } : {}),
      ...(p.breadcrumbs && p.breadcrumbs.length > 0 ? { breadcrumbs: p.breadcrumbs } : {}),
    })),
  };
}

/** Keep only elements whose concept is in the given set (or has no concept — structural). */
export function filterByConcepts(model: AppModel, concepts: string[]): AppModel {
  const set = new Set(concepts);
  return {
    ...model,
    pages: model.pages.map(p => ({
      ...p,
      elements: p.elements.filter(e => !e.concept || set.has(e.concept)),
    })),
  };
}

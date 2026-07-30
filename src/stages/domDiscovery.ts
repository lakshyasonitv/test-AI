/**
 * TypeScript client for the Crawl4AI-based Discovery Service.
 *
 * Calls the Python FastAPI service, receives structured DOM data,
 * and converts it to the existing AppModel format.
 *
 * This is the primary discovery path — replaces the old Playwright+Gemini
 * pipeline for standard pages. Gemini vision becomes a fallback only.
 */

import { AppModel, PageModel, Element } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DISCOVERY_SERVICE_URL = process.env.DISCOVERY_SERVICE_URL || "http://localhost:8000";
const REQUEST_TIMEOUT = 30_000;
const SERVICE_STARTUP_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Auto-start the Python discovery service
// ---------------------------------------------------------------------------

let serviceProcess: ChildProcess | null = null;
let serviceStarting = false;
let serviceStartPromise: Promise<boolean> | null = null;

/**
 * Find the Python executable. Tries python3 first, then python.
 */
function findPythonExecutable(): string {
  // On Windows, try python first (python3 often doesn't exist on Windows)
  return "python";
}

/**
 * Auto-start the Python discovery service if it's not already running.
 * This is a best-effort mechanism — if it fails, the system falls back to vision.
 */
async function ensureServiceRunning(): Promise<boolean> {
  // Already running
  if (serviceAvailable === true) return true;

  // Already starting — wait for it
  if (serviceStarting && serviceStartPromise) {
    return serviceStartPromise;
  }

  serviceStarting = true;
  serviceStartPromise = startService();
  
  try {
    return await serviceStartPromise;
  } finally {
    serviceStarting = false;
  }
}

async function startService(): Promise<boolean> {
  const serviceDir = path.join(process.cwd(), "discovery-service");
  const appPath = path.join(serviceDir, "app.py");

  // Check if the service directory exists
  if (!existsSync(appPath)) {
    console.warn(`[domDiscovery] Discovery service not found at ${appPath}`);
    return false;
  }

  console.log(`[domDiscovery] Starting discovery service from ${serviceDir}`);

  try {
    const python = findPythonExecutable();
    serviceProcess = spawn(python, ["-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"], {
      cwd: serviceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    serviceProcess.on("error", (err) => {
      console.error(`[domDiscovery] Service process error: ${err.message}`);
      serviceAvailable = false;
      serviceProcess = null;
    });

    serviceProcess.on("exit", (code) => {
      console.log(`[domDiscovery] Service process exited with code ${code}`);
      serviceAvailable = false;
      serviceProcess = null;
    });

    // Capture stdout/stderr for debugging
    serviceProcess.stdout?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[discovery-service] ${msg}`);
    });

    serviceProcess.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[discovery-service] ${msg}`);
    });

    // Wait for the service to be ready by polling the health endpoint
    const ready = await waitForServiceReady(SERVICE_STARTUP_TIMEOUT);
    if (ready) {
      console.log(`[domDiscovery] Discovery service started successfully on ${DISCOVERY_SERVICE_URL}`);
      serviceAvailable = true;
      return true;
    } else {
      console.warn(`[domDiscovery] Discovery service failed to start within ${SERVICE_STARTUP_TIMEOUT}ms`);
      serviceAvailable = false;
      return false;
    }
  } catch (err: any) {
    console.error(`[domDiscovery] Failed to start service: ${err?.message ?? err}`);
    serviceAvailable = false;
    return false;
  }
}

/**
 * Poll the health endpoint until the service is ready.
 */
async function waitForServiceReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${DISCOVERY_SERVICE_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) return true;
    } catch {
      // Service not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Response type matching the Python service's CrawlResponse schema
// ---------------------------------------------------------------------------

interface CrawlResponse {
  url: string;
  title: string;
  status_code: number;
  metadata: {
    title: string;
    description: string;
    keywords: string;
    og_title: string;
    og_description: string;
    canonical: string;
    favicon: string;
  };
  markdown: string;
  cleaned_html: string;
  forms: Array<{
    action: string;
    method: string;
    id: string;
    name: string;
    fields: Array<{
      tag: string;
      input_type: string;
      name: string;
      placeholder: string;
      label: string;
      required: boolean;
      value: string;
      options: string[];
      id: string;
      aria_label: string;
    }>;
    aria_label: string;
  }>;
  navigation: Array<{
    text: string;
    href: string;
    children: any[];
    is_dropdown: boolean;
    aria_label: string;
    role: string;
  }>;
  links: Array<{
    text: string;
    href: string;
    title: string;
    aria_label: string;
    is_external: boolean;
    role: string;
  }>;
  buttons: Array<{
    text: string;
    button_type: string;
    aria_label: string;
    disabled: boolean;
    id: string;
    role: string;
  }>;
  headings: Array<{
    level: number;
    text: string;
    id: string;
  }>;
  tables: Array<{
    headers: string[];
    rows: string[][];
    caption: string;
    aria_label: string;
    id: string;
  }>;
  images: Array<{
    src: string;
    alt: string;
    title: string;
    width: number;
    height: number;
  }>;
  interactive_elements: Array<{
    tag: string;
    role: string;
    name: string;
    text: string;
    href: string;
    id: string;
    css_classes: string[];
    aria_label: string;
    aria_role: string;
    visible: boolean;
    enabled: boolean;
    test_id?: string;
    css?: string;
    derived_name?: boolean;
  }>;
  internal_urls: string[];
  external_urls: string[];
  breadcrumbs: string[];
  has_search: boolean;
  has_pagination: boolean;
  has_modal: boolean;
  has_tabs: boolean;
  has_accordion: boolean;
  dom_depth: number;
  accessibility: {
    lang: string;
    title: string;
    landmark_roles: string[];
    aria_landmarks: Array<Record<string, string>>;
    skip_links: string[];
    forms_with_labels: number;
    images_with_alt: number;
    images_total: number;
    heading_order: number[];
  };
  needs_vision: boolean;
  vision_reason: string;
  crawl_time_ms: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Service health check
// ---------------------------------------------------------------------------

let serviceAvailable: boolean | null = null;

export async function checkDiscoveryServiceHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${DISCOVERY_SERVICE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    serviceAvailable = resp.ok;
    return serviceAvailable;
  } catch {
    // Service not running — try to start it
    serviceAvailable = false;
    return ensureServiceRunning();
  }
}

// ---------------------------------------------------------------------------
// Core crawl function
// ---------------------------------------------------------------------------

/**
 * Call the Python Discovery Service to crawl a URL.
 * Returns the raw CrawlResponse from the service.
 */
async function callDiscoveryService(url: string): Promise<CrawlResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const resp = await fetch(`${DISCOVERY_SERVICE_URL}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Discovery service returned ${resp.status}: ${await resp.text()}`);
    }

    return (await resp.json()) as CrawlResponse;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Conversion: CrawlResponse → AppModel
// ---------------------------------------------------------------------------

/**
 * Convert the Python service's structured DOM response into the existing
 * AppModel format that the rest of the pipeline expects.
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
 * Discover a page using the Crawl4AI-based Discovery Service.
 * This is the PRIMARY discovery path — no Gemini vision needed for standard pages.
 *
 * Falls back to null if the service is unavailable or the crawl fails,
 * allowing the caller to fall back to vision-based discovery.
 */
export async function discoverUsingCrawler(url: string): Promise<AppModel | null> {
  // Check cache first
  const cached = cacheGet(`dom:${url}`);
  if (cached) {
    console.log(`[domDiscovery] cache hit for ${url}`);
    return cached;
  }

  // Check if service is available, try to start if not
  if (serviceAvailable === false) {
    // Try to start the service once
    const started = await ensureServiceRunning();
    if (!started) {
      console.log(`[domDiscovery] service unavailable, skipping DOM discovery for ${url}`);
      return null;
    }
  }

  try {
    console.log(`[domDiscovery] calling discovery service for ${url}`);
    const crawlResult = await callDiscoveryService(url);

    if (crawlResult.error) {
      console.warn(`[domDiscovery] crawl error for ${url}: ${crawlResult.error}`);
      return null;
    }

    if (crawlResult.status_code >= 400) {
      console.warn(`[domDiscovery] HTTP ${crawlResult.status_code} for ${url}`);
      return null;
    }

    const appModel = crawlResponseToAppModel(crawlResult);
    console.log(
      `[domDiscovery] converted ${url}: ${appModel.pages[0]?.elements.length ?? 0} elements, ` +
      `${crawlResult.forms.length} forms, ${crawlResult.navigation.length} nav items, ` +
      `${crawlResult.buttons.length} buttons, needs_vision=${crawlResult.needs_vision}`
    );

    // Cache the result
    cacheSet(`dom:${url}`, appModel);

    return appModel;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[domDiscovery] timeout for ${url}`);
      serviceAvailable = false; // Short-circuit future calls
    } else {
      console.warn(`[domDiscovery] error for ${url}: ${err?.message ?? err}`);
    }
    return null;
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

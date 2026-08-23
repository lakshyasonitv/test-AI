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

import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel, AuthOutcome, type AuthStep, Element, PageModel } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";
import { discoverUsingCrawler, extractDomModelFromPage, needsVisionFallback } from "./domDiscovery.js";
import {
  modelFromAria, detectInteractiveElements, formatInteractiveElements, attachElementIdentity,
} from "./discovery.js";
import {
  credentialFieldMap, credentialKindForTarget, redactCredentials,
  type Credentials, type CredentialKind,
} from "./credentials.js";
import { AUTH_VERB, waitForAuthSettle } from "./authSettle.js";
import { runStepLive } from "./liveExtend.js";
import { resolveLive } from "./targetResolver.js";
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
    const { content: raw } = await gemini(user, {
      systemInstruction: system,
      json: true,
      model: process.env.GEMINI_MODEL_LITE,
      imageBase64: screenshotBase64,
      imageMime: screenshotBase64 ? "image/jpeg" : undefined,
      stage: "discovery",
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

/**
 * Logout controls, which every authenticated app puts in its nav. Same-origin and
 * link-shaped, so collectCrawlTargets queues them like any other page — and crawling one
 * mid-run ends the session, making every LATER snapshot anonymous. That degrades silently:
 * the crawl keeps producing non-empty login-page models instead of failing, which is the
 * hardest shape to debug. Matched on URL path (structural), never on link text.
 */
const LOGOUT_PATH = /(^|\/)(logout|log-out|signout|sign-out|logoff|log-off)(\/|$)/i;

/**
 * Own cache namespace, separate from discoverHybrid's bare-URL key: discoverSiteHybrid's
 * result is a different shape (possibly many pages) for the same URL, and sharing a key
 * would let either function silently hand back the other's cached result.
 *
 * The credential discriminator is not optional. An authenticated crawl and an anonymous one
 * produce completely different models for the SAME url, and this cache lives up to
 * APPMODEL_CACHE_TTL_MS (30 min default) — long enough to hand one run's logged-in model to
 * another run that supplied no credentials at all. Same class as TD-22/D-10: a key missing a
 * real input dimension serves a wrong answer for as long as it lives. Hashed rather than
 * interpolated so no credential value is ever part of a key string.
 */
const siteCacheKey = (url: string, creds?: Credentials) => {
  if (!creds) return `site:${url}`;
  const id = crypto.createHash("sha1")
    .update(JSON.stringify([creds.username, creds.password])).digest("hex").slice(0, 12);
  return `site:${url}#auth=${id}`;
};

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

/** Roles a credential can actually be typed into. Mirrors credentials.ts's own FILLABLE_ROLE:
 *  without it, a BUTTON named "Login" matches the identifier pattern and looks like a field. */
const FILLABLE_ROLE = /textbox|searchbox|combobox/i;

/** Ends the session if clicked — the button-shaped counterpart to LOGOUT_PATH. */
const SIGN_OUT_VERB = /^(sign\s*out|log\s*out|logout|signout|log\s*off)$/;

/**
 * Controls that change or destroy state rather than navigate. Discovery is supposed to be a
 * read-only pass over a customer's application, so these are never clicked while probing for
 * routes even though they are anchors.
 *
 * Matching an element's accessible NAME is deliberate and is not the TD-01 failure mode: that
 * warns against regexing LLM-authored or page *prose*. An accessible name is DOM data, and
 * SIGN_OUT_VERB / AUTH_VERB already set this precedent. Anchored, so "Delete" is excluded while
 * "Deleted items" — a legitimate destination — is not.
 */
const DESTRUCTIVE_VERB = /^(reset(\s+app\s+state)?|delete|remove|clear|discard|cancel|deactivate|archive)$/;

/** Upper bound on nav buttons clicked per page while probing an SPA for routes. */
const MAX_CLICK_PROBES = 12;

/**
 * Find where a page's JS-only navigation leads, by clicking it.
 *
 * `collectCrawlTargets` can only follow `href`s. A Next.js/React app routes with
 * `<button onClick={router.push(...)}>` and exposes no href at all — a real dashboard modelled
 * here had `internalUrls: []`, `domLinks: 0`, and twelve buttons. The crawl therefore stopped
 * at one page even after logging in successfully, which looks identical to the auth wall it
 * had just got past. Clicking is the only way to learn those destinations.
 *
 * Two candidate shapes, both provably unreachable via `href` (see the filter below): nav-landmark
 * buttons, and any anchor. Buttons stay scoped to the `nav` landmark — a DOM fact, not a guess
 * about button text — because an unscoped button could be "Delete" or "Add to cart". Anchors need
 * no such scoping: they are semantically navigation, and this only runs when the href pass
 * already returned nothing, so every anchor reaching here is one with no usable destination.
 *
 * ponytail: one click per candidate, re-navigating between each, capped at MAX_CLICK_PROBES.
 * Fine at MAX_DISCOVERY_PAGES scale; if it ever needs to scale, read the router's route table
 * instead of clicking. Known ceiling: an `<a href="#">` wired to a destructive handler would be
 * clicked — sign-out is excluded by name, but "Reset app state" on saucedemo is not.
 */
export async function discoverUrlsByClicking(
  page: Page, pageModel: PageModel, origin: string,
): Promise<string[]> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const candidates = pageModel.elements.filter((el) => {
    if (SIGN_OUT_VERB.test(norm(el.name))) return false;    // would end the session mid-crawl
    if (DESTRUCTIVE_VERB.test(norm(el.name))) return false; // discovery must stay read-only
    // Two shapes, both of which `collectCrawlTargets` provably cannot follow — this only runs
    // when the href pass already came back empty:
    //
    //  - a nav-landmark BUTTON: the Next.js `<button onClick={router.push()}>` sidebar.
    //  - ANY link: an <a> that survived the href pass has no usable destination. saucedemo's
    //    cart is literally `<a class="shopping_cart_link" data-test="shopping-cart-link">` with
    //    no href attribute at all, and its product links are `href="#"`. Anchors are safe to
    //    widen to because they are semantically navigation; buttons stay restricted to `nav`,
    //    since an unscoped button could be "Delete" or "Add to cart".
    const clickable = (/button/i.test(el.role) && el.landmark === "nav") || /link/i.test(el.role);
    if (!clickable) return false;
    const key = `${el.role}|${norm(el.name)}|${el.css ?? ""}`;
    if (seen.has(key)) return false;   // a grid repeats img-link + title-link per product
    seen.add(key);
    return true;
  }).slice(0, MAX_CLICK_PROBES);
  if (!candidates.length) return [];

  const found: string[] = [];
  for (const el of candidates) {
    try {
      // Re-navigate between probes: the previous click moved this page, and it is the CRAWL's
      // page now, not a throwaway. Callers must therefore treat the page as relocated when this
      // returns — `targetsFor` and `snapshot` both begin with their own `goto`, which is what
      // makes that safe.
      if (page.url() !== pageModel.url) {
        await page.goto(pageModel.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(500);
      }
      const before = page.url();
      await (await resolveLive(page, { role: el.role, name: el.name })).click({ timeout: 5000 });
      await page.waitForTimeout(800);
      const after = page.url();
      if (after !== before && new URL(after).origin === origin) found.push(after);
    } catch {
      // Not resolvable, not clickable, or it opened a modal instead of navigating. Either way
      // there's no destination to record — the next candidate is independent of this one.
    }
  }
  if (found.length) {
    console.log(`[hybrid] ${pageModel.url}: no links, found ${found.length} route(s) by clicking nav buttons`);
  }
  return found;
}

/** The visible password box, which is what makes a page a login gate.
 *
 *  `:visible` is load-bearing twice over: hidden honeypot password inputs are a routine
 *  anti-bot pattern, and a "change password" panel elsewhere in the DOM would otherwise
 *  outrank the real one. `:not([disabled])` skips a field the app hasn't enabled yet.
 *
 *  ponytail: first visible match. A page carrying two visible password boxes is a signup or
 *  change-password form, not a login — out of scope by the same rule that says a login gate
 *  has exactly one.
 */
const PASSWORD_INPUT = 'input[type="password"]:visible:not([disabled])';

/** Submit-button text, when the form has no `type="submit"` control to click. Anchored so it
 *  matches a button whose whole label is a login verb, not any button mentioning one. */
const AUTH_VERB_TEXT = /^\s*(sign\s*in|log\s*in|login|authenticate|submit|continue)\s*$/i;

/** True when this page presents a login gate — a live-DOM fact, no model required. */
export async function hasLoginGate(page: Page): Promise<boolean> {
  return await page.locator(PASSWORD_INPUT).count() > 0;
}

/**
 * Log in on a live page so the crawl that follows sees the real application.
 *
 * Why this exists: `collectCrawlTargets` only follows `href`s, and a login is a form SUBMIT,
 * not a link — the crawl could never get past an auth wall on its own, however many pages it
 * was allowed. For an LMS / asset-management / in-house app that meant the whole AppModel was
 * the login page and every generated test was a login test.
 *
 * **Everything here reads the LIVE DOM, never the extracted PageModel.** That is the whole
 * point of this version. The model is lossy in ways that silently defeat login detection:
 * `credentialFieldMap` is built only from `PageModel.forms[]`, and `extractForms` requires a
 * literal `<form>` tag — so a React login that renders bare inputs yields an empty map. The
 * fallback then matches the element's accessible *name* against /pass/i, and on a real site
 * (assettrack-web.onrender.com) that name was the placeholder "••••••••", which matches
 * nothing. Result: no password field found, no login attempted, one-page model, no error.
 * Meanwhile `input[type="password"]` was sitting right there in the DOM.
 *
 * `input[type="password"]` cannot be faked away by a framework, a missing label, or a
 * placeholder-as-name. It is the one universal signal, and it is also less code.
 */
export async function loginOnPage(page: Page, creds: Credentials): Promise<AuthStep[] | null> {
  // One DOM pass picks BOTH fields and the submit control, and returns a unique CSS selector for
  // each. Selectors rather than indices because the result is replayed later — by the grounding
  // replay and by the generated Playwright spec — where "the 2nd input on the page" is not a
  // contract anything can rely on.
  //
  // ponytail: deliberately written with NO inner named/const-assigned functions. Candidate tests
  // are repeated and selector-building runs as one loop over a targets array rather than a helper.
  //
  // That is not style, it is a runtime constraint. `page.evaluate` serializes this function's
  // source and runs it inside the browser, where none of the transpiler's helpers exist — and
  // esbuild (what `tsx` uses, which is how the server actually runs) wraps every *named*
  // function in a `__name(...)` call to preserve `.name`. A factored-out `const visible = ...`
  // therefore throws `ReferenceError: __name is not defined` in the page.
  //
  // It passed every vitest test before this comment existed, because vitest's transform does
  // not inject that helper — the failure only appeared on a real run under tsx. Anything added
  // here must stay helper-free for the same reason.
  const found = await page.evaluate((verbSource: string) => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const visible: boolean[] = [];
    for (const el of inputs) {
      const r = el.getBoundingClientRect();
      visible.push(r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden");
    }

    let pwIdx = -1;
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i].type === "password" && !inputs[i].disabled && visible[i]) { pwIdx = i; break; }
    }
    if (pwIdx < 0) return null;

    // Scope to the password box's own <form> when it has one, so a header search or newsletter
    // field elsewhere on the page can never be mistaken for the identifier. Form-less SPA
    // logins fall back to the document, where proximity is all there is.
    const form = inputs[pwIdx].closest("form");

    // NEAREST candidate above the password box, not the first on the page. Both are genuinely
    // identifier-shaped — a newsletter type="email" really is one — and proximity is what
    // separates them. Same rule credentials.ts already documents, on the live DOM.
    let idIdx = -1;
    for (let i = pwIdx - 1; i >= 0; i--) {
      const t = inputs[i].type;
      if ((t === "email" || t === "text" || t === "tel") && !inputs[i].disabled && visible[i]
        && (!form || inputs[i].closest("form") === form)) { idIdx = i; break; }
    }
    // Only if nothing precedes it, for a reversed layout.
    if (idIdx < 0) {
      for (let i = pwIdx + 1; i < inputs.length; i++) {
        const t = inputs[i].type;
        if ((t === "email" || t === "text" || t === "tel") && !inputs[i].disabled && visible[i]
          && (!form || inputs[i].closest("form") === form)) { idIdx = i; break; }
      }
    }

    // Submit control, cheapest reliable option first, scoped to the login form so a "Subscribe"
    // button above it can never win.
    const scope: ParentNode = form ?? document;
    // HTMLElement, not Element: this module imports a zod type named `Element` which shadows the
    // DOM one inside this callback's type-checking (same trap as the `visible` helper above).
    let submitEl: HTMLElement | null = scope.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
    if (!submitEl) {
      const verb = new RegExp(verbSource, "i");
      for (const b of Array.from(scope.querySelectorAll<HTMLElement>('button, a[role="button"], input[type="button"]'))) {
        const label = (b.textContent ?? (b as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim();
        if (verb.test(label)) { submitEl = b; break; }
      }
    }

    // A unique selector per target, preferring identity the site itself declared.
    //
    // The positional fallback at the end is not optional. learnvibes.vercel.app renders its login
    // inputs with NO id, NO name and NO data-* — only a placeholder — so an attribute-only ladder
    // found nothing for the identifier box or the submit button, filled the password alone, and
    // the login failed. Every rung below exists because some real login had only that rung.
    const targets: (HTMLElement | null)[] = [idIdx >= 0 ? inputs[idIdx] : null, inputs[pwIdx], submitEl];
    const selectors: (string | null)[] = [];
    for (const el of targets) {
      if (!el) { selectors.push(null); continue; }
      const tag = el.tagName.toLowerCase();
      const attempts: string[] = [];
      if (el.id) attempts.push("#" + CSS.escape(el.id));
      for (const a of ["data-test", "data-testid", "data-cy", "name", "placeholder", "aria-label"]) {
        const v = el.getAttribute(a);
        // Skip values carrying a quote or backslash rather than escaping them: a login field
        // with those in its placeholder is not worth the escaping bug, and a later rung covers it.
        if (v && !/["\\]/.test(v)) attempts.push(`${tag}[${a}="${v}"]`);
      }
      // Type is often the only distinguishing thing a login form has.
      const t = el.getAttribute("type");
      if (t && !/["\\]/.test(t)) attempts.push(`${tag}[type="${t}"]`);

      let chosen: string | null = null;
      for (const s of attempts) {
        // Uniqueness is the whole point: a selector matching two nodes is not replayable.
        if (document.querySelectorAll(s).length === 1) { chosen = s; break; }
      }
      if (!chosen) {
        // Unique by construction, so no uniqueness check (and `>> nth=` is Playwright selector
        // syntax, not CSS — querySelectorAll cannot evaluate it anyway). Positional and therefore
        // the most brittle option, which is exactly why it is last.
        const sameTag = Array.from(document.querySelectorAll(tag));
        chosen = `${tag} >> nth=${sameTag.indexOf(el)}`;
      }
      selectors.push(chosen);
    }
    return { user: selectors[0], pass: selectors[1], submit: selectors[2] };
  }, AUTH_VERB_TEXT.source);

  if (!found || !found.pass) return null;

  // Build the record FIRST, then execute exactly what it describes — so what gets replayed later
  // is provably the same thing that worked here, not a re-derivation of it.
  const steps: AuthStep[] = [];
  if (found.user) steps.push({ action: "fill", css: found.user, credential: "username" });
  steps.push({ action: "fill", css: found.pass, credential: "password" });
  steps.push(found.submit
    ? { action: "click", css: found.submit }
    // Native form submit: works on a real <form> with no button at all, which is why it is the
    // last resort rather than an error.
    : { action: "press", css: found.pass, key: "Enter" });

  for (const s of steps) {
    const loc = page.locator(s.css).first();
    if (s.action === "fill") {
      await loc.fill(s.credential === "password" ? creds.password : creds.username, { timeout: 10_000 });
    } else if (s.action === "click") {
      await loc.click({ timeout: 10_000 });
    } else {
      await loc.press(s.key ?? "Enter");
    }
  }

  await waitForAuthSettle(page);
  return steps; // "attempted", not "succeeded" — verifySession is the judge.
}

/**
 * Did the login actually establish a session?
 *
 * The signal is **the login form is gone from the page we are standing on**. Nothing else is
 * reliable across apps:
 *
 * - `page.url() !== urlBefore` (the first version) is wrong both ways — an SPA that renders its
 *   dashboard at the same route reports failure, and `/login -> /login?error=1` reports success.
 * - Re-fetching the reached URL on a fresh page (the second version) is wrong whenever the
 *   reached URL *is* the login route. assettrack-web.onrender.com authenticates in place: the URL
 *   stays `/login` while React swaps the dashboard in, and `/login` keeps rendering a form for a
 *   fresh page load. That produced a `login-failed` verdict on a login that had plainly worked —
 *   the page said "Logged in successfully".
 *
 * A wrong password leaves the form on screen, so it still reports failure correctly.
 *
 * `loginUrl` is passed so the persistence probe can be skipped when the app never navigated. When
 * the app *did* navigate somewhere else, a fresh page on the shared context re-loads that
 * destination — which is the one thing that catches a session that does not survive to the new
 * pages the crawl will open, the exact bug this whole area started with.
 */
export async function verifySession(page: Page, loginUrl: string): Promise<boolean> {
  await page.waitForTimeout(600);
  if (await hasLoginGate(page)) return false; // form still up: rejected, or never submitted

  const reached = page.url();
  if (normUrl(reached) === normUrl(loginUrl)) return true; // in-place auth, nowhere to re-probe

  // Re-load the destination in the SAME tab — which is exactly what every crawl hop does. A
  // fresh page would be the wrong probe: sessionStorage-based auth (assettrack) is per-tab, so
  // a new tab reports failure on a login that genuinely worked and will keep working for the
  // crawl. Re-navigating here still catches a session that does not survive a page load.
  try {
    await page.goto(reached, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(800);
    return !(await hasLoginGate(page));
  } catch {
    return false;
  }
}

/**
 * Discover a whole site, not just the entry page: crawl the entry page's own
 * internal links (same origin, bounded by MAX_DISCOVERY_PAGES) and merge every
 * reachable page into one AppModel. This is what lets a later "not satisfied,
 * focus on X" refinement actually steer — the target feature (Cart, Checkout, ...)
 * is only groundable once its page is in the model.
 *
 * When the entry page presents a login gate, the crawl logs in FIRST and proceeds from the
 * post-login page, so an app behind auth is modelled properly instead of as its own login
 * screen. Credentials come from `creds`, or — when the gate is detected and none were supplied
 * — from `askCredentials`, which is why that ask has to happen here rather than after discovery.
 *
 * Behavior is unchanged for a site whose entry page exposes no crawlable internal
 * links (auth walls, single-page apps): the result is a one-page model, exactly
 * what the old single-page discovery produced.
 */
export async function discoverSiteHybrid(
  url: string,
  creds?: Credentials,
  /** Pre-bound by the orchestrator over runId/url — discovery has neither. Returns null when
   *  the user skips or the prompt times out, which is a `no-credentials` outcome, not an error. */
  askCredentials?: () => Promise<Credentials | null>,
): Promise<AppModel> {
  // The cache lookup CANNOT happen here when askCredentials is in play: the key includes the
  // credential identity and we don't know it yet. Reading with a stale key and writing with the
  // real one means the read and write keys differ on every authenticated run, so nothing ever
  // hits and each run re-pays the whole crawl plus its Gemini labelling. The lookup moves below
  // the gate check, once the credentials are actually resolved.
  if (!askCredentials) {
    const cached = cacheGet(siteCacheKey(url, creds));
    if (cached) return cached;
  }

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
  //
  // `context` is the whole reason an authenticated crawl works. browser.newPage() creates a
  // fresh ANONYMOUS context on every call, so cookies never survive one hop to the next —
  // a login performed on the entry page would be discarded before the second page loaded,
  // and every later snapshot would be the login screen again. One context, reused, keeps the
  // session. (liveExtend.ts:151 documents this exact trap from the other direction.)
  const state: { browser?: Browser; context?: BrowserContext; page?: Page } = {};

  /**
   * ONE page for the entire crawl, reused across every hop.
   *
   * A shared BrowserContext is not enough. assettrack-web.onrender.com keeps its auth in
   * **sessionStorage** (`token`, `user`) with no cookie at all — a mainstream Vite/React
   * pattern — and sessionStorage is scoped to a TAB, not to a context. Opening a page per hop
   * therefore started every hop logged out: verified directly, a second page on the same
   * context came back with empty sessionStorage and the login form.
   *
   * One long-lived tab navigating from URL to URL carries cookies, localStorage AND
   * sessionStorage, so it is both the general answer and the smaller one. Each hop still begins
   * with a full `goto`, so no page state leaks between snapshots — only the session does, which
   * is the entire point.
   */
  const sharedPage = async (): Promise<Page> => {
    state.browser ??= await chromium.launch();
    state.context ??= await state.browser.newContext();
    state.page ??= await state.context.newPage();
    return state.page;
  };

  const snapshot = async (targetUrl: string): Promise<{ appModel: AppModel; finalUrl: string } | null> => {
    const page = await sharedPage();
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

    let entry = await labelPage(entrySnapshot.appModel.pages[0]);
    if (entry.elements.length === 0) {
      // DOM succeeded but found no elements (auth wall, not-yet-hydrated) — still a valid,
      // cacheable result. Without this, every call re-launches Chromium and re-crawls instead
      // of hitting the cache, unlike discoverHybrid's equivalent case.
      cacheSet(siteCacheKey(url, creds), entrySnapshot.appModel);
      return entrySnapshot.appModel;
    }

    // ---- Auth: detect the gate on the LIVE page, get credentials, log in, PROVE it ----
    //
    // Runs on the crawl's own page. entrySnapshot above is a plain value, not a live handle,
    // so navigating away from it here costs nothing.
    let auth: AuthOutcome = { status: "no-gate" };
    let authenticated = false;
    let entryUrlForCrawl = entrySnapshot.finalUrl;
    /** Set only when a login succeeded and the crawl re-rooted off the gate — the gate page is
     *  still put back into the model so login steps stay groundable. */
    let loginPageModel: PageModel | null = null;

    const authPage = await sharedPage();

    // Phase 1 — is there a gate, and where? Kept separate from the login attempt so the cache
    // lookup below can sit between them.
    let gateUrl: string | null = null;
    try {
      await authPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await authPage.waitForTimeout(800);
      if (await hasLoginGate(authPage)) {
        gateUrl = authPage.url();
      } else {
        // The login form is not always on the entry page — a marketing home links to it. One
        // hop only: deeper than that and the site has no conventional login.
        const loginLink = authPage.locator("a, button").filter({ hasText: AUTH_VERB_TEXT }).first();
        if (await loginLink.count() > 0) {
          await loginLink.click({ timeout: 5000 }).catch(() => { });
          await authPage.waitForTimeout(1000);
          if (await hasLoginGate(authPage)) {
            gateUrl = authPage.url();
            console.log(`[hybrid] login form found one hop from the entry page, at ${gateUrl}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[hybrid] gate detection failed: ${err?.message ?? err}`);
    }

    // Phase 2 — resolve credentials. This is the first moment we know a login exists, and it is
    // far earlier than credentialFieldsNeeded(appModel, cases), which needs discovery's output.
    if (gateUrl && !creds && askCredentials) {
      console.log(`[hybrid] login gate at ${gateUrl} — asking for credentials`);
      creds = (await askCredentials()) ?? undefined;
    }

    // Phase 3 — cache. The key includes credential identity, so this is the earliest point it
    // is stable; checking at the top of the function (where it used to be) would read under a
    // different key than it writes, and authenticated runs would never hit. Placed BEFORE the
    // login so a hit skips the real sign-in too, not just the crawl.
    if (askCredentials) {
      const cached = cacheGet(siteCacheKey(url, creds));
      if (cached) {
        console.log(`[hybrid] cache hit for ${url} — skipping login and crawl`);
        return cached;
      }
    }

    // Phase 4 — log in, then prove it.
    if (!gateUrl) {
      auth = { status: "no-gate" };
    } else if (!creds) {
      auth = { status: "no-credentials", url: gateUrl, detail: "A login gate was found but no credentials were supplied." };
      console.warn(`[hybrid] login gate at ${gateUrl} but no credentials — crawling anonymously`);
    } else {
      try {
        const loginSteps = await loginOnPage(authPage, creds);
        authenticated = await verifySession(authPage, gateUrl);
        const reached = authPage.url();
        if (authenticated) {
          auth = { status: "authenticated", url: reached, loginUrl: gateUrl, loginSteps: loginSteps ?? [] };
          console.log(`[hybrid] logged in, crawling from ${reached} instead of the login page`);
          const postLogin = await extractDomModelFromPage(authPage, reached);
          const postLoginPage = postLogin?.pages[0];
          if (postLoginPage && postLoginPage.elements.length > 0) {
            // The login page STAYS in the model. Dropping it is what left the IR with no idea a
            // login existed: the generated spec ran in a fresh browser, /dashboard bounced to
            // /login, and every step after it failed. Keeping it makes the login steps groundable
            // and keeps login-focused test cases possible (testCases.ts caps how many).
            loginPageModel = entry;
            entry = await labelPage(postLoginPage);
            entryUrlForCrawl = reached;
            visited.add(normUrl(reached));
          } else {
            console.warn(`[hybrid] login succeeded but ${reached} produced no elements`);
          }
        } else {
          auth = {
            status: "login-failed", url: reached,
            detail: `Credentials were submitted at ${gateUrl} but ${reached} still shows a password field, so no session was established. Check the values are correct for this site.`,
          };
          console.warn(`[hybrid] login FAILED — ${reached} still shows a password field. Crawling anonymously.`);
        }
      } catch (err: any) {
        auth = { status: "login-failed", url: gateUrl, detail: `Login attempt threw: ${err?.message ?? err}` };
        console.warn(`[hybrid] login attempt failed: ${err?.message ?? err} — crawling anonymously`);
      }
    }

    // Authenticated pages first, login page last: everything downstream that truncates the model
    // to fit a prompt (toLiteModel, toMicroModel, ir.ts's page slicing) drops from the END, and
    // the app is what the tests are supposed to be about. The login page still has to be present
    // — without it the login prefix has nothing to ground against.
    const pages: PageModel[] = loginPageModel ? [entry, loginPageModel] : [entry];
    // Both, not just the crawl root. When login re-roots the crawl onto the dashboard, the
    // login page's own URL would otherwise fall out of `visited` and be crawled again as an
    // ordinary link — re-modelling the one page this whole change exists to get past.
    visited.add(normUrl(entrySnapshot.finalUrl));
    visited.add(normUrl(entryUrlForCrawl));

    // While authenticated, never follow a logout link: it ends the session, and every later
    // snapshot would silently come back as the login page instead of failing outright.
    // collectCrawlTargets still marks them visited, so they can't be re-queued either.
    //
    // Note this tracks the login we DETECTED, not live session state. A site that authenticates
    // without navigating reports failure above, leaving the filter off while the shared context
    // may still hold a cookie — crawling /logout then is harmless, just not optimal.
    const crawlableFrom = (urls: string[]) => {
      const targets = collectCrawlTargets(urls, url, visited);
      if (!authenticated) return targets;
      return targets.filter((t) => {
        try {
          if (!LOGOUT_PATH.test(new URL(t).pathname)) return true;
          console.log(`[hybrid] skipping logout link ${t} — would end the authenticated session`);
          return false;
        } catch {
          return true;
        }
      });
    };

    /**
     * Crawl targets for one page: its `href`s, and — only when those yield nothing — wherever
     * its nav buttons lead. The fallback is what makes an SPA crawlable at all; the ordering
     * keeps it free on an ordinary site, where the href pass already returns everything and no
     * browser clicking happens.
     */
    const targetsFor = async (pageModel: PageModel): Promise<string[]> => {
      const viaLinks = crawlableFrom(pageModel.internalUrls ?? []);
      if (viaLinks.length) return viaLinks;
      const probe = await sharedPage();
      try {
        await probe.goto(pageModel.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await probe.waitForTimeout(800);
        return crawlableFrom(await discoverUrlsByClicking(probe, pageModel, entryOrigin));
      } catch (err: any) {
        console.warn(`[hybrid] click-probe failed for ${pageModel.url}: ${err?.message ?? err}`);
        return [];
      }
    };

    const queue = await targetsFor(entry);
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
      const page = { ...labeled, url: rawPage.url || snap.finalUrl };
      pages.push(page);

      if (pages.length < maxPages) {
        queue.push(...await targetsFor(page));
      }
    }

    // An authenticated crawl typed real credentials into a real browser, and a logged-in app
    // routinely echoes the identifier back ("Signed in as ..."). This model goes to the shared
    // cache under runs/_cache and onward into run artifacts, both publicly served (TD-14) —
    // scrub before anything persists it. No-op unless the credentials are marked `secret`.
    const result = redactCredentials(AppModel.parse({ baseUrl: entryOrigin, pages, auth }), creds);
    // Never cache a failed login. A failure is usually transient — wrong value typed, the site
    // briefly down, a login form that changed — and caching it pins the whole run to a
    // login-page-only model for APPMODEL_CACHE_TTL_MS, so the immediate retry silently gets the
    // same broken answer without even opening a browser. Caught exactly that way: a re-run after
    // fixing the login logged `cache hit — skipping login and crawl` and reported the OLD
    // failure. Successes stay cached; only the failure path pays for a retry.
    if (auth.status === "login-failed") {
      console.warn(`[hybrid] not caching ${url} — login failed, so a retry should try again`);
    } else {
      cacheSet(siteCacheKey(url, creds), result);
    }
    return result;
  } finally {
    await state.context?.close().catch(() => { });
    await state.browser?.close();
  }
}


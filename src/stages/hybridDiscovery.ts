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
import { chromiumLaunchOptions, browserContextOptions } from "../browserLaunch.js";
import { llm, cacheModelDimension } from "../llm/client.js";
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
import { llmCacheGet, llmCacheSet, makeCacheKey, isCacheableResult, llmCacheVersion } from "../kb/llmCache.js";
import { cutAtBoundary, siteHost } from "../text.js";
import { llmCacheDimension } from "../llm/llmContext.js";

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
/** Longest accessible name a single element may contribute to the concept-labeling prompt. */
const LABEL_NAME_MAX = () => {
  const raw = Number(process.env.LABEL_ELEMENT_NAME_MAX_CHARS ?? 200);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
};
/** Ceiling on the whole element list. Comfortably above every non-pathological page measured. */
const LABEL_LIST_MAX = () => {
  const raw = Number(process.env.LABEL_ELEMENTS_MAX_CHARS ?? 40_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40_000;
};

/**
 * The element list for the concept-labeling prompt, bounded on two axes.
 *
 * Exported for the test that replays the real amazon.in AppModel through it — the measurement is
 * the point, and a test that cannot see this function would have to reimplement it.
 *
 * Truncation drops from the END, matching every other prompt-fitting helper in this codebase, so
 * the elements a page declares first (its chrome and primary navigation) are the ones that
 * survive. Original indices are preserved on every line the model sees.
 */
export function capElementsList(elements: Element[]): string {
  const nameMax = LABEL_NAME_MAX();
  const listMax = LABEL_LIST_MAX();

  const lines = elements.map((e, i) => {
    // Collapse whitespace FIRST. This format is one line per element and the model maps its
    // answer back by the `[index]` at the start of each line — so a name containing a newline
    // silently splits one element into several lines, and every index after it reads as
    // belonging to a row that is really the tail of the previous name. Measured on the amazon.in
    // homepage: 229 elements produced 273 lines before this collapse.
    const raw = (e.name ?? "").replace(/\s+/g, " ").trim();
    // A name this long is never a real accessible name — it is page text or CSS that leaked into
    // one. Say so inline rather than silently handing the model a truncated blob it might quote
    // back as an element name.
    const name = raw.length > nameMax ? `${raw.slice(0, nameMax)}… [+${raw.length - nameMax} chars omitted]` : raw;
    return `[${i}] ${e.role} "${name}" (visible: ${e.visible ?? true}, section: ${e.pageSection ?? "body"})`;
  });

  const full = lines.join("\n");
  if (full.length <= listMax) return full;

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > listMax) break;
    kept.push(line);
    used += line.length + 1;
  }
  console.warn(
    `[hybrid] concept-labeling element list truncated: ${full.length} -> ${used} chars ` +
    `(${kept.length}/${lines.length} elements). A page this large usually means an element's ` +
    `name captured page text or CSS — see TECH_DEBT.md TD-73.`,
  );
  return kept.join("\n");
}

async function labelConceptsWithDOM(
  elements: Element[],
  pageTitle: string,
  markdown: string,
  screenshotBase64?: string,
): Promise<{ concepts: string[]; labeledElements: { index: number; concept: string }[] }> {
  // Build a compact element list.
  //
  // "Compact" was aspirational until measured. On run 2026-09-03T11-49-04-132Z-f568ba48
  // (amazon.in) this line produced **797,356 characters from 229 elements** — because an
  // element's accessible name can be an inlined stylesheet. That page's `main` element had a
  // 648,107-character name beginning `.gwm-window-tile:nth-child(9n+1) {background-…`, and two
  // `listitem`s carried 65K and 63K of CSS each. Median name length on the same page: 15.
  // Four elements were 99% of the payload, and the resulting discovery call cost 514,427 prompt
  // tokens — more than every other run in `runs/` combined. See TECH_DEBT.md TD-73.
  //
  // Two independent bounds, because either alone still leaks:
  //   per-name — one runaway element cannot dominate the prompt
  //   total    — a page with thousands of ordinary elements cannot either
  //
  // The ORIGINAL index is preserved on every surviving line: the caller maps the model's answer
  // back with `labeledElements.find(l => l.index === i)` against the unfiltered `page.elements`,
  // so renumbering here would silently label the wrong elements.
  const elementsList = capElementsList(elements);

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
    cacheModelDimension("lite"), llmCacheDimension("lite"), llmCacheVersion()
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
    const { content: raw } = await llm(user, {
      systemInstruction: system,
      json: true,
      role: "lite",
      imageBase64: screenshotBase64,
      imageMime: screenshotBase64 ? "image/jpeg" : undefined,
      stage: "discovery",
    });
    try {
      const parsed = parseJson(raw);
      if (parsed && Array.isArray(parsed.concepts) && Array.isArray(parsed.labeledElements)) {
        if (isCacheableResult(parsed)) llmCacheSet(cacheKey, parsed);
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
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    // Pinned here too even though this is the vision fallback and costs vision tokens: a model
    // reading a screenshot of a differently-localised page produces the same wrong AppModel the
    // DOM path would, and leaving one of the five consumers unpinned is the failure mode
    // browserLaunch.ts's docblock describes.
    const page = await browser.newPage(browserContextOptions());
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
  // `urls[0]` verbatim was wrong twice over: it keeps the entered SCHEME (so a redirected site
  // leaves every page disagreeing with the base — TD-82) and it keeps the PATH, so a base of
  // `http://host/s/` made `resolveHref(base, "/x")` and every page comparison resolve against a
  // page rather than the site. `baseUrl` is contractually an origin.
  let merged: AppModel = { baseUrl: landedOrigin(undefined, urls[0]), pages: [] };
  let normalised = false;

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const model = await discoverHybrid(url);
    // The first page actually fetched is what says where the browser landed; its own model's
    // baseUrl already comes from the crawled (post-redirect) URL.
    if (!normalised && model.pages.length > 0) {
      merged = withLandedBase(merged, model.pages[0].url ?? model.baseUrl, urls[0]);
      normalised = true;
    }
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

/**
 * The origin an AppModel should carry, given where the browser actually LANDED.
 *
 * `baseUrl` is what every relative path downstream resolves against and what pages are compared
 * to, so it must describe where the browser ended up, not what the user typed. A user entering
 * `http://veterans.my.site.com/s/` against a site that redirects to `https://` used to leave the
 * typed scheme in `baseUrl` while every discovered page carried the landed one, and the IR
 * navigate guard then refused a correct step while listing its path as known (TD-82).
 *
 * Also strips any PATH: `baseUrl` is contractually an origin (`resolveHref(baseUrl, "/x")` only
 * behaves if it is), and `discoverPagesHybrid` was passing the full entry URL including its path.
 *
 * Falls back to the entered URL when the landed one cannot be parsed — an unusable base is worse
 * than a stale one.
 */
export function landedOrigin(landedUrl: string | undefined, enteredUrl: string): string {
  for (const candidate of [landedUrl, enteredUrl]) {
    if (!candidate) continue;
    try { return new URL(candidate).origin; } catch { /* try the next */ }
  }
  return enteredUrl;
}

/** Set `baseUrl` to where the browser landed, keeping what the user typed for provenance. */
export function withLandedBase(model: AppModel, landedUrl: string | undefined, enteredUrl: string): AppModel {
  const baseUrl = landedOrigin(landedUrl, enteredUrl);
  const entered = (() => { try { return new URL(enteredUrl).origin; } catch { return enteredUrl; } })();
  if (baseUrl === entered) return { ...model, baseUrl };
  console.log(`[hybrid] entry ${entered} redirected to ${baseUrl} — using the landed origin as baseUrl`);
  return { ...model, baseUrl, enteredUrl };
}

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

/**
 * Keep a snapshot whose HTTP status was an error? — TECH_DEBT.md TD-103.
 *
 * Pure and exported so the rule can be tested without a browser; the crawl's own `snapshot` closure
 * calls it. A client-side-routed app serves one shell and routes in the browser, so a direct GET of
 * an inner route returns 404 while the DOM is entirely correct. Measured on saucedemo, signed in:
 * `GET /cart.html` -> 404 with the real cart in the body (14 elements, a Checkout button);
 * `GET /inventory.html` -> 404 as well. Only `/` is directly fetchable.
 *
 * `clientRouted` is NOT a guess — it means the click-probe already reached this URL by clicking, so
 * the page provably renders. Trusting every 4xx that rendered anything was measured against
 * `qa-practice.com` and admitted `index.html` / `index_v2.html`, genuine dead links whose 404 pages
 * carry one element, which then displaced real pages. An element-count threshold would be a magic
 * number between 1 and 14; provenance is the honest signal.
 */
export function keepErrorStatusSnapshot(
  status: number, renderedElements: number, clientRouted: boolean,
): boolean {
  if (status < 400) return true;
  if (!clientRouted) return false;
  return renderedElements > 0;
}

/**
 * Did this snapshot LAND somewhere already modelled? — the auth-wall bounce, TD-103.
 *
 * The comparison against `target` is load-bearing and was missing. `collectCrawlTargets` adds a URL
 * to `visited` when it QUEUES it, so a bare `visited.has(finalKey)` was true for every URL that does
 * not redirect — the loop threw away every honest page it had just fetched. It only ever appeared to
 * work on sites whose URLs redirect, which is why a link-based crawl looked fine while a
 * click-discovered page could never be added.
 */
export function landedOnAlreadyModelled(
  finalUrl: string, requestedUrl: string, visited: Set<string>,
): boolean {
  const finalKey = normUrl(finalUrl);
  return finalKey !== normUrl(requestedUrl) && visited.has(finalKey);
}

/**
 * Is this discovery result worth REMEMBERING for `APPMODEL_CACHE_TTL_MS`? — TECH_DEBT.md TD-106.
 *
 * `discoverSiteHybrid` had this rule once, for one status:
 *
 *   > Never cache a failed login. A failure is usually transient — wrong value typed, the site
 *   > briefly down, a login form that changed — and caching it pins the whole run to a
 *   > login-page-only model, so the immediate retry silently gets the same broken answer without
 *   > even opening a browser.
 *
 * That argument is right and was applied to `login-failed` alone, while three sibling paths cached
 * results just as transient and just as unusable:
 *
 *  1. **entry page with zero elements** — returns BEFORE the login is even attempted, and its own
 *     comment called the empty model "still a valid, cacheable result". A blank render (a cold
 *     serverless start beyond the 6s hydration poll, a network blip) therefore meant no login
 *     attempt AND thirty minutes of every retry getting the same nothing.
 *  2. **`no-credentials`** — a credential prompt that timed out. The next run might well have
 *     someone there to answer it; the cached login-page-only model means it never gets asked.
 *  3. **`authenticated` with nothing past the login page** — the nastiest, because it claims
 *     success. When the post-login page extracts no elements, `entry` stays the login page and
 *     `loginPageModel` stays unset, so the model is `[loginPage]` with `status: "authenticated"`.
 *     Downstream trusts that, builds a login prefix, and then cannot ground a single step beyond
 *     it — which presents as every case truncating rather than as a login problem.
 *
 * Successes stay cached; only a result a retry could plausibly improve on pays for the retry.
 */
export function discoveryIsWorthCaching(model: AppModel): { ok: true } | { ok: false; reason: string } {
  const status = model.auth?.status;
  if (status === "login-failed") {
    return { ok: false, reason: "the login failed, so a retry should try again" };
  }
  if (status === "no-credentials") {
    return { ok: false, reason: "no credentials were supplied, so a retry should ask again" };
  }
  const total = model.pages.reduce((n, pg) => n + pg.elements.length, 0);
  if (total === 0) {
    return { ok: false, reason: "no elements were found on any page — nothing usable to remember" };
  }
  // Signed in, but every page in the model IS the login page: the post-login extraction came back
  // empty. Compared on the landed URL rather than on page count, because a genuine single-page app
  // behind a login is a legitimate one-page model.
  if (status === "authenticated" && model.auth?.loginUrl) {
    const loginKey = normUrl(model.auth.loginUrl);
    if (model.pages.every((pg) => normUrl(pg.url) === loginKey)) {
      return { ok: false, reason: "signed in but nothing past the login page was captured" };
    }
  }
  return { ok: true };
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
 * Two candidate shapes, both provably unreachable via `href` (see `isCrawlClickCandidate`):
 * nav-landmark buttons, and any anchor. Buttons stay scoped to the `nav` landmark — a DOM fact,
 * not a guess about button text — because an unscoped button could be
 * "Delete" or "Add to cart". Anchors need no such scoping: they are semantically navigation, and
 * this only runs when the href pass already returned nothing, so every anchor reaching here is one
 * with no usable destination.
 *
 * ponytail: one click per candidate, re-navigating between each, capped at MAX_CLICK_PROBES.
 * Fine at MAX_DISCOVERY_PAGES scale; if it ever needs to scale, read the router's route table
 * instead of clicking.
 *
 * KNOWN CEILING, and it is narrower than it reads: `SIGN_OUT_VERB` and `DESTRUCTIVE_VERB` are
 * anchored `^...$`, so they stop a button named exactly "Delete" and admit one named "Delete
 * account". ("Reset app state" IS covered — the regex names it explicitly; an older version of
 * this comment said otherwise.) See `TECH_DEBT.md` TD-105: loosening the anchors is a tradeoff,
 * not a free win, because `^delete` would also start excluding real navigation like
 * "Cancelled orders".
 */
/** `norm` for element names — shared by the candidate filter and its dedupe key. */
const normName = (s: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Is this element worth CLICKING to discover a URL the href pass cannot see?
 *
 * Two shapes, both of which `collectCrawlTargets` provably cannot follow — and this only runs when
 * the href pass already came back empty:
 *
 *  - a NAVIGATION-LANDMARK BUTTON (`nav` or `header`): the Next.js `<button onClick=router.push()>`
 *    sidebar, and a site's cart or menu in its header.
 *  - ANY LINK: an `<a>` that survived the href pass has no usable destination. saucedemo's cart is
 *    `<a class="shopping_cart_link" data-test="shopping-cart-link">` with no href at all, and its
 *    product links are `href="#"`. Anchors are safe to widen to because they are semantically
 *    navigation.
 *
 * `header` COUNTS, NOT JUST `nav` — and the history is worth keeping. That widening shipped ALONE
 * first and changed nothing across four authenticated saucedemo runs, because the page it unlocked
 * was then discarded twice below it: a client-side route 404s on the crawl's re-fetch, and `visited`
 * was poisoned at queue time. See `keepErrorStatusSnapshot` and `landedOnAlreadyModelled`. All three
 * are required; any one alone is a no-op. Measured together: saucedemo 2 -> 3 pages with the cart
 * included, `qa-practice.com` unchanged at 5 real pages. TECH_DEBT.md TD-103.
 *
 * DELIBERATELY NOT widened to landmark-less buttons. That admits the six `Add to cart` buttons, and
 * discovery CLICKING those mutates application state — "Add to cart" is not a destructive *verb*, so
 * `DESTRUCTIVE_VERB` would not catch it and the read-only guarantee would go quietly. Product-detail
 * coverage is a real remaining gap; it needs its own decision about read-only-ness, not a wider
 * regex here.
 *
 * Known ceiling, narrower than it reads: both verb guards are anchored `^...$`, so they stop a
 * control named exactly "Delete" and admit "Delete account". See TD-105 — loosening the anchors is a
 * tradeoff, not a free win, because `^delete` would also exclude real navigation like
 * "Cancelled orders".
 */
export function isCrawlClickCandidate(
  el: { role: string; name: string; landmark?: string },
): boolean {
  if (SIGN_OUT_VERB.test(normName(el.name))) return false;    // would end the session mid-crawl
  if (DESTRUCTIVE_VERB.test(normName(el.name))) return false; // discovery must stay read-only
  // `header` counts as navigation chrome, not just `nav` — a site's cart and menu live there.
  // NECESSARY BUT NOT SUFFICIENT, which is the whole history of TD-103: this shipped alone, did
  // nothing, and was reverted. It only has an effect alongside the two downstream fixes (a 4xx from
  // a click-discovered route is trusted; a page is no longer rejected at dequeue for the `visited`
  // entry its own queueing added). Measured with all three: saucedemo 2 -> 3 pages, the cart
  // included; without any one of them, 2.
  const navish = el.landmark === "nav" || el.landmark === "header";
  return (/button/i.test(el.role) && navish) || /link/i.test(el.role);
}

export async function discoverUrlsByClicking(
  page: Page, pageModel: PageModel, origin: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const candidates = pageModel.elements.filter((el) => {
    if (!isCrawlClickCandidate(el)) return false;
    const key = `${el.role}|${normName(el.name)}|${el.css ?? ""}`;
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
      // Same SITE, not the same origin string. `origin` is the ENTERED origin, and on a site
      // that redirects http -> https every URL a click lands on carries the other scheme — so an
      // origin comparison discarded every destination this function exists to find, and
      // click-based discovery silently returned nothing. TD-82.
      if (after !== before && siteHost(after) === siteHost(origin)) found.push(after);
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
 * How long to wait for a login gate to CLEAR before calling the sign-in failed — TD-107.
 *
 * Matches the generated spec's own assertion budget (`ASSERTION_TIMEOUT_MS`, 10s) on purpose: the
 * spec asks the identical question with `expect(...).toBeHidden()`, and the two disagreeing is the
 * whole defect this constant exists to close.
 */
const AUTH_VERIFY_TIMEOUT_MS = () => Number(process.env.AUTH_VERIFY_TIMEOUT_MS) || 10_000;

/**
 * Wait for the login gate to go away, POLLING — TECH_DEBT.md TD-107.
 *
 * `hasLoginGate` is an instant sample (`count() > 0`), which is correct for DETECTING a gate: the
 * question there is "is there a password box on this page right now". It is wrong for verifying a
 * sign-in, where the question is "has the gate gone yet", and the honest answer takes time.
 *
 * WHY THIS WAS WRONG, measured against a real app. `verifySession` sampled once at +600ms, and once
 * more at +800ms after re-navigating. The generated spec asks the same question with
 * `expect(locator).toBeHidden({ timeout: 10000 })` — which POLLS. On learnvibes.vercel.app, a
 * Supabase app, the spec's login case PASSED while discovery reported `login-failed` on the same
 * credentials in the same session. Supabase keeps its session in `localStorage` and resolves it
 * ASYNCHRONOUSLY on load: after a navigation the app renders its unauthenticated view until
 * `getSession()` settles, then redirects. A single sample lands inside that window; a poll rides
 * through it. The result was a one-page model, every case truncated, and a report that said the
 * login failed when it had plainly worked.
 *
 * Same argument TD-31 already made for element extraction, in the same codebase: *"Poll briefly
 * rather than accept 0 outright — an auth wall costs nothing extra, since it's still correctly 0
 * after polling; a page that only needed more time now gets it."* A genuinely failed login still
 * fails, just at the end of the budget instead of at 600ms.
 */
export async function waitForLoginGateToClear(page: Page, budgetMs = AUTH_VERIFY_TIMEOUT_MS()): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!(await hasLoginGate(page))) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(400);
  }
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
  // POLL, do not sample. The gate clearing is asynchronous on any app that resolves its session
  // after load (Supabase reads localStorage then calls getSession()), so a single check at +600ms
  // reports failure on a login that worked. TD-107.
  if (!(await waitForLoginGateToClear(page))) return false; // form still up: rejected, or never submitted

  const reached = page.url();
  if (normUrl(reached) === normUrl(loginUrl)) return true; // in-place auth, nowhere to re-probe

  // Re-load the destination in the SAME tab — which is exactly what every crawl hop does. A
  // fresh page would be the wrong probe: sessionStorage-based auth (assettrack) is per-tab, so
  // a new tab reports failure on a login that genuinely worked and will keep working for the
  // crawl. Re-navigating here still catches a session that does not survive a page load.
  try {
    await page.goto(reached, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Same poll, and this is the sample that mattered most: a reload is exactly when an app that
    // keeps its session in storage has to re-resolve it, so the unauthenticated view is briefest
    // here and most likely to be caught mid-flight. TD-107.
    return await waitForLoginGateToClear(page);
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
    state.browser ??= await chromium.launch(chromiumLaunchOptions());
    // On the CONTEXT, not on the newPage() below: this site already owns a context deliberately
    // (see the comments above), and the one page it opens must stay the only one for
    // sessionStorage to survive. Options belong wherever the context is created.
    state.context ??= await state.browser.newContext(browserContextOptions());
    state.page ??= await state.context.newPage();
    return state.page;
  };

  /**
   * `clientRouted` — trust a 4xx body for this URL, because the click-probe already PROVED the
   * page renders: it clicked there and the browser displayed it. `TECH_DEBT.md` TD-103.
   *
   * A client-side-routed app serves one shell and routes in the browser, so a direct GET of an
   * inner route returns 404 while the DOM is entirely correct. Measured on saucedemo, signed in:
   * `GET /cart.html` -> **404**, and the body is the real cart ("Your Cart / QTY / Description /
   * 1 Sauce Labs Backpack", 14 elements, a Checkout button). `GET /inventory.html` 404s too — the
   * page the tests actually run against. Only `/` is directly fetchable.
   *
   * NOT unconditional, and this is the whole reason for the flag. Regressing `qa-practice.com`
   * with a blanket "accept any 4xx that rendered something" showed it admitting `index.html` and
   * `index_v2.html` — **genuine dead links** whose 404 pages carry 1 element — which then displaced
   * real pages in the model. An element-count threshold would be a magic number between 1 and 14;
   * provenance is the honest signal. A URL found in an `href` that 404s is a broken link. A URL
   * found by CLICKING cannot be, because the click worked.
   */
  const snapshot = async (
    targetUrl: string, clientRouted = false,
  ): Promise<{ appModel: AppModel; finalUrl: string } | null> => {
    const page = await sharedPage();
    try {
      const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const status = response?.status() ?? 0;
      if (!response) return null;
      // Early-out preserved exactly for the ordinary case: a 4xx from a link is still fatal, and
      // we do not pay for DOM extraction to find that out.
      if (status >= 400 && !clientRouted) return null;
      await page.waitForTimeout(800);
      const finalUrl = page.url();
      const appModel = await extractDomModelFromPage(page, finalUrl);
      const rendered = appModel?.pages?.[0]?.elements.length ?? 0;
      if (!keepErrorStatusSnapshot(status, rendered, clientRouted)) {
        console.log(`[hybrid] ${targetUrl}: ${status} and nothing usable rendered — dead route`);
        return null;
      }
      if (status >= 400) {
        console.log(`[hybrid] ${targetUrl}: ${status} from the server but ${rendered} elements rendered — ` +
          `client-side route, reached by clicking, keeping it`);
      }
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
      // DOM succeeded but found no elements — an auth wall, or a page still not painted after the
      // 6s hydration poll (TD-31). NOT cached: this path returns before the login is even
      // attempted, so remembering it means thirty minutes of retries that never try to sign in.
      // TD-106. The old comment here called it "still a valid, cacheable result"; it is neither.
      const emptyModel = withLandedBase(entrySnapshot.appModel, entrySnapshot.finalUrl, url);
      console.warn(`[hybrid] not caching ${url} — the entry page produced no elements, so a retry should try again`);
      return emptyModel;
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
            // The model is now `[loginPage]` carrying status "authenticated" — a result that claims
            // success and cannot ground a single step past the login. Left as authenticated (the
            // sign-in genuinely worked, and the prefix built from it is valid) but deliberately NOT
            // cacheable: see discoveryIsWorthCaching. TD-106.
            console.warn(`[hybrid] login succeeded but ${reached} produced no elements — the model will `
              + `contain only the login page, and will not be cached`);
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
    /** URLs the click-probe produced, i.e. pages a real click already reached. Consulted by
     *  `snapshot` to decide whether a 4xx body can be trusted — see its docblock. */
    const clickDiscovered = new Set<string>();

    const targetsFor = async (pageModel: PageModel): Promise<string[]> => {
      const viaLinks = crawlableFrom(pageModel.internalUrls ?? []);
      if (viaLinks.length) return viaLinks;
      const probe = await sharedPage();
      try {
        await probe.goto(pageModel.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await probe.waitForTimeout(800);
        const viaClicks = crawlableFrom(await discoverUrlsByClicking(probe, pageModel, entryOrigin));
        for (const u of viaClicks) clickDiscovered.add(u);
        return viaClicks;
      } catch (err: any) {
        console.warn(`[hybrid] click-probe failed for ${pageModel.url}: ${err?.message ?? err}`);
        return [];
      }
    };

    const queue = await targetsFor(entry);
    while (queue.length > 0 && pages.length < maxPages) {
      const target = queue.shift()!;
      const snap = await snapshot(target, clickDiscovered.has(target));
      if (!snap) continue;
      const finalKey = normUrl(snap.finalUrl);
      // Reject only a page that LANDED somewhere already modelled — the auth-wall bounce this
      // guard exists for. `collectCrawlTargets` adds a URL to `visited` when it QUEUES it, so a
      // bare `visited.has(finalKey)` was true for every URL that does not redirect, and the loop
      // threw away every honest page it fetched. It only ever appeared to work on sites whose
      // URLs redirect. TD-103.
      if (landedOnAlreadyModelled(snap.finalUrl, target, visited)) continue;
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
    // Where the browser LANDED, not what was typed — the entry navigation may have redirected
    // (http -> https, apex -> www, a locale prefix). Every relative path, every page comparison
    // and the generated spec's own page.goto all resolve against this. TD-82.
    const result = redactCredentials(
      AppModel.parse(withLandedBase({ baseUrl: entryOrigin, pages, auth }, entrySnapshot.finalUrl, url)),
      creds,
    );
    // Never cache a failed login. A failure is usually transient — wrong value typed, the site
    // briefly down, a login form that changed — and caching it pins the whole run to a
    // login-page-only model for APPMODEL_CACHE_TTL_MS, so the immediate retry silently gets the
    // same broken answer without even opening a browser. Caught exactly that way: a re-run after
    // fixing the login logged `cache hit — skipping login and crawl` and reported the OLD
    // failure. Successes stay cached; only the failure path pays for a retry.
    const worth = discoveryIsWorthCaching(result);
    if (!worth.ok) {
      console.warn(`[hybrid] not caching ${url} — ${worth.reason}`);
    } else {
      cacheSet(siteCacheKey(url, creds), result);
    }
    return result;
  } finally {
    await state.context?.close().catch(() => { });
    await state.browser?.close();
  }
}


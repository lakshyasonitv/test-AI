import type { Page } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel } from "../schema/appModel.js";

/** One interactive element found by the in-page detector below. */
export interface DetectedElement {
  role: string;
  /** Accessible name where one exists, otherwise a name derived from stable attributes. */
  name: string;
  /** True when `name` was derived rather than read from a real accname source. */
  derived: boolean;
  tag: string;
  hasIcon: boolean;
  /** A deterministic CSS selector for this exact element, when one can be built. */
  css: string;
  /** data-test / data-testid / data-qa value, if present. */
  testId: string;
  id: string;
}

/** Raw per-element facts read out of the DOM. Deliberately dumb — see detectInteractiveElements. */
interface RawInteractive {
  tag: string; role: string; ariaLabel: string; innerText: string; title: string;
  alt: string; placeholder: string; value: string; type: string;
  dataTest: string; dataTestid: string; dataQa: string;
  id: string; classes: string[]; href: string; hasIcon: boolean;
}

/** "shopping-cart-link" / "shopping_cart_container" / "btnAddToCart" -> "shopping cart link" */
export function humaniseIdentifier(raw: string): string {
  return raw
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Class tokens that say what an element IS are useful as a name source; styling noise isn't.
const CLASS_NOISE =
  /^(active|disabled|hidden|show|hide|open|closed|selected|first|last|odd|even|col|row|container|wrapper|inner|outer|flex|grid|sm|md|lg|xl|d|p|m|mt|mb|ml|mr|px|py|text|bg|border|rounded|shadow|w|h)([-_]?\d*)$/i;

const cssEscape = (s: string) => s.replace(/["\\]/g, "\\$&");

/** Deterministic selector for one element, most stable attribute first. "" when none exists. */
export function stableSelector(el: {
  dataTest?: string; dataTestid?: string; dataQa?: string; id?: string;
}): string {
  if (el.dataTest) return `[data-test="${cssEscape(el.dataTest)}"]`;
  if (el.dataTestid) return `[data-testid="${cssEscape(el.dataTestid)}"]`;
  if (el.dataQa) return `[data-qa="${cssEscape(el.dataQa)}"]`;
  if (el.id) return `#${cssEscape(el.id)}`;
  return "";
}

/**
 * Readable name for an element that has no accessible name, from its stable attributes.
 * Returns "" when the element is genuinely unaddressable and should be skipped.
 */
export function deriveElementName(el: {
  dataTest?: string; dataTestid?: string; dataQa?: string;
  id?: string; classes?: string[]; href?: string;
}): string {
  const attr = el.dataTest || el.dataTestid || el.dataQa || el.id;
  if (attr) return humaniseIdentifier(attr);
  const cls = (el.classes ?? []).find(c => c.length > 2 && !CLASS_NOISE.test(c));
  if (cls) return humaniseIdentifier(cls);
  const href = el.href ?? "";
  if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
    const leaf = (href.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "")
      .replace(/\.[a-z]{2,5}$/i, "");
    if (leaf) return humaniseIdentifier(leaf);
  }
  return "";
}

/**
 * Find every interactive element on the page, including the ones the accessibility tree
 * cannot express.
 *
 * Playwright's ariaSnapshot() reports only what the a11y tree exposes, and an element with
 * no accessible name and no text content is simply absent from it. saucedemo's cart is
 * exactly that shape — `<a class="shopping_cart_link" data-test="shopping-cart-link"
 * href="cart.html">` with a CSS background-image — so the cart was invisible to the whole
 * pipeline and every test needing it truncated. Icon-only controls (cart, close, search,
 * hamburger, pagination arrows) are common, so this is a general capability.
 *
 * The in-page half only reads attributes: no helper functions are declared inside
 * page.evaluate, because the bundler rewrites named functions with a `__name` helper that
 * does not exist in the browser context. Naming logic lives in Node, where it is also
 * directly unit-testable.
 */
export async function detectInteractiveElements(page: Page): Promise<DetectedElement[]> {
  const raw: RawInteractive[] = await page.evaluate(() => {
    // Things that are controls by virtue of their tag or role.
    const CONTROLS = [
      'button',
      // Bare `a`, not `a[href]`. saucedemo's cart is literally
      // `<a class="shopping_cart_link" data-test="shopping-cart-link"></a>` — no href at
      // all, navigation happens in a React onClick handler. Requiring href skipped it.
      'a',
      'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
      '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
      '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    // An element the author tagged with a test hook is something a test should be able to
    // target, regardless of tag or accessible name — but these also tag layout containers,
    // so they're filtered below.
    const HOOKS = '[data-test], [data-testid], [data-qa]';
    const SELECTORS = CONTROLS + ', ' + HOOKS;

    const out: any[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTORS))) {
      const h = el as HTMLElement;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      // Visibility via geometry + computed style. NOT offsetParent: that returns null for
      // any position:fixed element, which silently excludes the fixed headers where cart /
      // search / menu controls usually live.
      let visible = false;
      try {
        const cs = getComputedStyle(h);
        const r = h.getBoundingClientRect();
        visible = r.width > 0 && r.height > 0 &&
          cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
      } catch { /* detached node */ }
      if (!visible) continue;

      // Icons are often a CSS background or ::before glyph on the element itself, not a
      // child <svg>/<img> — the child-only check missed exactly the elements that most
      // need a screenshot to interpret.
      let hasIcon = el.querySelector('svg, img, [class*="icon"], [class*="Icon"]') !== null;
      if (!hasIcon) {
        try {
          const cs = getComputedStyle(h);
          const before = getComputedStyle(h, '::before');
          hasIcon =
            (!!cs.backgroundImage && cs.backgroundImage !== 'none') ||
            (before.content !== 'none' && before.content !== '""' && before.content !== 'normal');
        } catch { /* detached node */ }
      }

      // A layout wrapper that merely carries a test hook is not a control. Without this,
      // `[data-test="cart-contents-container"]` came back as an "element" whose name was
      // the entire cart contents.
      const isControl = el.matches(CONTROLS);
      if (!isControl && el.querySelector(CONTROLS) !== null) continue;

      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        ariaLabel: (el.getAttribute('aria-label') || '').trim(),
        // Collapse whitespace: a multi-line innerText makes an unusable element name.
        innerText: (h.innerText || '').replace(/\s+/g, ' ').trim(),
        title: (el.getAttribute('title') || '').trim(),
        alt: (el.getAttribute('alt') || '').trim(),
        placeholder: ((el as HTMLInputElement).placeholder || '').trim(),
        value: ((el as HTMLInputElement).value || '').trim(),
        type: el.getAttribute('type') || '',
        dataTest: (el.getAttribute('data-test') || '').trim(),
        dataTestid: (el.getAttribute('data-testid') || '').trim(),
        dataQa: (el.getAttribute('data-qa') || '').trim(),
        id: (el.getAttribute('id') || '').trim(),
        classes: Array.from(h.classList),
        href: el.getAttribute('href') || '',
        hasIcon,
      });
    }
    return out;
  });

  const results: DetectedElement[] = [];
  const seen = new Set<string>();

  for (const r of raw) {
    // Real accessible-name sources first. <input type=submit value="Login"> exposes
    // `value` as its accessible name.
    let name = r.ariaLabel || r.innerText || r.title || r.alt || r.placeholder || "";
    if (!name && /^(submit|button|reset)$/i.test(r.type)) name = r.value;

    let derived = false;
    if (!name) {
      name = deriveElementName(r);
      if (!name) continue;   // genuinely unaddressable
      derived = true;
    }
    if (name.length > 100) name = name.slice(0, 100) + "...";

    let role = r.role;
    if (!role) role = r.tag === "a" ? "link" : (r.tag === "button" || r.tag === "input") ? "button" : "generic";

    const css = stableSelector(r);
    const testId = r.dataTest || r.dataTestid || r.dataQa;

    // Dedupe on identity, not on name: the old key was `role:name:tag`, so with an empty
    // name EVERY unnamed link collapsed into one entry and the cart was whichever came first.
    const key = css || `${role}:${name}:${r.tag}:${results.length}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ role, name, derived, tag: r.tag, hasIcon: r.hasIcon, css, testId, id: r.id });
  }

  return results;
}

/**
 * The detector's output formatted as a text block to append to an ARIA snapshot.
 * `modelFromAria`'s prompt documents this "Interactive elements found on page" section.
 */
export function formatInteractiveElements(elements: DetectedElement[]): string {
  if (elements.length === 0) return '';

  // Count repeats so the model is told which names are ambiguous. Six identical
  // "Add to cart" buttons produced Playwright strict-mode violations because the IR
  // addressed them by name with no nth.
  const counts = new Map<string, number>();
  for (const el of elements) {
    const k = `${el.role.toLowerCase()}|${el.name.toLowerCase()}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const lines = elements.map(el => {
    const iconNote = el.hasIcon ? ' [has-icon]' : '';
    const namePart = el.name ? ` "${el.name}"` : ' [no-label]';
    // Tell the model the name is synthetic so it doesn't present it as visible UI text,
    // and hand it the stable selector so the AppModel can carry it downstream.
    const derivedNote = el.derived ? ' [derived-name]' : '';
    const idNote = el.testId ? ` [testid=${el.testId}]` : el.id ? ` [id=${el.id}]` : '';
    const n = counts.get(`${el.role.toLowerCase()}|${el.name.toLowerCase()}`) ?? 1;
    const dupNote = n > 1 ? ` [x${n}-requires-nth]` : '';
    return `- ${el.role}${namePart}${iconNote}${derivedNote}${idNote}${dupNote}`;
  });

  return `\nInteractive elements found on page:\n${lines.join('\n')}`;
}



const normalizeName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Copy the deterministic identity (css / testId / id) the in-page detector found onto the
 * matching elements of an LLM-produced AppModel.
 *
 * The LLM gives us role + name; only the detector knows the stable selector. Without this
 * an element whose name was DERIVED (e.g. "shopping cart link") is unlocatable, because
 * getByRole('link', { name: 'shopping cart link' }) matches nothing — the accessible name
 * is empty, which is why the name had to be derived in the first place.
 */
export function attachElementIdentity(model: AppModel, detected: DetectedElement[]): AppModel {
  if (!detected.length) return model;

  // Group by role+name. A key matching MORE THAN ONE detected element is ambiguous: the six
  // "Add to cart" buttons on a product grid each have their own selector
  // ([data-test="add-to-cart-sauce-labs-backpack"], ...-fleece-jacket, ...), so attaching
  // "the first one" to all of them makes every add-to-cart click add the *backpack*.
  // For ambiguous names we attach nothing and let the existing role+name+nth path handle it.
  const groups = new Map<string, DetectedElement[]>();
  for (const d of detected) {
    const key = `${d.role.toLowerCase()}|${normalizeName(d.name)}`;
    const g = groups.get(key);
    if (g) g.push(d); else groups.set(key, [d]);
  }
  const byKey = new Map<string, DetectedElement>();
  for (const [key, g] of groups) if (g.length === 1) byKey.set(key, g[0]);

  return {
    ...model,
    pages: model.pages.map(p => ({
      ...p,
      elements: p.elements.map(e => {
        const hit = byKey.get(`${e.role.toLowerCase()}|${normalizeName(e.name)}`);
        if (!hit) return e;
        return {
          ...e,
          ...(hit.testId && !e.testId ? { testId: hit.testId } : {}),
          ...(hit.id && !e.id ? { id: hit.id } : {}),
          ...(hit.css ? { css: hit.css } : {}),
        };
      }),
    })),
  };
}

/**
 * Turn an accessibility snapshot of a single page into an AppModel via the LLM. Shared by
 * the vision fallback in hybridDiscovery.ts (fresh page load) and the live-replay extender
 * (a page reached only after replaying a login/prefix), so both label pages with the exact
 * same anti-hallucination prompt. Retries once on schema-validation failure.
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
- Every element you output must come from the accessibility snapshot or the interactive elements list given to you. Never invent an element, role, or name that isn't literally present in those sources — a screenshot, if given, is ONLY for identifying which element is which; it is never a basis for adding an element the snapshot doesn't contain.
- The snapshot may include an "Interactive elements found on page" section listing clickable elements detected via JavaScript. Include these elements in your output — they are real clickable elements on the page that may have been missed by the accessibility snapshot. For elements marked [has-icon], use the screenshot (if provided) to determine the icon's meaning and assign an appropriate concept. For elements marked [no-label], use the screenshot to infer what the element does and assign a descriptive name based on its visual appearance.
- An element marked [derived-name] has NO accessible name; the name shown was derived from its test id, element id, or CSS class (e.g. a cart icon appearing as "shopping cart link"). ALWAYS include these elements — they are frequently the most important controls on the page (cart, checkout, close, search, menu). Keep the derived name as-is unless the screenshot clearly shows a better one; a later stage locates them by their id, not by name, so the name only has to be recognisable to a human.
- Markers like [has-icon], [derived-name], [testid=...] and [id=...] are metadata for you — never include the marker text itself in an element's "name".
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
${screenshotBase64 ? "\nA screenshot of this exact page is attached — use it to label elements more accurately, especially icon-only buttons and unlabeled interactive elements, per the rules above." : ""}

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

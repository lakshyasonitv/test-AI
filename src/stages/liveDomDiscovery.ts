/**
 * Live-DOM element enumeration — discovery that looks at the real page instead of a string.
 *
 * The cheerio path (`domExtract.ts`, fed by `page.content()`) parses a serialized HTML STRING.
 * That string has no computed style, so `visible` arrives hardcoded `true`; and form-extracted
 * elements carry no `css`, so `recheckVisibility` (domDiscovery.ts) can never correct them. That
 * pair is the Salesforce login bug: a hidden password-mirror input entered the model as visible
 * with no `css`, grounding accepted it, and `resolveCode` fell past its `t.css` branch to a
 * `field()` hint that resolved to nothing at run time. `page.content()` also never serializes a
 * shadow root, so anything rendered inside one was invisible to discovery altogether.
 *
 * This module walks the LIVE document — light DOM, then every OPEN shadow root, in the order
 * Playwright's getByRole returns them — and returns the existing `Element[]` shape, with, for
 * every element:
 *   - `name` computed from the accessible-name sources in accname order — never the HTML `name`
 *     attribute (see the precedence comment in domDiscovery.ts for what that broke on saucedemo);
 *   - `visible` measured with the same geometry + computed-style predicate `recheckVisibility`
 *     uses — deliberately NOT `offsetParent`, which is null for `position: fixed`;
 *   - a `css` selector that matches exactly that one element. Most stable attribute first; a
 *     positional path only when nothing stable exists (decided 2026-10-09).
 *
 * SHADOW DOM — what was measured, against the pinned Playwright 1.49.0 (D-19), not read in docs:
 *   - Playwright's CSS engine pierces open shadow roots, but `document.querySelectorAll` does not.
 *     A light `<button id="dup">` plus a shadow `<button id="dup">`: the DOM counts `#dup` once,
 *     Playwright counts it TWICE. So on a page with any shadow root, an in-page uniqueness check
 *     proves nothing about what the generated spec will match.
 *   - `host >> inner` (Playwright's documented chain) resolves inside the host's shadow tree,
 *     nested chains work, and `:scope` in the inner part is the host itself.
 *   - Playwright's `>` combinator ALSO crossed a shadow boundary in 1.49 (`#host > button` hit the
 *     shadow button). Not relied on: it is engine behaviour, not a documented contract, and the
 *     `>>` chain is.
 *   - Closed shadow roots are unreachable from page script by design; their content is not
 *     enumerated. A known limit, not a bug.
 * Hence: shadow elements get `>>` chains, and whenever the walk met a shadow root EVERY element's
 * selector candidates are verified through Playwright itself (`verifyWithPlaywright`). A page
 * with no shadow root keeps the in-page check, which is exact there.
 *
 * IFRAMES: `enumerateLiveElements` also walks every SAME-ORIGIN iframe (recursively) with the same
 * code, tagging its elements with `frame` — the `" >>> "`-joined selectors of the <iframe>
 * elements leading to it, each verified through Playwright in its parent frame. Grounding copies
 * that onto `Target.frame`, and `resolveCode`/the generator wrap the locator in
 * `page.frameLocator(...)`. Cross-origin frames are skipped.
 *
 * Nothing here reads DISCOVERY_LIVE_DOM — the strategy switch in domDiscovery.ts does.
 */

import type { Frame, JSHandle, Page } from "playwright";
import type { Element } from "../schema/appModel.js";
import { deriveElementName } from "./discovery.js";

/** One element as the in-page walk reports it, before Node-side naming fallbacks. */
export interface LiveRawElement {
  tag: string;
  role: string;
  /** Accessible name, or "" when no accessible-name source produced one. */
  name: string;
  /** Which source produced `name`; "" when `name` is "". */
  nameSource: string;
  /** Short visible text immediately before a field — only filled when `name` is "". */
  proximity: string;
  visible: boolean;
  enabled: boolean;
  /** The chosen selector; "" when no candidate could be verified. */
  css: string;
  /** Every selector candidate, ladder order, already prefixed with the shadow-host chain. */
  candidates: string[];
  /** True when the element lives inside an open shadow root. */
  inShadow: boolean;
  /** Same-origin iframe path (`Target.frame` format); "" for the top-level document. */
  frame: string;
  dataTest: string;
  dataTestid: string;
  dataQa: string;
  id: string;
  classes: string[];
  href: string;
  genericPath: string;
  /** Name of the open dialog/modal the element sits in (walking out through shadow hosts), or null
   *  when it is not inside one. "" means inside a dialog that has no accessible name. */
  dialogName: string | null;
}

/** What the in-page walk hands back: the facts, the nodes they describe, and whether any
 *  shadow root was met (which decides whether Playwright must re-verify every selector). */
interface WalkResult {
  items: LiveRawElement[];
  nodes: unknown[];
  hasShadow: boolean;
  /** Selector candidates for every <iframe>/<frame> element met, and the elements themselves —
   *  so a child Frame can be matched to its element and given a verified selector. */
  frameEls: Array<{ candidates: string[] }>;
  frameNodes: unknown[];
}

/** Elements the walk enumerates. Mirrors the cheerio extractor's union (domExtract.ts
 *  `extractInteractiveElements` + headings), so the live model never has FEWER kinds of
 *  element than the static one — only more accurate ones. */
export const LIVE_ELEMENT_SELECTOR = "a, button, input, select, textarea, [role], h1, h2, h3, h4, h5, h6";

/** Longest text accepted as a proximity label — the same bound domExtract.ts uses. */
const MAX_PROXIMITY_LABEL = 60;

/**
 * Walk the live DOM and return the raw per-element facts, each with a verified `css` (or "").
 * Exported for tests; production code calls `enumerateLiveElements`.
 */
export async function walkLiveDom(page: Page | Frame): Promise<LiveRawElement[]> {
  const { items, handle } = await walkOneDocument(page);
  await handle.dispose();
  return items;
}

/**
 * Walk ONE document (a page's main frame, or one iframe's) and keep the result handle alive, so
 * the caller can still match that document's <iframe> elements against Playwright's child frames.
 * The caller disposes the handle.
 */
async function walkOneDocument(page: Page | Frame): Promise<{ items: LiveRawElement[]; handle: JSHandle<WalkResult>; frameEls: Array<{ candidates: string[] }> }> {
  // <live-walk> — the source between these markers runs INSIDE THE BROWSER.
  //
  // ponytail: deliberately written with NO inner named or const-assigned functions, and no
  // callbacks at all — plain loops and an explicit stack, with small pieces of logic repeated
  // where a helper would have been natural. That is not style, it is a runtime constraint
  // (TECH_DEBT.md TD-40): `page.evaluate` serializes this function's source and runs it in the
  // page, where none of the transpiler's helpers exist, and esbuild (what `tsx` uses, which is how
  // the server actually runs) wraps every named function in `__name(...)` to preserve `.name`. A
  // factored-out `const escape = ...` throws `ReferenceError: __name is not defined` in the page —
  // and passes every vitest run, because vitest's transform does not inject that helper. The same
  // warning sits on the callbacks in hybridDiscovery.ts and discovery.ts.
  // tests/liveDomDiscovery.test.ts runs this module under real `tsx` to catch a regression.
  const handle = await page.evaluateHandle(
    ({ selector, maxProximity }) => {
      const items: Array<{
        tag: string; role: string; name: string; nameSource: string; proximity: string;
        visible: boolean; enabled: boolean; css: string; candidates: string[]; inShadow: boolean;
        dataTest: string; dataTestid: string; dataQa: string; id: string; classes: string[];
        href: string; genericPath: string; frame: string; dialogName: string | null;
      }> = [];
      const nodes: HTMLElement[] = [];
      const frameEls: Array<{ candidates: string[] }> = [];
      const frameNodes: HTMLElement[] = [];
      let hasShadow = false;
      const NATIVE = ["a", "button", "input", "select", "textarea"];
      const BUTTON_INPUTS = ["submit", "button", "reset", "image"];
      const CONTROL_TAGS = ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "FORM"];

      // Scope by scope: the document's light DOM first, then each OPEN shadow root, depth-first
      // over roots (a root nested in another comes before the next sibling host's root). That is
      // the order Playwright's getByRole and plain-selector queries return — MEASURED against the
      // pinned 1.49.0, not assumed: a composed-tree walk (shadow content at its host's position)
      // disagreed, and so does Playwright's own order for a comma-list selector. getByRole's is
      // the one that matters: it is the fallback `nth` indexes when no css verifies, and the
      // model's order is what the IR's `nth` counts. Within a scope, a native
      // `querySelectorAll("*")` gives tree order and never enters a shadow root.
      // Parallel stacks rather than an object per entry: the scope root, and the `>>` chain of
      // host selectors that leads to it.
      const scopes: Array<Document | ShadowRoot> = [document];
      const scopeChains: string[] = [""];

      while (scopes.length) {
        const scope = scopes.pop() as Document | ShadowRoot;
        const chain = scopeChains.pop() as string;
        const inShadow = chain !== "";
        const all = scope.querySelectorAll("*");
        const childScopes: ShadowRoot[] = [];
        const childChains: string[] = [];

        for (let ei = 0; ei < all.length; ei++) {
          const el = all[ei] as HTMLElement;
          const isTarget = el.matches(selector);
          const shadow = el.shadowRoot; // null for a CLOSED root — unreachable by design
          // An <iframe> is never a target itself, but needs a selector so a frameLocator can
          // reach the document inside it.
          const isFrameEl = el.tagName === "IFRAME" || el.tagName === "FRAME";
          if (!isTarget && !shadow && !isFrameEl) continue;

          const tag = el.tagName.toLowerCase();

          // ---- selector candidates, relative to this element's scope, most stable first --------
          // Computed for targets AND for shadow hosts, which need a selector to start the `>>`
          // chain for everything inside them. A candidate is kept only when it is unique WITHIN
          // the scope (native check); cross-scope uniqueness is Playwright's to confirm.
          const scoped: string[] = [];
          const attrCands: Array<[string, string, string]> = [
            ["", "data-test", el.getAttribute("data-test") || ""],
            ["", "data-testid", el.getAttribute("data-testid") || ""],
            ["", "data-qa", el.getAttribute("data-qa") || ""],
            ["#", "", el.id],
            [tag, "name", el.getAttribute("name") || ""],
            [tag, "aria-label", el.getAttribute("aria-label") || ""],
          ];
          for (let k = 0; k < attrCands.length; k++) {
            const prefix = attrCands[k][0];
            const attrName = attrCands[k][1];
            const value = attrCands[k][2];
            if (!value) continue;
            // Inside a double-quoted CSS string only backslash, the quote and newlines need
            // escaping. A plain id stays `#id`; an id that would need identifier escapes takes the
            // quoted `[id="…"]` form instead, because Playwright 1.49's own selector parser throws
            // on some escaped identifiers the browser accepts (`#\-`, id "-") — the same rule as
            // stableSelector in discovery.ts (LS-4).
            const quoted = "\"" +
              value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ") + "\"]";
            const cand = prefix === "#"
              ? (CSS.escape(value) === value ? "#" + value : "[id=" + quoted)
              : prefix + "[" + attrName + "=" + quoted;
            try {
              const hits = scope.querySelectorAll(cand);
              if (hits.length === 1 && hits[0] === el) scoped.push(cand);
            } catch { /* an unparseable candidate is skipped, never fatal */ }
          }
          // Positional fallback: tag + :nth-of-type up to the scope's top, anchored at the
          // nearest ancestor whose id is unique in the scope. In the document the path starts at
          // <body>; in a shadow tree it starts at `:scope >`, which in a `>>` chain is the host.
          {
            const segs: string[] = [];
            let node: HTMLElement | null = el;
            let anchored = false;
            while (node && node !== document.documentElement) {
              const nt = node.tagName.toLowerCase();
              if (node !== el && node.id) {
                // Same plain-or-quoted rule as the id candidate above.
                const anchor = CSS.escape(node.id) === node.id
                  ? "#" + node.id
                  : "[id=\"" + node.id.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ") + "\"]";
                let unique = false;
                try { unique = scope.querySelectorAll(anchor).length === 1; } catch { unique = false; }
                if (unique) { segs.unshift(anchor); anchored = true; break; }
              }
              if (!inShadow && nt === "body") { segs.unshift("body"); anchored = true; break; }
              let seg = nt;
              const parent: HTMLElement | null = node.parentElement;
              // A shadow tree's top-level elements have no parentElement; their siblings are the
              // shadow root's children.
              const sibs = parent ? parent.children : (node.parentNode as ShadowRoot | null)?.children;
              if (sibs) {
                let sameTag = 0;
                let pos = 0;
                for (let k = 0; k < sibs.length; k++) {
                  if (sibs[k].tagName === node.tagName) {
                    sameTag++;
                    if (sibs[k] === node) pos = sameTag;
                  }
                }
                if (sameTag > 1) seg += ":nth-of-type(" + pos + ")";
              }
              segs.unshift(seg);
              node = parent;
            }
            if (inShadow && !anchored) segs.unshift(":scope");
            const cand = segs.join(" > ");
            if (inShadow) {
              // `:scope` means nothing to a native ShadowRoot query, so this one is checked by
              // Playwright only (every selector is, once a shadow root has been seen).
              scoped.push(cand);
            } else {
              try {
                const hits = scope.querySelectorAll(cand);
                if (hits.length === 1 && hits[0] === el) scoped.push(cand);
              } catch { /* skipped */ }
            }
          }
          const candidates: string[] = [];
          for (let k = 0; k < scoped.length; k++) candidates.push(inShadow ? chain + " >> " + scoped[k] : scoped[k]);

          if (isFrameEl) {
            frameEls.push({ candidates });
            frameNodes.push(el);
          }
          if (shadow) {
            hasShadow = true;
            // Without a selector for the host, nothing inside it can be addressed; skip it rather
            // than enumerate elements no spec could ever reach.
            if (candidates.length) {
              childScopes.push(shadow);
              childChains.push(candidates[0]);
            }
          }
          if (!isTarget) continue;

          const typeAttr = (el.getAttribute("type") || "").trim().toLowerCase();
          const isNative = NATIVE.indexOf(tag) !== -1;
          const isField = tag === "input" || tag === "select" || tag === "textarea";

          // A type=hidden input is not in the accessibility tree and never user-addressable.
          // (The cheerio loop emitted these as "textbox" named by their `name` attribute.)
          if (tag === "input" && typeAttr === "hidden") continue;

          // ---- role: explicit (first token) beats implicit -------------------------------------
          let role = (el.getAttribute("role") || "").trim().split(/\s+/)[0] || "";
          if (role === "presentation" || role === "none" || role === "img") {
            // Parity with the cheerio [role] pass, which skips these on non-native elements.
            // A native control keeps its implicit role: browsers ignore role=none on focusables.
            if (!isNative) continue;
            role = "";
          }
          if (!role) {
            if (tag === "a") role = "link";
            else if (tag === "button") role = "button";
            else if (tag === "select") role = "combobox";
            else if (tag === "textarea") role = "textbox";
            else if (tag.length === 2 && tag[0] === "h") role = "heading";
            else if (tag === "input") {
              if (BUTTON_INPUTS.indexOf(typeAttr) !== -1) role = "button";
              else if (typeAttr === "checkbox") role = "checkbox";
              else if (typeAttr === "radio") role = "radio";
              else if (typeAttr === "range") role = "slider";
              else if (typeAttr === "number") role = "spinbutton";
              else if (typeAttr === "search") role = "searchbox";
              else role = "textbox";
            }
          }
          if (!role) continue;

          // ---- accessible name, accname order; the HTML `name` attribute is never a source ------
          let name = "";
          let nameSource = "";
          const labelledBy = (el.getAttribute("aria-labelledby") || "").trim();
          if (labelledBy) {
            const ids = labelledBy.split(/\s+/);
            let acc = "";
            for (let k = 0; k < ids.length; k++) {
              // IDREFs resolve within the element's own tree — the shadow root, not the document.
              const ref = scope.getElementById(ids[k]);
              if (ref) acc += " " + (ref.textContent || "");
            }
            name = acc.replace(/\s+/g, " ").trim();
            if (name) nameSource = "aria-labelledby";
          }
          if (!name) {
            name = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            if (name) nameSource = "aria-label";
          }
          if (!name && isField) {
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length) {
              let acc = "";
              for (let k = 0; k < labels.length; k++) {
                let t = labels[k].textContent || "";
                // A control nested inside its <label> contributes its own text (a <select>'s
                // options, most often) — that is not part of the label.
                if (labels[k].contains(el)) t = t.replace(el.textContent || "", " ");
                acc += " " + t;
              }
              name = acc.replace(/\s+/g, " ").trim();
              if (name) nameSource = "label";
            }
          }
          if (!name && tag === "input" && typeAttr === "image") {
            name = (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
            if (name) nameSource = "alt";
          }
          if (!name && !isField) {
            name = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (name) nameSource = "content";
            if (!name) {
              const img = el.querySelector("img[alt]");
              name = img ? (img.getAttribute("alt") || "").replace(/\s+/g, " ").trim() : "";
              if (name) nameSource = "alt";
            }
          }
          if (!name && tag === "input" && BUTTON_INPUTS.indexOf(typeAttr) !== -1) {
            // A button-type input's value IS its label. A textbox's value is user content, not a
            // name, so it is deliberately not read for any other type (TD-64's CSRF-token-as-name).
            name = (el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
            if (!name && typeAttr === "submit") name = "Submit";
            if (!name && typeAttr === "reset") name = "Reset";
            if (name) nameSource = "value";
          }
          if (!name && isField) {
            name = (el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
            if (name) nameSource = "placeholder";
          }
          if (!name) {
            name = (el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
            if (name) nameSource = "title";
          }

          // ---- proximity label, only for an otherwise-anonymous field (domExtract parity) -------
          let proximity = "";
          if (!name && isField) {
            const near = [el.previousElementSibling, el.parentElement ? el.parentElement.previousElementSibling : null];
            for (let k = 0; k < near.length; k++) {
              const c = near[k];
              if (!c || CONTROL_TAGS.indexOf(c.tagName) !== -1) continue;
              const t = (c.textContent || "").replace(/\s+/g, " ").trim();
              if (t && t.length <= maxProximity) { proximity = t; break; }
            }
          }

          // ---- visibility: the recheckVisibility predicate, verbatim (NOT offsetParent) ---------
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const visible = r.width > 0 && r.height > 0 &&
            cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0;

          const enabled = !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";

          // ---- genericPath: tag names from <html> down, crossing shadow roots to their host -----
          // Inside an open dialog? Walk up through ancestors AND out through shadow hosts
          // (Element.closest stops at a shadow boundary, and Lightning modals are built from
          // nested components). Plain loops only — TD-40.
          let dialogName: string | null = null;
          let anc: HTMLElement | null = el;
          while (anc && dialogName === null) {
            const dlg = anc.closest('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]') as HTMLElement | null;
            if (dlg) {
              let dn = (dlg.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
              const by = (dlg.getAttribute("aria-labelledby") || "").trim();
              if (!dn && by) {
                const ref = dlg.getRootNode() as Document | ShadowRoot;
                const ids = by.split(/\s+/);
                let acc = "";
                for (let q = 0; q < ids.length; q++) {
                  const t = ref.getElementById ? ref.getElementById(ids[q]) : null;
                  if (t) acc += " " + (t.textContent || "");
                }
                dn = acc.replace(/\s+/g, " ").trim();
              }
              dialogName = dn.slice(0, 80);
              break;
            }
            const root = anc.getRootNode() as ShadowRoot;
            anc = root && (root as ShadowRoot).host ? ((root as ShadowRoot).host as HTMLElement) : null;
          }

          const tags: string[] = [];
          let up: HTMLElement | null = el;
          while (up) {
            tags.unshift(up.tagName.toLowerCase());
            up = up.parentElement || ((up.parentNode as ShadowRoot | null)?.host as HTMLElement | undefined) || null;
          }

          items.push({
            tag, role, name, nameSource, proximity, visible, enabled,
            css: candidates.length ? candidates[0] : "",
            candidates, inShadow,
            dataTest: el.getAttribute("data-test") || "",
            dataTestid: el.getAttribute("data-testid") || "",
            dataQa: el.getAttribute("data-qa") || "",
            id: el.id || "",
            classes: (el.getAttribute("class") || "").split(/\s+/).filter(Boolean),
            href: tag === "a" ? (el.getAttribute("href") || "") : "",
            genericPath: tags.join(">"),
            frame: "",
            dialogName,
          });
          nodes.push(el);
        }
        // Reverse push so the first child root pops first: depth-first over roots.
        for (let k = childScopes.length - 1; k >= 0; k--) {
          scopes.push(childScopes[k]);
          scopeChains.push(childChains[k]);
        }
      }
      return { items, nodes, hasShadow, frameEls, frameNodes };
    },
    { selector: LIVE_ELEMENT_SELECTOR, maxProximity: MAX_PROXIMITY_LABEL },
  );
  // </live-walk>
  try {
    const { items, hasShadow, frameEls } = await handle.evaluate(
      (w) => ({ items: w.items, hasShadow: w.hasShadow, frameEls: w.frameEls }));
    if (hasShadow) await verifyWithPlaywright(page, handle as JSHandle<WalkResult>, items);
    return { items, handle: handle as JSHandle<WalkResult>, frameEls };
  } catch (err) {
    await handle.dispose();
    throw err;
  }
}

/**
 * `about:blank` / `about:srcdoc` frames inherit their parent's origin. Anything else must share
 * the top page's real origin; an OPAQUE origin ("null" — `data:`, sandboxed) never counts, even
 * when the top page's is also "null", because two opaque origins are not the same origin.
 */
function sameOrigin(frameUrl: string, topOrigin: string): boolean {
  if (frameUrl.startsWith("about:")) return true;
  try {
    const o = new URL(frameUrl).origin;
    return o !== "null" && o === topOrigin;
  } catch { return false; }
}

/**
 * Walk a page's main document and, recursively, every SAME-ORIGIN iframe in it. Elements inside a
 * frame carry `frame`: the `" >>> "`-joined selectors of the <iframe> elements leading to it,
 * outermost first, each verified through Playwright in its PARENT frame to match exactly that
 * iframe. Frames are listed after the document that contains them.
 *
 * Cross-origin frames are skipped — the brief scopes this to same-origin, and a site's own pages
 * are what discovery models. A frame whose <iframe> gets no verified selector is skipped too: a
 * spec could never reach what is inside it.
 */
export async function walkLiveDomWithFrames(page: Page): Promise<LiveRawElement[]> {
  const top = page.mainFrame();
  let topOrigin = "";
  try { topOrigin = new URL(page.url()).origin; } catch { topOrigin = ""; }
  const all: LiveRawElement[] = [];
  // Explicit queue rather than recursion so a deep frame tree cannot blow the stack.
  const queue: Array<{ frame: Frame; path: string }> = [{ frame: top, path: "" }];
  while (queue.length) {
    const { frame, path } = queue.shift()!;
    let walked: Awaited<ReturnType<typeof walkOneDocument>>;
    try { walked = await walkOneDocument(frame); } catch { continue; } // detached mid-walk
    try {
      for (const item of walked.items) { item.frame = path; all.push(item); }
      for (const child of frame.childFrames()) {
        if (!sameOrigin(child.url(), topOrigin)) continue;
        const el = await child.frameElement().catch(() => null);
        if (!el) continue;
        let chosen = "";
        for (let i = 0; i < walked.frameEls.length && !chosen; i++) {
          const isThis = await walked.handle.evaluate((w, [n, idx]) => w.frameNodes[idx as number] === n, [el, i] as const);
          if (!isThis) continue;
          for (const cand of walked.frameEls[i].candidates) {
            const ok = await frame.locator(cand).evaluateAll(
              (ns, n) => ns.length === 1 && ns[0] === n, el,
            ).catch(() => false);
            if (ok) { chosen = cand; break; }
          }
        }
        await el.dispose();
        if (chosen) queue.push({ frame: child, path: path ? path + " >>> " + chosen : chosen });
      }
    } finally {
      await walked.handle.dispose();
    }
  }
  return all;
}

/**
 * Re-pick every element's `css` by asking PLAYWRIGHT, not the DOM, which candidate matches
 * exactly one element — and that it is the very node the walk saw. Needed once a shadow root
 * exists, because Playwright's piercing CSS engine and `querySelectorAll` disagree there (see the
 * header). The first candidate that passes wins; none passing leaves `css` empty, which is
 * reported honestly rather than papered over with a selector that resolves elsewhere.
 *
 * Cost, measured: a `count()` and an identity `evaluate` per candidate, one element after
 * another, took 4.5s for 320 shadow elements. One `evaluateAll` per candidate (count and
 * identity in a single round trip), with elements checked concurrently so Playwright pipelines
 * the calls, is what this does instead.
 */
async function verifyWithPlaywright(page: Page | Frame, handle: JSHandle<WalkResult>, items: LiveRawElement[]): Promise<void> {
  await Promise.all(items.map(async (item, i) => {
    let chosen = "";
    for (const cand of item.candidates) {
      try {
        const ok = await page.locator(cand).evaluateAll(
          (ns, [w, idx]) => ns.length === 1 && ns[0] === (w as unknown as WalkResult).nodes[idx as number],
          [handle, i] as const,
        );
        if (ok) { chosen = cand; break; }
      } catch { /* an invalid or detached candidate is simply not chosen */ }
    }
    item.css = chosen;
  }));
}

/**
 * Turn the raw walk into `Element[]`, applying the same last-resort naming the cheerio path
 * uses when no accessible name exists: proximity text for a field (flagged `nameFromProximity`,
 * because getByRole can never match it), then a name derived from stable attributes, else the
 * element is unaddressable by name and skipped — exactly as domExtract.ts skips it.
 */
export function toElements(raw: LiveRawElement[]): Element[] {
  const elements: Element[] = [];
  let order = 0;
  for (const r of raw) {
    let name = r.name;
    let nameSource = r.nameSource;
    let nameFromProximity = false;
    if (!name && r.proximity) {
      name = r.proximity;
      nameSource = "proximity";
      nameFromProximity = true;
    }
    if (!name) {
      name = deriveElementName({
        dataTest: r.dataTest, dataTestid: r.dataTestid, dataQa: r.dataQa,
        id: r.id, classes: r.classes, href: r.href,
      });
      if (!name) continue;
      nameSource = "derived";
    }
    const testId = r.dataTest || r.dataTestid || r.dataQa;
    elements.push({
      role: r.role,
      name,
      visible: r.visible,
      enabled: r.enabled,
      id: r.id || `${r.role}_${order}`,
      ...(testId ? { testId } : {}),
      ...(r.css ? { css: r.css } : {}),
      ...(nameFromProximity ? { nameFromProximity: true } : {}),
      genericPath: r.genericPath,
      // Only for elements discovered INSIDE an open dialog. Absent otherwise, so an element on the
      // page itself is exactly what it was before. The IR prompt tells the model it can use
      // containerRole/containerName/pageSection to tell same-named controls apart.
      ...(r.dialogName !== null ? {
        pageSection: "dialog", containerRole: "dialog",
        ...(r.dialogName ? { containerName: r.dialogName } : {}),
      } : {}),
      order: order++,
      ...(r.inShadow ? { inShadow: true } : {}),
      ...(r.frame ? { frame: r.frame } : {}),
      nameSource,
      visibleSource: "computed",
    });
  }
  return elements;
}

/** The live-DOM element list for an already-open page, same-origin iframes included. */
export async function enumerateLiveElements(page: Page): Promise<Element[]> {
  return toElements(await walkLiveDomWithFrames(page));
}

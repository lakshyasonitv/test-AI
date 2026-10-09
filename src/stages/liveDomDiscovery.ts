/**
 * Live-DOM element enumeration — discovery that looks at the real page instead of a string.
 *
 * The cheerio path (`domExtract.ts`, fed by `page.content()`) parses a serialized HTML STRING.
 * That string has no computed style, so `visible` arrives hardcoded `true`; and form-extracted
 * elements carry no `css`, so `recheckVisibility` (domDiscovery.ts) can never correct them. That
 * pair is the Salesforce login bug: a hidden password-mirror input entered the model as visible
 * with no `css`, grounding accepted it, and `resolveCode` fell past its `t.css` branch to a
 * `field()` hint that resolved to nothing at run time.
 *
 * This module walks the LIVE document in ONE `page.evaluate` and returns the existing `Element[]`
 * shape, with, for every element:
 *   - `name` computed from the accessible-name sources in accname order — never the HTML `name`
 *     attribute (see the precedence comment in domDiscovery.ts for what that broke on saucedemo);
 *   - `visible` measured with the same geometry + computed-style predicate `recheckVisibility`
 *     uses — deliberately NOT `offsetParent`, which is null for `position: fixed` and would hide
 *     every fixed header;
 *   - a `css` selector verified IN THE PAGE to match exactly that one element. Most stable
 *     attribute first; a positional path only when nothing stable exists (decided 2026-10-09,
 *     see the phase report). With a `css` on everything, grounding's auto-attach always fires.
 *
 * Scope of this file today: the top-level document's light DOM. Shadow roots and same-origin
 * iframes are later phases; nothing here reads DISCOVERY_LIVE_DOM — the strategy switch in
 * domDiscovery.ts does.
 */

import type { Page } from "playwright";
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
  /** Verified unique selector; "" only if even the positional path failed to verify. */
  css: string;
  dataTest: string;
  dataTestid: string;
  dataQa: string;
  id: string;
  classes: string[];
  href: string;
  genericPath: string;
}

/** Elements the walk enumerates. Mirrors the cheerio extractor's union (domExtract.ts
 *  `extractInteractiveElements` + headings), so the live model never has FEWER kinds of
 *  element than the static one — only more accurate ones. */
export const LIVE_ELEMENT_SELECTOR = "a, button, input, select, textarea, [role], h1, h2, h3, h4, h5, h6";

/** Longest text accepted as a proximity label — the same bound domExtract.ts uses. */
const MAX_PROXIMITY_LABEL = 60;

/**
 * Walk the live DOM and return the raw per-element facts. Exported for tests; production code
 * calls `enumerateLiveElements`.
 */
export async function walkLiveDom(page: Page): Promise<LiveRawElement[]> {
  // <live-walk> — the source between these markers runs INSIDE THE BROWSER.
  //
  // ponytail: deliberately written with NO inner named or const-assigned functions, and no
  // callbacks at all — plain loops only, with small pieces of logic repeated where a helper would
  // have been natural. That is not style, it is a runtime constraint (TECH_DEBT.md TD-40):
  // `page.evaluate` serializes this function's source and runs it in the page, where none of the
  // transpiler's helpers exist, and esbuild (what `tsx` uses, which is how the server actually
  // runs) wraps every named function in `__name(...)` to preserve `.name`. A factored-out
  // `const escape = ...` throws `ReferenceError: __name is not defined` in the page — and passes
  // every vitest run, because vitest's transform does not inject that helper. The same warning
  // sits on the callbacks in hybridDiscovery.ts and discovery.ts. tests/liveDomDiscovery.test.ts
  // runs this module under real `tsx` to catch a regression.
  return await page.evaluate(
    ({ selector, maxProximity }) => {
      const out: Array<{
        tag: string; role: string; name: string; nameSource: string; proximity: string;
        visible: boolean; enabled: boolean; css: string;
        dataTest: string; dataTestid: string; dataQa: string; id: string; classes: string[];
        href: string; genericPath: string;
      }> = [];
      const nodes = document.querySelectorAll(selector);
      const NATIVE = ["a", "button", "input", "select", "textarea"];
      const BUTTON_INPUTS = ["submit", "button", "reset", "image"];
      const CONTROL_TAGS = ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "FORM"];

      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i] as HTMLElement;
        const tag = el.tagName.toLowerCase();
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
            const ref = document.getElementById(ids[k]);
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

        // ---- css: most stable first, each candidate verified to match exactly this element ----
        const dataTest = el.getAttribute("data-test") || "";
        const dataTestid = el.getAttribute("data-testid") || "";
        const dataQa = el.getAttribute("data-qa") || "";
        const attrCands: Array<[string, string, string]> = [
          ["", "data-test", dataTest],
          ["", "data-testid", dataTestid],
          ["", "data-qa", dataQa],
          ["#", "", el.id],
          [tag, "name", el.getAttribute("name") || ""],
          [tag, "aria-label", el.getAttribute("aria-label") || ""],
        ];
        let css = "";
        for (let k = 0; k < attrCands.length && !css; k++) {
          const prefix = attrCands[k][0];
          const attrName = attrCands[k][1];
          const value = attrCands[k][2];
          if (!value) continue;
          // Inside a double-quoted CSS string only backslash, the quote and newlines need
          // escaping; an id goes through CSS.escape because it is an identifier, not a string.
          const cand = prefix === "#"
            ? "#" + CSS.escape(value)
            : prefix + "[" + attrName + "=\"" +
              value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ") + "\"]";
          try {
            const hits = document.querySelectorAll(cand);
            if (hits.length === 1 && hits[0] === el) css = cand;
          } catch { /* an unparseable candidate is skipped, never fatal */ }
        }
        if (!css) {
          // Positional fallback: tag + :nth-of-type up the tree, anchored at the nearest
          // ancestor whose id is unique in the document (shorter and less layout-coupled than a
          // path from <body>), else at <body>.
          const segs: string[] = [];
          let node: HTMLElement | null = el;
          while (node && node !== document.documentElement) {
            const nt = node.tagName.toLowerCase();
            if (node !== el && node.id) {
              const anchor = "#" + CSS.escape(node.id);
              let unique = false;
              try { unique = document.querySelectorAll(anchor).length === 1; } catch { unique = false; }
              if (unique) { segs.unshift(anchor); break; }
            }
            if (nt === "body") { segs.unshift("body"); break; }
            let seg = nt;
            const parent: HTMLElement | null = node.parentElement;
            if (parent) {
              let sameTag = 0;
              let pos = 0;
              for (let k = 0; k < parent.children.length; k++) {
                if (parent.children[k].tagName === node.tagName) {
                  sameTag++;
                  if (parent.children[k] === node) pos = sameTag;
                }
              }
              if (sameTag > 1) seg += ":nth-of-type(" + pos + ")";
            }
            segs.unshift(seg);
            node = parent;
          }
          const cand = segs.join(" > ");
          try {
            const hits = document.querySelectorAll(cand);
            if (hits.length === 1 && hits[0] === el) css = cand;
          } catch { css = ""; }
        }

        // ---- genericPath: tag names from <html> down, the same format domExtract produces -----
        const tags: string[] = [];
        let up: HTMLElement | null = el;
        while (up) { tags.unshift(up.tagName.toLowerCase()); up = up.parentElement; }

        out.push({
          tag, role, name, nameSource, proximity, visible, enabled, css,
          dataTest, dataTestid, dataQa, id: el.id || "",
          classes: (el.getAttribute("class") || "").split(/\s+/).filter(Boolean),
          href: tag === "a" ? (el.getAttribute("href") || "") : "",
          genericPath: tags.join(">"),
        });
      }
      return out;
    },
    { selector: LIVE_ELEMENT_SELECTOR, maxProximity: MAX_PROXIMITY_LABEL },
  );
  // </live-walk>
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
      order: order++,
      nameSource,
      visibleSource: "computed",
    });
  }
  return elements;
}

/** The live-DOM element list for an already-open page. */
export async function enumerateLiveElements(page: Page): Promise<Element[]> {
  return toElements(await walkLiveDom(page));
}

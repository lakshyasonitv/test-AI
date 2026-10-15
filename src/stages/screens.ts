import crypto from "node:crypto";
import { AppModel, type PageModel, type Element } from "../schema/appModel.js";
import { pageKey } from "../text.js";

/**
 * SCREENS — several pages behind one URL (DECISIONS.md D-52).
 *
 * A Salesforce "New" form, a multi-step wizard or a modal replaces the DOM without changing the
 * URL. Everything else in this codebase keys a page by `pageKey(url)`, so the second screen of a
 * three-screen form REPLACED the first in the model (`mergePageInto`), grounding then lost the
 * first screen's fields, re-captured, lost the second's, and the run truncated after the navigate.
 *
 * A screen is a page model plus a fingerprint: the URL, the screen's title (an open dialog's name,
 * else the first heading in the main content), the selected tab, and the labels of its fields.
 *
 * SAME SCREEN OR NEW SCREEN is decided LOOSELY, not by the exact key: same URL, same title (or the
 * same non-empty tab), and the field labels overlap by at least `SAME_SCREEN_OVERLAP` of the
 * smaller set. Re-capturing a screen after a field was removed, added or renamed then REPLACES it
 * (the fresh capture wins and the screen count holds), while a wizard's next step — different
 * fields under the same heading — is ADDED. An exact key alone could never replace anything: any
 * change to the labels is a new key, so every re-capture would add a stale twin.
 *
 * Pure code, no browser: everything here is deterministic over the page model.
 */

/** Fraction of the SMALLER label set that must also be on the other screen for the two to count
 *  as the same screen. 0.7 per the design review: "most of the field labels overlap". */
export const SAME_SCREEN_OVERLAP = 0.7;

const FIELD_ROLES = new Set(["textbox", "combobox", "searchbox", "checkbox", "radio", "spinbutton", "listbox", "switch"]);
const CHROME_SECTIONS = new Set(["header", "nav", "footer", "banner", "navigation", "contentinfo"]);

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export interface ScreenFingerprint {
  key: string;
  title: string;
  tab: string;
  labels: string[];
}

/** The elements that make up "the screen": an open dialog's own controls when one is open (the
 *  modal IS the screen; the page behind it is chrome), else everything outside header/nav/footer. */
export function screenElements(elements: Element[]): Element[] {
  const visible = elements.filter((e) => e.visible !== false);
  const inDialog = visible.filter((e) => norm(e.containerRole) === "dialog" || norm(e.pageSection) === "dialog");
  if (inDialog.length) return inDialog;
  const body = visible.filter((e) => !CHROME_SECTIONS.has(norm(e.pageSection)));
  return body.length ? body : visible;
}

/** Labels that identify the screen: its form fields' names. A screen with no fields at all (a
 *  confirmation, a list view) falls back to its buttons and links, or every such screen would
 *  look alike. */
function screenLabels(elements: Element[]): string[] {
  const own = screenElements(elements);
  const fields = own.filter((e) => FIELD_ROLES.has(norm(e.role)) && norm(e.name));
  const pick = fields.length ? fields : own.filter((e) => norm(e.name) && norm(e.role) !== "heading");
  return Array.from(new Set(pick.map((e) => norm(e.name)))).sort();
}

function screenTitle(elements: Element[]): string {
  const visible = elements.filter((e) => e.visible !== false);
  const dialog = visible.find((e) => norm(e.containerRole) === "dialog" && norm(e.containerName));
  if (dialog) return norm(dialog.containerName);
  const heading = visible.find((e) => norm(e.role) === "heading" && norm(e.name) && !CHROME_SECTIONS.has(norm(e.pageSection)))
    ?? visible.find((e) => norm(e.role) === "heading" && norm(e.name));
  return heading ? norm(heading.name) : "";
}

/**
 * Fingerprint a page model. `tab` is the selected tab's name when the caller read it from the live
 * page (`[role=tab][aria-selected=true]`); element models do not record selection, so a page
 * fingerprinted from its elements alone has tab "".
 */
export function screenFingerprint(page: Pick<PageModel, "url" | "elements">, tab = ""): ScreenFingerprint {
  const title = screenTitle(page.elements);
  const labels = screenLabels(page.elements);
  const t = norm(tab);
  const key = crypto.createHash("sha1")
    .update([pageKey(page.url), title, t, labels.join("\u0001")].join("\u0000"))
    .digest("hex").slice(0, 12);
  return { key, title, tab: t, labels };
}

/** A page's fingerprint: the stored one when a screen capture set it, else derived from its
 *  elements (every page discovery produced). */
export function fingerprintOf(page: PageModel): ScreenFingerprint {
  return page.screen ?? screenFingerprint(page);
}

/** |A ∩ B| / min(|A|, |B|). Two empty sets overlap fully; one empty set overlaps nothing. */
export function labelOverlap(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const bs = new Set(b);
  let common = 0;
  for (const l of new Set(a)) if (bs.has(l)) common++;
  return common / Math.min(new Set(a).size, bs.size);
}

/** The loose rule: same URL, same title or same (non-empty) tab, and most labels shared. */
export function sameScreen(
  a: { url: string; fp: ScreenFingerprint }, b: { url: string; fp: ScreenFingerprint },
): boolean {
  if (pageKey(a.url) !== pageKey(b.url)) return false;
  if (a.fp.key === b.fp.key) return true; // the quick path: byte-identical screen
  const titleMatch = a.fp.title === b.fp.title || (!!a.fp.tab && a.fp.tab === b.fp.tab);
  return titleMatch && labelOverlap(a.fp.labels, b.fp.labels) >= SAME_SCREEN_OVERLAP;
}

/**
 * Put a captured screen into the model. Replaces the page it is the SAME screen as (the fresh
 * capture wins, so a field removed since is gone), otherwise appends it beside the other screens
 * of the same URL. Returns the screen's key, plus the key of the screen it replaced so a caller
 * holding references to that key can follow it.
 */
export function mergeScreenInto(
  model: AppModel, captured: PageModel, tab = "",
): { model: AppModel; key: string; replacedKey?: string } {
  const fp = screenFingerprint(captured, tab);
  const page: PageModel = { ...captured, screen: fp };
  const idx = model.pages.findIndex((p) => sameScreen({ url: p.url, fp: fingerprintOf(p) }, { url: page.url, fp }));
  if (idx < 0) return { model: AppModel.parse({ ...model, pages: [...model.pages, page] }), key: fp.key };
  const replacedKey = fingerprintOf(model.pages[idx]).key;
  const pages = model.pages.slice();
  pages[idx] = page;
  return { model: AppModel.parse({ ...model, pages }), key: fp.key, replacedKey };
}

/** The page holding screen `key`, if the model still has it. */
export function findScreen(model: AppModel, key: string): PageModel | undefined {
  return model.pages.find((p) => fingerprintOf(p).key === key);
}

/** How many screens the model holds for `url`. */
export function screenCount(model: AppModel, url: string): number {
  return model.pages.filter((p) => pageKey(p.url) === pageKey(url)).length;
}

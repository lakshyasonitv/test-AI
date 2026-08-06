import type { AppModel } from "../schema/appModel.js";

/**
 * Selectors a user wrote directly into their prompt.
 *
 * People reach for this exactly when discovery has failed them — e.g.
 * `click on the cart button id="shopping_cart_container" on the top right corner`. The
 * pipeline used to drop that hint entirely: `Target` had no selector field and the IR
 * prompt forbids CSS, so the run truncated on an ungroundable "Cart" link while the answer
 * was sitting in the prompt.
 *
 * These are treated as HINTS, never as truth. Each one is checked against the discovered
 * model (and, when available, the live page) before it can be used — a stale or mistyped
 * selector should degrade to normal grounding with a visible note, not produce a test that
 * fails for a reason the user can't see.
 */
export interface PromptSelector {
  /** CSS selector as it will be used, e.g. `#shopping_cart_container`. */
  css: string;
  /** The raw fragment matched in the prompt, for reporting. */
  raw: string;
}

// Deliberately narrow. Broad CSS-ish matching turns ordinary prose ("click .Continue") into
// bogus selectors, so we only accept forms where the user clearly meant an attribute.
const PATTERNS: RegExp[] = [
  /\bid\s*=\s*["']([A-Za-z][\w-]*)["']/g,                  // id="shopping_cart_container"
  /\bdata-(?:test|testid|qa)\s*=\s*["']([\w-]+)["']/g,      // data-test="checkout"
  /(?:^|[\s(])#([A-Za-z][\w-]{2,})\b/g,                     // #shopping_cart_container
  /\[\s*(data-(?:test|testid|qa))\s*=\s*["']([^"']+)["']\s*\]/g, // [data-test="checkout"]
];

/** Extract candidate selectors from free-form prompt text. Deduplicated, order preserved. */
export function extractPromptSelectors(prompt: string): PromptSelector[] {
  const out: PromptSelector[] = [];
  const seen = new Set<string>();
  const add = (css: string, raw: string) => {
    if (seen.has(css)) return;
    seen.add(css);
    out.push({ css, raw });
  };

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const raw = m[0].trim();
      if (raw.startsWith("[")) add(`[${m[1]}="${m[2]}"]`, raw);
      else if (/^data-/.test(raw)) add(`[${raw.split(/\s*=\s*/)[0]}="${m[1]}"]`, raw);
      else add(`#${m[1]}`, raw);
    }
  }
  return out;
}

/**
 * Keep only the selectors that correspond to something discovery actually saw.
 *
 * An `id`/`data-*` the user names may sit on a wrapper rather than the control itself
 * (`#shopping_cart_container` wraps `a[data-test="shopping-cart-link"]`), so a match against
 * a known element's own selector counts, and so does a match on the element's `id`.
 */
export function verifyAgainstModel(
  selectors: PromptSelector[], model: AppModel
): { usable: PromptSelector[]; unknown: PromptSelector[] } {
  const known = new Set<string>();
  for (const p of model.pages) {
    for (const e of p.elements) {
      if (e.css) known.add(e.css.toLowerCase());
      if (e.id) known.add(`#${e.id}`.toLowerCase());
      if (e.testId) {
        known.add(`[data-test="${e.testId}"]`.toLowerCase());
        known.add(`[data-testid="${e.testId}"]`.toLowerCase());
        known.add(`[data-qa="${e.testId}"]`.toLowerCase());
      }
    }
  }
  const usable: PromptSelector[] = [];
  const unknown: PromptSelector[] = [];
  for (const s of selectors) (known.has(s.css.toLowerCase()) ? usable : unknown).push(s);
  return { usable, unknown };
}

/**
 * A prompt line for the IR stage listing the user's own verified selectors. Kept out of the
 * "never use CSS selectors" rule's way by being explicit that these are pre-verified facts,
 * not something the model may invent.
 */
export function promptSelectorHint(usable: PromptSelector[]): string {
  if (!usable.length) return "";
  return (
    `\nThe user named these selectors in their request and discovery confirmed each one ` +
    `exists on the page. When a step targets one of these elements, set the step's ` +
    `target.css to the exact value shown (this is the ONE case where target.css is allowed ` +
    `— these are verified, not invented):\n` +
    usable.map(s => `  ${s.css}   (from "${s.raw}" in the request)`).join("\n") + "\n"
  );
}

import type { Page, Locator } from "playwright";
import type { Target } from "../schema/ir.js";

const q = (s: string) => JSON.stringify(s);

/**
 * Resolvers for target fields OTHER than role+name — label → placeholder → text → testId,
 * in priority order. role+name is handled separately below since it alone gets the
 * self-healing fallback chain: a site rename or button<->link swap is by far the most
 * common real-world locator break, and these other fields are comparatively stable (a
 * label/placeholder rarely drifts independently of the element it's attached to).
 */
const RESOLVERS: Array<{
  match: (t: Target) => boolean;
  code: (t: Target) => string;
  live: (page: Page, t: Target) => Locator;
}> = [
  // css first: it is only ever set by discovery, from an element it verified exists, and it
  // is the only way to reach a control whose accessible name is empty (icon-only cart,
  // close, search). Everything below is a name-based guess by comparison.
  { match: (t) => !!t.css,         code: (t) => `page.locator(${q(t.css!)})`,                  live: (p, t) => p.locator(t.css!) },
  { match: (t) => !!t.label,       code: (t) => `page.getByLabel(${q(t.label!)})`,             live: (p, t) => p.getByLabel(t.label!) },
  { match: (t) => !!t.placeholder, code: (t) => `page.getByPlaceholder(${q(t.placeholder!)})`, live: (p, t) => p.getByPlaceholder(t.placeholder!) },
  { match: (t) => !!t.text,        code: (t) => `page.getByText(${q(t.text!)})`,                live: (p, t) => p.getByText(t.text!) },
  { match: (t) => !!t.testId,      code: (t) => `page.getByTestId(${q(t.testId!)})`,            live: (p, t) => p.getByTestId(t.testId!) },
];

function pick(t: Target) {
  const r = RESOLVERS.find((r) => r.match(t));
  if (!r) throw new Error(`No semantic locator for target: ${JSON.stringify(t)}`);
  return r;
}

/**
 * Actions that can only ever act on a form control. `getByText` is not merely a weak choice
 * for these — it is categorically wrong, because it matches the element CONTAINING the text,
 * which for a labelled field is the label. Seen in production: `fill { text: "Name" }` became
 * `getByText('Name')`, resolved to `<label>Full Name</label>`, and Playwright refused with
 * "Element is not an <input>, <textarea>, <select> or [contenteditable]".
 */
const FIELD_ACTIONS = new Set(["fill", "select", "check"]);

/** The human-facing string that identifies a field, whichever slot the IR put it in. */
export function fieldHint(t: Target): string {
  return t.label || t.name || t.placeholder || t.text || "";
}

export const isFieldAction = (action?: string) => !!action && FIELD_ACTIONS.has(action);

/**
 * Positional fallback for a field with no accessible name and no stable selector — the
 * `<div>Full Name</div><input>` shape, where the only thing tying the control to its label is
 * layout. `:near()` is Playwright's built-in layout engine, so this needs no extra dependency,
 * and `:text()` matches on substring — which is exactly what lets a request that says "Name"
 * reach a field labelled "Full Name".
 *
 * ponytail: one positional strategy, not four. `:near` covers a label above, beside, or before
 * the input; if a layout ever needs strict direction, `:below(...)`/`:right-of(...)` are the
 * upgrade path.
 */
export function nearFieldSelector(hint: string): string {
  const anchor = `:text(${JSON.stringify(hint)})`;
  return ["input", "textarea", "select"].map(tag => `${tag}:near(${anchor}, 120)`).join(", ");
}

// button<->link is the single most common real-world role mismatch (a styled <a> used as a
// button, or vice versa) — the fallback chain covers exactly this, not an open-ended set.
const ROLE_SWAP: Record<string, string> = { button: "link", link: "button" };

/**
 * Locator expression as source code (for the generator). role+name targets call the
 * `locate()` helper generator.ts injects once per spec — its LOCATE_HELPER constant mirrors
 * resolveRoleWithFallback() below. Kept in sync manually: the generated spec is a separate,
 * self-contained file (no deps beyond @playwright/test), so the algorithm can't be shared
 * as an import — only as the same logic written twice.
 */
export function resolveCode(t: Target, action?: string): string {
  // A verified selector beats role+name even when both are present — role+name may be a
  // name discovery derived (e.g. "shopping cart link"), which getByRole cannot match.
  if (t.css) {
    const base = `page.locator(${q(t.css)})`;
    return t.nth !== undefined && t.nth !== null ? `${base}.nth(${t.nth})` : `${base}.first()`;
  }
  // A field action routes through the field() helper regardless of which slot carried the
  // hint, so a role+name whose name was inferred from an adjacent <div> still resolves —
  // getByRole cannot match a name the DOM does not actually have.
  if (isFieldAction(action) && fieldHint(t)) {
    return `(await field(page, ${q(fieldHint(t))}))`;
  }
  if (t.role && t.name) {
    // If nth is specified, use it to disambiguate duplicate elements
    if (t.nth !== undefined && t.nth !== null) {
      return `(await locate(page, ${q(t.role)}, ${q(t.name)}, ${t.nth}))`;
    }
    return `(await locate(page, ${q(t.role)}, ${q(t.name)}))`;
  }
  return `${pick(t).code(t)}.first()`;
}

/**
 * Try the exact role, the common alternate interactive role with the same name, then a
 * broad text match — first candidate resolving to exactly one element wins. Falls back to
 * the original locator if none are unique, so an unrecoverable failure's error message is
 * unchanged; this only adds chances to succeed, never removes the existing path.
 */
async function resolveRoleWithFallback(page: Page, role: string, name: string): Promise<Locator> {
  const original = page.getByRole(role as any, { name });
  const candidates: Locator[] = [original];
  const alt = ROLE_SWAP[role.toLowerCase()];
  if (alt) candidates.push(page.getByRole(alt as any, { name }));
  candidates.push(page.getByText(name));
  for (const c of candidates) {
    if (await c.count() === 1) return c;
  }
  return original.first();
}

/**
 * Live counterpart of the generated spec's field() helper. Tries the ways a field can be
 * named, in decreasing order of how much the DOM actually vouches for them, and takes the
 * first that identifies exactly one element — same "count() === 1" shape
 * resolveRoleWithFallback uses. Falls through to the positional match, so a control with no
 * accessible name at all is still reachable.
 */
export async function resolveField(page: Page, hint: string): Promise<Locator> {
  const candidates: Locator[] = [
    page.getByLabel(hint),
    page.getByPlaceholder(hint),
    page.getByRole("textbox", { name: hint }),
    page.getByRole("combobox", { name: hint }),
    page.getByRole("checkbox", { name: hint }),
    page.locator(nearFieldSelector(hint)),
  ];
  for (const c of candidates) {
    if (await c.count() === 1) return c;
  }
  // Nothing was unique. The positional match is the only one that can't resolve to a
  // non-fillable node, so prefer its closest hit over a label/text match that would.
  return page.locator(nearFieldSelector(hint)).first();
}

/** Live Playwright Locator against a running page (for the replay runner). */
export async function resolveLive(page: Page, t: Target, action?: string): Promise<Locator> {
  if (t.css) {
    const base = page.locator(t.css);
    return t.nth !== undefined && t.nth !== null ? base.nth(t.nth) : base.first();
  }
  if (isFieldAction(action) && fieldHint(t)) {
    return resolveField(page, fieldHint(t));
  }
  if (t.role && t.name) {
    // If nth is specified, use it to disambiguate duplicate elements
    if (t.nth !== undefined && t.nth !== null) {
      const locator = page.getByRole(t.role as any, { name: t.name });
      return locator.nth(t.nth);
    }
    return resolveRoleWithFallback(page, t.role, t.name);
  }
  return pick(t).live(page, t).first();
}

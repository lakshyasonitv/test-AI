import type { Page, Locator } from "playwright";
import type { Target } from "../schema/ir.js";

const q = (s: string) => JSON.stringify(s);

/**
 * Single source of truth for how a Target maps to a locator, in priority order:
 * role+name → label → placeholder → text → testId. Both consumers walk this same
 * list, so "generate this step as code" (code) and "run this step for real" (live)
 * can never disagree about which element a step means. Adding a target field or
 * reordering priority happens here once, not in two places that would drift.
 *
 * Every locator ends in .first(). An accessible name is not unique — a product card
 * routinely exposes the same name on its image link and its title link — and Playwright's
 * strict mode makes a 2-match locator a hard error, which would fail generated tests on
 * most real pages. The IR can't express "the 2nd match" anyway, so first-match is the only
 * resolution available; it costs the ability to detect genuine duplicate-name ambiguity.
 */
const RESOLVERS: Array<{
  match: (t: Target) => boolean;
  code: (t: Target) => string;
  live: (page: Page, t: Target) => Locator;
}> = [
  { match: (t) => !!(t.role && t.name), code: (t) => `page.getByRole(${q(t.role!)}, { name: ${q(t.name!)} })`, live: (p, t) => p.getByRole(t.role as any, { name: t.name! }) },
  { match: (t) => !!t.label,            code: (t) => `page.getByLabel(${q(t.label!)})`,                        live: (p, t) => p.getByLabel(t.label!) },
  { match: (t) => !!t.placeholder,      code: (t) => `page.getByPlaceholder(${q(t.placeholder!)})`,            live: (p, t) => p.getByPlaceholder(t.placeholder!) },
  { match: (t) => !!t.text,             code: (t) => `page.getByText(${q(t.text!)})`,                          live: (p, t) => p.getByText(t.text!) },
  { match: (t) => !!t.testId,           code: (t) => `page.getByTestId(${q(t.testId!)})`,                      live: (p, t) => p.getByTestId(t.testId!) },
];

function pick(t: Target) {
  const r = RESOLVERS.find((r) => r.match(t));
  if (!r) throw new Error(`No semantic locator for target: ${JSON.stringify(t)}`);
  return r;
}

/** Locator expression as source code (for the generator). */
export function resolveCode(t: Target): string {
  return `${pick(t).code(t)}.first()`;
}

/** Live Playwright Locator against a running page (for the replay runner). */
export function resolveLive(page: Page, t: Target): Locator {
  return pick(t).live(page, t).first();
}

import type { Page, Locator } from "playwright";
import type { Target } from "../schema/ir.js";
import { cosineSimilarity } from "../llm/embeddings.js";

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
export function resolveCode(t: Target): string {
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
  return original;
}

/** Live Playwright Locator against a running page (for the replay runner). */
export async function resolveLive(page: Page, t: Target): Promise<Locator> {
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

// --- Fuzzy AppModel matching (no AI) ---------------------------------------------------
// Used when an exact/substring role+name match against the AppModel fails — the single
// most common real-world locator break is a same-role rename (e.g. "Login" -> "Sign In"),
// not a structural change that actually needs rediscovery. Deterministic and cheap, so
// ir.ts tries this BEFORE spending a live-extend browser launch or another Groq call on it.

import type { Element as ModelElement } from "../schema/appModel.js";

export interface ModelMatch {
  kind: "exact" | "similar" | "multiple" | "none";
  element: ModelElement | null;
  candidates?: ModelElement[];
  score: number;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Levenshtein edit distance, normalized to a 0..1 similarity score (1 = identical). */
function similarity(a: string, b: string): number {
  const s1 = normName(a), s2 = normName(b);
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const dp: number[][] = Array.from({ length: s1.length + 1 }, () => new Array(s2.length + 1).fill(0));
  for (let i = 0; i <= s1.length; i++) dp[i][0] = i;
  for (let j = 0; j <= s2.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      dp[i][j] = s1[i - 1] === s2[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[s1.length][s2.length] / Math.max(s1.length, s2.length);
}


async function semanticScore(
  a: string,
  b: string,
  embed: (text: string) => Promise<number[]>
): Promise<number> {
  const embA = await embed(a);
  const embB = await embed(b);
  return cosineSimilarity(embA, embB);
}

export async function resolveAgainstModel(
  role: string,
  name: string,
  elements: ModelElement[],
  opts: {
    syntacticThreshold?: number;
    semanticThreshold?: number;
    embed?: (text: string) => Promise<number[]>;
  } = {}
): Promise<ModelMatch> {
  const syntacticThreshold = opts.syntacticThreshold ?? 0.72;
  const semanticThreshold = opts.semanticThreshold ?? 0.82;

  const r = role.toLowerCase();
  const sameRole = elements.filter((e) => e.role.toLowerCase() === r);
  const n = normName(name);

  const exactMatches = sameRole.filter(e => {
    const en = normName(e.name);
    return en === n || en.includes(n) || n.includes(en);
  });

  if (exactMatches.length === 1) {
    return {
      kind: "exact",
      element: exactMatches[0],
      score: 1
    };
  }

  if (exactMatches.length > 1) {
    return {
      kind: "multiple",
      element: null,
      candidates: exactMatches,
      score: 1
    };
  }

  if (!sameRole.length) return { kind: "none", element: null, score: 0 };

  let bestSyntactic: { element: ModelElement; score: number } | null = null;
  for (const e of sameRole) {
    const score = similarity(name, e.name);
    if (!bestSyntactic || score > bestSyntactic.score) bestSyntactic = { element: e, score };
  }
  if (bestSyntactic && bestSyntactic.score >= syntacticThreshold) {
    return { kind: "similar", element: bestSyntactic.element, score: bestSyntactic.score };
  }

  if (opts.embed) {
    try {
      const visibleElements = sameRole.filter(e => e.visible !== false);
      const candidateElements = visibleElements.length > 0 ? visibleElements : sameRole;
      
      let bestSemantic: { element: ModelElement; score: number } | null = null;
      for (const e of candidateElements) {
        const query = `${role}: ${name}`;
        const target = e.concept 
          ? `${e.role}: ${e.concept}` 
          : `${e.role}: ${e.name}`;
        
        const score = await semanticScore(query, target, opts.embed);
        if (!bestSemantic || score > bestSemantic.score) bestSemantic = { element: e, score };
      }
      if (bestSemantic && bestSemantic.score >= semanticThreshold) {
        return { kind: "similar", element: bestSemantic.element, score: bestSemantic.score };
      }
    } catch (err: any) {
      console.log(`[targetResolver] semantic match skipped: ${err?.message ?? err}`);
    }
  }

  return { kind: "none", element: null, score: bestSyntactic?.score ?? 0 };
}

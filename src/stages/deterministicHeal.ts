import type { AppModel, Element, PageModel } from "../schema/appModel.js";
import type { IR, Step, Target } from "../schema/ir.js";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Strip common icon glyphs and whitespace so "🔍 Search" matches "Search". */
const stripGlyphs = (s: string) =>
  s.replace(/[\u2000-\u206F\u2190-\u21FF\u2600-\u27BF\u2B50-\u2B55\uFE00-\uFE0F\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/[\s*_#<>[\]{}|\\~`!@#$%^&()+=]+/g, "")
    .trim()
    .toLowerCase();

/**
 * Roles that are structurally interchangeable for the purpose of healing.
 * A "link" target that can't be found may have become a "button" (or vice versa)
 * — same user interaction, different HTML element.
 */
const COMPATIBLE_ROLE_GROUPS = [
  new Set(["link", "button", "menuitem", "tab"]),
  new Set(["textbox", "searchbox", "combobox"]),
  new Set(["checkbox", "switch", "radio"]),
];

function areRolesCompatible(a: string, b: string): boolean {
  const an = norm(a);
  const bn = norm(b);
  if (an === bn) return true;
  for (const group of COMPATIBLE_ROLE_GROUPS) {
    if (group.has(an) && group.has(bn)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Name matching — same tiered algorithm as ir.ts bestNameMatch, extracted so
// deterministicHeal.ts and ir.ts share identical ranking logic (single source
// of truth for the tier definitions). If ir.ts's copy is ever changed, this
// must change too — see TECH_DEBT.md TD-07 for why this duplication exists.
// ──────────────────────────────────────────────────────────────────────────────

interface NameMatch {
  element: Element;
  tier: number;        // 0=exact, 1=glyph-stripped, 2=prefix/suffix, 3=substring
  delta: number;       // length difference between names
}

function findNameMatches(
  elements: Element[],
  name: string,
  roleFilter: (role: string) => boolean,
): NameMatch[] {
  const sn = stripGlyphs(name);
  const results: NameMatch[] = [];

  for (const e of elements) {
    if (!roleFilter(norm(e.role ?? ""))) continue;
    const en = norm(e.name ?? "");
    if (!en) continue;
    const sen = stripGlyphs(en);

    let tier: number;
    if (en === name) tier = 0;
    else if (sn && sen && sn === sen) tier = 1;
    else if (en.startsWith(name) || en.endsWith(name)) tier = 2;
    else if (en.includes(name)) tier = 3;
    else continue;

    results.push({ element: e, tier, delta: Math.abs(en.length - name.length) });
  }

  results.sort((a, b) => a.tier - b.tier || a.delta - b.delta);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Target diffing — describe what changed between old and new targets
// ──────────────────────────────────────────────────────────────────────────────

export interface TargetDiff {
  field: string;
  oldValue: string | undefined;
  newValue: string | undefined;
}

export function diffTargets(oldTarget: Target | undefined, newTarget: Target): TargetDiff[] {
  if (!oldTarget) return [{ field: "target", oldValue: undefined, newValue: JSON.stringify(newTarget) }];
  const diffs: TargetDiff[] = [];
  for (const key of ["role", "name", "css", "testId", "nth", "text", "placeholder", "label"] as const) {
    const ov = (oldTarget as any)[key];
    const nv = (newTarget as any)[key];
    if (ov !== nv) diffs.push({ field: key, oldValue: ov, newValue: nv });
  }
  return diffs;
}

// ──────────────────────────────────────────────────────────────────────────────
// Deterministic heal result
// ──────────────────────────────────────────────────────────────────────────────

export interface DeterministicHealResult {
  /** The corrected step with the new target applied. */
  step: Step;
  /** The element that was matched, for callers that need the full AppModel entry. */
  matchedElement: Element;
  /** Confidence in the match: "exact" (tier 0), "strong" (tier 1-2), "weak" (tier 3). */
  confidence: "exact" | "strong" | "weak";
  /** Human-readable description of what changed, for logging/UI. */
  changeDescription: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core: heal one step's target against the AppModel
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically re-match a failing step's IR target against the AppModel,
 * without calling an LLM or re-snapshotting the page.
 *
 * Searches ALL pages in the AppModel (the element may have moved to a different
 * page, or the AppModel may have multiple snapshots from different points in the
 * crawl). Returns null when no better match is found — the caller falls back to
 * the existing LLM-based heal path.
 *
 * Matches by: role compatibility → name tiered match (exact → glyph → prefix → substring).
 * When a match is found, copies deterministic grounding fields (css, testId) from
 * the matched element onto the corrected target, exactly as groundingError does.
 */
export function healStepTarget(
  step: Step,
  appModel: AppModel,
): DeterministicHealResult | null {
  const target = step.target;
  if (!target) return null;

  // No role or name to match against — can't deterministically heal a text-only or
  // URL-only target.
  if (!target.role && !target.name) return null;

  const role = target.role ?? "";
  const name = target.name ?? "";
  if (!name.trim()) return null;
  // Normalize the target's name to the same lowercase/collapsed form findNameMatches applies
  // to element names, so exact comparisons (`en === name`) actually match "Submit" -> "submit".
  // ir.ts's bestNameMatch receives its name already normalized by its caller; here we do it
  // explicitly since this function is called directly.
  const normalizedName = norm(name);

  // Collect all elements from every page in the AppModel.
  const allElements: { element: Element; page: PageModel }[] = [];
  for (const page of appModel.pages) {
    for (const el of page.elements) {
      allElements.push({ element: el, page });
    }
  }

  // Pass 1: exact role match, tiered name match.
  const exactRoleMatches = findNameMatches(
    allElements.map((e) => e.element),
    normalizedName,
    (r) => areRolesCompatible(r, role),
  );

  // Pass 2: broader role group (clickable → clickable, input → input).
  let broaderMatches: NameMatch[] = [];
  if (exactRoleMatches.length === 0 || exactRoleMatches[0].tier > 1) {
    broaderMatches = findNameMatches(
      allElements.map((e) => e.element),
      normalizedName,
      (r) => {
        // Already checked exact+compatible in pass 1; now allow any interactive role
        // that shares a compatible group with the original role.
        for (const group of COMPATIBLE_ROLE_GROUPS) {
          if (group.has(norm(role)) && group.has(r)) return true;
        }
        return false;
      },
    );
  }

  const best = exactRoleMatches[0] ?? broaderMatches[0];
  if (!best) return null;

  // Don't "heal" to the exact same element — that means nothing changed. Compare against the
  // normalized target name (same form as `normalizedName`), since `norm(role)`/`norm(name)`
  // lowercases but does not necessarily equal the raw target casing.
  const sameRole = norm(best.element.role ?? "") === norm(role);
  const sameName = norm(best.element.name ?? "") === normalizedName;
  const sameCss = best.element.css === target.css;
  const sameTestId = best.element.testId === target.testId;
  if (sameRole && sameName && sameCss && sameTestId) return null;

  // Build the corrected target.
  const corrected: Target = { ...target };
  corrected.role = best.element.role ?? role;
  corrected.name = best.element.name ?? name;
  if (best.element.css) corrected.css = best.element.css;
  if (best.element.testId) corrected.testId = best.element.testId;
  // Clear nth if the match is unambiguous (single element of this role+name).
  if (best.tier <= 1) corrected.nth = undefined;

  const confidence: DeterministicHealResult["confidence"] =
    best.tier === 0 ? "exact" : best.tier <= 2 ? "strong" : "weak";

  const diffs = diffTargets(target, corrected);
  const changeDescription = diffs.length > 0
    ? diffs.map((d) => d.field + ': "' + (d.oldValue ?? "(none)") + '" => "' + (d.newValue ?? "(none)") + '"').join("; ")
    : "no structural changes";

  return {
    step: { ...step, target: corrected },
    matchedElement: best.element,
    confidence,
    changeDescription,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite-level: heal multiple failing steps across a suite
// ──────────────────────────────────────────────────────────────────────────────

export interface SuiteDeterministicHealResult {
  healedSteps: Array<{
    stepId: string;
    result: DeterministicHealResult;
  }>;
  unhealableStepIds: string[];
}

/**
 * Attempt deterministic healing for multiple failing steps in a suite run.
 * Each step is healed independently against the same AppModel.
 */
export function healSuiteSteps(
  steps: Step[],
  appModel: AppModel,
): SuiteDeterministicHealResult {
  const healedSteps: SuiteDeterministicHealResult["healedSteps"] = [];
  const unhealableStepIds: string[] = [];

  for (const step of steps) {
    const result = healStepTarget(step, appModel);
    if (result) {
      healedSteps.push({ stepId: step.id, result });
    } else {
      unhealableStepIds.push(step.id);
    }
  }

  return { healedSteps, unhealableStepIds };
}

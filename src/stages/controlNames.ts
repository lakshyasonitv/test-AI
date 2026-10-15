// Type-only, so no runtime cycle with testCases.ts (which imports this module).
import type { TestCase } from "./testCases.js";

/**
 * The control names a person wrote in their request, put back into the generated test cases
 * exactly as written (TD-127).
 *
 * The test-case prompt already says "keep the real element's name in quotes exactly", and the
 * model still paraphrased: run 2026-10-15T03-01-14's case turned "select for eoi" into "click the
 * control labelled 'Select' for EOI", and the IR stage then looked for a button named "Select".
 * A prompt rule is a preference (CLAUDE.md), so this is the check behind it: plain code over the
 * request's own text and the cases' text, run after generation.
 *
 * What counts as a name the person wrote, deliberately narrow so prose is never rewritten:
 *   - anything they QUOTED ('...', "...", ‘...’, “...”);
 *   - a phrase of two or more Capitalised words ("Min Budget (AED)", "Buying Timeline"), where an
 *     all-caps parenthesis like "(AED)" counts as a word;
 *   - one Capitalised word right before a control noun ("Next button", "Purpose combobox").
 * A lower-case name ("select for eoi") cannot be told apart from the sentence around it, so it is
 * NOT recovered — writing it as "Select for EOI" or quoting it is what makes it exact.
 *
 * What gets restored, in a case's steps and expected outcome:
 *   - the same words in different letter case -> the person's casing, but only inside quotes or
 *     right before a control noun, so "the next step" and "the phone number" (the digits) are left
 *     alone;
 *   - a name cut short inside quotes with the rest of it following ("'Select' for EOI") -> the
 *     whole name inside the quotes ("'Select for EOI'").
 */

const CONTROL_NOUN = "(?:button|textbox|text box|combobox|combo box|dropdown|drop-down|field|link|tab|checkbox|check box|radio|option|menu|box|picklist|input|toggle)";
const CAP_WORD = String.raw`(?:[A-Z][\p{L}\p{N}'&.-]*|\([A-Z]{2,}\))`;

/** The control names in a request, longest first, de-duplicated (exact text kept). */
export function extractControlNames(request: string): string[] {
  const out = new Set<string>();
  for (const m of request.matchAll(/'([^'\n]{2,60})'|"([^"\n]{2,60})"|‘([^’\n]{2,60})’|“([^”\n]{2,60})”/g)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    if (q) out.add(q);
  }
  // Two or more capitalised words in a row.
  for (const m of request.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])${CAP_WORD}(?:\s+${CAP_WORD})+(?![\p{L}\p{N}])`, "gu"))) {
    out.add(m[0].trim());
  }
  // One capitalised word right before a control noun.
  for (const m of request.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])([A-Z][\p{L}\p{N}-]*)\s+${CONTROL_NOUN}\b`, "gu"))) {
    out.add(m[1]);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whitespace-tolerant, case-insensitive pattern for a name's words. */
const wordsPattern = (words: string[]) => words.map(esc).join(String.raw`\s+`);
const B = String.raw`(?<![\p{L}\p{N}])`; // word start
const E = String.raw`(?![\p{L}\p{N}])`;  // word end

/** One piece of case text with every name restored. Pure; returns the text unchanged when nothing applies. */
export function restoreNamesInText(text: string, names: string[]): string {
  let s = text;
  for (const name of names) {
    const words = name.split(/\s+/);
    // A name cut short inside quotes, the rest following outside: 'Select' for EOI -> 'Select for EOI'.
    for (let k = 1; k < words.length; k++) {
      const head = wordsPattern(words.slice(0, k));
      const tail = wordsPattern(words.slice(k));
      s = s.replace(new RegExp(String.raw`(['"‘“])(${head})(['"’”])\s+${tail}${E}`, "giu"),
        (_m, open, _h, close) => `${open}${name}${close}`);
    }
    // Same words, other letter case — only where it is plainly the CONTROL being named: inside
    // quotes, or right before a control noun. In open prose "the phone number" is the digits, not
    // the "Phone Number" field, so it is left alone.
    const w = wordsPattern(words);
    const re = new RegExp(String.raw`(?<=['"‘“])${w}(?=['"’”])|${B}${w}(?=\s+${CONTROL_NOUN}\b)`, "giu");
    s = s.replace(re, (m) => (m === name ? m : name));
  }
  return s;
}

/** The cases with the request's control names restored, and how many texts changed. */
export function restoreControlNames(cases: TestCase[], request: string): { cases: TestCase[]; changed: number } {
  const names = extractControlNames(request);
  if (!names.length) return { cases, changed: 0 };
  let changed = 0;
  const fix = (t: string) => { const r = restoreNamesInText(t, names); if (r !== t) changed++; return r; };
  const out = cases.map((c) => ({
    ...c,
    steps: (c.steps ?? []).map(fix),
    ...(typeof c.expected === "string" ? { expected: fix(c.expected) } : {}),
  }));
  return { cases: out, changed };
}

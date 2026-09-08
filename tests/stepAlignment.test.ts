import { describe, it, expect } from "vitest";
import { formatIrStep, parseIrStep, parseIrSteps, estimateRegrounding } from "../src/stages/stepText.js";
import { IR, type Step } from "../src/schema/ir.js";

/**
 * Edited rows are paired with originals BY CONTENT, not by index — TECH_DEBT.md TD-90.
 *
 * THE DEFECT. `parseIrSteps` compared `texts[i]` with `originals[i]`. So deleting one row made
 * every row below it look changed: their grounding was stripped, they were queued for up to five
 * browser walks, and each inherited the id of the row that used to sit at its index. On the saved
 * "Admin creates a new user" case, deleting the `Wait briefly` at row 8:
 *
 *     changed = [8,9,10,11,12,13]   reground = [8..13]   snapshots = 5
 *     s10 -> s9,  s11 -> s10,  s12 -> s11,  s13 -> s12,  s14 -> s13,  s15 -> s14
 *
 * The id shift is the worse half: version history and failure reports then point at the wrong
 * step, permanently. Deleting a `Wait` cannot move any element — it should cost nothing.
 */

/** The saved case, written out rather than read from `runs/` (which is gitignored). */
const ADMIN_CASE = IR.parse({
  meta: {
    feature: "admin", title: "Admin creates a new user via management interface",
    priority: "high", sourcePrompt: "add a user", baseUrl: "https://learnvibes.vercel.app",
  },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com", css: "#u" }, value: "${env:TEST_USERNAME}" },
    { id: "s3", action: "fill", target: { role: "textbox", name: "*********", css: "#p" }, value: "${env:TEST_PASSWORD}" },
    { id: "s4", action: "click", target: { role: "button", name: "Sign In", css: "#signin" } },
    { id: "s5", action: "wait", value: "3000" },
    { id: "s6", action: "click", target: { role: "button", name: "Admin", css: "#admin" } },
    { id: "s7", action: "click", target: { role: "button", name: "Users", css: "#users" } },
    { id: "s8", action: "click", target: { role: "button", name: "Add New", css: "#addnew" } },
    { id: "s9", action: "wait", value: "2000" },
    { id: "s10", action: "fill", target: { role: "textbox", name: "Full Name", css: "#name" }, value: "test lakshay" },
    { id: "s11", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "test@thinkvibes.com" },
    { id: "s12", action: "select", target: { role: "combobox", name: "Manager", css: "#mgr" }, value: "prashant mishra" },
    { id: "s13", action: "select", target: { role: "combobox", name: "Role", css: "#role" }, value: "Learner" },
    { id: "s14", action: "click", target: { role: "button", name: "Save", css: "#save" } },
    { id: "s15", action: "assert", target: { text: "test lakshay" }, assertion: "text_contains", value: "test lakshay" },
  ],
});

const ORIGINALS = ADMIN_CASE.steps;
const ROWS = ORIGINALS.map((s) => formatIrStep(s));

/** Run an edit and report what it cost, plus which sentences kept their id. */
function edit(texts: string[]) {
  const r = parseIrSteps(texts, ORIGINALS);
  if (!r.ok) throw new Error(`parse failed at ${r.index}: ${r.error}`);
  const est = estimateRegrounding(r.result);
  return {
    steps: r.result.steps,
    ids: r.result.steps.map((s) => s.id),
    changed: r.result.changedIndexes,
    reground: r.result.regroundIndexes,
    snapshots: est.snapshots,
    instant: est.instant,
  };
}

/**
 * Every id that an UNCHANGED sentence carried before must still be carried by that same sentence
 * after. Compared as a set of (sentence -> id) pairs, because positions move by design.
 */
function idsPreservedForUnchanged(texts: string[], out: ReturnType<typeof edit>): string[] {
  const complaints: string[] = [];
  // Count how many times each sentence appears, so duplicates are compared as multisets.
  const beforeBySentence = new Map<string, string[]>();
  ROWS.forEach((t, i) => {
    const list = beforeBySentence.get(t) ?? [];
    list.push(ORIGINALS[i].id);
    beforeBySentence.set(t, list);
  });
  const afterBySentence = new Map<string, string[]>();
  texts.forEach((t, i) => {
    const list = afterBySentence.get(t) ?? [];
    list.push(out.ids[i]);
    afterBySentence.set(t, list);
  });
  for (const [sentence, afterIds] of afterBySentence) {
    const beforeIds = beforeBySentence.get(sentence);
    if (!beforeIds) continue;                       // a genuinely new sentence — nothing to keep
    const kept = afterIds.filter((id) => beforeIds.includes(id)).length;
    const expected = Math.min(afterIds.length, beforeIds.length);
    if (kept < expected) {
      complaints.push(`"${sentence.slice(0, 40)}": kept ${kept}/${expected} (${beforeIds} -> ${afterIds})`);
    }
  }
  return complaints;
}

describe("the 15 edit scenarios", () => {
  const scenarios: {
    name: string;
    texts: string[];
    changed: number[];
    reground: number[];
    instant?: boolean;
  }[] = [
    { name: "no-op", texts: [...ROWS], changed: [], reground: [], instant: true },
    {
      name: "value edit (same element)",
      texts: ROWS.map((t, i) => i === 9 ? `Type "someone else" into textbox "Full Name"` : t),
      changed: [9], reground: [], instant: true,
    },
    {
      name: "delete middle (a Wait — cannot move the page)",
      texts: ROWS.filter((_, i) => i !== 8),
      changed: [], reground: [], instant: true,
    },
    {
      name: "delete first (a navigate — everything below resolves elsewhere)",
      texts: ROWS.slice(1),
      changed: [], reground: Array.from({ length: 14 }, (_, i) => i),
    },
    {
      name: "delete last",
      texts: ROWS.slice(0, -1),
      changed: [], reground: [], instant: true,
    },
    {
      name: "delete a Wait AND edit a value below it",
      texts: ROWS.filter((_, i) => i !== 8).map((t, i) => i === 8 ? `Type "someone else" into textbox "Full Name"` : t),
      changed: [8], reground: [], instant: true,
    },
    {
      name: "append at the end",
      texts: [...ROWS, `Click on button "Done"`],
      changed: [15], reground: [15],
    },
    {
      name: "insert a non-page-changing row in the middle",
      texts: [...ROWS.slice(0, 9), "Wait briefly", ...ROWS.slice(9)],
      changed: [9], reground: [],
    },
    {
      // The copy is a genuinely NEW step: pass 1 gives the one original to the first occurrence,
      // and the second has no grounding of its own, so it has to be verified. Only the copy —
      // the original row and everything after it stay free.
      name: "duplicate a row",
      texts: [...ROWS.slice(0, 10), ROWS[9], ...ROWS.slice(10)],
      changed: [10], reground: [10],
    },
    {
      name: "role-word change (textbox -> combobox)",
      texts: ROWS.map((t, i) => i === 9 ? `Type "test lakshay" into combobox "Full Name"` : t),
      changed: [9], reground: [9],
    },
    {
      name: "retype an identical sentence",
      texts: ROWS.map((t, i) => i === 5 ? `${t}` : t),
      changed: [], reground: [], instant: true,
    },
    {
      name: "typo in an element name",
      texts: ROWS.map((t, i) => i === 5 ? `Click on button "Admn"` : t),
      changed: [5], reground: [5],
    },
  ];

  for (const sc of scenarios) {
    it(sc.name, () => {
      const out = edit(sc.texts);
      expect(out.changed, "changedIndexes").toEqual(sc.changed);
      expect(out.reground, "regroundIndexes").toEqual(sc.reground);
      if (sc.instant !== undefined) expect(out.instant, "instant").toBe(sc.instant);
      // The invariant that holds for every scenario: an unchanged sentence keeps its id.
      expect(idsPreservedForUnchanged(sc.texts, out)).toEqual([]);
    });
  }

  it("swap two adjacent rows", () => {
    // Both are page-changing clicks, so each now has a different set above it. Both re-ground.
    const texts = [...ROWS];
    [texts[5], texts[6]] = [texts[6], texts[5]];
    const out = edit(texts);
    expect(out.reground).toEqual([5, 6]);
    // Neither sentence changed, so neither may be renumbered.
    expect(idsPreservedForUnchanged(texts, out)).toEqual([]);
    expect(out.ids[5]).toBe("s7");
    expect(out.ids[6]).toBe("s6");
  });

  it("move a row up by four", () => {
    const texts = [...ROWS];
    const [moved] = texts.splice(13, 1);            // the Save click
    texts.splice(9, 0, moved);
    const out = edit(texts);
    expect(out.ids[9]).toBe("s14");                 // it is still the same step
    expect(idsPreservedForUnchanged(texts, out)).toEqual([]);
    expect(out.reground).toContain(9);              // it now runs at a different point
  });
});

describe("the delete-a-Wait case specifically — the one that was reported", () => {
  it("is instant, touches nothing, and renumbers nothing", () => {
    const texts = ROWS.filter((_, i) => i !== 8);
    const out = edit(texts);
    expect(out.changed).toEqual([]);
    expect(out.reground).toEqual([]);
    expect(out.snapshots).toBe(0);
    expect(out.instant).toBe(true);
    // The exact renumbering that used to happen, asserted as NOT happening.
    expect(out.ids).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s10", "s11", "s12", "s13", "s14", "s15"]);
  });

  it("keeps every surviving step byte-identical to the original object", () => {
    // Not merely the same id — the same `css`, the same `${env:...}` values, the same everything.
    const texts = ROWS.filter((_, i) => i !== 8);
    const out = edit(texts);
    for (const step of out.steps) {
      const original = ORIGINALS.find((s) => s.id === step.id);
      expect(step).toEqual(original);
    }
  });
});

describe("the round-trip guarantee still holds", () => {
  it("parseIrStep(formatIrStep(step), step) deep-equals step, for every step in the case", () => {
    // The contract EDITABLE_IR.md §2 is built on. Content matching supplies a base from a
    // different index, so this is exactly what could have broken.
    for (const step of ORIGINALS) {
      const r = parseIrStep(formatIrStep(step), step);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.step).toEqual(step);
    }
  });

  it("a leftover row whose text differs is treated as NEW, not parsed onto a wrong base", () => {
    // Pass 2 pairs positionally only when the rendering also matches. Pairing a differing row
    // with its positional original would resolve `text_contains` vs `text_equals`, a Wait's
    // millisecond value, and a Press's target from the wrong step — silently.
    const ambiguous = IR.parse({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://e.com" },
      steps: [
        { id: "s1", action: "wait", value: "9000" },
        { id: "s2", action: "assert", target: { text: "hello" }, assertion: "text_equals", value: "hello" },
      ],
    });
    const out = parseIrSteps([`Click on button "Totally Different"`, "Wait briefly"], ambiguous.steps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Row 1 is "Wait briefly", which DOES render-match s1 — so it keeps s1 and its 9000ms.
    expect(out.result.steps[1].id).toBe("s1");
    expect(out.result.steps[1].value).toBe("9000");
    // Row 0 matches nothing, so it is new: a fresh id, and no inherited assertion fields.
    expect(out.result.steps[0].id).not.toBe("s1");
    expect(out.result.steps[0].id).not.toBe("s2");
    expect(out.result.steps[0].assertion).toBeUndefined();
  });

  it("never emits a duplicate id", () => {
    const texts = [...ROWS.slice(0, 10), ROWS[9], ROWS[9], ...ROWS.slice(10)];
    const out = edit(texts);
    expect(new Set(out.ids).size).toBe(out.ids.length);
  });
});

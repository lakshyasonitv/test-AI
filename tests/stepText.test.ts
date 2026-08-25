import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatIrStep, parseIrStep, parseIrSteps, nextStepId } from "../src/stages/stepText.js";
import type { Step } from "../src/schema/ir.js";

/**
 * The IR <-> English mapping.
 *
 * Two things are pinned here, and they are the reason the case editor can be trusted:
 *
 *  1. THE ROUND TRIP. `parseIrStep(formatIrStep(step), step)` returns the step untouched, for
 *     every step of every real saved case. That identity is what makes an unedited line free —
 *     it is not re-derived, so its grounding, its `${env:...}` value and its `nth` all survive
 *     by construction rather than by the parser happening to reproduce them.
 *
 *  2. NO DRIFT WITH THE BROWSER. `public/app.js` has its own `formatIrStep` for display and
 *     cannot import the server's (classic script, no module surface). So this file extracts that
 *     copy from the file, evaluates it, and asserts it renders identically. Drift becomes a
 *     failing test instead of an editor that shows one sentence and parses another.
 *
 * The fixture is REAL data, copied out of the user's database — same convention as
 * tests/fixtures/irGroqToGeminiReplay. It carries the cases that matter: a `wait` whose
 * millisecond value the format drops, an id that is not `sN` ("literal-wait-3000"), a password
 * field whose accessible name is literally asterisks, `${env:...}` credential references, and a
 * page-level assertion with no target at all.
 */

interface SavedCase { title: string; ir: { steps: Step[] } }
const SAVED: SavedCase[] = JSON.parse(
  readFileSync(new URL("fixtures/stepText/savedCases.json", import.meta.url), "utf8"),
);
const ALL_STEPS: Step[] = SAVED.flatMap((c) => c.ir.steps);

/** Steps the fixture cannot cover, because no saved case happens to use them yet. */
const SYNTHETIC: Step[] = [
  { id: "y1", action: "check", target: { role: "checkbox", name: "Remember me" } },
  { id: "y2", action: "press", target: { role: "textbox", name: "Search" }, value: "Enter" },
  { id: "y3", action: "assert", assertion: "hidden", target: { role: "button", name: "Sign In" } },
  { id: "y4", action: "assert", assertion: "enabled", target: { role: "button", name: "Save" } },
  { id: "y5", action: "assert", assertion: "disabled", target: { role: "button", name: "Save" } },
  { id: "y6", action: "assert", assertion: "text_contains", value: "Payment" },
  { id: "y7", action: "assert", assertion: "text_equals", value: "Exactly this" },
  { id: "y8", action: "assert", assertion: "visible", target: { text: "Order complete" } },
  { id: "y9", action: "click", target: { role: "button", name: "Go", css: "#go", testId: "go-btn", nth: 2 } },
  { id: "y10", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "${env:TEST_USERNAME}" },
  { id: "y11", action: "click", target: { role: "link" } },
  { id: "y12", action: "navigate", target: { url: "/cart" } },
];

const CORPUS: Step[] = [...ALL_STEPS, ...SYNTHETIC];

describe("stepText — the round trip over real saved cases", () => {
  it("covers every step of every saved case in the fixture", () => {
    // Guards the guard: if the fixture were ever emptied, every case below would vacuously pass.
    expect(ALL_STEPS.length).toBeGreaterThanOrEqual(21);
    expect(SAVED.length).toBeGreaterThanOrEqual(2);
  });

  for (const [i, step] of CORPUS.entries()) {
    it(`step ${i} (${step.action}${step.assertion ? `/${step.assertion}` : ""}) survives format -> parse unchanged`, () => {
      const text = formatIrStep(step);
      const parsed = parseIrStep(text, step);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.step).toEqual(step);
      // and it must not be reported as an edit, or an untouched save would pay for a browser walk
      expect(parsed.changed).toBe(false);
    });
  }

  it("preserves a credential reference verbatim rather than resolving it", () => {
    const step = ALL_STEPS.find((s) => s.value?.startsWith("${env:"))!;
    expect(step).toBeTruthy();
    const parsed = parseIrStep(formatIrStep(step), step);
    expect(parsed.ok && parsed.step.value).toBe(step.value);
    expect(formatIrStep(step)).toContain("${env:");
  });

  it("keeps a wait's millisecond value, which the sentence drops entirely", () => {
    const wait = ALL_STEPS.find((s) => s.action === "wait" && s.value)!;
    expect(wait.value).toBeTruthy();
    expect(formatIrStep(wait)).toBe("Wait briefly");
    const parsed = parseIrStep("Wait briefly", wait);
    expect(parsed.ok && parsed.step.value).toBe(wait.value);
  });

  it("keeps grounded identity (css/testId/nth) that the sentence never shows", () => {
    const step = SYNTHETIC.find((s) => s.target?.css)!;
    expect(formatIrStep(step)).not.toContain("#go");
    const parsed = parseIrStep(formatIrStep(step), step);
    expect(parsed.ok && parsed.step.target).toEqual(step.target);
  });
});

describe("stepText — an edited line loses its grounding, which is what forces a re-check", () => {
  const grounded: Step = {
    id: "s1", action: "click",
    target: { role: "button", name: "Sign In", css: "#signin", testId: "signin", nth: 1 },
  };

  it("clears css/testId/nth when the target changes", () => {
    const parsed = parseIrStep(`Click on button "Log In"`, grounded);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.changed).toBe(true);
    expect(parsed.step.target).toEqual({ role: "button", name: "Log In" });
    // The stale ones are gone — a css that resolves to the element you just stopped describing
    // is worse than no css, because it silently succeeds against the wrong control.
    expect(parsed.step.target?.css).toBeUndefined();
    expect(parsed.step.target?.testId).toBeUndefined();
    expect(parsed.step.target?.nth).toBeUndefined();
  });

  it("keeps grounding when only the VALUE changes, since the element is the same", () => {
    const fill: Step = {
      id: "s2", action: "fill",
      target: { role: "textbox", name: "Email", css: "#email" }, value: "old@example.com",
    };
    const parsed = parseIrStep(`Type "new@example.com" into textbox "Email"`, fill);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.changed).toBe(true);          // it IS an edit
    expect(parsed.step.value).toBe("new@example.com");
    expect(parsed.step.target?.css).toBe("#email"); // but the element was never in question
  });

  it("keeps the step's id, because a failure report names it", () => {
    const parsed = parseIrStep(`Click on button "Something else"`, grounded);
    expect(parsed.ok && parsed.step.id).toBe("s1");
  });
});

describe("stepText — every sentence shape parses", () => {
  const cases: [string, Partial<Step>][] = [
    ["Go to /login", { action: "navigate", target: { url: "/login" } }],
    [`Click on button "Sign In"`, { action: "click", target: { role: "button", name: "Sign In" } }],
    [`Type "hi" into textbox "Email"`, { action: "fill", value: "hi" }],
    [`Choose "Learner" from combobox "Role"`, { action: "select", value: "Learner" }],
    [`Check checkbox "Remember me"`, { action: "check" }],
    ["Press the Enter key", { action: "press", value: "Enter" }],
    ["Wait briefly", { action: "wait" }],
    [`Check that button "Save" appears on the page`, { action: "assert", assertion: "visible" }],
    [`Check that button "Save" is not shown`, { action: "assert", assertion: "hidden" }],
    [`Check that button "Save" is enabled`, { action: "assert", assertion: "enabled" }],
    [`Check that button "Save" is disabled`, { action: "assert", assertion: "disabled" }],
    [`Check that the text "Payment" is displayed`, { action: "assert", assertion: "text_contains" }],
    [`Check the page address contains "/cart"`, { action: "assert", assertion: "url_contains" }],
    [`Check that text "Welcome" appears on the page`, { action: "assert", assertion: "visible" }],
  ];

  for (const [text, expected] of cases) {
    it(`parses: ${text}`, () => {
      const parsed = parseIrStep(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.step).toMatchObject(expected);
    });
  }

  it("refuses a sentence it cannot read, and says what it accepts", () => {
    const parsed = parseIrStep("frobnicate the widget");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("could not read");
    expect(parsed.error).toContain("Click on button");
  });

  it("refuses a blank step rather than storing an empty one", () => {
    expect(parseIrStep("   ").ok).toBe(false);
  });

  it("reads `Check that ...` as an assertion, never as the check action", () => {
    const parsed = parseIrStep(`Check that checkbox "Terms" appears on the page`);
    expect(parsed.ok && parsed.step.action).toBe("assert");
  });
});

describe("stepText — editing a whole list", () => {
  const originals: Step[] = [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email", css: "#e" }, value: "a@b.c" },
    { id: "s3", action: "click", target: { role: "button", name: "Sign In", css: "#s" } },
  ];
  const rendered = originals.map(formatIrStep);

  it("reports nothing changed when nothing changed", () => {
    const out = parseIrSteps(rendered, originals);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.changedIndexes).toEqual([]);
    expect(out.result.steps).toEqual(originals);
  });

  it("reports only the row that changed", () => {
    const edited = [...rendered];
    edited[1] = `Type "z@z.z" into textbox "Email"`;
    const out = parseIrSteps(edited, originals);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.changedIndexes).toEqual([1]);
  });

  it("treats an inserted step as changed and gives it a fresh id", () => {
    const edited = [...rendered.slice(0, 2), `Click on button "Extra"`, ...rendered.slice(2)];
    const out = parseIrSteps(edited, originals);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ids = out.result.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);   // no duplicates
    expect(ids).toContain("s4");                  // never reuses s1..s3
  });

  it("attributes a bad row to its index, so the editor can mark it", () => {
    const edited = [...rendered];
    edited[2] = "do something vague";
    const out = parseIrSteps(edited, originals);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.index).toBe(2);
  });

  it("refuses an empty list — a test with no steps is not a test", () => {
    const out = parseIrSteps([], originals);
    expect(out.ok).toBe(false);
  });

  it("never reuses an id, because ids name the failing step in a report", () => {
    expect(nextStepId([{ id: "s1" }, { id: "s7" }] as Step[])).toBe("s8");
    // Ignores ids that are not sN — the fixture has a real one ("literal-wait-3000").
    expect(nextStepId([{ id: "literal-wait-3000" }, { id: "s2" }] as Step[])).toBe("s3");
  });
});

describe("stepText — public/app.js's copy must not drift from this one", () => {
  /**
   * `public/app.js` is a classic script, so it cannot import the server's formatter. Rather than
   * accept two definitions that quietly diverge (TD-07's shape), extract its copy and prove it
   * renders identically. If someone edits one and not the other, this fails.
   */
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function formatIrStep(step)");
  const body = source.slice(start);
  // Balance braces from the function's opening one to find exactly where it ends.
  let depth = 0, end = -1;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const extracted = body.slice(0, end);
  // eslint-disable-next-line no-new-func
  const browserFormat = new Function(`${extracted}; return formatIrStep;`)() as (s: Step) => string;

  it("finds the browser's copy at all (guards this test from silently passing)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    expect(typeof browserFormat).toBe("function");
    expect(browserFormat({ id: "s1", action: "click", target: { role: "button", name: "X" } }))
      .toBe(`Click on button "X"`);
  });

  for (const [i, step] of CORPUS.entries()) {
    it(`renders step ${i} identically in browser and server`, () => {
      expect(browserFormat(step)).toBe(formatIrStep(step));
    });
  }
});

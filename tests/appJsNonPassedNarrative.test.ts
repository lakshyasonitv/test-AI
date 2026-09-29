import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "What happened" / "What the image shows" on the outcomes that are NOT `passed`.
 *
 * WHAT IT WAS. `loadCaseDetails` called `renderCaseNarrative` behind `status === "passed"`, so a
 * Blocked, Unconfirmed (`truncated_no_assertion`) or Partial (`truncated`) card rendered a badge,
 * a screenshot, and no words at all — the reader was shown a picture of a page with nothing
 * saying what ran or what they were looking at. `failed` stays excluded on purpose: it has its
 * own richer block (failing step + error + diagnosis), and rendering both would say the same
 * thing twice in two different voices.
 *
 * THE TWO TRAPS THIS PINS, which are why widening the gate is not a one-character change:
 *
 *  1. **"Here's what happened" is a lie on a truncated case.** Its IR is the surviving PREFIX —
 *     real steps were dropped before it ever executed. Introducing that list as what "happened"
 *     tells the reader the plan completed. Same class of overclaim as TD-101 (a failed case
 *     reported as passed), just in prose instead of a counter.
 *
 *  2. **A blocked case's screenshot is the WALL, not the test's final state.** It comes from
 *     `blockedScreenshot` (a captcha, a login gate, an IP block). `describeScreenshot` reads the
 *     IR's last step, so pointed at a blocked case it confidently narrates an assertion that is
 *     nowhere in the image — "The page showing X, confirming it appeared as expected" over a
 *     picture of a captcha.
 *
 * Extract-and-evaluate, the same technique as `tests/appJsProjectDelete.test.ts` and
 * `tests/stepText.test.ts`: `public/app.js` is a classic script with no module surface.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function extractFunctionSource(name: string): string {
  let start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public/app.js`);
  if (APP.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const body = APP.slice(start);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(0, i + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

/** The lead-in map and the blocked caption are consts, not functions — take them verbatim. */
function extractConst(name: string): string {
  const start = APP.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found in public/app.js`);
  const end = APP.indexOf("\n};", start) >= 0 && APP.indexOf("\n};", start) < APP.indexOf(";", APP.indexOf("=", start)) + 2
    ? APP.indexOf("\n};", start) + 3
    : APP.indexOf(";", APP.indexOf("=", start)) + 1;
  return APP.slice(start, end);
}

type Step = { id: string; action: string; target?: Record<string, unknown>; assertion?: string };

const harness = `
  ${extractConst("NARRATIVE_LEAD_IN")}
  ${extractConst("BLOCKED_IMAGE_DESC")}
  ${extractFunctionSource("formatIrStep")}
  ${extractFunctionSource("buildStepNarrative")}
  ${extractFunctionSource("describeScreenshot")}
  ${extractFunctionSource("renderCaseNarrative")}
  return { NARRATIVE_LEAD_IN, BLOCKED_IMAGE_DESC, buildStepNarrative, describeScreenshot, renderCaseNarrative };
`;

// eslint-disable-next-line no-new-func
const api = new Function("escapeHtml", harness)((s: string) => String(s));

/** A minimal stand-in for the container element renderCaseNarrative writes into. */
const fakeContainer = () => {
  const classes = new Set<string>(["hidden"]);
  return {
    innerHTML: "",
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      has: (c: string) => classes.has(c),
    },
    get hidden() { return classes.has("hidden"); },
  };
};

const STEPS: Step[] = [
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "click", target: { role: "button", name: "Open Menu" } },
];

const ASSERT_STEPS: Step[] = [
  ...STEPS,
  { id: "s3", action: "assert", assertion: "visible", target: { role: "link", name: "Git Pocket Guide" } },
];

// `null`, not `undefined`, for "no screenshot": passing `undefined` to a defaulted parameter
// re-triggers the default, so the no-image case would silently test the WITH-image path.
const render = (status: string, steps: Step[] = STEPS, screenshotUrl: string | null = "/shot.png") => {
  const el = fakeContainer();
  api.renderCaseNarrative(el, { screenshotUrl, whyItMatters: "" }, { steps }, status);
  return el;
};

describe("case narrative on non-passed outcomes", () => {
  it("renders for blocked, unconfirmed and partial — the whole point of the change", () => {
    for (const status of ["blocked", "truncated_no_assertion", "truncated"]) {
      const el = render(status);
      expect(el.hidden, `${status} rendered nothing`).toBe(false);
      expect(el.innerHTML, `${status} has no "What happened"`).toContain("What happened:");
      expect(el.innerHTML, `${status} has no image line`).toContain("What the image shows:");
    }
  });

  it("leaves `passed` wording exactly as it was — no existing card moves", () => {
    expect(api.buildStepNarrative(STEPS, "passed")).toMatch(/^Here's what happened: /);
    // And the default, for any caller that still omits the argument.
    expect(api.buildStepNarrative(STEPS, undefined)).toMatch(/^Here's what happened: /);
  });

  it("never claims a TRUNCATED case 'happened' — its IR is only the surviving prefix", () => {
    for (const status of ["truncated", "truncated_no_assertion"]) {
      const text = api.buildStepNarrative(STEPS, status);
      expect(text, `${status} overclaims`).not.toContain("Here's what happened");
      expect(text).toContain("actually ran");
    }
  });

  it("does not narrate a BLOCKED case as though the plan completed", () => {
    const text = api.buildStepNarrative(STEPS, "blocked");
    expect(text).not.toContain("Here's what happened");
    expect(text).toContain("stopped");
  });

  it("describes a blocked screenshot as the WALL, not as the IR's last assertion", () => {
    // The trap: describeScreenshot would say "confirming it appeared as expected" over a captcha.
    const viaIr = api.describeScreenshot(ASSERT_STEPS);
    expect(viaIr).toContain("confirming it appeared as expected");

    const el = render("blocked", ASSERT_STEPS);
    expect(el.innerHTML).toContain(api.BLOCKED_IMAGE_DESC);
    expect(el.innerHTML, "blocked card narrated an assertion its image does not show")
      .not.toContain("confirming it appeared as expected");
  });

  it("still uses the IR-grounded description for non-blocked outcomes", () => {
    const el = render("truncated", ASSERT_STEPS);
    expect(el.innerHTML).toContain("confirming it appeared as expected");
    expect(el.innerHTML).not.toContain(api.BLOCKED_IMAGE_DESC);
  });

  it("omits the image line when there is no screenshot, for every status", () => {
    for (const status of ["blocked", "truncated_no_assertion", "truncated", "passed"]) {
      const el = render(status, STEPS, null);
      expect(el.innerHTML, `${status} promised an image it does not have`)
        .not.toContain("What the image shows:");
      expect(el.innerHTML, `${status} lost its narrative`).toContain("What happened:");
    }
  });

  it("excludes `failed` from the map, so it keeps its own diagnosis block instead", () => {
    // The call site gates on `NARRATIVE_LEAD_IN[status]`, so membership IS the gate.
    expect(api.NARRATIVE_LEAD_IN.failed).toBeUndefined();
    expect(Object.keys(api.NARRATIVE_LEAD_IN).sort())
      .toEqual(["blocked", "passed", "truncated", "truncated_no_assertion"]);
  });

  it("the call site gates on the map, not on a hardcoded status list", () => {
    // Pins the wiring the unit tests above cannot see. A future edit that reverts this to
    // `status === "passed"` makes every assertion above pass while the product regresses.
    expect(APP).toMatch(/if \(NARRATIVE_LEAD_IN\[status\] && c\) renderCaseNarrative\(narrativeEl, c, ir, status\);/);
  });
});

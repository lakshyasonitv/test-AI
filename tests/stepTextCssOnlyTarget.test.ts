import { describe, it, expect } from "vitest";
import { formatIrStep, parseIrStep } from "../src/stages/stepText.js";
import { buildLoginPrefix } from "../src/stages/ir.js";
import type { Step } from "../src/schema/ir.js";

/**
 * A css-only target must render as the selector, not as the word "element".
 *
 * THE BUG, from a real saucedemo run the user pasted. Four of the five cases described their own
 * login as:
 *
 *   type "${env:TEST_USERNAME}" into element, type "${env:TEST_PASSWORD}" into element,
 *   click on element, check that element is not shown
 *
 * while case 1 — the only one whose targetUrl IS the login page, so `needsLoginPrefix` returned
 * false — read `textbox "Username"`. The difference is structural, not random: `buildLoginPrefix`
 * grounds every login step by css ALONE (`{ css: "#user-name" }`), deliberately, because those
 * selectors are captured live by `loginOnPage` and never derived from the model. `formatIrStep`
 * had no branch for that shape and fell through to the literal string "element".
 *
 * Confirmed against a real artifact before fixing — runs/2026-09-17T11-55-50-219Z-0a948aa9's
 * case-0 IR carries exactly `{"id":"auth-1","action":"fill","target":{"css":"#user-name"}}`.
 *
 * THE TRAP THIS TEST GUARDS. `stepText.ts`'s contract is `parseIrStep(formatIrStep(step), step)` —
 * parsing ONTO the original. `mergeTarget` compares role/name/text/url and, when they differ,
 * deletes every grounded field so grounding is forced to re-derive them. So a rendering that
 * parsed back as `{ name: "#user-name" }` would mark every untouched login line EDITED and strip
 * the very selector the login depends on. The selector must read back as "no semantic target",
 * exactly as "element" did.
 */

const loginPrefix = (): Step[] => buildLoginPrefix({
  status: "authenticated",
  loginUrl: "https://www.saucedemo.com/",
  loginSteps: [
    { action: "fill", css: "#user-name", credential: "username" },
    { action: "fill", css: "#password", credential: "password" },
    { action: "click", css: "#login-button" },
  ],
} as any);

describe("a css-only target names something", () => {
  it("renders the selector instead of the word element", () => {
    const rendered = loginPrefix().map(formatIrStep);
    expect(rendered).toEqual([
      "Go to https://www.saucedemo.com/",
      'Type "${env:TEST_USERNAME}" into #user-name',
      'Type "${env:TEST_PASSWORD}" into #password',
      "Click on #login-button",
      "Check that #password is not shown",
    ]);
    expect(rendered.join(" ")).not.toContain("element");
  });

  it("still keeps the grounding when the line is untouched", () => {
    // The whole point of the trap above. `changed` must be false and `css` must survive.
    for (const step of loginPrefix().slice(1)) {
      const back = parseIrStep(formatIrStep(step), step);
      expect(back.ok, `did not parse: ${formatIrStep(step)}`).toBe(true);
      if (!back.ok) continue;
      expect(back.changed, `${formatIrStep(step)} read as an edit`).toBe(false);
      expect(back.step.target?.css).toBe(step.target?.css);
    }
  });

  it("an attribute selector survives too, not just an id", () => {
    const step = { id: "s1", action: "click", target: { css: '[data-test="shopping-cart-link"]' } } as Step;
    const back = parseIrStep(formatIrStep(step), step);
    expect(formatIrStep(step)).toBe('Click on [data-test="shopping-cart-link"]');
    expect(back.ok && back.changed).toBe(false);
    expect(back.ok && back.step.target?.css).toBe('[data-test="shopping-cart-link"]');
  });

  it("css comes LAST, so a target with a role renders exactly as before", () => {
    // Moving css ahead of `role` would change what these sentences say, and parseTargetDesc would
    // then read the difference as an edit and clear the grounding off an untouched line.
    const step = { id: "s1", action: "click", target: { role: "button", css: "#x" } } as Step;
    expect(formatIrStep(step)).toBe("Click on button");
    const back = parseIrStep(formatIrStep(step), step);
    expect(back.ok && back.changed).toBe(false);
  });

  it("a real edit still clears the grounding", () => {
    // The negative direction: retargeting a login step by hand must NOT keep #user-name.
    const step = { id: "auth-1", action: "fill", target: { css: "#user-name" }, value: "x" } as Step;
    const back = parseIrStep('Type "x" into textbox "Username"', step);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.changed).toBe(true);
    expect(back.step.target?.css).toBeUndefined();
    expect(back.step.target?.name).toBe("Username");
  });
});

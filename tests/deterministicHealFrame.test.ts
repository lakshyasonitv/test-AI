import { describe, it, expect } from "vitest";
import { healStepTarget, diffTargets } from "../src/stages/deterministicHeal.js";
import { resolveCode } from "../src/stages/targetResolver.js";

/**
 * LS-5: the deterministic heal copied the matched element's `css` but kept the OLD step's `frame`,
 * pairing a selector with an iframe it does not live in. Only reachable with live-DOM discovery,
 * the one producer of `frame`.
 */
const model = (el: Record<string, unknown>): any => ({
  baseUrl: "https://x.test",
  pages: [{ url: "https://x.test/", title: "t", concepts: [], elements: [{ role: "button", name: "Save", visible: true, order: 0, ...el }] }],
});
const step = (target: Record<string, unknown>): any => ({ id: "s2", action: "click", target: { role: "button", name: "Save", ...target } });

describe("deterministic heal carries the matched element's frame (LS-5)", () => {
  it("drops the old frame when the element now lives in the top document", () => {
    const r = healStepTarget(step({ css: "#old-save", frame: "#f" }), model({ css: "#save" }))!;
    expect(r.step.target).not.toHaveProperty("frame");
    expect(resolveCode(r.step.target!, "click")).toBe('page.locator("#save").first()');
  });

  it("takes the new frame when the element now lives in an iframe", () => {
    const r = healStepTarget(step({ css: "#old-save" }), model({ css: "#save", frame: "#f" }))!;
    expect(r.step.target!.frame).toBe("#f");
    expect(resolveCode(r.step.target!, "click")).toBe('page.frameLocator("#f").locator("#save").first()');
  });

  it("reports a frame change in the change description", () => {
    const r = healStepTarget(step({ css: "#save", frame: "#f" }), model({ css: "#save", frame: "#g" }))!;
    expect(r.changeDescription).toContain('frame: "#f" => "#g"');
  });

  it("diffTargets sees a frame-only change", () => {
    expect(diffTargets({ css: "#a", frame: "#f" }, { css: "#a", frame: "#g" })).toEqual([
      { field: "frame", oldValue: "#f", newValue: "#g" },
    ]);
  });

  it("leaves a frameless heal exactly as before — no frame key appears", () => {
    const r = healStepTarget(step({ css: "#old-save" }), model({ css: "#save" }))!;
    expect(r.step.target).toEqual({ role: "button", name: "Save", css: "#save" });
  });
});

describe("the 'nothing changed' early return", () => {
  it("still returns null for the genuinely same element (same css, same frame)", () => {
    expect(healStepTarget(step({ css: "#save", frame: "#f" }), model({ css: "#save", frame: "#f" }))).toBeNull();
    expect(healStepTarget(step({ css: "#save" }), model({ css: "#save" }))).toBeNull();
  });
});

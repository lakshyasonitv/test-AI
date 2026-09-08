import { describe, it, expect } from "vitest";
import {
  healStepTarget,
  diffTargets,
  healSuiteSteps,
} from "../src/stages/deterministicHeal.js";
import type { AppModel, Element, PageModel } from "../src/schema/appModel.js";
import type { Step } from "../src/schema/ir.js";

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const el = (o: Partial<Element>): Element => ({
  role: "button",
  name: "Submit",
  ...o,
});

const page = (url: string, elements: Element[]): PageModel => ({
  url,
  title: "",
  concepts: [],
  elements,
});

const appModel = (elObjects: Element[]): AppModel => ({
  baseUrl: "https://x/",
  pages: [page("https://x/", elObjects)],
});

const step = (o: Partial<Step>): Step => ({
  id: "s2",
  action: "click",
  target: { role: "button", name: "Submit" },
  ...o,
});

// ──────────────────────────────────────────────────────────────────────────────
// healStepTarget — role+name re-matching
// ──────────────────────────────────────────────────────────────────────────────

describe("healStepTarget — role and name matching", () => {
  it("matches an exact role+name and copies css/testId grounding onto the corrected target", () => {
    const result = healStepTarget(step(), appModel([
      el({ role: "button", name: "Submit", css: "#submit", testId: "submit-btn" }),
    ]));
    expect(result).not.toBeNull();
    expect(result!.matchedElement.name).toBe("Submit");
    expect(result!.step.target!.css).toBe("#submit");
    expect(result!.step.target!.testId).toBe("submit-btn");
    expect(result!.confidence).toBe("exact");
  });

  it("heals a renamed element (substring match) with confidence 'weak'", () => {
    // "tt" is a substring of "button" that is neither a prefix nor suffix, forcing tier 3.
    const result = healStepTarget(step({ target: { role: "button", name: "tt" } }), appModel([
      el({ role: "button", name: "Button" }),
    ]));
    expect(result).not.toBeNull();
    expect(result!.step.target!.name).toBe("Button");
    expect(result!.confidence).toBe("weak");
  });

  it("heals a role change within a compatible group (link -> button)", () => {
    const result = healStepTarget(
      step({ target: { role: "link", name: "Continue" } }),
      appModel([el({ role: "button", name: "Continue", css: "#cont" })]),
    );
    expect(result).not.toBeNull();
    expect(result!.step.target!.role).toBe("button");
    expect(result!.step.target!.css).toBe("#cont");
  });

  it("returns null when no element matches the name at all", () => {
    const result = healStepTarget(step({ target: { role: "button", name: "Izzy" } }), appModel([
      el({ role: "button", name: "Submit" }),
    ]));
    expect(result).toBeNull();
  });

  it("returns null for a target with no role or name (text-only / URL-only)", () => {
    const result = healStepTarget(step({ target: { text: "hello" } }), appModel([el({})]));
    expect(result).toBeNull();
  });

  it("returns null when the only match is the exact same element (nothing to heal)", () => {
    const result = healStepTarget(
      step({ target: { role: "button", name: "Submit", css: "#submit" } }),
      appModel([el({ role: "button", name: "Submit", css: "#submit" })]),
    );
    expect(result).toBeNull();
  });

  it("matches across multiple pages in the AppModel", () => {
    const model: AppModel = {
      baseUrl: "https://x/",
      pages: [
        page("https://x/login", [el({ role: "button", name: "Log G" })]),
        page("https://x/dashboard", [el({ role: "button", name: "Log in", css: "#login" })]),
      ],
    };
    const result = healStepTarget(step({ target: { role: "button", name: "Log in" } }), model);
    expect(result).not.toBeNull();
    expect(result!.matchedElement.name).toBe("Log in");
  });

  it("returns null for a target with an empty name", () => {
    const result = healStepTarget(step({ target: { role: "button", name: "" } }), appModel([
      el({ role: "button", name: "Submit" }),
    ]));
    expect(result).toBeNull();
  });

  it("matches free-text hierarchy ignoring glyphs (tier 1 -> strong)", () => {
    const result = healStepTarget(
      step({ target: { role: "button", name: "Search" } }),
      appModel([el({ role: "button", name: "Search", css: "#s" })]),
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("exact");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// diffTargets
// ──────────────────────────────────────────────────────────────────────────────

describe("diffTargets", () => {
  it("reports only the fields that changed", () => {
    const diffs = diffTargets(
      { role: "link", name: "Old" },
      { role: "button", name: "New" },
    );
    expect(diffs).toEqual([
      { field: "role", oldValue: "link", newValue: "button" },
      { field: "name", oldValue: "Old", newValue: "New" },
    ]);
  });

  it("handles a missing old target", () => {
    const diffs = diffTargets(undefined, { role: "button", name: "New" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe("target");
  });

  it("returns empty for identical targets", () => {
    const diffs = diffTargets({ role: "button", name: "X" }, { role: "button", name: "X" });
    expect(diffs).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// healSuiteSteps
// ──────────────────────────────────────────────────────────────────────────────

describe("healSuiteSteps", () => {
  it("heals healable steps and reports the rest as unhealable", () => {
    const result = healSuiteSteps(
      [
        step({ id: "s1", target: { role: "button", name: "Subm" } }),
        step({ id: "s2", target: { role: "button", name: "Nope" } }),
        step({ id: "s3" }), // no target at all
      ],
      appModel([el({ role: "button", name: "Submit" })]),
    );
    expect(result.healedSteps.map((h) => h.stepId)).toEqual(["s1"]);
    expect(result.unhealableStepIds.sort()).toEqual(["s2", "s3"]);
  });
});

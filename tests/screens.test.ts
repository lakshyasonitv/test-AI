import { describe, it, expect } from "vitest";
import { AppModel } from "../src/schema/appModel.js";
import {
  screenFingerprint, sameScreen, mergeScreenInto, labelOverlap, screenCount, findScreen, fingerprintOf,
} from "../src/stages/screens.js";
import { groundingError, screenBoundaries } from "../src/stages/ir.js";

// Pure tests of the screen model (D-52). The real-browser flow is tests/multiScreenWizard.test.ts.

const URL = "https://org.example/lightning/o/Account/new";
const field = (name: string, extra: any = {}) => ({ role: "textbox", name, visible: true, ...extra });
const heading = (name: string) => ({ role: "heading", name, visible: true });
const page = (elements: any[], url = URL) => ({ url, title: "New Account", concepts: [], elements });
const model = (...pages: any[]) => AppModel.parse({ baseUrl: "https://org.example", pages });

const FIVE = [heading("New Account"), field("Name"), field("Phone"), field("Fax"), field("Website"), field("Email")];

describe("screen fingerprint", () => {
  it("is stable for the same screen and ignores element order", () => {
    const a = screenFingerprint(page(FIVE));
    const b = screenFingerprint(page([...FIVE].reverse()));
    expect(a.key).toBe(b.key);
    expect(a.title).toBe("new account");
    expect(a.labels).toEqual(["email", "fax", "name", "phone", "website"]);
  });

  it("an open dialog IS the screen: its name is the title and the page behind it is not counted", () => {
    const fp = screenFingerprint(page([
      field("Search", { pageSection: "header" }),
      heading("Accounts"),
      field("Filter list"),
      field("Last Name", { containerRole: "dialog", containerName: "New Contact" }),
      field("Email", { containerRole: "dialog", containerName: "New Contact" }),
    ]));
    expect(fp.title).toBe("new contact");
    expect(fp.labels).toEqual(["email", "last name"]);
  });

  it("hidden elements are not part of the screen", () => {
    const fp = screenFingerprint(page([heading("Step"), field("Shown"), field("Gone", { visible: false })]));
    expect(fp.labels).toEqual(["shown"]);
  });
});

describe("same screen, loosely", () => {
  const at = (els: any[], url = URL, tab = "") => ({ url, fp: screenFingerprint(page(els, url), tab) });

  it("one field removed from five is still the same screen (overlap 4/4 of the smaller set)", () => {
    expect(sameScreen(at(FIVE), at(FIVE.filter((e) => e.name !== "Email")))).toBe(true);
  });

  it("a wizard's next step — same heading, different fields — is a different screen", () => {
    const step2 = [heading("New Account"), field("Industry"), field("Employees"), field("Revenue")];
    expect(sameScreen(at(FIVE), at(step2))).toBe(false);
  });

  it("a different URL is never the same screen", () => {
    expect(sameScreen(at(FIVE), at(FIVE, "https://org.example/other"))).toBe(false);
  });

  it("a different title with the same fields is a different screen, unless the selected tab matches", () => {
    const renamed = [heading("Edit Account"), ...FIVE.slice(1)];
    expect(sameScreen(at(FIVE), at(renamed))).toBe(false);
    expect(sameScreen(at(FIVE, URL, "Details"), at(renamed, URL, "Details"))).toBe(true);
  });

  it("overlap is measured against the smaller label set", () => {
    expect(labelOverlap(["a", "b", "c"], ["a", "b", "c", "d"])).toBe(1);
    expect(labelOverlap(["a", "b"], ["c", "d"])).toBe(0);
    expect(labelOverlap([], [])).toBe(1);
    expect(labelOverlap(["a"], [])).toBe(0);
  });
});

describe("mergeScreenInto", () => {
  it("REMOVE A FIELD, RE-CAPTURE: the screen is replaced and the screen count stays the same", () => {
    const first = mergeScreenInto(model(), page(FIVE));
    expect(screenCount(first.model, URL)).toBe(1);
    const again = mergeScreenInto(first.model, page(FIVE.filter((e) => e.name !== "Email")));
    expect(screenCount(again.model, URL)).toBe(1);
    expect(again.replacedKey).toBe(first.key);
    // The fresh capture won: the removed field is gone, not kept as a stale twin.
    const names = again.model.pages.flatMap((p) => p.elements.map((e) => e.name));
    expect(names).not.toContain("Email");
    expect(findScreen(again.model, again.key)).toBeDefined();
    expect(findScreen(again.model, first.key)).toBeUndefined();
  });

  it("replaces a discovery page (no stored fingerprint) when the capture is the same screen", () => {
    const discovered = model(page(FIVE));
    expect(discovered.pages[0].screen).toBeUndefined();
    const merged = mergeScreenInto(discovered, page(FIVE));
    expect(merged.model.pages).toHaveLength(1);
    expect(merged.model.pages[0].screen?.key).toBe(merged.key);
  });

  it("adds the next screen of a wizard beside the first, keeping both", () => {
    const step2 = [heading("New Account"), field("Industry"), field("Employees")];
    const a = mergeScreenInto(model(page(FIVE)), page(step2));
    expect(a.replacedKey).toBeUndefined();
    expect(screenCount(a.model, URL)).toBe(2);
    expect(fingerprintOf(a.model.pages[0]).labels).toContain("name");
    expect(fingerprintOf(a.model.pages[1]).labels).toContain("industry");
  });

  it("leaves every page that is not a screen capture byte-identical", () => {
    const other = page([field("Q")], "https://org.example/search");
    const before = model(other);
    const merged = mergeScreenInto(before, page(FIVE));
    expect(merged.model.pages[0]).toEqual(before.pages[0]);
    expect("screen" in merged.model.pages[0]).toBe(false);
  });
});

describe("screen boundaries", () => {
  const ir = (steps: any[]) => ({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://org.example" }, steps }) as any;

  it("marks the first element step after a button click, skipping waits", () => {
    expect(screenBoundaries(ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "x" },
      { id: "s3", action: "click", target: { role: "button", name: "Next" } },
      { id: "s4", action: "wait", value: "500" },
      { id: "s5", action: "fill", target: { role: "textbox", name: "Industry" }, value: "y" },
      { id: "s6", action: "click", target: { role: "link", name: "Accounts" } },
      { id: "s7", action: "click", target: { role: "button", name: "New" } },
      { id: "s8", action: "fill", target: { role: "textbox", name: "Last Name" }, value: "z" },
    ]))).toEqual([4, 7]); // s7 follows a LINK click: trackPages and live-extend own that one
  });

  it("a text-only assertion after the last click needs no capture", () => {
    expect(screenBoundaries(ir([
      { id: "s1", action: "click", target: { role: "button", name: "Save" } },
      { id: "s2", action: "assert", target: { text: "was created" }, assertion: "visible" },
    ]))).toEqual([]);
  });
});

describe("groundingError — a step is grounded against its own screen", () => {
  const screen1 = page([heading("New Account"), field("Name", { css: "#name" }),
    { role: "button", name: "Next", visible: true, css: "#n1" }]);
  const screen2 = page([heading("New Account"), field("Industry", { css: "#industry" }),
    { role: "button", name: "Next", visible: true, css: "#n2" }]);
  const m1 = mergeScreenInto(model(), screen1);
  const m2 = mergeScreenInto(m1.model, screen2);
  const irOf = () => ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://org.example" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/lightning/o/Account/new" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "x" },
      { id: "s3", action: "click", target: { role: "button", name: "Next" } },
      { id: "s4", action: "fill", target: { role: "textbox", name: "Industry" }, value: "y" },
      { id: "s5", action: "click", target: { role: "button", name: "Next" } },
    ],
  }) as any;

  it("the second screen's Next binds to the second screen's button, not the first's", () => {
    const ir = irOf();
    const err = groundingError(ir, m2.model, { screenAt: [{ at: 3, key: m2.key }] });
    expect(err).toBeNull();
    expect(ir.steps[2].target.css).toBe("#n1");
    expect(ir.steps[4].target.css).toBe("#n2");
  });

  it("a selector from another screen is not accepted as grounded on this one", () => {
    const ir = irOf();
    ir.steps[4].target.css = "#n1"; // known to the model — but on screen 1
    expect(groundingError(ir, m2.model, { screenAt: [{ at: 3, key: m2.key }] })).toBeNull();
    expect(ir.steps[4].target.css).toBe("#n2");
  });

  it("a field missing from its screen is reported, even though another screen of the URL has it", () => {
    const ir = irOf();
    ir.steps[3].target.name = "Name"; // on screen 1 only
    const err = groundingError(ir, m2.model, { screenAt: [{ at: 3, key: m2.key }] });
    expect(err?.index).toBe(3);
  });

  it("an uncaptured boundary is reported in step order as screen-uncaptured", () => {
    const err = groundingError(irOf(), m2.model, { screenAt: [], captureBefore: new Set([3]) });
    expect(err).toMatchObject({ index: 3, kind: "screen-uncaptured" });
  });

  it("without a scope, grounding is unchanged: the merged pool can bind the WRONG Next", () => {
    // This is the defect the screens exist for, pinned so the test above is not vacuous.
    const ir = irOf();
    expect(groundingError(ir, m2.model)).toBeNull();
    expect(ir.steps[4].target.css).toBe("#n1");
  });
});

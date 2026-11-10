import { describe, it, expect } from "vitest";
import { nameFromAriaSnapshot } from "../src/stages/hybridDiscovery.js";

// Run 2026-11-10T06-11-58-646Z-12cc4157: a screen flow's fields came out of the walk as "input 23",
// "radio 0 24"; Playwright's accessibility snapshot of the same page has their real labels.
describe("nameFromAriaSnapshot", () => {
  const snapshot = [
    '- main:',
    '  - heading "Zq Onboarding Wizard" [level=1]',
    '  - textbox "*Zq Company Name"',
    '  - group "Zq Industry":',
    '    - radio "Zq Tech"',
    '    - radio "Zq Retail"',
    '  - spinbutton "Zq Revenue"',
    '  - button "Next"',
  ].join("\n");

  it("names made-up names by role and order, and leaves real names alone", () => {
    const els = [
      { role: "heading", name: "Zq Onboarding Wizard" },
      { role: "textbox", name: "input 23" },
      { role: "radio", name: "radio 0 24" }, { role: "radio", name: "radio 1 24" },
      { role: "spinbutton", name: "input 33" },
      { role: "button", name: "Next" },
    ];
    expect(nameFromAriaSnapshot(els, snapshot)).toBe(4);
    expect(els.map((e) => e.name)).toEqual(["Zq Onboarding Wizard", "*Zq Company Name", "Zq Tech", "Zq Retail", "Zq Revenue", "Next"]);
  });

  it("drops a positional selector from an element it names, keeps a plain one", () => {
    const els: { role: string; name: string; css?: string }[] = [
      { role: "textbox", name: "input 23", css: 'input[name="Zq_Company"]' },
      { role: "radio", name: "radio 0 24", css: "#flowContainer > article >> :scope > div > span:nth-of-type(1) > input" },
    ];
    nameFromAriaSnapshot(els, snapshot);
    expect(els[0].css).toBe('input[name="Zq_Company"]');
    expect(els[1]).toEqual({ role: "radio", name: "Zq Tech" });
  });

  it("does nothing without a snapshot, or when the snapshot has no name for that role", () => {
    const els = [{ role: "textbox", name: "input 23" }];
    expect(nameFromAriaSnapshot(els, "")).toBe(0);
    expect(nameFromAriaSnapshot(els, '- button "Next"')).toBe(0);
    expect(els[0].name).toBe("input 23");
  });
});

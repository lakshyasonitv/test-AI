import { describe, it, expect } from "vitest";
import { strengthenSaveOutcome, assertRecordTypeForms, deleteOutsideOwnRecord, fieldChecksOnRecordView } from "../src/stages/salesforceGuidance.js";
import { readFileSync } from "node:fs";
import type { IR, Step } from "../src/schema/ir.js";

const ir = (steps: Step[]): IR => ({ meta: { title: "t", sourcePrompt: "p", baseUrl: "https://x.example" }, steps } as unknown as IR);
const nav = (url: string): Step => ({ id: "n", action: "navigate", target: { url } } as Step);
const click = (name: string): Step => ({ id: "c", action: "click", target: { role: "button", name } } as Step);
const fill = (name: string, value: string): Step => ({ id: "f", action: "fill", target: { role: "textbox", name }, value } as Step);
const saveIs = (assertion: "hidden" | "visible"): Step => ({ id: "a", action: "assert", target: { role: "button", name: "Save" }, assertion } as Step);
const tail = (i: IR) => i.steps[i.steps.length - 1];

describe("strengthenSaveOutcome", () => {
  it("a create that ends on 'Save hidden' also asserts the 'was created' toast", () => {
    const i = ir([nav("https://x.example/lightning/o/Lead/new"), fill("Company", "Zq Co"), click("Save"), saveIs("hidden")]);
    expect(strengthenSaveOutcome(i)).toMatch(/was created/);
    expect(tail(i)).toMatchObject({ action: "assert", target: { text: "was created" }, assertion: "visible" });
    expect(i.steps[i.steps.length - 2]).toMatchObject({ target: { name: "Save" }, assertion: "hidden" });
  });

  it("an edit asserts 'was saved'; a form opened by clicking New asserts 'was created'", () => {
    const edit = ir([click("Edit"), fill("Phone", "1"), click("Save"), saveIs("hidden")]);
    strengthenSaveOutcome(edit);
    expect(tail(edit).target?.text).toBe("was saved");
    const viaNew = ir([click("New"), fill("Company", "Zq Co"), click("Save"), saveIs("hidden")]);
    strengthenSaveOutcome(viaNew);
    expect(tail(viaNew).target?.text).toBe("was created");
  });

  it("a refused save that ends on 'Save visible' also asserts Salesforce's error", () => {
    const i = ir([nav("https://x.example/lightning/o/Case/new"), fill("Subject", ""), click("Save"), saveIs("visible")]);
    strengthenSaveOutcome(i);
    expect(tail(i)).toMatchObject({ target: { text: "We hit a snag." }, assertion: "visible" });
  });

  it("leaves a case alone when it already checks a message, ends elsewhere, or the opener is unknown", () => {
    const checked = ir([nav("https://x.example/lightning/o/Lead/new"), click("Save"),
      { id: "m", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step, saveIs("hidden")]);
    expect(strengthenSaveOutcome(checked)).toBeNull();
    const endsOnText = ir([nav("https://x.example/lightning/o/Lead/new"), click("Save"),
      { id: "m", action: "assert", target: { text: "Bad phone" }, assertion: "visible" } as Step]);
    expect(strengthenSaveOutcome(endsOnText)).toBeNull();
    const unknownOpener = ir([click("Save"), saveIs("hidden")]);
    expect(strengthenSaveOutcome(unknownOpener)).toBeNull();
    expect(unknownOpener.steps).toHaveLength(2);
  });
});

// Run 2026-10-25T15-42-33-878Z-ef392788: every "TB Partner" case opened that record type's form,
// but asserted only "was created", which the DEFAULT form passes too.
describe("assertRecordTypeForms", () => {
  const org = { validationRulesRead: true, objects: [{ api: "Account", label: "Account", fields: [],
    recordTypes: [{ name: "Zq Retail", id: "012zq0000000001AAA", default: true }, { name: "Zq Partner", id: "012zq0000000002AAA" }] }] } as any;
  it("asserts the record type form's own header right after it opens", () => {
    const i = ir([nav("/lightning/o/Account/new?recordTypeId=012zq0000000002AAA&count=1"),
      { id: "w", action: "wait", value: "500" } as Step, fill("Account Name", "Zq Co"), click("Save"), saveIs("hidden")]);
    expect(assertRecordTypeForms(i, org)).toHaveLength(1);
    expect(i.steps[2]).toMatchObject({ action: "assert", target: { text: "New Account: Zq Partner" }, assertion: "visible" });
    // Run twice, added once.
    expect(assertRecordTypeForms(i, org)).toHaveLength(0);
  });
  it("adds nothing for the plain create form or an id the org model does not list", () => {
    const plain = ir([nav("/lightning/o/Account/new"), click("Save"), saveIs("hidden")]);
    const unknown = ir([nav("/lightning/o/Account/new?recordTypeId=012zq0000000009AAA"), click("Save"), saveIs("hidden")]);
    expect(assertRecordTypeForms(plain, org)).toEqual([]);
    expect(assertRecordTypeForms(unknown, org)).toEqual([]);
  });
});

// Phase A: a clone saves a NEW record ("was created"); a field's inline pencil ("Edit Phone") saves an
// existing one ("was saved"). Both used to fall through as an unknown opener and get no outcome.
describe("strengthenSaveOutcome: clone and inline edit", () => {
  it("a clone's Save expects 'was created'; an inline field edit's Save expects 'was saved'", () => {
    const clone = ir([nav("/lightning/o/Account/new"), click("Save"), click("Clone"), fill("Account Name", "Zq Copy"), click("Save"), saveIs("hidden")]);
    strengthenSaveOutcome(clone);
    expect(tail(clone).target?.text).toBe("was created");
    const inline = ir([nav("/lightning/o/Account/new"), click("Save"), click("Edit Phone"), fill("Phone", "5550100"), click("Save"), saveIs("hidden")]);
    strengthenSaveOutcome(inline);
    expect(tail(inline).target?.text).toBe("was saved");
  });
});

// Phase A: a quick action that creates a child ("New Contact") saves a NEW record; a delete ends on
// the confirm dialog's "Delete" and Salesforce answers "was deleted".
describe("strengthenSaveOutcome: quick action and delete", () => {
  it("a 'New Contact' quick action's Save expects 'was created'", () => {
    const qa = ir([nav("/lightning/o/Account/new"), click("Save"), click("New Contact"), fill("Last Name", "Zq"), click("Save"), saveIs("hidden")]);
    strengthenSaveOutcome(qa);
    expect(tail(qa).target?.text).toBe("was created");
  });
  it("a delete gains 'was deleted'; one already checking a message is left alone", () => {
    const del = ir([nav("/lightning/o/Account/new"), click("Save"), click("Delete"), click("Delete")]);
    expect(strengthenSaveOutcome(del)).toMatch(/was deleted/);
    expect(tail(del)).toMatchObject({ target: { text: "was deleted" }, assertion: "visible" });
    const checked = ir([nav("/lightning/o/Account/new"), click("Save"), click("Delete"), click("Delete"),
      { id: "m", action: "assert", target: { text: "was deleted" }, assertion: "visible" } as Step]);
    expect(strengthenSaveOutcome(checked)).toBeNull();
  });
});

// DATA SAFETY (Phase A): grounding replays steps in the real org, so only the record the case itself
// created may be deleted; anything else is refused before the replay.
describe("deleteOutsideOwnRecord", () => {
  const link = (name: string): Step => ({ id: "l", action: "click", target: { role: "link", name } } as Step);
  it("allows deleting the record the case just created, from the page its Save opened", () => {
    expect(deleteOutsideOwnRecord(ir([nav("/lightning/o/Account/new"), fill("Account Name", "Zq"), click("Save"),
      click("Delete"), click("Delete")]))).toBeNull();
    expect(deleteOutsideOwnRecord(ir([nav("/lightning/o/Account/new"), click("Save")]))).toBeNull();
  });
  it("refuses a delete with no create before it", () => {
    expect(deleteOutsideOwnRecord(ir([nav("/lightning/o/Account/list"), link("Zq Old Co"), click("Delete"), click("Delete")])))
      .toMatch(/did not create/);
  });
  it("refuses a delete reached by opening another record after the create", () => {
    expect(deleteOutsideOwnRecord(ir([nav("/lightning/o/Account/new"), click("Save"), nav("/lightning/o/Account/list"),
      click("Delete")]))).toMatch(/leaves the record/);
    expect(deleteOutsideOwnRecord(ir([nav("/lightning/o/Account/new"), click("Save"), link("Zq Old Co"),
      click("Delete")]))).toMatch(/leaves the record/);
  });
  it("runs in toIR before any grounding replay", () => {
    const src = readFileSync(new URL("../src/stages/ir.ts", import.meta.url), "utf8");
    const guard = src.indexOf("deleteOutsideOwnRecord(parsed.data)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("// Sign in BEFORE grounding."));
  });
});

describe("fieldChecksOnRecordView", () => {
  // Canary org: a record page with Related/Details tabs, and a create form whose field is an input.
  const model = { pages: [
    { url: "https://zq.lightning.force.com/lightning/o/Account/new", elements: [{ role: "textbox", name: "Zq Expiry" }] },
    { url: "https://zq.lightning.force.com/lightning/r/Account/001zq0000000001AAA/view", elements: [{ role: "tab", name: "Related" }, { role: "tab", name: "Details" }] },
  ] };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const fieldIs = (role: string, name: string, assertion = "visible"): Step => ({ id: "x", action: "assert", target: { role, name, css: "input[name=\"Zq__c\"]" }, assertion } as Step);
  const base = () => [nav("/lightning/o/Account/new"), fill("Account Name", "Zq"), click("Save"), created];

  it("a field checked after the Save becomes its label on the Details tab", () => {
    const i = ir([...base(), fieldIs("textbox", "Zq Expiry *")]);
    expect(fieldChecksOnRecordView(i, model)).toHaveLength(2);
    expect(i.steps.slice(-3).map((s) => [s.action, s.target?.role ?? s.target?.text ?? s.value, s.target?.name])).toEqual([
      ["click", "tab", "Details"], ["wait", "500", undefined], ["assert", "Zq Expiry", undefined],
    ]);
    expect(i.steps[i.steps.length - 1].target).toEqual({ text: "Zq Expiry" });
  });

  it("keeps a 'hidden' check, and clicks Details only once", () => {
    const i = ir([...base(), fieldIs("textbox", "Zq Expiry", "hidden"), fieldIs("combobox", "Zq Tier")]);
    fieldChecksOnRecordView(i, model);
    expect(i.steps.filter((s) => s.target?.name === "Details")).toHaveLength(1);
    expect(i.steps.slice(-2).map((s) => [s.target?.text, s.assertion])).toEqual([["Zq Expiry", "hidden"], ["Zq Tier", "visible"]]);
  });

  it("leaves alone: checks before the Save, value checks, inputs reopened by Edit, and no Details tab", () => {
    const before = ir([nav("/lightning/o/Account/new"), fieldIs("textbox", "Zq Expiry"), click("Save"), created]);
    expect(fieldChecksOnRecordView(before, model)).toEqual([]);
    const value = ir([...base(), fieldIs("textbox", "Zq Expiry", "text_equals")]);
    expect(fieldChecksOnRecordView(value, model)).toEqual([]);
    const reopened = ir([...base(), click("Edit Zq Expiry"), fieldIs("textbox", "Zq Expiry")]);
    expect(fieldChecksOnRecordView(reopened, model)).toEqual([]);
    const noTab = ir([...base(), fieldIs("textbox", "Zq Expiry")]);
    fieldChecksOnRecordView(noTab, { pages: [model.pages[0]] });
    expect(noTab.steps.some((s) => s.target?.name === "Details")).toBe(false);
    expect(noTab.steps[noTab.steps.length - 1].target).toEqual({ text: "Zq Expiry" });
  });

  it("is wired into IR generation", () => {
    expect(readFileSync("src/stages/ir.ts", "utf8")).toMatch(/fieldChecksOnRecordView\(parsed\.data, currentModel\)/);
  });
});

describe("fieldChecksOnRecordView: text checks of org fields", () => {
  const model = {
    pages: [{ url: "https://zq.lightning.force.com/lightning/r/Opportunity/006zq0000000001AAA/view", elements: [{ role: "tab", name: "Details" }] }],
    salesforceOrg: { objects: [{ fields: [{ label: "Amount" }], calculated: [{ label: "Zq Expected" }] }] },
  };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const textIs = (text: string): Step => ({ id: "t", action: "assert", target: { text }, assertion: "visible" } as Step);

  it("a field label checked as text after the Save opens the Details tab first", () => {
    const i = ir([nav("/lightning/o/Opportunity/new"), click("Save"), created, textIs("Zq Expected")]);
    fieldChecksOnRecordView(i, model);
    expect(i.steps.slice(-3).map((s) => s.target?.name ?? s.value ?? s.target?.text)).toEqual(["Details", "500", "Zq Expected"]);
  });

  it("other text (a related list, a toast) does not switch tabs", () => {
    const i = ir([nav("/lightning/o/Opportunity/new"), click("Save"), created, textIs("Contacts (1)")]);
    expect(fieldChecksOnRecordView(i, model)).toEqual([]);
  });
});

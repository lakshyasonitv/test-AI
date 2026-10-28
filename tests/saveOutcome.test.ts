import { describe, it, expect } from "vitest";
import {
  strengthenSaveOutcome, assertRecordTypeForms, deleteOutsideOwnRecord, fieldChecksOnRecordView, returnToCreatedRecords,
} from "../src/stages/salesforceGuidance.js";
import { recordRef } from "../src/stages/salesforceFrontdoor.js";
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

// Phase A (run 2026-10-26T07-23-21-344Z-9cd29004): create an Account, an Opportunity for it, then check
// the Account's roll-up. After the Opportunity's Save the flow went home and clicked a link named as it
// had typed the Account ("Test Account {{uid}}"), which no page shows: the case was cut there.
describe("returnToCreatedRecords", () => {
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const link = (id: string, name: string): Step => ({ id, action: "click", target: { role: "link", name } } as Step);
  const rollUp = (linkName: string) => ir([
    nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created,
    nav("/lightning/o/Zq_Child__c/new"), fill("Zq Child Name", "Zq Child {{uid}}"),
    { id: "lk", action: "select", target: { role: "combobox", name: "Zq Parent", lookup: true }, value: "Zq Parent {{uid}}" } as Step,
    click("Save"), created, nav("/"), link("back", linkName),
    { id: "v", action: "assert", target: { text: "Zq Total" }, assertion: "text_contains", value: "5,000" } as Step,
  ]);

  it("a click on the name the case typed for a record it created opens that record directly", () => {
    const i = rollUp("Zq Parent {{uid}}");
    expect(returnToCreatedRecords(i)).toHaveLength(1);
    expect(i.steps.find((s) => s.id === "back")).toEqual({ id: "back", action: "navigate", target: { url: recordRef("Zq_Parent__c", 1) } });
    // The child too: any object the case created.
    const child = rollUp("Zq Child {{uid}}");
    returnToCreatedRecords(child);
    expect(child.steps.find((s) => s.id === "back")?.target?.url).toBe(recordRef("Zq_Child__c", 1));
  });

  it("names WHICH of an object's records it created: a parent and a child of one object are told apart", () => {
    const two = (name: string) => ir([
      nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Parent {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Child {{uid}}"), click("Save"), created,
      nav("/"), link("back", name),
    ]);
    const parent = two("Zq Parent {{uid}}");
    returnToCreatedRecords(parent);
    expect(parent.steps.find((s) => s.id === "back")?.target?.url).toBe(recordRef("Zq_Acct__c", 1));
    const child = two("Zq Child {{uid}}");
    returnToCreatedRecords(child);
    expect(child.steps.find((s) => s.id === "back")?.target?.url).toBe(recordRef("Zq_Acct__c", 2));
    // Every saved create form of the object counts, named with a code or not: the spec counts them all.
    const plainFirst = ir([nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Plain"), click("Save"), created,
      nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Child {{uid}}"), click("Save"), created, nav("/"), link("back", "Zq Child {{uid}}")]);
    returnToCreatedRecords(plainFirst);
    expect(plainFirst.steps.find((s) => s.id === "back")?.target?.url).toBe(recordRef("Zq_Acct__c", 2));
  });

  it("a lookup typed with the parent's name in the child's form does not make the name the child's", () => {
    const lookupFill = (role: string) => ir([
      nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq P {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Child__c/new"), fill("Zq Child Name", "Zq K {{uid}}"),
      { id: "lk", action: "fill", target: { role, name: "Zq Parent" }, value: "Zq P {{uid}}" } as Step,
      click("Save"), created, nav("/"), link("back", "Zq P {{uid}}"),
    ]);
    for (const role of ["combobox", "textbox"]) {
      const i = lookupFill(role);
      expect(returnToCreatedRecords(i), role).toHaveLength(1);
      expect(i.steps.find((s) => s.id === "back")?.target?.url, role).toBe(recordRef("Zq_Parent__c", 1));
    }
    // A parent created where the pass cannot see it (its form opened by a "New" click): the lookup
    // still never makes its name the child's.
    const unseen = lookupFill("combobox");
    unseen.steps.splice(0, 1, click("New"));
    expect(returnToCreatedRecords(unseen)).toEqual([]);
  });

  it("leaves alone: another record's name, a name typed in a form never saved, a click before the Save", () => {
    const other = rollUp("Zq Old Parent");
    expect(returnToCreatedRecords(other)).toEqual([]);
    expect(other.steps.find((s) => s.id === "back")?.action).toBe("click");
    const unsaved = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), nav("/"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(unsaved)).toEqual([]);
    const plain = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Plain"), click("Save"), created, link("back", "Zq Plain")]);
    expect(returnToCreatedRecords(plain)).toEqual([]);
    // Inside the child's open form, before its Save: the parent's suggestion picked by its name.
    // Leaving the form there would leave the child unsaved.
    const pick: Step = { id: "pick", action: "click", target: { text: "Zq Parent {{uid}}" } } as Step;
    const inForm = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Child__c/new"),
      { id: "lk", action: "select", target: { role: "combobox", name: "Zq Parent", lookup: true }, value: "Zq Parent {{uid}}" } as Step,
      pick, click("Save")]);
    expect(returnToCreatedRecords(inForm)).toEqual([]);
    expect(inForm.steps.find((s) => s.id === "pick")).toEqual(pick);
    const firstInForm = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Child__c/new"), { id: "w", action: "wait", value: "500" } as Step, pick, click("Save")]);
    expect(returnToCreatedRecords(firstInForm)).toEqual([]);
  });

  it("leaves alone a click that finds the record in its list or a search: finding it may be the check", () => {
    const saved = [nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created];
    const inList = ir([...saved, nav("/lightning/o/Zq_Parent__c/list?filterName=Recent"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(inList)).toEqual([]);
    const searched = ir([...saved, fill("Search", "Zq Parent {{uid}}"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(searched)).toEqual([]);
    // The list reached the way the click-route guidance says: the object's tab in the navigation bar.
    const byTab = ir([...saved, link("tab", "Zq Parents"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(byTab)).toEqual([]);
    expect(byTab.steps.find((s) => s.id === "back")?.action).toBe("click");
  });

  it("the record opened again is a record page: its field value check is read inside the field", () => {
    const i = rollUp("Zq Parent {{uid}}");
    returnToCreatedRecords(i);
    const model = {
      pages: [{ url: "https://zq.lightning.force.com/lightning/r/Zq_Parent__c/a0Zzq0000000001AAA/view", elements: [{ role: "tab", name: "Details" }] }],
      salesforceOrg: { objects: [{ fields: [], calculated: [{ label: "Zq Total" }] }] },
    };
    fieldChecksOnRecordView(i, model);
    expect(i.steps.slice(-3).map((s) => [s.action, s.target?.name ?? s.value, s.target?.field])).toEqual([
      ["click", "Details", undefined], ["wait", "500", undefined], ["assert", "5,000", "Zq Total"],
    ]);
  });

  it("a delete after going back is still refused (it is not the page the Save opened)", () => {
    const i = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created,
      nav("/"), link("back", "Zq Parent {{uid}}"), click("Delete")]);
    returnToCreatedRecords(i);
    expect(deleteOutsideOwnRecord(i)).toMatch(/leaves the record/);
  });

  it("is wired into IR generation before the field checks", () => {
    const src = readFileSync("src/stages/ir.ts", "utf8");
    const back = src.indexOf("returnToCreatedRecords(parsed.data)");
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(src.indexOf("fieldChecksOnRecordView(parsed.data, currentModel)"));
  });
});

// Phase A: a field's VALUE on the record page, read inside that field ("Expected Revenue" shows
// "$100.00"), never as text anywhere on the page.
describe("fieldChecksOnRecordView: value checks", () => {
  const model = {
    pages: [{ url: "https://zq.lightning.force.com/lightning/r/Zq_Deal__c/a0Zzq0000000001AAA/view", elements: [{ role: "tab", name: "Details" }] }],
    salesforceOrg: { objects: [{ fields: [{ label: "Zq Heat", picklist: ["Zq Hot", "Zq Cold"] }, { label: "Zq Due" }], calculated: [{ label: "Zq Expected" }] }] },
  };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const base = () => [nav("/lightning/o/Zq_Deal__c/new"), fill("Zq Amount", "1000"), click("Save"), created];
  const check = (target: any, assertion: string, value?: string): Step => ({ id: "x", action: "assert", target, assertion, value } as Step);
  const last = (i: IR) => i.steps[i.steps.length - 1];

  it("a value check on a field's label or on its form control becomes a check of that field", () => {
    const byText = ir([...base(), check({ text: "Zq Expected" }, "text_contains", "$100.00")]);
    fieldChecksOnRecordView(byText, model);
    expect(last(byText)).toMatchObject({ target: { field: "Zq Expected" }, assertion: "text_contains", value: "$100.00" });
    expect(byText.steps.some((s) => s.target?.name === "Details")).toBe(true);
    const byControl = ir([...base(), check({ role: "spinbutton", name: "Zq Amount *", css: "input[name=\"Zq__c\"]" }, "text_equals", "1000")]);
    fieldChecksOnRecordView(byControl, model);
    expect(last(byControl).target).toEqual({ field: "Zq Amount" });
    expect(last(byControl).assertion).toBe("text_equals");
  });

  it("a bare value checked right after its field's label becomes that field's value check", () => {
    const amount = ir([...base(), check({ text: "Zq Expected" }, "visible"), { id: "w", action: "wait", value: "500" } as Step, check({ text: "$100.00" }, "visible")]);
    fieldChecksOnRecordView(amount, model);
    expect(last(amount)).toMatchObject({ target: { field: "Zq Expected" }, assertion: "text_contains", value: "$100.00" });
    const pick = ir([...base(), check({ text: "Zq Heat" }, "visible"), check({ text: "Zq Hot" }, "visible")]);
    fieldChecksOnRecordView(pick, model);
    expect(last(pick).target).toEqual({ field: "Zq Heat" });
    for (const shown of ["11/25/2026", "2026-11-25", "25.11.2026", "{{date:+30:en-US}}", "10%", "USD 5,000.00"]) {
      const due = ir([...base(), check({ text: "Zq Due" }, "visible"), check({ text: shown }, "visible")]);
      fieldChecksOnRecordView(due, model);
      expect(last(due), shown).toMatchObject({ target: { field: "Zq Due" }, value: shown });
    }
  });

  it("leaves alone: a bare value with no label before it, a toast or plain words after a label, a value with no value", () => {
    for (const steps of [
      [...base(), check({ text: "$100.00" }, "visible")],
      [...base(), check({ text: "Zq Expected" }, "visible"), check({ text: "was saved" }, "visible")],
      [...base(), check({ text: "Zq Expected" }, "visible"), check({ text: "Zq Notes" }, "visible")],
      [...base(), check({ text: "Zq Expected" }, "hidden"), check({ text: "$100.00" }, "visible")],
      [...base(), check({ text: "Zq Expected" }, "text_contains")],
      // Words with a digit in them are not a value: a related list's count heading.
      [...base(), check({ text: "Zq Expected" }, "visible"), check({ text: "Zq Children (1)" }, "visible")],
      // The label written as its own value is a presence check, as written: never a value of the field.
      [...base(), check({ text: "Zq Expected" }, "text_contains", "Zq Expected")],
      [...base(), check({ text: "Zq Expected" }, "text_equals", "expected")],
      [...base(), check({ role: "spinbutton", name: "Zq Amount *" }, "text_equals", "Zq Amount")],
    ]) {
      const i = ir(steps);
      const asWritten = structuredClone(steps[steps.length - 1]);
      fieldChecksOnRecordView(i, model);
      expect(i.steps.some((s) => s.target && "field" in s.target)).toBe(false);
      expect(last(i)).toEqual(asWritten);
    }
  });

  it("every Save that lands on a record page starts one, each with its own Details click", () => {
    const i = ir([...base(), check({ text: "Zq Expected" }, "text_contains", "$100.00"),
      nav("/lightning/o/Zq_Deal__c/new"), fill("Zq Amount", "2000"), click("Save"), created, check({ text: "Zq Expected" }, "text_contains", "$200.00")]);
    fieldChecksOnRecordView(i, model);
    expect(i.steps.filter((s) => s.target?.field).map((s) => s.value)).toEqual(["$100.00", "$200.00"]);
    expect(i.steps.filter((s) => s.target?.name === "Details").map((s) => s.id)).toEqual(["sf-details", "sf-details-2"]);
  });
});

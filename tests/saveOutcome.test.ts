import { describe, it, expect } from "vitest";
import {
  strengthenSaveOutcome, assertRecordTypeForms, deleteOutsideOwnRecord, fieldChecksOnRecordView, returnToCreatedRecords,
  requestedFieldChecks, deleteNamedRecord, flowEffectChecks, recordTabClicks,
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
  // Run 2026-11-10T06-03-48-658Z-ac13a6f8: "create an Account, an Opportunity for it, then delete the
  // Account" went back to the Account by its record reference and was refused.
  it("allows going back to a record this case created and saved, by its record reference only", () => {
    const back = (ref: string) => ir([nav("/lightning/o/Account/new"), click("Save"), nav("/lightning/o/Opportunity/new"), click("Save"),
      nav(ref), click("Delete"), click("Delete")]);
    expect(deleteOutsideOwnRecord(back("${record:Account:1}"))).toBeNull();
    // Never a record it did not create: a second Account it never saved, an object it never created.
    expect(deleteOutsideOwnRecord(back("${record:Account:2}"))).toMatch(/leaves the record/);
    expect(deleteOutsideOwnRecord(back("${record:Contact:1}"))).toMatch(/leaves the record/);
    expect(deleteOutsideOwnRecord(back("/lightning/r/Account/001zq0000000001AAA/view"))).toMatch(/leaves the record/);
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
  });

  // Run 2026-11-10T10-08-27-191Z-4830927e: no record page was modelled ("a high priority account"), so no
  // Details click, and Rating (on Details) was never found. With no record page known, the click is
  // inserted; the spec skips it where the page has none (generator.ts, sf-details).
  it("with no record page modelled at all, still opens Details (the spec skips it if absent)", () => {
    const noPage = ir([...base(), fieldIs("textbox", "Zq Expiry")]);
    fieldChecksOnRecordView(noPage, { pages: [model.pages[0]] });
    expect(noPage.steps.some((s) => s.target?.name === "Details")).toBe(true);
    expect(noPage.steps[noPage.steps.length - 1].target).toEqual({ text: "Zq Expiry" });
  });

  it("is wired into IR generation, with the request", () => {
    // With the request, and the case's own title and expected result (the bare-value rule reads both).
    const src = readFileSync("src/stages/ir.ts", "utf8");
    expect(src).toContain("fieldChecksOnRecordView(parsed.data, currentModel, sourcePrompt, `${testCase.title}");
    expect(src).toContain("${testCase.expected ?? \"\"}`)");
  });

  // Run 2026-11-03T07-31-20-798Z-dcc341ef: the record page was captured before its tabs drew, so the
  // model showed none, though the page has Related | Details; the field check never opened Details.
  it("a record page captured with no tabs at all still gets the Details click", () => {
    const i = ir([...base(), fieldIs("textbox", "Zq Expiry")]);
    fieldChecksOnRecordView(i, { pages: [model.pages[0], { url: model.pages[1].url, elements: [{ role: "button", name: "Edit" }] }] });
    expect(i.steps.filter((s) => s.target?.name === "Details")).toHaveLength(1);
  });

  it("a captured page whose tabs include no Details gets none", () => {
    const i = ir([...base(), fieldIs("textbox", "Zq Expiry")]);
    fieldChecksOnRecordView(i, { pages: [model.pages[0], { url: model.pages[1].url, elements: [{ role: "tab", name: "Related" }] }] });
    expect(i.steps.some((s) => s.target?.name === "Details")).toBe(false);
  });

  // Run 2026-11-03T08-18-32-287Z-885b1ba6: the roll-up was looked for on the Accounts LIST after the
  // flow went home and clicked the tab. It belongs to the Account this case created: open it first.
  it("a created record's field checked elsewhere opens that record first", async () => {
    const { checksOnCreatedRecord } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [
      { api: "Zq_Parent__c", fields: [{ label: "Zq Name" }], calculated: [{ label: "Zq Total" }] },
      { api: "Zq_Child__c", fields: [{ label: "Zq Amount" }] },
    ] };
    const textAt = (text: string, value: string): Step => ({ id: "c", action: "assert", target: { text }, assertion: "text_contains", value } as Step);
    const i = ir([
      nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Name", "Zq P {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Child__c/new"), fill("Zq Amount", "5000"), click("Save"), created,
      nav("/"), click("Zq Parents"), textAt("Zq Total", "5,000"),
    ]);
    expect(checksOnCreatedRecord(i, org)).toHaveLength(1);
    const k = i.steps.findIndex((s) => s.id === "sf-open-Zq_Parent__c");
    expect(i.steps[k].target?.url).toMatch(/Zq_Parent__c/);
    expect(i.steps[k + 1]).toMatchObject({ target: { text: "Zq Total" } });
    // Already on that record (its own Save landed there): nothing added.
    const here = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Name", "Zq P {{uid}}"), click("Save"), created, textAt("Zq Total", "0")]);
    expect(checksOnCreatedRecord(here, org)).toEqual([]);
    // Run 2026-11-03T09-46-16-921Z-04a94b10: a guessed list URL on the way, rejected by grounding.
    // The record is opened directly, so the way there goes, unless finding it is the request.
    const routed = () => ir([
      nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Name", "Zq P {{uid}}"), click("Save"), created,
      nav("/lightning/o/Zq_Child__c/new"), fill("Zq Amount", "5000"), click("Save"), created,
      nav("/lightning/o/Zq_Parent__c/list?filterName=__Recent"), click("Zq Parents"), textAt("Zq Total", "5,000"),
    ]);
    const direct = routed();
    checksOnCreatedRecord(direct, org, "verify the Zq Total shows 5,000");
    expect(direct.steps.some((s) => /list\?/.test(s.target?.url ?? "") || s.target?.name === "Zq Parents")).toBe(false);
    const finding = routed();
    checksOnCreatedRecord(finding, org, "check the Zq Parent appears in the list with Zq Total 5,000");
    expect(finding.steps.some((s) => /list\?/.test(s.target?.url ?? ""))).toBe(true);
  });

  // Run 2026-11-03T08-26-40-331Z-684ad8dc: the check on the roll-up came without its value 4 times.
  it("a value check with no value takes the one the request states after the label", async () => {
    const { valuesFromRequest } = await import("../src/stages/salesforceGuidance.js");
    const empty = (text: string): Step => ({ id: "v", action: "assert", target: { text }, assertion: "text_contains" } as Step);
    const i = ir([empty("Zq Total Amount")]);
    expect(valuesFromRequest(i, "verify the Account's Zq Total Amount shows 5,000")).toHaveLength(1);
    expect(i.steps[0].value).toBe("5,000");
    const quoted = ir([empty("Zq Status")]);
    valuesFromRequest(quoted, "and check Zq Status is 'Closed Won'");
    expect(quoted.steps[0].value).toBe("Closed Won");
    // Run 2026-11-03T09-52-32-235Z-e9e0149b: the label written with its object's name.
    const owned = ir([empty("Zq Parent's Zq Total Amount")]);
    valuesFromRequest(owned, "verify the Zq Parent's Zq Total Amount shows 5,000");
    expect(owned.steps[0].target?.text).toBe("Zq Total Amount");
    expect(owned.steps[0].value).toBe("5,000");
    const heading = ir([{ id: "h", action: "assert", target: { text: "Today's Zq Tasks" }, assertion: "visible" } as Step]);
    valuesFromRequest(heading, "p");
    expect(heading.steps[0].target?.text).toBe("Today's Zq Tasks");
    const none = ir([empty("Zq Total Amount")]);
    expect(valuesFromRequest(none, "verify the Zq Total Amount updates")).toEqual([]);
    expect(none.steps[0].value).toBeUndefined();
  });

  // Same run: the request said "the SLA field"; the writer checked "SLA Expiration Date". The org's
  // Dynamic Forms rule shows "SLA" only when Customer Priority = High: that is the field to check.
  it("checks the field the org's Dynamic Forms rule shows, when the request names it", () => {
    const textIs = (text: string): Step => ({ id: "t", action: "assert", target: { text }, assertion: "visible" } as Step);
    const org = { objects: [{ fields: [{ label: "Zq SLA" }, { label: "Zq SLA Expiry" }],
      visibilityRules: [{ target: "Zq SLA", when: "Zq Priority = High" }] }] };
    const i = ir([...base(), textIs("Zq SLA Expiry")]);
    fieldChecksOnRecordView(i, { ...model, salesforceOrg: org }, "Create an Account with Zq Priority High and verify the Zq SLA field is shown");
    expect(i.steps[i.steps.length - 1].target).toEqual({ field: "Zq SLA" });
    expect(i.steps.filter((s) => s.target?.name === "Details")).toHaveLength(1);
    const asked = ir([...base(), textIs("Zq SLA Expiry")]);
    fieldChecksOnRecordView(asked, { ...model, salesforceOrg: org }, "verify the Zq SLA Expiry field is shown");
    expect(asked.steps[asked.steps.length - 1].target).toEqual({ text: "Zq SLA Expiry" });
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

  // Run 2026-11-10T04-32-01-102Z-e4c449e4: a flow set Rating = Hot; the case checked getByText("Hot")
  // on the Related tab. The org's label is "Account Rating"; the page and the request say "Rating".
  describe("a bare picklist value of a field the request names", () => {
    const org = { objects: [{ fields: [
      { label: "Zqacct Zrating", picklist: ["Zhot", "Zwarm"] },
      { label: "Zq Priority", picklist: ["Zhigh", "Zlow"] },
      { label: "Zq Mood", picklist: ["Zhot"] },
    ] }] };
    const valueIs = (v: string): Step => ({ id: "v", action: "assert", target: { text: v }, value: v, assertion: "text_equals" } as Step);
    const run = (step: Step, request: string) => {
      const i = ir([nav("/lightning/o/Account/new"), click("Save"), created, step]);
      fieldChecksOnRecordView(i, { ...model, salesforceOrg: org }, request);
      return i.steps;
    };

    it("is read inside that field, under the label the request uses, on the Details tab", () => {
      const steps = run(valueIs("Zhot"), "Create an Account with Zq Priority Zhigh and verify its Zrating shows Zhot");
      expect(steps.slice(-3).map((s) => s.target?.name ?? s.value)).toEqual(["Details", "500", "Zhot"]);
      expect(steps[steps.length - 1]).toMatchObject({ target: { field: "Zrating" }, assertion: "text_contains", value: "Zhot" });
    });

    it("a visible check of the value is treated the same way", () => {
      const steps = run(textIs("Zhot"), "verify the Zqacct Zrating is Zhot");
      expect(steps[steps.length - 1]).toMatchObject({ target: { field: "Zqacct Zrating" }, value: "Zhot" });
    });

    it("takes the field from the object the record belongs to when another object has the same label", () => {
      // The real case: Lead also has a "Rating" field offering "Hot".
      const two = { objects: [
        { api: "Zlead", fields: [{ label: "Zrating", picklist: ["Zhot"] }] },
        { api: "Account", fields: [{ label: "Zqacct Zrating", picklist: ["Zhot"] }] },
      ] };
      const i = ir([nav("/lightning/o/Account/new"), click("Save"), created, valueIs("Zhot")]);
      fieldChecksOnRecordView(i, { ...model, salesforceOrg: two }, "verify its Zrating shows Zhot");
      expect(i.steps.at(-1)).toMatchObject({ target: { field: "Zrating" }, value: "Zhot" });
    });

    it("uses the object's word with the label when the request does (\"Lead Status\" for the org's \"Status\")", () => {
      const lead = { objects: [{ api: "Zlead", label: "Zlead", fields: [{ label: "Zstatus", picklist: ["Zopen", "Zworking"] }] }] };
      const i = ir([nav("/lightning/o/Zlead/new"), click("Save"), created, valueIs("Zworking")]);
      fieldChecksOnRecordView(i, { ...model, salesforceOrg: lead }, "verify its Zlead Zstatus shows Zworking");
      expect(i.steps.at(-1)).toMatchObject({ target: { field: "Zlead Zstatus" }, value: "Zworking" });
    });

    it("also when only the case's own expected result names the field (\"Test every branch of the flow\")", () => {
      const i = ir([nav("/lightning/o/Account/new"), click("Save"), created, valueIs("Zhot")]);
      fieldChecksOnRecordView(i, { ...model, salesforceOrg: org }, "Test every branch of the Zq Routing flow", "Zq branch\nthe Zrating shows Zhot");
      expect(i.steps.at(-1)).toMatchObject({ target: { field: "Zrating" }, value: "Zhot" });
    });

    it("is left alone when the request names no field offering it, or two do", () => {
      expect(run(valueIs("Zhot"), "verify Zhot is shown").at(-1)!.target).toEqual({ text: "Zhot" });
      expect(run(valueIs("Zhot"), "verify Zrating and Zq Mood show Zhot").at(-1)!.target).toEqual({ text: "Zhot" });
    });
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
    const finds = "Create a Zq Parent and check it appears in the Zq Parents list";
    expect(returnToCreatedRecords(inList, finds)).toEqual([]);
    const searched = ir([...saved, fill("Search", "Zq Parent {{uid}}"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(searched)).toEqual([]);
    // The list reached the way the click-route guidance says: the object's tab in the navigation bar.
    const byTab = ir([...saved, link("tab", "Zq Parents"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(byTab, finds)).toEqual([]);
    expect(byTab.steps.find((s) => s.id === "back")?.action).toBe("click");
  });

  // Run 2026-11-03T08-39-38-811Z-a28f4ed4: Home, the object's tab, then the new record's link, for a
  // check of its field. The request is not about finding it: the tabs were only the way there.
  it("opens the record when the tab clicks were only the way to it", () => {
    const saved = [nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created];
    const byTab = ir([...saved, link("home", "Home"), link("tab", "Zq Parents"), link("back", "Zq Parent {{uid}}")]);
    expect(returnToCreatedRecords(byTab, "Create a Zq Parent and verify its Zq Total shows 5,000")).toHaveLength(1);
    expect(byTab.steps.find((s) => s.id === "back")?.target?.url).toBe(recordRef("Zq_Parent__c", 1));
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

  // Was refused until run 2026-11-10T06-03-48-658Z-ac13a6f8 (delete an Account after creating an
  // Opportunity for it). The way back is a record reference, which resolves only to the record THIS
  // case's create form saved (SF_RECORD_PAGES_JS: "never one the flow opened"), so it is allowed; the
  // link it replaced, or any other path to a record, is still refused (deleteOutsideOwnRecord tests).
  it("a delete after going back by the record reference to its own record is allowed", () => {
    const i = ir([nav("/lightning/o/Zq_Parent__c/new"), fill("Zq Parent Name", "Zq Parent {{uid}}"), click("Save"), created,
      nav("/"), link("back", "Zq Parent {{uid}}"), click("Delete")]);
    returnToCreatedRecords(i);
    expect(i.steps.some((s) => s.target?.url === "${record:Zq_Parent__c:1}")).toBe(true);
    expect(deleteOutsideOwnRecord(i)).toBeNull();
  });

  it("is wired into IR generation before the field checks", () => {
    const src = readFileSync("src/stages/ir.ts", "utf8");
    const back = src.indexOf("returnToCreatedRecords(parsed.data, sourcePrompt)");
    expect(back).toBeGreaterThan(-1);
    expect(back).toBeLessThan(src.indexOf("fieldChecksOnRecordView(parsed.data, currentModel, sourcePrompt,"));
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

  it("a label and its value as one text is a check of that field; a section heading is not (run 2026-11-13T12-23-59-973Z-80c3f152)", () => {
    const i = ir([...base(), check({ text: "Zq Heat Zq Hot" }, "visible")]);
    fieldChecksOnRecordView(i, model, "Create a Zq Deal and verify the heat");
    expect(last(i)).toMatchObject({ target: { field: "Zq Heat" }, assertion: "text_contains", value: "Zq Hot" });
    const h = ir([...base(), check({ text: "Zq Heat Information" }, "visible")]);
    fieldChecksOnRecordView(h, model, "Create a Zq Deal");
    expect(last(h).target).toEqual({ text: "Zq Heat Information" });
  });
  it("a label-and-value text after the Details click stays on Details as that field's check (run 2026-11-13T13-50-37-642Z-f2f97e6d)", () => {
    const i = ir([...base(), { id: "dt", action: "click", target: { role: "tab", name: "Details" } } as Step, check({ text: "Zq Heat Zq Hot" }, "visible")]);
    fieldChecksOnRecordView(i, model, "Create a Zq Deal with heat Zq Hot");
    expect(i.steps.some((s) => s.target?.name === "Related")).toBe(false);
    expect(last(i)).toMatchObject({ target: { field: "Zq Heat" }, value: "Zq Hot" });
  });
  it("a value typed into an address part is checked inside the compound address (run 2026-11-13T12-58-06-198Z-0bdc663a)", () => {
    const i = ir([nav("/lightning/o/Zq_Deal__c/new"), fill("Billing Country", "Zqland"), click("Save"), created, check({ text: "Zqland" }, "text_equals", "Zqland")]);
    fieldChecksOnRecordView(i, model, "Create a Zq Deal billed in Zqland");
    expect(last(i)).toMatchObject({ target: { field: "Billing Address" }, assertion: "text_contains", value: "Zqland" });
  });
  it("a bare number the case typed into a field is checked inside that field (run 2026-11-13T12-02-09-298Z-fc1e4b67)", () => {
    const i = ir([nav("/lightning/o/Zq_Deal__c/new"), fill("Zq Amount", "1234.56"), click("Save"), created, check({ text: "1234.56" }, "text_contains", "1234.56")]);
    const m2 = { ...model, salesforceOrg: { objects: [{ fields: [{ label: "Zq Amount" }] }] } };
    fieldChecksOnRecordView(i, m2, "Create a Zq Deal with Zq Amount 1234.56");
    expect(last(i)).toMatchObject({ target: { field: "Zq Amount" }, assertion: "text_contains", value: "1234.56" });
  });
  it("a bare number the request gives a field becomes a check of that field (run 2026-11-13T07-31-06-677Z-c4484063)", () => {
    const i = ir([...base(), check({ text: "$100.00" }, "text_contains", "$100.00")]);
    fieldChecksOnRecordView(i, model, "Create a Zq Deal with Amount 1000 and verify Zq Expected is $100.00");
    expect(last(i)).toMatchObject({ target: { field: "Zq Expected" }, assertion: "text_contains", value: "$100.00" });
    expect(i.steps.some((s) => s.target?.name === "Details")).toBe(true);
    // Not named by the request: left alone.
    const j = ir([...base(), check({ text: "$100.00" }, "text_contains", "$100.00")]);
    fieldChecksOnRecordView(j, model, "Create a Zq Deal with Amount 1000");
    expect(last(j).target).toEqual({ text: "$100.00" });
  });

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

// Run 2026-11-10T05-05-39-201Z-52ce7aed: "verify its Rating shows Hot, its Lead Status shows Working -
// Contacted, and a Task ... appears": the steps checked only the Task.
describe("requestedFieldChecks", () => {
  const org = { objects: [
    { api: "Zlead", label: "Zlead", fields: [
      { label: "Zrating", picklist: ["Zhot", "Zcold"] }, { label: "Zstatus", picklist: ["Zopen", "Zworking - Zcontacted"] }, { label: "Zname" }] },
    { api: "Zacct", label: "Zacct", fields: [{ label: "Zacct Ztype", picklist: ["Zcustomer - Zdirect", "Zprospect"] }] },
    { api: "Zopp", label: "Zopp", fields: [{ label: "Ztype", picklist: ["Zcustomer - Zdirect"] }] },
  ] };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const textIs = (text: string): Step => ({ id: "t", action: "assert", target: { text }, assertion: "visible" } as Step);
  const lead = () => ir([nav("/lightning/o/Zlead/new"), click("Save"), created, textIs("Zcall the zhot lead")]);

  it("adds a check for each requested picklist value no step checks, under the request's label", () => {
    const i = lead();
    requestedFieldChecks(i, org, "Create a Zlead and verify its Zrating shows Zhot, its Zlead Zstatus shows Zworking - Zcontacted");
    // Right after the Save is confirmed, before the case's own later checks (the Task).
    expect(i.steps.slice(-3)).toEqual([
      { id: "sf-check-Zlead-Zstatus", action: "assert", target: { field: "Zlead Zstatus" }, assertion: "text_contains", value: "Zworking - Zcontacted" },
      { id: "sf-check-Zrating", action: "assert", target: { field: "Zrating" }, assertion: "text_contains", value: "Zhot" },
      { id: "t", action: "assert", target: { text: "Zcall the zhot lead" }, assertion: "visible" },
    ]);
  });

  // Run 2026-11-10T07-19-49-819Z-0ddc0b02: the Account's Type was checked before the Opportunity whose
  // flow sets it was saved, and again on the Opportunity's page.
  it("moves a requested check made before the last Save, or on another record, to after the last Save on its record", () => {
    const early = { id: "e", action: "assert", target: { field: "Ztype" }, assertion: "text_contains", value: "Zcustomer - Zdirect" } as Step;
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), created, early,
      nav("/lightning/o/Zopp/new"), click("Save"), created, textIs("Zq Onboarding")]);
    requestedFieldChecks(i, org, "Create a Zacct, then a Zopp for it, and verify the Zacct's Ztype shows Zcustomer - Zdirect and a Zq Onboarding case appears");
    expect(i.steps.some((s) => s.id === "e")).toBe(false);
    expect(i.steps.slice(-3).map((s) => s.target?.url ?? s.target?.field ?? s.target?.text))
      .toEqual(["${record:Zacct:1}", "Ztype", "Zq Onboarding"]);
  });

  it("adds nothing for a value already checked, a value that is no option, or a field only set", () => {
    const i = ir([nav("/lightning/o/Zlead/new"), click("Save"), created, { id: "v", action: "assert", target: { text: "Zhot" }, assertion: "visible" } as Step]);
    expect(requestedFieldChecks(i, org, "verify its Zrating shows Zhot")).toEqual([]);
    expect(requestedFieldChecks(lead(), org, "verify its Zrating shows Zlukewarm")).toEqual([]);
    expect(requestedFieldChecks(lead(), org, "Create a Zlead with Zrating Zhot and save it")).toEqual([]);
  });

  it("a field two saved objects share is checked only on the one the request names, which it opens", () => {
    const both = () => ir([nav("/lightning/o/Zacct/new"), click("Save"), created, nav("/lightning/o/Zopp/new"), click("Save"), created]);
    const named = both();
    requestedFieldChecks(named, org, "Create a Zacct and a Zopp, and verify the Zacct's Ztype shows Zcustomer - Zdirect");
    expect(named.steps.slice(-2).map((s) => s.target)).toEqual([{ url: "${record:Zacct:1}" }, { field: "Ztype" }]);
    expect(requestedFieldChecks(both(), org, "Create a Zacct and a Zopp, and verify the Ztype shows Zcustomer - Zdirect")).toEqual([]);
  });
});

// Run 2026-11-10T05-56-59-108Z-b85b16e9: the Account's Type was checked on Details, then the Case
// "TB Onboarding" was looked for there; related records show on the Related tab.
describe("fieldChecksOnRecordView: back to Related for a related record", () => {
  const model = {
    pages: [{ url: "https://zq.lightning.force.com/lightning/r/Zacct/001zq0000000001AAA/view", elements: [{ role: "tab", name: "Details" }, { role: "tab", name: "Related" }] }],
    salesforceOrg: { objects: [{ api: "Zacct", label: "Zacct", fields: [{ label: "Ztype", picklist: ["Zdirect"] }] }] },
  };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const fieldIs: Step = { id: "f", action: "assert", target: { field: "Ztype" }, assertion: "text_contains", value: "Zdirect" } as Step;
  const textIs = (text: string): Step => ({ id: "t", action: "assert", target: { text }, assertion: "visible" } as Step);

  it("clicks Related before text that is no field of the record, after Details", () => {
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), created, fieldIs, textIs("Zq Onboarding case")]);
    fieldChecksOnRecordView(i, model, "verify the Zacct's Ztype shows Zdirect and a case Zq Onboarding case appears");
    expect(i.steps.map((s) => s.target?.name ?? s.target?.field ?? s.target?.text ?? s.value).slice(-6))
      .toEqual(["Details", "500", "Ztype", "Related", "500", "Zq Onboarding case"]);
  });

  it("also clicks Related before a 'contains' check of such text", () => {
    const contains: Step = { id: "t", action: "assert", target: { text: "Zq Onboarding" }, assertion: "text_contains", value: "Zq Onboarding" } as Step;
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), created, fieldIs, contains]);
    fieldChecksOnRecordView(i, model, "verify the Zacct's Ztype shows Zdirect and a case Zq Onboarding appears");
    expect(i.steps.at(-3)?.target?.name).toBe("Related");
  });

  it("stays on Details for a field's option or a toast", () => {
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), created, fieldIs, textIs("Zdirect")]);
    fieldChecksOnRecordView(i, model, "verify Ztype shows Zdirect");
    expect(i.steps.some((s) => s.target?.name === "Related")).toBe(false);
  });
});

// Run 2026-11-10T06-30-57-251Z-32a03bc8: "create an Account, an Opportunity for it, then delete that
// Account": the step writer left out going back, and the delete ran on the Opportunity page.
describe("deleteNamedRecord", () => {
  const org = { objects: [{ api: "Zacct", label: "Zacct" }, { api: "Zopp", label: "Zopp" }] };
  const created: Step = { id: "o", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const flow = (...tail: Step[]) => ir([nav("/lightning/o/Zacct/new"), click("Save"), created,
    nav("/lightning/o/Zopp/new"), click("Save"), created, ...tail]);
  const menu = click("Show more actions");
  const del = click("Delete");

  it("opens the named record this case created before its actions menu, and the guard then allows it", () => {
    const i = flow(menu, del, click("Delete"));
    deleteNamedRecord(i, org, "Create a Zacct, then a Zopp for it, then delete that Zacct and verify the error");
    expect(i.steps.slice(-4).map((s) => s.target?.url ?? s.target?.name)).toEqual(["${record:Zacct:1}", "Show more actions", "Delete", "Delete"]);
    expect(deleteOutsideOwnRecord(i)).toBeNull();
  });

  it("reads a casual 'delete an <object>' too (run 2026-11-10T11-00-07-983Z-98a9fe31 deleted the Opportunity)", () => {
    const i = flow(menu, del, click("Delete"));
    deleteNamedRecord(i, org, "make sure nobody can delete an Zacct that still has open Zopps");
    expect(i.steps.at(-4)!.target?.url).toBe("${record:Zacct:1}");
  });

  it("goes back before the menu even with a wait between the menu and Delete", () => {
    const wait = { id: "w", action: "wait", value: "500" } as Step;
    const i = flow(menu, wait, del);
    deleteNamedRecord(i, org, "then delete that Zacct");
    expect(i.steps.slice(-4).map((s) => s.target?.url ?? s.target?.name ?? s.value)).toEqual(["${record:Zacct:1}", "Show more actions", "500", "Delete"]);
  });

  it("adds nothing when the flow is already on that record, or the request names no object it saved", () => {
    const on = ir([nav("/lightning/o/Zacct/new"), click("Save"), created, menu, del]);
    expect(deleteNamedRecord(on, org, "Create a Zacct and delete it")).toEqual([]);
    expect(deleteNamedRecord(flow(menu, del), org, "delete that Zthing")).toEqual([]);
  });

  it("takes the request's wording for the expected message when the model added quotes", () => {
    const i = flow(menu, del, { id: "e", action: "assert", target: { text: 'Zq: "This Zacct" cannot be deleted' }, assertion: "visible" } as Step);
    deleteNamedRecord(i, org, "delete that Zacct and verify the error Zq: This Zacct cannot be deleted is shown");
    expect(i.steps.at(-1)!.target).toEqual({ text: "Zq: This Zacct cannot be deleted" });
  });
});

describe("Enter on a create form", () => {
  it("becomes the form's Save click; an Enter after a Save stays", () => {
    const sel = { id: "p", action: "select", target: { name: "Priority" }, value: "High" } as Step;
    const enter = { id: "e", action: "press", value: "Enter" } as Step;
    const i = ir([nav("https://x.example/lightning/o/Case/new"), sel, enter, { id: "a", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step]);
    strengthenSaveOutcome(i);
    expect(i.steps[2]).toMatchObject({ action: "click", target: { role: "button", name: "Save" } });
    const j = ir([nav("https://x.example/lightning/o/Case/new"), click("Save"), { ...enter }]);
    strengthenSaveOutcome(j);
    expect(j.steps[2].action).toBe("press");
  });
});

describe("flowEffectChecks", () => {
  const org = {
    objects: [{ api: "Lead", label: "Lead", fields: [
      { label: "Industry", api: "Industry" }, { label: "Annual Revenue", api: "AnnualRevenue" },
      { label: "Rating", api: "Rating" }, { label: "Lead Status", api: "Status" }, { label: "Company", api: "Company" },
    ] }],
    flows: [{ label: "Zq Routing", object: "Lead", effects: [
      'branch "Hot": when Industry = Technology and AnnualRevenue >= 1000000 -> sets Rating = Hot, Status = Working; creates a Task "Zq Call now"',
      'branch "Default Outcome" (none of the above) -> sets Rating = Cold',
    ] }],
  };
  const sel = (name: string, value: string) => ({ id: "s", action: "select", target: { name }, value } as Step);
  const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  const lead = () => ir([nav("https://x.example/lightning/o/Lead/new"), fill("Company", "Zq Co"), sel("Industry", "Technology"), fill("Annual Revenue", "1500000"), click("Save"), created]);

  it("checks what the branch the typed values take sets and creates", () => {
    const i = lead();
    expect(flowEffectChecks(i, org, "As a rep I want hot tech leads marked hot with a call task")).toHaveLength(1);
    const added = i.steps.slice(6);
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { field: "Rating" }, value: "Hot" }),
      expect.objectContaining({ target: { field: "Lead Status" }, value: "Working" }),
      expect.objectContaining({ target: { text: "Zq Call now" } }),
    ]));
  });

  it("takes the default branch when no rule holds, and guesses nothing when a value is unknown", () => {
    const i = ir([nav("https://x.example/lightning/o/Lead/new"), sel("Industry", "Retail"), fill("Annual Revenue", "10"), click("Save"), created]);
    flowEffectChecks(i, org, "the lead should be rated cold");
    expect(i.steps.at(-1)).toMatchObject({ target: { field: "Rating" }, value: "Cold" });
    const j = ir([nav("https://x.example/lightning/o/Lead/new"), sel("Industry", "Technology"), click("Save"), created]);
    expect(flowEffectChecks(j, org, "the lead should be rated hot")).toEqual([]);
  });

  it("adds nothing when the request is not about the outcome, or it is already checked", () => {
    expect(flowEffectChecks(lead(), org, "create a lead")).toEqual([]);
    const i = lead();
    i.steps.push({ id: "x", action: "assert", target: { field: "Rating" }, assertion: "text_contains", value: "Hot" } as Step,
      { id: "y", action: "assert", target: { field: "Lead Status" }, assertion: "text_contains", value: "Working" } as Step,
      { id: "z", action: "assert", target: { text: "Zq Call now" }, assertion: "visible" } as Step);
    expect(flowEffectChecks(i, org, "rated hot")).toEqual([]);
  });
});

describe("recordTabClicks", () => {
  it("turns the model's Related/Details tab click into the record-tab click, and leaves other clicks", () => {
    const i = ir([{ id: "s9", action: "click", target: { css: "#relatedListTab__item" } } as Step,
      { id: "s10", action: "click", target: { role: "tab", name: "Details" } } as Step, click("Save")]);
    expect(recordTabClicks(i)).toHaveLength(2);
    expect(i.steps[0]).toMatchObject({ id: "sf-related-s9", target: { role: "tab", name: "Related" } });
    expect(i.steps[1]).toMatchObject({ id: "sf-details-s10", target: { role: "tab", name: "Details" } });
    expect(i.steps[2]).toMatchObject({ id: "c", target: { name: "Save" } });
  });
});

describe("inventedRecordLinks", () => {
  it("drops a link to a record no step typed, and what follows, once a check has run", async () => {
    const { inventedRecordLinks } = await import("../src/stages/salesforceGuidance.js");
    const typedName = { id: "f1", action: "fill", target: { name: "Opportunity Name" }, value: "Zq Deal {{uid}}" } as Step;
    const check = { id: "a1", action: "assert", target: { text: "Zq Onboarding" }, assertion: "visible" } as Step;
    const invented = { id: "c9", action: "click", target: { role: "link", name: "Zq Other {{uid}}" } } as Step;
    const i = ir([typedName, click("Save"), check, invented, { ...check, id: "a2" }]);
    expect(inventedRecordLinks(i)).toHaveLength(1);
    expect(i.steps.map((s) => s.id)).toEqual(["f1", "c", "a1"]);
    const typedLink = ir([typedName, check, { ...invented, target: { role: "link", name: "Zq Deal {{uid}}" } }]);
    expect(inventedRecordLinks(typedLink)).toEqual([]);
    const noCheckYet = ir([typedName, invented]);
    expect(inventedRecordLinks(noCheckYet)).toEqual([]);
  });
});

describe("requestedTextChecks", () => {
  const org = { objects: [{ api: "Zacct", label: "Zacct", fields: [{ label: "Ztype", api: "Ztype__c", type: "picklist" }] }] };
  const fieldCheck = { id: "f", action: "assert", target: { field: "Ztype" }, assertion: "text_contains", value: "Zq Direct" } as Step;
  it("adds a check for a value the request verifies that no step checks, after the last field check", async () => {
    const { requestedTextChecks } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), fieldCheck, nav("/lightning/o/Zacct/list")]);
    expect(requestedTextChecks(i, org as any, "Create a Zacct and verify its Ztype shows Zq Direct and a case Zq Onboarding Item appears")).toHaveLength(1);
    expect(i.steps[3]).toMatchObject({ action: "assert", target: { text: "Zq Onboarding Item" }, assertion: "visible" });
  });
  it("never adds a calculated field's name, and never ahead of the Save's confirmation", async () => {
    const { requestedTextChecks } = await import("../src/stages/salesforceGuidance.js");
    const calc = { objects: [{ ...org.objects[0], calculated: [{ label: "Zq Expected Gain" }] }] };
    const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), created]);
    expect(requestedTextChecks(i, calc as any, "Create a Zacct and verify Zq Expected Gain is $100.00")).toEqual([]);
    const k = ir([nav("/lightning/o/Zacct/new"), click("Save"), { id: "wt", action: "wait", value: "500" } as Step, created]);
    requestedTextChecks(k, org as any, "Create a Zacct and verify a case Zq Onboarding Item appears");
    expect(k.steps.map((s) => s.id)).toEqual(["n", "c", "wt", "w", "sf-req-Zq-Onboarding-Item"]);
  });
  it("adds nothing when every verified value is checked, or names a field", async () => {
    const { requestedTextChecks } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([nav("/lightning/o/Zacct/new"), click("Save"), fieldCheck]);
    expect(requestedTextChecks(i, org as any, "Create a Zacct and verify Ztype shows Zq Direct")).toEqual([]);
  });
});

describe("flowEffectChecks: a checkbox the flow ticks", () => {
  it("is not checked on screen (a layout may not show it); the API check reads it", async () => {
    const org = { objects: [{ api: "Zcase", label: "Zcase", fields: [{ label: "Zpri", api: "Zpri", type: "picklist" }, { label: "Zesc", api: "IsZesc", type: "boolean" }] }],
      flows: [{ label: "Zq Esc", object: "Zcase", effects: ["only when Zpri = High", "sets IsZesc = true"] }] };
    const i = ir([nav("/lightning/o/Zcase/new"), { id: "p", action: "select", target: { name: "Zpri" }, value: "High" } as Step, click("Save")]);
    flowEffectChecks(i, org, "high priority cases should be escalated automatically (Zq Esc)");
    expect(i.steps.some((s) => s.target?.field === "Zesc")).toBe(false);
    const { flowSetChecks, sameValue } = await import("../src/stages/salesforceOracles.js");
    expect(flowSetChecks(i, org as any)).toEqual([{ object: "Zcase", n: 1, values: [{ label: "Zesc", api: "IsZesc", type: "boolean", value: "true" }] }]);
    expect(sameValue("boolean", "true", true)).toBe(true);
  });
});

describe("noTokensInRuleFields", () => {
  it("keeps the unique code out of a field a validation rule reads, and leaves other fields", async () => {
    const { noTokensInRuleFields } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zlead", label: "Zlead", fields: [{ label: "Zco", api: "Company" }, { label: "Zlast", api: "LastName" }],
      validationRules: [{ name: "r", message: "m", condition: "LEN(Company) < 3" }] }] };
    const i = ir([nav("/lightning/o/Zlead/new"), fill("Zco", "AB {{uid}}"), fill("Zlast", "Zq {{uid}}"), click("Save")]);
    expect(noTokensInRuleFields(i, org as any)).toHaveLength(1);
    expect(i.steps[1].value).toBe("AB");
    expect(i.steps[2].value).toBe("Zq {{uid}}");
  });
});

describe("pathStageClicks", () => {
  const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Stage", api: "StageName", picklist: ["Zq One", "Zq Two"] }] }] };
  it("adds Mark as Current Stage after a path stage click, and requested checks go after it", async () => {
    const { pathStageClicks } = await import("../src/stages/salesforceGuidance.js");
    const pick = { id: "p", action: "select", target: { name: "Stage" }, value: "Zq One" } as Step;
    const echo = { id: "e", action: "assert", target: { text: "Stage Zq One" }, assertion: "visible" } as Step;
    const stage = { id: "s9", action: "click", target: { role: "button", name: "Zq Two" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), pick, echo, click("Save"), stage]);
    expect(pathStageClicks(i, org as any)).toHaveLength(2);
    expect(i.steps.map((s) => s.target?.name ?? s.value ?? s.id)).toEqual([undefined, "Stage", "Save", "Zq Two", "Mark as Current Stage", "1500"].map((x, k) => k === 0 ? i.steps[0].target?.name ?? i.steps[0].value ?? i.steps[0].id : x));
    expect(pathStageClicks(i, org as any)).toEqual([]);
  });
});

describe("seededLookups", () => {
  it("fills an empty lookup to a seeded object with the seeded record's name", async () => {
    const { seededLookups } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zcon", label: "Zcon", fields: [{ label: "Zacct ID", api: "AccountId", lookup: "Zacct" }] }],
      seeded: [{ object: "Zacct", label: "Zacct", name: "TB Seed ab12cd" }] };
    const look = { id: "l", action: "select", target: { role: "combobox", name: "Zacct Name", lookup: true }, value: "" } as Step;
    const i = ir([nav("/lightning/o/Zcon/new"), look, click("Save")]);
    expect(seededLookups(i, org as any)).toHaveLength(2);
    expect(i.steps[1].value).toBe("TB Seed ab12cd");
    expect(i.steps.at(-1)).toMatchObject({ target: { text: "TB Seed ab12cd" }, assertion: "visible" });
  });
});

describe("the record tracker counts a Clone as a new record", () => {
  it("names the copy by the record it was cloned from", async () => {
    const { recordPages } = await import("../src/stages/salesforceFrontdoor.js");
    const t = recordPages();
    t.visit("https://x.example/lightning/r/Opportunity/006zq0000000001AAA/view");
    t.visit("https://x.example/lightning/r/Opportunity/006zq0000000001AAA/clone");
    t.visit("https://x.example/lightning/r/Opportunity/006zq0000000002AAA/view");
    expect(t.made()).toEqual({ Opportunity: ["006zq0000000002AAA"] });
  });
});

describe("pathStageClicks: the stage the request names", () => {
  const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Stage", api: "StageName", picklist: ["Zq One", "Zq Two", "Closed Won"] }] }] };
  it("turns Mark Stage as Complete into the way to the named stage, through the Closed dialog for a closing one", async () => {
    const { pathStageClicks } = await import("../src/stages/salesforceGuidance.js");
    const mark = { id: "m", action: "click", target: { role: "button", name: "Mark Stage as Complete" } } as Step;
    const closed = ir([nav("/lightning/o/Zopp/new"), click("Save"), mark]);
    pathStageClicks(closed, org as any, "Create a Zopp with Stage Zq One, then use the path to close it as Closed Won");
    expect(closed.steps.slice(2).map((s) => s.target?.name ?? s.value)).toEqual(["Closed", "Select Closed Stage", "1000", "Stage", "Save", "1500"]);
    expect(closed.steps[5].value).toBe("Closed Won");
    const open = ir([nav("/lightning/o/Zopp/new"), click("Save"), { ...mark }]);
    pathStageClicks(open, org as any, "use the path to move it to Zq Two");
    expect(open.steps.slice(2).map((s) => s.target?.name ?? s.value)).toEqual(["Zq Two", "Mark as Current Stage", "1500"]);
  });
});

describe("placeholderMessages", () => {
  it("checks the whole message with the typed value in place of <Field>", async () => {
    const { placeholderMessages } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([fill("Zlast", "Doe {{uid}}"), click("Next"), { id: "a", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step]);
    expect(placeholderMessages(i, "enter a Zlast, click Next, and verify the message Zcontact <Zlast> was created")).toHaveLength(1);
    expect(i.steps[2]).toMatchObject({ target: { text: "was created" }, assertion: "text_contains", value: "Zcontact Doe {{uid}} was created" });
    expect(placeholderMessages(i, "verify the message Zcontact <Zother> was created")).toEqual([]);
  });
});

describe("eventRecordSearch", () => {
  it("finds a record a published event's flow made through global search, once", async () => {
    const { eventRecordSearch } = await import("../src/stages/salesforceGuidance.js");
    const org = { flows: [{ label: "Zq Ev", api: "Zq_Ev", type: "platform-event", effects: ['creates a Account "TB Event ab12cd"'] }] };
    const check = { id: "a", action: "assert", target: { text: "TB Event ab12cd" }, assertion: "visible" } as Step;
    const i = ir([click("Zq List"), check]);
    expect(eventRecordSearch(i, org as any)).toHaveLength(1);
    expect(i.steps.map((s) => s.id)).toEqual(["c", "sf-ev-home", "sf-ev-search", "sf-ev-wait", "sf-ev-type", "sf-ev-enter", "sf-ev-wait2", "a"]);
    expect(eventRecordSearch(i, org as any)).toEqual([]);
  });
});

describe("pathStageClicks: a direct click on a closing stage", () => {
  it("goes through the Closed dialog instead of Mark as Current Stage", async () => {
    const { pathStageClicks } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Stage", api: "StageName", picklist: ["Zq One", "Closed Won"] }] }] };
    const won = { id: "s13", action: "click", target: { role: "button", name: "Closed Won" } } as Step;
    const markIt = { id: "m", action: "click", target: { role: "button", name: "Mark as Current Stage" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), won, markIt]);
    pathStageClicks(i, org as any, "");
    expect(i.steps.slice(2).map((s) => s.target?.name ?? s.value)).toEqual(["Closed", "Select Closed Stage", "1000", "Stage", "Save", "1500"]);
    expect(i.steps[5].value).toBe("Closed Won");
  });
});

describe("pathStageClicks: no path step at all", () => {
  it("adds the path steps right after the confirmed Save", async () => {
    const { pathStageClicks } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Stage", api: "StageName", picklist: ["Zq One", "Closed Won"] }] }] };
    const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
    const check = { id: "k", action: "assert", target: { field: "Stage" }, assertion: "text_contains", value: "Closed Won" } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), created, check]);
    pathStageClicks(i, org as any, "Create a Zopp with Stage Zq One, then use the path to close it as Closed Won");
    expect(i.steps.map((s) => s.target?.name ?? s.target?.field ?? s.target?.text ?? s.value)).toEqual(
      [undefined, "Save", "was created", "Closed", "Select Closed Stage", "1000", "Stage", "Save", "1500", "Stage"]);
  });
});

describe("leadConvertSteps", () => {
  it("scopes the second Convert to the dialog and checks Salesforce's converted message", async () => {
    const { leadConvertSteps } = await import("../src/stages/salesforceGuidance.js");
    const conv = (id: string) => ({ id, action: "click", target: { role: "button", name: "Convert" } } as Step);
    const i = ir([conv("a"), conv("b"), { id: "x", action: "assert", target: { text: "Converted" }, assertion: "visible" } as Step]);
    expect(leadConvertSteps(i)).toHaveLength(2);
    expect(i.steps[1].target?.css).toContain("role=dialog");
    expect(i.steps[2].target?.text).toBe("Your lead has been converted");
    expect(leadConvertSteps(ir([conv("a")]))).toEqual([]);
  });
});

describe("calculatedFieldReads", () => {
  it("turns a check of a calculated field's label into a read of its value", async () => {
    const { calculatedFieldReads } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [], calculated: [{ label: "Zq Expected", api: "Zq_Exp__c", type: "Currency" }] }] };
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), { id: "s9", action: "assert", target: { text: "Zq Expected" }, assertion: "visible" } as Step]);
    expect(calculatedFieldReads(i, org as any)).toHaveLength(1);
    expect(i.steps[2]).toMatchObject({ id: "sf-calc-s9", target: { field: "Zq Expected" }, assertion: "visible" });
  });
});

describe("approvalSteps", () => {
  const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Description", api: "Description" }] }],
    approvals: [{ label: "Zq Big Deal", api: "Zq_Big_Deal", object: "Zopp" }] };
  const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
  it("adds submit, the decision and the requested check after the confirmed Save, replacing what followed", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const junk = { id: "j", action: "assert", target: { text: "Zq Approved" }, assertion: "visible" } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), created, junk]);
    expect(approvalSteps(i, org as any, "Create a Zopp, submit it for approval, then approve it and verify its Description shows Zq Approved")).toHaveLength(1);
    const ids = i.steps.map((s) => s.id);
    expect(ids).not.toContain("j");
    expect(ids).toEqual(expect.arrayContaining(["sf-ap-submit", "sf-ap-send", "sf-ap-decide", "sf-ap-confirm", "sf-ap-check-Description"]));
    expect(i.steps.find((s) => s.id === "sf-ap-decide")?.target?.name).toBe("Approve");
    expect(i.steps.at(-1)).toMatchObject({ target: { field: "Description" }, value: "Zq Approved" });
  });
  it("rejects when asked, submits only when no decision is asked, and adds nothing without a submit", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const r = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(r, org as any, "submit it for approval, then reject it");
    expect(r.steps.find((s) => s.id === "sf-ap-decide")?.target?.name).toBe("Reject");
    const p = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(p, org as any, "submit it for approval and verify it was submitted");
    expect(p.steps.some((s) => s.id === "sf-ap-decide")).toBe(false);
    expect(approvalSteps(ir([nav("/lightning/o/Zopp/new"), click("Save")]), org as any, "create a Zopp")).toEqual([]);
  });
  it("approves each step of a multi-step process when the request asks for both steps; once otherwise", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const two = { ...org, approvals: [...org.approvals, { label: "Zq Mega", api: "Zq_Mega", object: "Zopp", steps: ["Zq First", "Zq Final"] }] };
    const m = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(m, two as any, "Create a Zopp, submit it for approval, then approve both steps");
    expect(m.steps.filter((s) => /^sf-ap-decide/.test(s.id)).map((s) => s.id)).toEqual(["sf-ap-decide", "sf-ap-decide-2"]);
    // Every round's Comments box is the dialog's own.
    for (const c of m.steps.filter((s) => /^sf-ap-comment2/.test(s.id))) expect(c.target?.css).toBe('role=dialog >> role=textbox[name="Comments"s]');
    const one = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(one, two as any, "Create a Zopp, submit it for approval, then approve it");
    expect(one.steps.filter((s) => /^sf-ap-decide/.test(s.id))).toHaveLength(1);
  });
  it("pins the case's own menu click before Submit for Approval to the record's Show more actions", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const taskMenu = { id: "m", action: "click", target: { role: "button", name: "Show more actions - Zq Review task", css: "#upcoming-activities-section-zq > a" } } as Step;
    const submit = { id: "sub", action: "click", target: { role: "menuitem", name: "Submit for Approval" } } as Step;
    const send = { id: "send", action: "click", target: { role: "button", name: "Submit" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), created, taskMenu, submit, send]);
    approvalSteps(i, org as any, "Create a Zopp, submit it for approval, then approve it");
    expect(i.steps.find((s) => s.id === "m")?.target).toEqual({ role: "button", name: "Show more actions" });
  });
  it("recalls as the submitter: the Recall menu item and dialog button, and no switch to the approver", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const r = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(r, org as any, "Create a Zopp, submit it for approval, then recall the approval request", "${env:ZQ_SECOND}");
    expect(r.steps.find((s) => s.id === "sf-ap-decide")?.target?.name).toBe("Recall");
    expect(r.steps.find((s) => s.id === "sf-ap-confirm")?.target?.name).toBe("Recall");
    expect(r.steps.some((s) => s.id === "sf-ap-as-approver")).toBe(false);
    // Approve still switches to the approver.
    const a = ir([nav("/lightning/o/Zopp/new"), click("Save"), created]);
    approvalSteps(a, org as any, "submit it for approval, then approve it", "${env:ZQ_SECOND}");
    expect(a.steps.some((s) => s.id === "sf-ap-as-approver")).toBe(true);
  });
});

describe("leadConvertSteps: the model's was-created check", () => {
  it("drops 'was created' after the dialog's Convert and adds the converted check", async () => {
    const { leadConvertSteps } = await import("../src/stages/salesforceGuidance.js");
    const conv = (id: string) => ({ id, action: "click", target: { role: "button", name: "Convert" } } as Step);
    const i = ir([conv("a"), conv("b"), { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step]);
    leadConvertSteps(i);
    expect(i.steps.map((s) => s.id)).toEqual(["a", "b", "sf-convert-wait", "sf-convert-done"]);
  });
});

describe("leadConvertSteps: other wordings of the conversion", () => {
  it("turns 'was converted' into Salesforce's message", async () => {
    const { leadConvertSteps } = await import("../src/stages/salesforceGuidance.js");
    const conv = (id: string) => ({ id, action: "click", target: { role: "button", name: "Convert" } } as Step);
    const i = ir([conv("a"), conv("b"), { id: "x", action: "assert", target: { text: "was converted" }, assertion: "visible" } as Step]);
    leadConvertSteps(i);
    expect(i.steps.filter((s) => s.action === "assert").map((s) => s.target?.text)).toEqual(["Your lead has been converted"]);
  });
});

describe("approvalSteps with an approver", () => {
  it("signs in as the approver before the decision", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const { SECOND_USER_REF } = await import("../src/stages/salesforceFrontdoor.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [] }], approvals: [{ label: "Zq Big Deal", api: "Zq_Big_Deal", object: "Zopp" }] };
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step]);
    approvalSteps(i, org as any, "submit it for approval, then approve it", SECOND_USER_REF);
    const ids = i.steps.map((s) => s.id);
    expect(ids.indexOf("sf-ap-as-approver")).toBeGreaterThan(ids.indexOf("sf-ap-sent"));
    expect(ids.indexOf("sf-ap-as-approver")).toBeLessThan(ids.indexOf("sf-ap-decide"));
    expect(i.steps.find((s) => s.id === "sf-ap-as-approver")?.target?.url).toBe(SECOND_USER_REF);
  });
});

describe("approvalSteps after the case's own submission", () => {
  it("keeps the submission and replaces what follows with the approver's decision", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const { SECOND_USER_REF } = await import("../src/stages/salesforceFrontdoor.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Description", api: "Description" }] }], approvals: [{ label: "Zq Big Deal", api: "Zq_Big_Deal", object: "Zopp" }] };
    const sub = { id: "s11", action: "click", target: { role: "menuitem", name: "Submit for Approval" } } as Step;
    const send = { id: "s14", action: "click", target: { role: "button", name: "Submit" } } as Step;
    const sent = { id: "s16", action: "assert", target: { text: "was submitted for approval" }, assertion: "visible" } as Step;
    const wander = { id: "s17", action: "click", target: { role: "link", name: "Approval History(0)" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), sub, send, sent, wander]);
    approvalSteps(i, org as any, "submit it for approval, then reject it and verify its Description shows Zq Rejected", SECOND_USER_REF);
    const ids = i.steps.map((s) => s.id);
    expect(ids.slice(0, 5)).toEqual(["n", "c", "s11", "s14", "s16"]);
    expect(ids).not.toContain("s17");
    expect(ids).toEqual(expect.arrayContaining(["sf-ap-as-approver", "sf-ap-decide", "sf-ap-check-Description"]));
    expect(i.steps.find((s) => s.id === "sf-ap-decide")?.target?.name).toBe("Reject");
  });
});

describe("approvalSteps after a half-done submission", () => {
  it("replaces it with the whole submission", async () => {
    const { approvalSteps } = await import("../src/stages/salesforceGuidance.js");
    const org = { objects: [{ api: "Zopp", label: "Zopp", fields: [] }], approvals: [{ label: "Zq Big Deal", api: "Zq_Big_Deal", object: "Zopp" }] };
    const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
    const half = { id: "s14", action: "click", target: { role: "menuitem", name: "Submit for Approval" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save"), created, click("Show more actions"), half]);
    expect(approvalSteps(i, org as any, "submit it for approval, then approve it")).toHaveLength(1);
    const ids = i.steps.map((s) => s.id);
    expect(ids).not.toContain("s14");
    expect(ids).toEqual(expect.arrayContaining(["sf-ap-submit", "sf-ap-send", "sf-ap-decide"]));
  });
});

describe("customLinkSteps", () => {
  const org = {
    objects: [{ api: "Zopp", label: "Zopp", fields: [{ label: "Zq Tracking Number", api: "ZqTracking__c" }, { label: "Zopp Name", api: "Name" }] }],
    customLinks: [{ object: "Zopp", label: "Zq Delivery", url: "http://zq.example/track?n={!Zopp_Zq_Tracking_Number}&lang=en", kind: "link", newWindow: true }],
  };
  const fill = (name: string, value: string) => ({ id: `f-${name}`, action: "fill", target: { role: "textbox", name }, value } as Step);
  it("opens the record's Details and checks the address with the typed merge value, replacing the case's own link steps", async () => {
    const { customLinkSteps } = await import("../src/stages/salesforceGuidance.js");
    const own = { id: "own", action: "click", target: { role: "link", name: "Zq Delivery" } } as Step;
    const i = ir([nav("/lightning/o/Zopp/new"), fill("Zq Tracking Number", "Zq 42"), click("Save"), own]);
    expect(customLinkSteps(i, org as any, "Create a Zopp with tracking number Zq 42 and check its Zq Delivery link")).toHaveLength(1);
    expect(i.steps.map((s) => s.id)).not.toContain("own");
    const check = i.steps.at(-1)!;
    expect(check).toMatchObject({ assertion: "opens_url_contains", target: { role: "link", name: "Zq Delivery" }, value: "http://zq.example/track?n=Zq%2042&lang=en" });
    expect(i.steps.find((s) => s.id === "sf-cl-open-0")?.target?.url).toBe("${record:Zopp:1}");
  });
  it("a button is checked from the record header; the longer of two nested labels is the one named", async () => {
    const { customLinkSteps } = await import("../src/stages/salesforceGuidance.js");
    const both = { ...org, customLinks: [...org.customLinks,
      { object: "Zopp", label: "Zq TB Delivery", url: "http://zq.example/tb?n={!Zopp.ZqTracking__c}", kind: "link", newWindow: true },
      { object: "Zopp", label: "Zq Search", url: "https://zq.example/s?q={!Zopp.Name}", kind: "button", newWindow: true }] };
    const i = ir([nav("/lightning/o/Zopp/new"), fill("Zq Tracking Number", "Zq42"), click("Save")]);
    expect(customLinkSteps(i, both as any, "check the Zq TB Delivery link of a new Zopp")).toHaveLength(1);
    expect(i.steps.at(-1)?.value).toBe("http://zq.example/tb?n=Zq42");
    const j = ir([nav("/lightning/o/Zopp/new"), fill("Zopp Name", "Zq Deal"), click("Save")]);
    customLinkSteps(j, both as any, "click the Zq Search button of a new Zopp");
    expect(j.steps.at(-1)).toMatchObject({ target: { role: "menuitem", name: "Zq Search" }, value: "https://zq.example/s?q=Zq%20Deal" });
    // The menu opens as a step of its own, so grounding sees the item.
    expect(j.steps.find((s) => s.id === "sf-cl-menu-0")?.target).toEqual({ role: "button", name: "Show more actions" });
    expect(j.steps.some((s) => s.target?.name === "Details")).toBe(false);
  });
  it("a link is requested only when named as a link or button (run 2026-11-13T12-26-08-557Z-f7e2c00c: a billing address)", async () => {
    const { customLinkSteps } = await import("../src/stages/salesforceGuidance.js");
    const billing = { ...org, customLinks: [{ object: "Zopp", label: "Zq Billing", url: "http://zq.example/b", kind: "link", newWindow: true }] };
    const i = ir([nav("/lightning/o/Zopp/new"), click("Save")]);
    expect(customLinkSteps(i, billing as any, "Create a Zopp with a Zq Billing address in Toronto")).toEqual([]);
    expect(customLinkSteps(ir([nav("/lightning/o/Zopp/new"), click("Save")]), billing as any, "Create a Zopp and open its Zq Billing link")).toHaveLength(1);
  });
  it("stays on the Details tab: the record-view pass leaves the link check there", async () => {
    const { customLinkSteps, fieldChecksOnRecordView } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([nav("/lightning/o/Zopp/new"), fill("Zq Tracking Number", "Zq 42"), click("Save")]);
    customLinkSteps(i, org as any, "check the Zq Delivery link of a new Zopp");
    fieldChecksOnRecordView(i, { pages: [], salesforceOrg: org as any }, "check the Zq Delivery link of a new Zopp");
    expect(i.steps.some((s) => s.target?.name === "Related")).toBe(false);
    // The link's own text, not a "Custom Links" heading Lightning does not draw.
    expect(i.steps.find((s) => s.id === "sf-cl-shown-0")?.target).toEqual({ text: "Zq Delivery" });
  });
  it("checks only the part before a merge field the case did not type, and nothing when the link is not asked for", async () => {
    const { customLinkSteps } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([nav("/lightning/o/Zopp/new"), fill("Zopp Name", "Zq {{uid}}"), click("Save")]);
    customLinkSteps(i, org as any, "check the Zq Delivery link of a new Zopp");
    expect(i.steps.at(-1)?.value).toBe("http://zq.example/track?n=");
    const j = ir([nav("/lightning/o/Zopp/new"), click("Save")]);
    expect(customLinkSteps(j, org as any, "create a Zopp")).toEqual([]);
  });
});

describe("editSaveConfirmed (run 2026-11-13T14-13-29-358Z-ac7a1e04)", () => {
  it("adds was saved after an edit's Save, and only when the case has no outcome check there", async () => {
    const { editSaveConfirmed } = await import("../src/stages/salesforceGuidance.js");
    const i = ir([nav("/lightning/o/Zq_Deal__c/new"), click("Save"), click("Edit"), { id: "w", action: "wait", value: "500" } as Step, click("Save"), { id: "x", action: "assert", target: { field: "Zq Heat" }, assertion: "text_equals", value: "Zq Hot" } as Step]);
    expect(editSaveConfirmed(i)).toHaveLength(1);
    expect(i.steps[5]).toMatchObject({ action: "assert", target: { text: "was saved" } });
    const j = ir([nav("/lightning/o/Zq_Deal__c/new"), click("Save"), click("Edit"), click("Save"), { id: "y", action: "assert", target: { text: "was saved" }, assertion: "visible" } as Step]);
    expect(editSaveConfirmed(j)).toEqual([]);
  });
});

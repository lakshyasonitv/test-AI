import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyTestData, testDataEnabled, valueFor } from "../src/stages/testData.js";
import { UNIQUE_TOKEN } from "../src/text.js";
import type { IR } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * Session 102: the values a case types come from the model's text alone, so runs repeated the
 * same "Acme Corporation" / "Doe" (the org's duplicate rule then blocked the save), left required
 * fields empty, and picked picklist values the org does not have. The org model already knows
 * every field's type, its picklist values and which fields a validation rule reads; this pass uses
 * that, deterministically, on POSITIVE cases only. All names below are made-up canaries.
 */

const appModel = {
  baseUrl: "https://zq.example",
  pages: [],
  salesforceOrg: {
    validationRulesRead: true,
    objects: [{
      api: "Zq_Thing__c", label: "Zq Thing", createable: true,
      fields: [
        { label: "Zq Name", api: "Zq_Name__c", type: "String", required: true },
        { label: "Zq Code", api: "Zq_Code__c", type: "String", required: true },
        { label: "Zq Stage", api: "Zq_Stage__c", type: "Picklist", required: true, picklist: ["Zq Open - Fresh", "Zq Closed"] },
        { label: "Zq Phone", api: "Zq_Phone__c", type: "Phone" },
        { label: "Zq Mail", api: "Zq_Mail__c", type: "Email", required: true },
        { label: "Zq Due", api: "Zq_Due__c", type: "Date", required: true },
      ],
      validationRules: [
        { name: "Zq_Rule", message: "Zq code is wrong.", condition: "LEN(Zq_Code__c) <> 4" },
        // Run 2026-10-24T18-15-55-156Z-9e5d75c0: the happy path filled only the metadata-required
        // fields and the org's own "either/or" rule blocked the save.
        { name: "Zq_Either", message: "Zq phone or mail should be filled.", condition: "ISBLANK(Zq_Phone__c) && ISBLANK(Zq_Mail__c)" },
      ],
    }],
  },
} as unknown as AppModel;

/** The same org with only "Zq Name" required: rule tests then see only the rule's added step. */
const nameOnlyRequired = (() => {
  const m = structuredClone(appModel) as AppModel;
  for (const f of m.salesforceOrg!.objects[0].fields) if (f.api !== "Zq_Name__c") delete (f as any).required;
  return m;
})();

const ir = (steps: any[]): IR => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
  steps: [{ id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Thing__c/new" } }, ...steps],
}) as unknown as IR;

const valid = { category: "valid" } as any;
const value = (r: IR, id: string) => r.steps.find((s) => s.id === id)!.value;

describe("testDataEnabled", () => {
  const ORIGINAL = process.env.TEST_DATA_ENABLED;
  beforeEach(() => { delete process.env.TEST_DATA_ENABLED; });
  afterEach(() => { if (ORIGINAL === undefined) delete process.env.TEST_DATA_ENABLED; else process.env.TEST_DATA_ENABLED = ORIGINAL; });
  it("is off unless asked for", () => {
    expect(testDataEnabled()).toBe(false);
    process.env.TEST_DATA_ENABLED = "true";
    expect(testDataEnabled()).toBe(true);
  });
});

describe("applyTestData", () => {
  it("makes a required name field unique per run, so a repeat run is not a duplicate", () => {
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Sample" }]);
    applyTestData(r, valid, appModel);
    expect(value(r, "s2")).toBe(`Zq Sample ${UNIQUE_TOKEN}`);
  });

  it("never touches a field a validation rule reads", () => {
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Code" }, value: "ABCD" }]);
    applyTestData(r, valid, appModel);
    expect(value(r, "s2")).toBe("ABCD");
  });

  it("fills an empty required field with a value shaped by its type", () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Mail" } },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "" },
    ]);
    applyTestData(r, valid, appModel);
    expect(value(r, "s2")).toMatch(/^[a-z]+\.[a-z]+\+\{\{uid\}\}@example\.com$/);
    expect(value(r, "s3")).toBe("{{date:+30:en-US}}");   // resolved where it is typed, never here
  });

  it("snaps a picklist value to the option the org actually has", () => {
    // The form says "Zq Thing Stage", the org says "Zq Stage": matched by VALUE, not label.
    const r = ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Thing Stage" }, value: "Zq Open" }]);
    applyTestData(r, valid, appModel, "Create a Zq Thing with Zq Thing Stage Zq Open");
    expect(value(r, "s2")).toBe("Zq Open - Fresh");
  });

  it("leaves a NEGATIVE case's typed values exactly as written: blank and wrong values are the test", () => {
    const steps = [
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Sample" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Zq Mail" } },
    ];
    const r = ir(JSON.parse(JSON.stringify(steps)));
    applyTestData(r, { category: "invalid-input" } as any, appModel);
    expect(r.steps.slice(1)).toEqual(steps);
  });

  // Run 2026-10-24T20-37-00-424Z-410671c2 (a second org): a "functional-other" case picked Lead Status
  // "Working", which the org does not have ("Working - Contacted"), and failed there. A picklist
  // offers only its options, so a value that is not one is never what a test means — any category.
  it("snaps a picklist value to the org's real option in EVERY case, not only positive ones", () => {
    for (const category of ["invalid-input", "functional-other", "empty-boundary"]) {
      const r = ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Stage" }, value: "Zq Open" }]);
      applyTestData(r, { category } as any, appModel);
      expect(value(r, "s2"), category).toBe("Zq Open - Fresh");
    }
  });

  it("does nothing without an org model or a create-form navigate", () => {
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Sample" }]);
    applyTestData(r, valid, { ...appModel, salesforceOrg: undefined } as AppModel);
    expect(value(r, "s2")).toBe("Zq Sample");
    const noNav = { ...r, steps: r.steps.slice(1) } as IR;
    applyTestData(noNav, valid, appModel);
    expect(value(noNav, "s2")).toBe("Zq Sample");
  });

  it("fills one field of an all-blank rule so a positive case can actually save", () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: `Zq ${UNIQUE_TOKEN}` },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
      { id: "s4", action: "assert", target: { role: "button", name: "Save" }, assertion: "hidden" },
    ]);
    const notes = applyTestData(r, valid, nameOnlyRequired);
    const added = r.steps.find((s) => s.action === "fill" && s.target?.name === "Zq Phone");
    expect(added?.value).toBe("{{phone}}");
    expect(r.steps.indexOf(added!)).toBe(2);   // before the Save click
    expect(notes.join("\n")).toContain("Zq_Either");
  });

  it("adds nothing when the case already fills one of the rule's fields", () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Mail" }, value: "zq@example.com" },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    ]);
    applyTestData(r, valid, nameOnlyRequired);
    // The rule is satisfied by Zq Mail, so no Zq Phone step; the untouched required Zq Name is added.
    expect(r.steps.some((s) => s.target?.name === "Zq Phone")).toBe(false);
    expect(r.steps.some((s) => s.target?.name === "Zq Name")).toBe(true);
  });

  // Replay 2026-10-24T21-16-14-645Z-b254fab3: a saved "valid create" typed the same email as the run
  // that authored it, and the org's duplicate rule ("Similar Records Exist") blocked the save. An
  // email is how duplicate rules match, required or not, so it gets the run code too.
  it("makes an email unique per run (plus-addressing), required or not", () => {
    const optionalMail = { ...appModel, salesforceOrg: { ...appModel.salesforceOrg!, objects: [{
      ...appModel.salesforceOrg!.objects[0],
      fields: [{ label: "Zq Mail", api: "Zq_Mail__c", type: "Email" }],
      validationRules: [],
    }] } } as AppModel;
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Mail" }, value: "zq.person@example.com" }]);
    applyTestData(r, valid, optionalMail, "Create a Zq Thing with the Zq Mail filled");
    expect(value(r, "s2")).toBe(`zq.person+${UNIQUE_TOKEN}@example.com`);
    // A value the request itself gives is typed as given.
    const given = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Mail" }, value: "zq.person@example.com" }]);
    applyTestData(given, valid, optionalMail, "Create a Zq Thing with email zq.person@example.com");
    expect(value(given, "s2")).toBe("zq.person@example.com");
  });

  // Code review, Session 102: an assertion that quotes a typed value must still match after this pass.
  it("leaves a typed value alone when an assertion quotes it", () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Sample" },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
      { id: "s4", action: "assert", target: { text: "Zq Thing \"Zq Sample\" was created" }, assertion: "visible" },
    ]);
    applyTestData(r, valid, appModel);
    expect(value(r, "s2")).toBe("Zq Sample");
  });

  it("adds a rule's fill only before a Save click, and tries every field of the rule", () => {
    const noSave = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: `Zq ${UNIQUE_TOKEN}` },
      { id: "s3", action: "press", target: { role: "textbox", name: "Zq Name" }, value: "Enter" },
      { id: "s4", action: "assert", target: { text: "was created" }, assertion: "visible" },
    ]);
    applyTestData(noSave, valid, appModel);
    expect(noSave.steps.at(-1)!.id).toBe("s4");            // never appended after the final assert
    expect(noSave.steps.some((s) => s.id.startsWith("td-"))).toBe(false);
    // First field not fillable by type (a picklist), the second is: use the second.
    const org2 = structuredClone(nameOnlyRequired) as AppModel;
    org2.salesforceOrg!.objects[0].validationRules = [{ name: "Zq_Either2", message: "m", condition: "ISBLANK(Zq_Stage__c) && ISBLANK(Zq_Phone__c)" }];
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: `Zq ${UNIQUE_TOKEN}` },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    ]);
    applyTestData(r, valid, org2);
    expect(r.steps.find((s) => s.id === "td-1")?.target?.name).toBe("Zq Phone");
  });

  it("snaps a select against ITS field's options when the field is known", () => {
    const org3 = structuredClone(appModel) as AppModel;
    org3.salesforceOrg!.objects[0].fields.push({ label: "Zq Kind", api: "Zq_Kind__c", type: "Picklist", picklist: ["Zq Open Space"] } as any);
    const r = ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Kind" }, value: "Zq Open" }]);
    applyTestData(r, valid, org3, "Create a Zq Thing with Zq Kind Zq Open");
    expect(value(r, "s2")).toBe("Zq Open Space");          // not Zq Stage's "Zq Open - Fresh"
  });

  it("keeps a value that already carries the run code", () => {
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: `Zq ${UNIQUE_TOKEN}` }]);
    applyTestData(r, valid, appModel);
    expect(value(r, "s2")).toBe(`Zq ${UNIQUE_TOKEN}`);
  });
});

describe("the case writer sees each field's type when the generator is on", () => {
  const ORIGINAL = process.env.TEST_DATA_ENABLED;
  afterEach(() => { if (ORIGINAL === undefined) delete process.env.TEST_DATA_ENABLED; else process.env.TEST_DATA_ENABLED = ORIGINAL; });
  it("lists typed fields in the org block, and not at all when off", async () => {
    const { orgModelForCases } = await import("../src/stages/salesforceOrgModel.js");
    delete process.env.TEST_DATA_ENABLED;
    expect(orgModelForCases(appModel.salesforceOrg)).not.toContain("field types:");
    process.env.TEST_DATA_ENABLED = "true";
    const block = orgModelForCases(appModel.salesforceOrg);
    expect(block).toContain("field types: Zq Name (String), Zq Code (String), Zq Phone (Phone), Zq Mail (Email), Zq Due (Date)");
  });
});

describe("applyTestData on a flow that creates several objects (run 2026-10-24T21-26-12-355Z-15cbc64f)", () => {
  // Contact's save was blocked: "Review the following fields: Account Name" — a lookup typed as text
  // with no record picked. Opportunity's required Close Date had no step at all. Canary names.
  const multi = {
    baseUrl: "https://zq.example", pages: [],
    salesforceOrg: { validationRulesRead: true, objects: [
      { api: "Zq_Person__c", label: "Zq Person", createable: true, fields: [
        { label: "Zq Surname", api: "Zq_Surname__c", type: "String", required: true },
        { label: "Zq Firm ID", api: "Zq_Firm__c", type: "Reference", lookup: "Zq_Firm__c" },
      ] },
      { api: "Zq_Deal__c", label: "Zq Deal", createable: true, fields: [
        { label: "Zq Deal Name", api: "Name", type: "String", required: true },
        { label: "Zq Close", api: "Zq_Close__c", type: "Date", required: true },
        { label: "Zq Phase", api: "Zq_Phase__c", type: "Picklist", required: true, picklist: ["Zq New", "Zq Won"] },
        { label: "Zq Owner Link ID", api: "Zq_Owner__c", type: "Reference", required: true, lookup: "User" },
      ] },
    ] },
  } as unknown as AppModel;
  const flow = () => ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Person__c/new" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Surname" }, value: "Zq Kim" },
      { id: "s3", action: "fill", target: { role: "combobox", name: "Zq Firm Name" }, value: "Zq Firm" },
      { id: "s4", action: "click", target: { role: "button", name: "Save" } },
      { id: "s5", action: "assert", target: { role: "button", name: "Save" }, assertion: "hidden" },
      { id: "s6", action: "navigate", target: { url: "/lightning/o/Zq_Deal__c/new" } },
      { id: "s7", action: "fill", target: { role: "textbox", name: "Zq Deal Name" }, value: "Zq Big" },
      { id: "s8", action: "click", target: { role: "button", name: "Save" } },
      { id: "s9", action: "assert", target: { role: "button", name: "Save" }, assertion: "hidden" },
    ],
  }) as unknown as IR;

  it("handles every object's section, not only the first", () => {
    const r = flow();
    applyTestData(r, valid, multi);
    expect(value(r, "s2")).toBe(`Zq Kim ${UNIQUE_TOKEN}`);
    expect(value(r, "s7")).toBe(`Zq Big ${UNIQUE_TOKEN}`);
  });

  it("drops an optional lookup typed as text (shown as '<X> Name' for the '<X> ID' field)", () => {
    const r = flow();
    applyTestData(r, valid, multi);
    expect(r.steps.find((s) => s.id === "s3")).toBeUndefined();
  });

  it("adds missing required fields before that object's Save: a date, the first picklist option", () => {
    const r = flow();
    applyTestData(r, valid, multi);
    const deal = r.steps.slice(r.steps.findIndex((s) => s.id === "s6"), r.steps.findIndex((s) => s.id === "s8"));
    const close = deal.find((s) => s.target?.name === "Zq Close");
    const phase = deal.find((s) => s.target?.name === "Zq Phase");
    expect(close?.action).toBe("fill");
    expect(close?.value).toBe("{{date:+30:en-US}}");
    expect(phase?.action).toBe("select");
    expect(phase?.value).toBe("Zq New");
    // A required lookup cannot be typed: it becomes a pick of the first suggestion the org offers.
    const owner = deal.find((s) => /Owner Link/.test(s.target?.name ?? ""));
    expect(owner?.action).toBe("select");
    expect(owner?.target?.lookup).toBe(true);
    expect(owner?.value).toBe("");
    // Nothing lands in the person section or after an assert.
    const person = r.steps.slice(0, r.steps.findIndex((s) => s.id === "s6"));
    expect(person.some((s) => s.id.startsWith("td-"))).toBe(false);
  });

  it("a negative case keeps its lookup fill and gets no added fields", () => {
    const r = flow();
    applyTestData(r, { category: "empty-boundary" } as any, multi);
    expect(r.steps.find((s) => s.id === "s3")).toBeDefined();
    expect(r.steps.some((s) => s.id.startsWith("td-"))).toBe(false);
  });
});

describe("fill policy: required + rule-read fields only, other fields only when the request names them", () => {
  const policyOrg = {
    baseUrl: "https://zq.example",
    pages: [{ url: "https://zq.example/lightning/o/Zq_Lead__c/new?count=1", concepts: [], elements: [
      { role: "combobox", name: "Zq Firm Name" }, { role: "textbox", name: "Zq Surname" },
    ] }],
    salesforceOrg: { validationRulesRead: true, userLocale: "en_GB", objects: [{
      api: "Zq_Lead__c", label: "Zq Lead", createable: true,
      fields: [
        { label: "Zq Surname", api: "Zq_Surname__c", type: "String", required: true },
        { label: "Zq Given", api: "Zq_Given__c", type: "String" },
        { label: "Zq Mail", api: "Zq_Mail__c", type: "Email" },
        { label: "Zq Cell", api: "Zq_Cell__c", type: "Phone" },
        { label: "Zq Job", api: "Zq_Job__c", type: "String" },
        { label: "Zq Firm ID", api: "Zq_Firm__c", type: "Reference", lookup: "Zq_Firm__c" },
        { label: "Zq Due", api: "Zq_Due__c", type: "Date", required: true },
      ],
      validationRules: [{ name: "Zq_Cell_Rule", message: "m", condition: "LEN(Zq_Cell__c) <> 10" }],
    }] },
  } as unknown as AppModel;
  const flow = () => ir([
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Surname" }, value: "Rao" },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Zq Given" }, value: "Asha" },
    { id: "s4", action: "fill", target: { role: "textbox", name: "Zq Mail" }, value: "asha@example.com" },
    { id: "s5", action: "fill", target: { role: "textbox", name: "Zq Cell" }, value: "4155550100" },
    { id: "s6", action: "fill", target: { role: "textbox", name: "Zq Job" }, value: "Analyst" },
    { id: "s7", action: "fill", target: { role: "combobox", name: "Zq Firm Name" }, value: "Zq Firm" },
    { id: "s8", action: "click", target: { role: "button", name: "Save" } },
    { id: "s9", action: "assert", target: { role: "button", name: "Save" }, assertion: "hidden" },
  ]).steps.map((s, i) => (i === 0 ? { ...s, target: { url: "/lightning/o/Zq_Lead__c/new?count=1" } } : s));
  const run = (request: string) => { const r = { meta: {}, steps: flow() } as unknown as IR; const notes = applyTestData(r, valid, policyOrg, request); return { r, notes }; };
  const names = (r: IR) => r.steps.filter((s) => s.action === "fill" || s.action === "select").map((s) => s.target?.name);

  it("without explicit fields: keeps the required surname and the rule-read phone, drops the rest, adds the required date", () => {
    const { r } = run("Create a new Zq Lead and verify it is created");
    expect(names(r)).toEqual(["Zq Surname", "Zq Cell", "Zq Due"]);
    expect(value(r, "s2")).toBe(`Rao ${UNIQUE_TOKEN}`);
    expect(value(r, "s5")).toBe("4155550100");                  // a rule reads it: never changed
    expect(r.steps.find((s) => s.target?.name === "Zq Due")?.value).toBe("{{date:+30:en-GB}}");
  });

  it("with explicit fields: keeps the fields and values the request names, makes the email unique", () => {
    const { r } = run("Create a Zq Lead with Zq Given Asha, the Zq Mail filled, and job Analyst");
    expect(names(r)).toEqual(["Zq Surname", "Zq Given", "Zq Mail", "Zq Cell", "Zq Job", "Zq Due"]);
    expect(value(r, "s3")).toBe("Asha");
    expect(value(r, "s4")).toBe(`asha+${UNIQUE_TOKEN}@example.com`);
    expect(value(r, "s6")).toBe("Analyst");
  });

  it("a lookup the request names becomes a real lookup pick of that record", () => {
    const r = { meta: {}, steps: flow().map((s) => s.id === "s7" ? { ...s, value: "Zq Bluepeak" } : s) } as unknown as IR;
    applyTestData(r, valid, policyOrg, "Create a Zq Lead linked to the Zq Firm Zq Bluepeak");
    const s7 = r.steps.find((s) => s.id === "s7")!;
    expect(s7.action).toBe("select");
    expect(s7.target?.lookup).toBe(true);
    expect(s7.value).toBe("Zq Bluepeak");
  });

  it("a required lookup with no step picks the first suggestion, under the label the form shows", () => {
    const org = structuredClone(policyOrg) as AppModel;
    org.salesforceOrg!.objects[0].fields.find((f) => f.api === "Zq_Firm__c")!.required = true;
    const r = { meta: {}, steps: flow().filter((s) => s.id !== "s7") } as unknown as IR;
    applyTestData(r, valid, org, "Create a Zq Lead");
    const added = r.steps.find((s) => s.target?.lookup);
    expect(added?.target?.name).toBe("Zq Firm Name");
    expect(added?.value).toBe("");
    expect(r.steps.indexOf(added!)).toBeLessThan(r.steps.findIndex((s) => s.id === "s8"));
  });

  // Run 2026-10-25T05-01-36-627Z-b0d6a138: the added required "Status" step was grounded to "SLA
  // Status"; the form calls the field "Lead Status" (object label + field label).
  it("names an added required field the way the form does: '<Object> <Field>' when the form shows that", () => {
    const org = structuredClone(policyOrg) as AppModel;
    org.salesforceOrg!.objects[0].fields.push({ label: "Zq Phase", api: "Zq_Phase__c", type: "Picklist", required: true, picklist: ["Zq Open"] } as any);
    org.pages[0].elements.push({ role: "combobox", name: "Zq Lead Zq Phase" } as any, { role: "combobox", name: "Zq Other Zq Phase" } as any);
    const r = { meta: {}, steps: flow() } as unknown as IR;
    applyTestData(r, valid, org, "Create a Zq Lead");
    expect(r.steps.find((s) => s.value === "Zq Open")?.target?.name).toBe("Zq Lead Zq Phase");
  });

  // Run 2026-10-25T05-01-36-627Z-b0d6a138 kept an unrequested Phone: the org model lists at most 40
  // fields (required first), so a field missing from it is optional — and dropped like any other.
  it("drops a form field the org model does not list, unless the request names it", () => {
    const steps = () => [...flow().slice(0, 7),
      { id: "s20", action: "fill", target: { role: "textbox", name: "Zq Fax" }, value: "4155550199" }, ...flow().slice(7)];
    const r = { meta: {}, steps: steps() } as unknown as IR;
    applyTestData(r, valid, policyOrg, "Create a Zq Lead");
    expect(r.steps.some((s) => s.id === "s20")).toBe(false);
    const named = { meta: {}, steps: steps() } as unknown as IR;
    applyTestData(named, valid, policyOrg, "Create a Zq Lead with a Zq Fax number");
    expect(named.steps.some((s) => s.id === "s20")).toBe(true);
  });

  it("an email that already has a plus part still gets the run code", () => {
    const r = { meta: {}, steps: flow().map((s) => s.id === "s4" ? { ...s, value: "qa+lead@example.com" } : s) } as unknown as IR;
    applyTestData(r, valid, policyOrg, "Create a Zq Lead with the Zq Mail filled");
    expect(value(r, "s4")).toBe(`qa+lead+${UNIQUE_TOKEN}@example.com`);
  });

  it("realistic values: names, firms, emails, phones and dates by label and type", () => {
    const f = (label: string, type: string) => ({ label, api: "X", type } as any);
    expect(valueFor(f("First Name", "String"))).toMatch(/^[A-Z][a-z]+$/);
    expect(valueFor(f("Last Name", "String"))).toMatch(new RegExp(`^[A-Z][a-z]+ ${UNIQUE_TOKEN.replace(/[{}]/g, "\$&")}$`));
    expect(valueFor(f("Account Name", "String"))).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \{\{uid\}\}$/);
    expect(valueFor(f("Title", "String"))).toMatch(/Manager|Director|Lead|Analyst/);
    expect(valueFor(f("Email", "Email"))).toMatch(/^[a-z]+\.[a-z]+\+\{\{uid\}\}@example\.com$/);
    expect(valueFor(f("Phone", "Phone"))).toBe("{{phone}}");
    expect(valueFor(f("Close Date", "Date"), "de-DE")).toBe("{{date:+30:de-DE}}");
    expect(valueFor(f("Annual Revenue", "Currency"))).toBe("25000");
    expect(valueFor(f("Account ID", "Reference"))).toBeUndefined();
  });
});

describe("lookups in every case (run 2026-10-25T06-38-05-138Z-dfdd0d4f, a Contact linked to an Account)", () => {
  const org = {
    baseUrl: "https://zq.example",
    pages: [{ url: "https://zq.example/lightning/o/Zq_Person__c/new", concepts: [], elements: [{ role: "combobox", name: "Zq Firm Name" }] }],
    salesforceOrg: { validationRulesRead: true, objects: [{
      api: "Zq_Person__c", label: "Zq Person", createable: true,
      fields: [
        { label: "Zq Surname", api: "Zq_Surname__c", type: "String", required: true },
        { label: "Zq Firm ID", api: "Zq_Firm__c", type: "Reference", lookup: "Zq_Firm__c" },
      ],
    }] },
  } as unknown as AppModel;
  const flow = (lookupStep: any) => ({ meta: {}, steps: [
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Person__c/new" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Surname" }, value: `Zq ${UNIQUE_TOKEN}` },
    { id: "s3", ...lookupStep },
    { id: "s4", action: "click", target: { role: "button", name: "Save" } },
  ] }) as unknown as IR;
  const req = "Create a new Zq Person linked to an existing Zq Firm and verify it is created";

  it("a record name the model invented is not searched for: the first real record is picked (case-0)", () => {
    const r = flow({ action: "select", target: { role: "combobox", name: "Zq Firm Name" }, value: "Existing Zq Firm" });
    applyTestData(r, valid, org, req);
    const s3 = r.steps.find((s) => s.id === "s3")!;
    expect(s3.target?.lookup).toBe(true);
    expect(s3.value).toBe("");
  });

  it("a record the REQUEST names is searched for", () => {
    const r = flow({ action: "fill", target: { role: "textbox", name: "Zq Firm Name" }, value: "Zq Northwind" });
    applyTestData(r, valid, org, "Create a Zq Person for the Zq Firm Zq Northwind");
    expect(r.steps.find((s) => s.id === "s3")!.value).toBe("Zq Northwind");
  });

  it("a SELECT on a lookup becomes a lookup pick too, never a picklist choice (case-2)", () => {
    const r = flow({ action: "select", target: { role: "combobox", name: "Zq Firm Name" }, value: "Zq Kim Zq Lee" });
    applyTestData(r, valid, org, req);
    const s3 = r.steps.find((s) => s.id === "s3")!;
    expect(s3.target?.lookup).toBe(true);
    expect(s3.value).toBe("");
  });

  // Phase A (run 2026-10-26T07-23-21-344Z-9cd29004): a child for the parent THIS case created. The
  // lookup was blanked to "the first suggestion" and only linked the right parent by luck.
  it("a lookup naming the record this case created earlier (its run-token name) keeps that name", () => {
    const parent = { ...structuredClone(org), salesforceOrg: { ...structuredClone(org.salesforceOrg!), objects: [
      ...structuredClone(org.salesforceOrg!.objects),
      { api: "Zq_Firm__c", label: "Zq Firm", createable: true, fields: [{ label: "Zq Firm Title", api: "Name", type: "String", required: true }] },
    ] } } as unknown as AppModel;
    const typed = `Zq Parent ${UNIQUE_TOKEN}`;
    const r = { meta: {}, steps: [
      { id: "p1", action: "navigate", target: { url: "/lightning/o/Zq_Firm__c/new" } },
      { id: "p2", action: "fill", target: { role: "textbox", name: "Zq Firm Title" }, value: typed },
      { id: "p3", action: "click", target: { role: "button", name: "Save" } },
      ...flow({ action: "select", target: { role: "combobox", name: "Zq Firm Name" }, value: typed }).steps,
    ] } as unknown as IR;
    applyTestData(r, valid, parent, req);
    const s3 = r.steps.find((s) => s.id === "s3")!;
    expect(s3.target?.lookup).toBe(true);
    expect(s3.value).toBe(typed);
    // A run-token name the case never typed for that object is still the model's invention.
    const invented = flow({ action: "select", target: { role: "combobox", name: "Zq Firm Name" }, value: typed });
    applyTestData(invented, valid, parent, req);
    expect(invented.steps.find((s) => s.id === "s3")!.value).toBe("");
  });

  it("a security case picks a record too, so its save can happen (case-3); invalid-input and empty cases are left alone", () => {
    const sec = flow({ action: "fill", target: { role: "textbox", name: "Zq Firm Name" }, value: "Existing Zq Firm" });
    applyTestData(sec, { category: "security-xss" } as any, org, req);
    expect(sec.steps.find((s) => s.id === "s3")!.target?.lookup).toBe(true);
    for (const category of ["invalid-input", "empty-boundary"]) {
      const neg = flow({ action: "fill", target: { role: "textbox", name: "Zq Firm Name" }, value: "zz-not-a-firm" });
      applyTestData(neg, { category } as any, org, req);
      const s3 = neg.steps.find((s) => s.id === "s3")!;
      expect(s3.action, category).toBe("fill");
      expect(s3.value, category).toBe("zz-not-a-firm");
    }
  });
});

describe("a case that expects a save gets its required fields, whatever its category (run 2026-10-25T10-28-59-649Z-7acbedab)", () => {
  // The XSS and SQL Case cases were blocked by "Review the following fields: Case Origin": required
  // fields were added for valid cases only. Their own payload must still be left exactly as written.
  const org = {
    baseUrl: "https://zq.example", pages: [],
    salesforceOrg: { validationRulesRead: true, objects: [{
      api: "Zq_Ticket__c", label: "Zq Ticket", createable: true,
      fields: [
        { label: "Zq Origin", api: "Zq_Origin__c", type: "Picklist", required: true, picklist: ["Zq Phone", "Zq Web"] },
        { label: "Zq Subject", api: "Zq_Subject__c", type: "String" },
      ],
    }] },
  } as unknown as AppModel;
  const flow = () => ({ meta: {}, steps: [
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Ticket__c/new" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Subject" }, value: "<script>alert(1)</script>" },
    { id: "s3", action: "click", target: { role: "button", name: "Save" } },
  ] }) as unknown as IR;

  it("security and functional cases: the missing required picklist is added, the payload is untouched", () => {
    for (const category of ["security-xss", "security-injection", "functional-other"]) {
      const r = flow();
      applyTestData(r, { category } as any, org, "Create a Zq Ticket");
      expect(r.steps.find((s) => s.target?.name === "Zq Origin")?.value, category).toBe("Zq Phone");
      expect(value(r, "s2"), category).toBe("<script>alert(1)</script>");
    }
  });

  it("invalid-input and empty-boundary cases get nothing added", () => {
    for (const category of ["invalid-input", "empty-boundary"]) {
      const r = flow();
      applyTestData(r, { category } as any, org, "Create a Zq Ticket");
      expect(r.steps.some((s) => s.id.startsWith("td-")), category).toBe(false);
    }
  });
});

// Phase A: a dependent picklist is disabled until its controlling field has a value, and offers a
// value only under the controlling values it was configured for ("TB Territory" under "TB Region"
// on the scratch org, 2026-10-25). Canaries below.
describe("dependent picklists: the controlling field first, with a value that offers the dependent one", () => {
  const dep = structuredClone(appModel) as AppModel;
  const obj = dep.salesforceOrg!.objects[0];
  for (const f of obj.fields) delete (f as any).required;
  obj.validationRules = [];
  obj.fields.push(
    { label: "Zq Region", api: "Zq_Region__c", type: "Picklist", picklist: ["Zq North", "Zq South"] } as any,
    { label: "Zq Territory", api: "Zq_Territory__c", type: "Picklist", picklist: ["Zq North East", "Zq South West"],
      controlledBy: "Zq_Region__c", validFor: { "Zq North East": ["Zq North"], "Zq South West": ["Zq South"] } } as any,
  );
  const territory = (v: string) => ({ id: "s3", action: "select", target: { role: "combobox", name: "Zq Territory" }, value: v });
  const region = (v: string) => ({ id: "s2", action: "select", target: { role: "combobox", name: "Zq Region" }, value: v });
  const save = { id: "s9", action: "click", target: { role: "button", name: "Save" } };
  const order = (r: IR) => r.steps.map((s) => `${s.target?.name ?? s.action}=${s.value ?? ""}`);
  const ask = "Create a Zq Thing in territory Zq South West";

  it("adds the controlling step, before the dependent one, when the case has none", () => {
    const r = ir([territory("Zq South West"), save]);
    applyTestData(r, valid, dep, ask);
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq South", "Zq Territory=Zq South West"]);
  });

  it("moves a controlling step that comes after, and fixes a value that does not offer the dependent one", () => {
    const r = ir([territory("Zq South West"), region("Zq North"), save]);
    applyTestData(r, valid, dep, ask);
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq South", "Zq Territory=Zq South West"]);
  });

  it("keeps a controlling value the request names, and picks a dependent value offered under it", () => {
    const r = ir([region("Zq North"), territory("Zq South West"), save]);
    applyTestData(r, valid, dep, "Create a Zq Thing in Zq North with Zq Territory");
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq North", "Zq Territory=Zq North East"]);
  });

  // Run 2026-10-25T15-42-33-903Z-d11ab7a2: the model wrote "TB Territory South West" (its label in the
  // value), nothing snapped it, and the dependency pass then picked "South East" against the request.
  it("a value carrying its field label snaps to the option, and stays the one the request asked for", () => {
    const r = ir([region("Zq South"), territory("Zq Territory Zq South West"), save]);
    applyTestData(r, valid, dep, "Create a Zq Thing in Zq Region Zq South with Zq Territory Zq South West");
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq South", "Zq Territory=Zq South West"]);
  });

  it("an unknown dependent value switches to the one the request names, not the first offered", () => {
    const wide = structuredClone(dep) as AppModel;
    const t = wide.salesforceOrg!.objects[0].fields.find((f) => f.api === "Zq_Territory__c")! as any;
    t.picklist = ["Zq South East", "Zq South West"];
    t.validFor = { "Zq South East": ["Zq South"], "Zq South West": ["Zq South"] };
    const r = ir([region("Zq South"), territory("Somewhere"), save]);
    applyTestData(r, valid, wide, "Create a Zq Thing in Zq South with Zq Territory Zq South West");
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq South", "Zq Territory=Zq South West"]);
  });

  it("leaves a case whose bad value IS the test alone", () => {
    const r = ir([territory("Zq South West"), region("Zq North"), save]);
    applyTestData(r, { category: "invalid-input" } as any, dep, ask);
    expect(order(r).slice(1, 3)).toEqual(["Zq Territory=Zq South West", "Zq Region=Zq North"]);
  });
});

// Phase A: a formula or roll-up field has no input; a step typing into one can never pass.
describe("a field the org calculates is never filled", () => {
  it("drops a fill on it, in any case", () => {
    const m = structuredClone(appModel) as AppModel;
    (m.salesforceOrg!.objects[0] as any).calculated = [{ label: "Zq Total", api: "Zq_Total__c", type: "Currency" }];
    const r = ir([{ id: "s2", action: "fill", target: { role: "textbox", name: "Zq Total" }, value: "10" },
      { id: "s9", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(r, { category: "invalid-input" } as any, m, "Create a Zq Thing with Zq Total 10");
    expect(r.steps.some((s) => s.target?.name === "Zq Total")).toBe(false);
  });
});

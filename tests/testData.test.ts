import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyTestData, asksForEveryField, dateTimeFills, dateTimeValue, fitToField, localeDate, testDataEnabled, valueFor } from "../src/stages/testData.js";
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

describe("asksForEveryField: the person's own words ask for the whole form", () => {
  it.each([
    "can you fill the account with each and every field",
    "can you create a account filling each and every component of that",
    "create a new account with all the fields filled",
    "create an account with full details",
    "can you create a camapaign with all the fields field",
    "fill everything on the Opportunity form",
    "Fill ALL fields of the case",
    "create a contact with every feild",
    "can you create a account filling each and every componet of that",   // the real request, typo and all
    "fill all the filds",
  ])("yes: %s", (request) => expect(asksForEveryField(request)).toBe(true));

  it.each([
    "create an account",
    "fill all required fields",
    "create an opportunity with all the mandatory fields",
    "fill one opportunity with full of the fields which are required",
    "all fields are required",
    "check every link on the page",
  ])("no: %s", (request) => expect(asksForEveryField(request)).toBe(false));
});

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

  // Run 2026-11-10T05-05-39-201Z-52ce7aed: the request said Industry "Technology"; the model's option
  // list was cut short, and the step was swapped to "Biotechnology", so the flow's branch never ran.
  it("never swaps a value the request names for an option that only contains it", () => {
    const org = structuredClone(appModel) as AppModel;
    org.salesforceOrg!.objects[0].fields.push({ label: "Zq Sector", api: "Zq_Sector__c", type: "Picklist", required: true, picklist: ["Zqbiotech", "Zq Retail"] } as any);
    const r = ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Sector" }, value: "tech" }]);
    applyTestData(r, valid, org, "Create a Zq Thing with Zq Sector tech");
    expect(value(r, "s2")).toBe("tech");
    // Not named by the request: the option is still taken.
    const unnamed = ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Sector" }, value: "tech" }]);
    applyTestData(unnamed, valid, org, "Create a Zq Thing");
    expect(value(unnamed, "s2")).toBe("Zqbiotech");
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

  // Run 2026-10-28T05-42-18-894Z-a951424e ("filling each and every component") filled 33 fields with
  // the pass off; with it on, the same kind of request kept only the required ones, because it names
  // no field. The whole form is what was asked for, so every field the case fills is kept.
  it("an 'each and every field' request keeps every field the case fills, and still fixes the values", () => {
    const { r } = run("Create a Zq Lead filling each and every field");
    expect(names(r)).toEqual(["Zq Surname", "Zq Given", "Zq Mail", "Zq Cell", "Zq Job", "Zq Firm Name", "Zq Due"]);
    expect(value(r, "s2")).toBe(`Rao ${UNIQUE_TOKEN}`);          // required name: unique per run
    expect(value(r, "s3")).toBe("Asha");                          // optional, kept as typed
    expect(value(r, "s4")).toBe(`asha+${UNIQUE_TOKEN}@example.com`);
    expect(value(r, "s5")).toBe("4155550100");                    // a rule reads it: never changed
    expect(value(r, "s6")).toBe("Analyst");
    const firm = r.steps.find((s) => s.id === "s7")!;             // a lookup is still a real pick
    expect([firm.action, firm.target?.lookup]).toEqual(["select", true]);
  });

  it("an optional date kept by 'all the fields' is written in the org user's format, so Save accepts it", () => {
    const org = structuredClone(policyOrg) as AppModel;
    org.salesforceOrg!.objects[0].fields.push({ label: "Zq Expiry", api: "Zq_Expiry__c", type: "Date" } as any);
    const r = { meta: {}, steps: [...flow().slice(0, 7),
      { id: "s21", action: "fill", target: { role: "textbox", name: "Zq Expiry" }, value: "2026-12-31" }, ...flow().slice(7)] } as unknown as IR;
    applyTestData(r, valid, org, "create a new Zq Lead with all the fields filled");
    expect(value(r, "s21")).toBe("{{date:+30:en-GB}}");
  });

  it("an 'every field' request also keeps a form field the org model does not list", () => {
    const r = { meta: {}, steps: [...flow().slice(0, 7),
      { id: "s20", action: "fill", target: { role: "textbox", name: "Zq Fax" }, value: "4155550199" }, ...flow().slice(7)] } as unknown as IR;
    applyTestData(r, valid, policyOrg, "Create a Zq Lead with full details");
    expect(r.steps.some((s) => s.id === "s20")).toBe(true);
  });

  // Run 2026-11-02T17-24-47-449Z-ab0328f3: the model left "Primary Campaign Source" blank on purpose (no
  // value). Kept by the every-field rule it became choose(..., ""): a click on whatever row came first.
  it("an 'every field' request does not keep a step that types or picks nothing", () => {
    const r = { meta: {}, steps: [...flow().slice(0, 7),
      { id: "s20", action: "select", target: { role: "combobox", name: "Zq Promo Source" } }, ...flow().slice(7)] } as unknown as IR;
    applyTestData(r, valid, policyOrg, "Create a Zq Lead filling each and every field");
    expect(r.steps.some((s) => s.id === "s20")).toBe(false);
    expect(names(r)).toEqual(["Zq Surname", "Zq Given", "Zq Mail", "Zq Cell", "Zq Job", "Zq Firm Name", "Zq Due"]);
  });

  it("'all required fields' still means the required ones only", () => {
    const { r } = run("Create a Zq Lead with all required fields");
    expect(names(r)).toEqual(["Zq Surname", "Zq Cell", "Zq Due"]);
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

  it("an invalid-input case picks a record for a lookup the request does not name (run 2026-11-13T19-16-31-705Z-1c10477d)", () => {
    const neg = flow({ action: "fill", target: { role: "textbox", name: "Zq Firm Name" }, value: "Zq Invented Parent" });
    applyTestData(neg, { category: "invalid-input" } as any, org, "Create a Zq Person whose Zq Due is before its Zq Start and verify it is rejected");
    const s3 = neg.steps.find((s) => s.id === "s3")!;
    expect(s3.target?.lookup).toBe(true);
    expect(s3.value).toBe("");
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

  // Run 2026-11-02T17-17-02-125Z-59cae03e: "each and every field" kept TB Region "North" with the
  // model's TB Territory "Territory 1", an option of no region; the replay died on it.
  it("a dependent value that is no option at all becomes one offered under the controlling value", () => {
    const r = ir([region("Zq North"), territory("Somewhere"), save]);
    applyTestData(r, valid, dep, "Create a Zq Thing filling each and every field");
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq North", "Zq Territory=Zq North East"]);
  });

  // Run 2026-11-03T04-29-50-846Z-c820d0e1: the model wrote "Region A" and "Territory 1"; neither exists.
  it("an invented controlling value becomes a real option, and the dependent value follows it", () => {
    const r = ir([region("Zq Area A"), territory("Zq Patch 1"), save]);
    applyTestData(r, valid, dep, "Create a Zq Thing filling each and every field");
    expect(order(r).slice(1, 3)).toEqual(["Zq Region=Zq North", "Zq Territory=Zq North East"]);
  });

  it("a website is made unique per run, so a duplicate rule does not match an earlier run's record", () => {
    const web = structuredClone(dep) as AppModel;
    web.salesforceOrg!.objects[0].fields.push({ label: "Zq Site", api: "Zq_Site__c", type: "Url" } as any);
    const r = ir([{ id: "s4", action: "fill", target: { role: "textbox", name: "Zq Site" }, value: "https://www.example.com" }, save] as any);
    applyTestData(r, valid, web, "Create a Zq Thing filling each and every field");
    expect(r.steps.find((s) => s.id === "s4")?.value).toBe("https://{{uid}}.example.com");
  });

  it("an 'every field' request drops a step whose value is 'None' (the model leaving it blank)", () => {
    const r = ir([{ id: "s14", action: "select", target: { role: "combobox", name: "Zq Promo Source" }, value: "None" }, save] as any);
    applyTestData(r, valid, dep, "Create a Zq Thing filling each and every field");
    expect(r.steps.some((s) => s.id === "s14")).toBe(false);
  });

  it("a select the form names in its own words ('Primary Campaign Source') is treated as that lookup", () => {
    const lk = structuredClone(dep) as AppModel;
    lk.salesforceOrg!.objects[0].fields.push({ label: "Zq Campaign ID", api: "Zq_Campaign__c", type: "Reference", lookup: "Zqcampaign" } as any);
    const r = ir([{ id: "s13", action: "select", target: { role: "combobox", name: "Primary Zqcampaign Source" }, value: "Online Zqcampaign" }, save] as any);
    applyTestData(r, valid, lk, "Create a Zq Thing filling each and every field");
    const s = r.steps.find((x) => x.id === "s13")!;
    expect(s.target?.lookup).toBe(true);
    expect(s.value).toBe("");
  });

  it("keeps an invented value the request itself names", () => {
    const r = ir([region("Zq Area A"), save]);
    applyTestData(r, valid, dep, "Create a Zq Thing with Zq Region Zq Area A and check the error");
    expect(order(r)[1]).toBe("Zq Region=Zq Area A");
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

// Run 2026-11-03T08-32-47-277Z-249e547b: "Select a date for Close Date" then "Today" opened a popup
// no screen captured, and grounding truncated the case there.
describe("a date is typed, never picked from the calendar", () => {
  it("drops the picker click, the waits and the day pick after it", () => {
    const r = ir([{ id: "s2", action: "click", target: { role: "button", name: "Select a date for Zq Date" } },
      { id: "s3", action: "wait", value: "1000" } as any,
      { id: "s4", action: "click", target: { role: "button", name: "Today" } },
      { id: "s9", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(r, valid, appModel, "Create a Zq Thing");
    expect(r.steps.map((s) => s.id)).not.toContain("s2");
    expect(r.steps.map((s) => s.id)).not.toContain("s4");
    expect(r.steps.some((s) => s.target?.name === "Save")).toBe(true);
  });
});

// Run 2026-11-03T10-42-46-258Z-6b58f976: "every field" with "Private" asserted hidden mid-form.
describe("every field: a check on a form control before Save is a field to fill", () => {
  it("ticks a checkbox and drops any other control check; leaves the final check", () => {
    const r = ir([
      { id: "s2", action: "assert", target: { role: "checkbox", name: "Zq Private" }, assertion: "hidden" } as any,
      { id: "s3", action: "assert", target: { role: "combobox", name: "Zq Source" }, assertion: "visible" } as any,
      { id: "s9", action: "click", target: { role: "button", name: "Save" } },
      { id: "s10", action: "assert", target: { text: "was created" }, assertion: "visible" } as any]);
    applyTestData(r, valid, appModel, "Create a Zq Thing and fill each and every field on the form");
    expect(r.steps.find((s) => s.id === "s2")?.action).toBe("check");
    expect(r.steps.some((s) => s.id === "s3")).toBe(false);
    expect(r.steps.some((s) => s.id === "s10")).toBe(true);
  });
});

// Run 2026-11-10T05-11-20-593Z-6f9640b8: "... and verify the Account's Type shows Customer - Direct" (a flow
// sets it). The case set Type itself on create, so the check proved nothing.
describe("a field the request only checks is not filled", () => {
  it("requestedActions keeps what to do and drops what to check", async () => {
    const { requestedActions } = await import("../src/stages/testData.js");
    expect(requestedActions("Create a Zq Thing with Zq Stage Zq Open, save it, and verify its Zq Kind shows Zq Big"))
      .toBe("Create a Zq Thing with Zq Stage Zq Open, save it, and ");
    expect(requestedActions("Create a Zq Thing")).toBe("Create a Zq Thing");
    expect(requestedActions("Create a Zq Thing and checkout")).toBe("Create a Zq Thing and checkout");
  });

  it("drops an optional field named only in the check, keeps one named in the action", () => {
    const org = structuredClone(appModel) as AppModel;
    org.salesforceOrg!.objects[0].fields.push({ label: "Zq Kind", api: "Zq_Kind__c", type: "Picklist", picklist: ["Zq Big", "Zq Small"] } as any);
    const steps = () => ir([{ id: "s2", action: "select", target: { role: "combobox", name: "Zq Kind" }, value: "Zq Big" }]);
    const checked = steps();
    applyTestData(checked, valid, org, "Create a Zq Thing, save it, and verify its Zq Kind shows Zq Big");
    expect(checked.steps.find((s) => s.id === "s2")).toBeUndefined();
    const asked = steps();
    applyTestData(asked, valid, org, "Create a Zq Thing with Zq Kind Zq Big, save it, and verify its Zq Kind shows Zq Big");
    expect(value(asked, "s2")).toBe("Zq Big");
  });
});

// Run 2026-11-10T05-51-13-444Z-c5882e76: "verify its Rating shows Hot, its Lead Status shows Working -
// Contacted": the case set both itself; Rating stayed because a later check quoted "Hot".
describe("a value the request only checks is not set by the test", () => {
  const org = () => {
    const o = structuredClone(appModel) as AppModel;
    o.salesforceOrg!.objects[0].fields.push(
      { label: "Zq Mood", api: "Zq_Mood__c", type: "Picklist", picklist: ["Zq Calm", "Zq Glad"] } as any,
      { label: "Zq Phase", api: "Zq_Phase__c", type: "Picklist", required: true, picklist: ["Zq Start", "Zq Done"] } as any);
    return o;
  };
  const run = () => {
    const r = ir([
      { id: "s2", action: "select", target: { role: "combobox", name: "Zq Mood" }, value: "Zq Glad" },
      { id: "s3", action: "select", target: { role: "combobox", name: "Zq Phase" }, value: "Zq Done" },
      { id: "s4", action: "click", target: { role: "button", name: "Save" } },
      { id: "s5", action: "assert", target: { field: "Zq Mood" }, assertion: "text_contains", value: "Zq Glad" },
      { id: "s6", action: "assert", target: { field: "Zq Phase" }, assertion: "text_contains", value: "Zq Done" },
    ]);
    applyTestData(r, valid, org(), "Create a Zq Thing, save it, and verify its Zq Mood shows Zq Glad and its Zq Phase shows Zq Done");
    return r;
  };

  it("drops an optional one even though a later check quotes it", () => {
    expect(run().steps.find((s) => s.id === "s2")).toBeUndefined();
  });

  it("starts a required one on another option", () => {
    expect(value(run(), "s3")).toBe("Zq Start");
  });
});

// Run 2026-11-10T06-22-41-469Z-3fe92274: after the Account's Save, the flow created an Opportunity from
// the Account page's action; its required "Opportunity Name *" was judged as an Account field and dropped.
describe("a create form's section ends at its Save", () => {
  it("leaves the steps after the Save alone", () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq {{uid}}" },
      { id: "s3", action: "click", target: { role: "button", name: "Save" } },
      { id: "s4", action: "click", target: { role: "button", name: "Zq Other Action" } },
      { id: "s5", action: "fill", target: { role: "textbox", name: "Zq Other Name *" }, value: "Zq Other" },
    ]);
    applyTestData(r, valid, appModel, "Create a Zq Thing, then a Zq Other from its page");
    expect(value(r, "s5")).toBe("Zq Other");
  });
});

// Run 2026-11-10T08-56-13-526Z-86865e92: "Test every branch of the lead routing flow". The fields that pick a
// branch were dropped as optional (every case took the default branch), and the Hot case set the flow's
// own result (Lead Status "Working - Contacted") itself.
describe("fields a flow reads or sets", () => {
  const withFlow = () => {
    const o = structuredClone(appModel) as AppModel;
    o.salesforceOrg!.objects[0].fields.push(
      { label: "Zq Revenue", api: "Zq_Revenue__c", type: "Currency" } as any,
      { label: "Zq Mood", api: "Zq_Mood__c", type: "Picklist", picklist: ["Zq Calm", "Zq Glad"] } as any,
      { label: "Zq Phase", api: "Zq_Phase__c", type: "Picklist", required: true, picklist: ["Zq Start", "Zq Done"] } as any);
    (o.salesforceOrg as any).flows = [{ label: "Zq Routing", api: "Zq_Routing", type: "record-triggered", object: o.salesforceOrg!.objects[0].label,
      effects: ['branch "Zhot": when Zq_Revenue__c >= 1000000 -> sets Zq_Mood__c = Zq Glad, Zq_Phase__c = Zq Done'] }];
    return o;
  };
  const run = () => {
    const r = ir([
      { id: "s2", action: "fill", target: { role: "spinbutton", name: "Zq Revenue" }, value: "2000000" },
      { id: "s3", action: "select", target: { role: "combobox", name: "Zq Mood" }, value: "Zq Glad" },
      { id: "s4", action: "select", target: { role: "combobox", name: "Zq Phase" }, value: "Zq Done" },
      { id: "s5", action: "click", target: { role: "button", name: "Save" } },
    ]);
    applyTestData(r, valid, withFlow(), "Test every branch of the Zq Routing flow");
    return r;
  };

  it("keeps a field a flow's branch condition reads, though the request names no field", () => {
    expect(value(run(), "s2")).toBe("2000000");
  });

  it("drops an optional field set to the value the flow sets, and starts a required one elsewhere", () => {
    const r = run();
    expect(r.steps.find((s) => s.id === "s3")).toBeUndefined();
    expect(value(r, "s4")).toBe("Zq Start");
  });
});

describe("test data fitted to each field (field limits from object-info)", () => {
  const f = (o: any) => ({ label: "Zq Field", api: "Zq__c", type: "String", ...o } as any);
  it("never longer than the field: the run code stays whole when shortening", () => {
    // Opportunity's Tracking Number takes 12 characters: "Test Tracking Number <code>" would not save.
    const v = valueFor(f({ label: "Zq Tracking Number", length: 12 }))!;
    expect(v.replace("{{uid}}", "xxxxxx").length).toBeLessThanOrEqual(12);
    expect(v).toContain("{{uid}}");
    expect(fitToField("Zq a very long company name {{uid}}", f({ length: 15 })).replace("{{uid}}", "xxxxxx").length).toBeLessThanOrEqual(15);
    expect(fitToField("Zq short", f({ length: 40 }))).toBe("Zq short");
  });
  it("numbers within their digits and decimals, with the locale's decimal mark", () => {
    expect(fitToField("25000.555", f({ type: "Currency", precision: 18, scale: 2 }))).toBe("25000.55");
    expect(fitToField("25000.50", f({ type: "Currency", precision: 18, scale: 2 }), "de-DE")).toBe("25000,50");
    expect(fitToField("123456", f({ type: "Double", precision: 5, scale: 2 }))).toBe("999");
    expect(fitToField("12.7", f({ type: "Int" }))).toBe("12");
    expect(fitToField("150", f({ type: "Percent", precision: 3, scale: 0 }))).toBe("100");
    expect(valueFor(f({ label: "Zq Amount", type: "Currency", precision: 18, scale: 2 }))).toBe("25000.50");
  });
  it("a unique field gets the run code; types that take no single typed value get none", () => {
    expect(valueFor(f({ label: "Zq Ext Ref", unique: true, length: 255 }))).toContain("{{uid}}");
    expect(valueFor(f({ type: "MultiPicklist", picklist: ["Zq A", "Zq B"] }))).toBeUndefined();
    expect(valueFor(f({ type: "Location" }))).toBeUndefined();
    expect(valueFor(f({ type: "Time" }), "en-US")).toMatch(/^10:30\s?AM$/);
    expect(valueFor(f({ type: "Time" }), "de-DE")).toBe("10:30");
  });
  it("a value the case typed is fitted; one the request gives is left as the test", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].fields.find((x) => x.api === "Zq_Code__c")!.length = 6;
    m.salesforceOrg!.objects[0].validationRules = [];
    const typed = ir([{ id: "c", action: "fill", target: { role: "textbox", name: "Zq Code" }, value: "Zq LONG CODE VALUE" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(typed, valid, m, "Create a Zq Thing");
    expect(value(typed, "c")!.replace("{{uid}}", "xxxxxx").length).toBeLessThanOrEqual(6);
    const asked = ir([{ id: "c", action: "fill", target: { role: "textbox", name: "Zq Code" }, value: "Zq LONG CODE VALUE" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(asked, valid, m, "Create a Zq Thing with Zq Code Zq LONG CODE VALUE");
    expect(value(asked, "c")).toContain("Zq LONG CODE VALUE");   // not shortened (the run code a required text gets stays)
  });
  it("a record type's own picklist values on its form", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].recordTypes = [{ name: "Zq Partner", id: "012zq0000000001AAA", picklists: { "Zq Stage": ["Zq Partner Open"] } }] as any;
    const r = { meta: {}, steps: [{ id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Thing__c/new?recordTypeId=012zq0000000001AAA" } },
      { id: "p", action: "select", target: { role: "combobox", name: "Zq Stage" }, value: "Open" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } }] } as unknown as IR;
    applyTestData(r, valid, m, "Create a Zq Partner Zq Thing");
    expect(value(r, "p")).toBe("Zq Partner Open");
  });
});

describe("a value a check quotes still fits its field (run 2026-11-13T12-02-09-298Z-fc1e4b67)", () => {
  it("is shortened, and the checks quoting it are shortened the same way", () => {
    const m = structuredClone(appModel) as AppModel;
    const o = m.salesforceOrg!.objects[0];
    o.validationRules = [];
    o.fields.push({ label: "Zq Track", api: "Zq_Track__c", type: "String", length: 12 } as any);
    const r = ir([
      { id: "t", action: "fill", target: { role: "textbox", name: "Zq Track" }, value: "ZQTRACK-PLAN-001" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { text: "ZQTRACK-PLAN-001" }, assertion: "visible" },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing with a Zq Track");
    expect(value(r, "t")).toBe("ZQTRACK-PLAN");
    expect(r.steps.find((s) => s.id === "a")!.target?.text).toBe("ZQTRACK-PLAN");
  });
});

describe("bug hunt 13 Nov: dates in words and full names", () => {
  it("a date in words or ISO is the same day in the user's format; a numeric one is left alone", () => {
    expect(localeDate("15 March 1990", "en-US")).toBe("3/15/1990");
    expect(localeDate("March 15, 1990", "en-US")).toBe("3/15/1990");
    expect(localeDate("1990-03-15", "de-DE")).toBe("15.3.1990");
    expect(localeDate("31 February 1990")).toBeUndefined();
    expect(localeDate("03/04/1990")).toBeUndefined();
  });
  it("a requested date in words is typed in the user's format, and a check quoting it changes with it", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].validationRules = [];
    const r = ir([
      { id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "15 March 1990" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { text: "15 March 1990" }, assertion: "visible" },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing with Zq Due 15 March 1990 and verify it");
    expect(value(r, "d")).toBe("3/15/1990");
    expect(r.steps.find((s) => s.id === "a")!.target?.text).toBe("3/15/1990");
  });
  it("the requested day however the model wrote it, with its checks; yesterday and {{yesterday}} are run-relative", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].validationRules = [];
    const r = ir([
      { id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "15/03/1990" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { text: "15 March 1990" }, assertion: "visible" },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing with Zq Due 15 March 1990 and verify it");
    expect(value(r, "d")).toBe("3/15/1990");
    expect(r.steps.find((s) => s.id === "a")!.target?.text).toBe("3/15/1990");
    const y = ir([{ id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "{{yesterday}}" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(y, valid, m, "Create a Zq Thing due yesterday");
    expect(value(y, "d")).toBe("{{date:-1:en-US}}");
    // A check quoting the made-up token is changed with it.
    const q = ir([{ id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "{{yesterday}}" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { text: "{{yesterday}}" }, assertion: "text_contains", value: "{{yesterday}}" }]);
    applyTestData(q, valid, m, "Create a Zq Thing due yesterday");
    expect(q.steps.find((s) => s.id === "a")).toMatchObject({ value: "{{date:-1:en-US}}", target: { text: "{{date:-1:en-US}}" } });
    // A fixed date naming that same day becomes relative too, so a replay tomorrow still checks yesterday.
    const now = new Date();
    const yesterday = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1)));
    const f = ir([{ id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "yesterday" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { field: "Zq Due" }, assertion: "text_contains", value: yesterday }]);
    applyTestData(f, valid, m, "Create a Zq Thing due yesterday");
    expect(f.steps.find((s) => s.id === "a")!.value).toBe("{{date:-1:en-US}}");
  });
  it("First Name keeps only its own words when it also holds the Last Name", () => {
    const m = structuredClone(appModel) as AppModel;
    const o = m.salesforceOrg!.objects[0];
    o.validationRules = [];
    o.fields.push({ label: "First Name", api: "FirstName", type: "String" } as any, { label: "Last Name", api: "LastName", type: "String", required: true } as any);
    const r = ir([
      { id: "f", action: "fill", target: { role: "textbox", name: "First Name" }, value: "Zqana Zqlopez" },
      { id: "l", action: "fill", target: { role: "textbox", name: "Last Name" }, value: "Zqlopez {{uid}}" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing for Zqana Zqlopez");
    expect(value(r, "f")).toBe("Zqana");
  });
});

describe("bug hunt round 2: dates typed on an edit form (run 2026-11-13T13-59-40-225Z-73d6d7c6)", () => {
  it("a date in words on the Edit form is typed in the user's format, with its checks", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].validationRules = [];
    const r = ir([
      { id: "n", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq {{uid}}" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "ed", action: "click", target: { role: "button", name: "Edit" } },
      { id: "d", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "31 December 2026" },
      { id: "sv2", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { field: "Zq Due" }, assertion: "text_equals", value: "31 December 2026" },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing, then edit its Zq Due to 31 December 2026");
    expect(value(r, "d")).toBe("12/31/2026");
    expect(r.steps.find((s) => s.id === "a")!.value).toBe("12/31/2026");
  });
});

describe("bug hunt round 2: a record type picked as a picklist value (run 2026-11-13T14-13-11-352Z-7c8d6c62)", () => {
  it("is dropped when the field does not offer it; a field that does offer it keeps it", () => {
    const m = structuredClone(appModel) as AppModel;
    const o = m.salesforceOrg!.objects[0];
    o.validationRules = [];
    o.recordTypes = [{ name: "Zq Partner", id: "012zq0000000001AAA" }] as any;
    const step = (v: string) => ({ id: "p", action: "select", target: { role: "combobox", name: "Zq Stage" }, value: v });
    const r = { meta: {}, steps: [{ id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Thing__c/new?recordTypeId=012zq0000000001AAA" } }, step("Zq Partner"), { id: "sv", action: "click", target: { role: "button", name: "Save" } }] } as unknown as IR;
    applyTestData(r, valid, m, "Create a Zq Partner Zq Thing");
    expect(r.steps.some((s) => s.id === "p")).toBe(false);
    o.fields.find((f) => f.label === "Zq Stage")!.picklist!.push("Zq Partner");
    const k = { meta: {}, steps: [{ id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Thing__c/new" } }, step("Zq Partner"), { id: "sv", action: "click", target: { role: "button", name: "Save" } }] } as unknown as IR;
    applyTestData(k, valid, m, "Create a Zq Thing");
    expect(k.steps.find((s) => s.id === "p")?.value).toBe("Zq Partner");
  });
});

describe("bug hunt round 3: a value holding its own field label (run 2026-11-13T15-19-02-592Z-1e01cacf)", () => {
  it("drops the label, with the checks quoting it; a request that writes it so keeps it", () => {
    const m = structuredClone(appModel) as AppModel;
    m.salesforceOrg!.objects[0].validationRules = [];
    const r = ir([
      { id: "c", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Name Zqsato {{uid}}" },
      { id: "sv", action: "click", target: { role: "button", name: "Save" } },
      { id: "a", action: "assert", target: { text: "Zq Name Zqsato {{uid}}" }, assertion: "visible" },
    ]);
    applyTestData(r, valid, m, "Create a Zq Thing for Zqsato");
    expect(value(r, "c")).toBe("Zqsato {{uid}}");
    expect(r.steps.find((s) => s.id === "a")!.target?.text).toBe("Zqsato {{uid}}");
    const k = ir([{ id: "c", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Name Zqsato" }, { id: "sv", action: "click", target: { role: "button", name: "Save" } }]);
    applyTestData(k, valid, m, "Create a Zq Thing named Zq Name Zqsato");
    expect(value(k, "c")).toContain("Zq Name Zqsato");
  });
});

describe("date-time fields (runs 2026-11-13T18-30-28-619Z-653368f1, 18-35-51-793Z-df1af5e4)", () => {
  it("writes '<day> <time>' in the user's format, the day relative to the run", () => {
    expect(dateTimeValue("tomorrow 9:00 AM", "Zq Start", "en-US")).toBe("{{date:+1:en-US}} 9:00 AM");
    expect(dateTimeValue("in 3 days 2:15 PM", "Zq Start", "en-US")).toBe("{{date:+3:en-US}} 2:15 PM");
    expect(dateTimeValue("2026-11-16T14:00:00Z", "Zq Start", "en-US", "", "tomorrow")).toBe("{{date:+1:en-US}} 2:00 PM");
    expect(dateTimeValue("15 March 2030 10:00", "Zq Start", "en-US", "start on 15 March 2030")).toBe("3/15/2030 10:00 AM");
    expect(dateTimeValue("2026-11-16", "Zq Due Date", "en-US")).toBe("{{date:+3:en-US}} 10:30 AM");
    expect(dateTimeValue("", "Zq Start", "de-DE")).toBe("{{date:+1:de-DE}} 10:30");
  });
  it("turns a fill of a DateTime field into one sf-dt- step naming the field, and leaves other fields", () => {
    const org = { userLocale: "en_US", objects: [{ api: "ZqAppt", label: "Zq Appt", fields: [
      { label: "Zq Earliest", api: "ZqEarliest__c", type: "DateTime", required: true },
      { label: "Zq Due", api: "ZqDue__c", type: "DateTime", required: true },
      { label: "Zq Subject", api: "Subject", type: "String" },
    ] }] } as any;
    const ir = { meta: {}, steps: [
      { id: "n", action: "navigate", target: { url: "/lightning/o/ZqAppt/new" } },
      { id: "a", action: "fill", target: { role: "textbox", name: "Zq Earliest" }, value: "2026-11-16" },
      { id: "b", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "2026-11-18 4:00 PM" },
      { id: "c", action: "fill", target: { role: "textbox", name: "Zq Subject" }, value: "Zq" },
    ] } as unknown as IR;
    expect(dateTimeFills(ir, org, "Zq Earliest tomorrow and Zq Due in 3 days")).toHaveLength(2);
    expect(ir.steps[1]).toMatchObject({ id: "sf-dt-a", target: { role: "group", name: "Zq Earliest" }, value: "{{date:+1:en-US}} 10:30 AM" });
    expect(ir.steps[2]).toMatchObject({ id: "sf-dt-b", value: "{{date:+3:en-US}} 4:00 PM" });
    expect(ir.steps[3].id).toBe("c");
  });
});

describe("date-time boxes named just Date or Time (run 2026-11-13T19-05-25-624Z-90c95d42)", () => {
  it("drops them, and gives each date-time field the request sets its own step before Save", () => {
    const org = { userLocale: "en_US", objects: [{ api: "ZqAppt", label: "Zq Appt", fields: [
      { label: "Zq Earliest", api: "ZqEarliest__c", type: "DateTime" },
      { label: "Zq Due", api: "ZqDue__c", type: "DateTime" },
    ] }] } as any;
    const ir = { meta: {}, steps: [
      { id: "n", action: "navigate", target: { url: "/lightning/o/ZqAppt/new" } },
      { id: "a", action: "fill", target: { role: "textbox", name: "Date" }, value: "tomorrow" },
      { id: "b", action: "fill", target: { role: "textbox", name: "Date" }, value: "in 3 days" },
      { id: "s", action: "click", target: { role: "button", name: "Save" } },
    ] } as unknown as IR;
    dateTimeFills(ir, org, "Create a Zq Appt with Zq Earliest tomorrow and Zq Due in 3 days");
    expect(ir.steps.map((s) => s.id)).toEqual(["n", "sf-dt-req-ZqEarliest__c", "sf-dt-req-ZqDue__c", "s"]);
    expect(ir.steps[1].value).toBe("{{date:+1:en-US}} 10:30 AM");
    expect(ir.steps[2].value).toBe("{{date:+3:en-US}} 10:30 AM");
  });
});

import { describe, it, expect, vi } from "vitest";
import { typedValues, sameValue, apiChecks, apiChecksEnabled } from "../src/stages/salesforceOracles.js";
import type { Step } from "../src/schema/ir.js";

// Phase D API checks. Canary names (Zq).
const org = { objects: [{ api: "Zq_Acct__c", label: "Zq Acct", fields: [
  { label: "Zq Name", api: "Name", type: "string" },
  { label: "Phone", api: "Phone", type: "phone" },
  { label: "Annual Revenue", api: "AnnualRevenue", type: "currency" },
  { label: "Parent", api: "ParentId", type: "reference", lookup: "Zq_Acct__c" },
  { label: "Start", api: "Start__c", type: "date" },
] }] };
const nav = (url: string) => ({ id: "n", action: "navigate", target: { url } } as Step);
const fill = (name: string, value: string) => ({ id: "f", action: "fill", target: { name }, value } as Step);
const save = { id: "s", action: "click", target: { role: "button", name: "Save" } } as Step;
const created = { id: "w", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;

describe("typedValues", () => {
  it("takes what each saved create form typed, skipping lookups and dates", () => {
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq {{uid}}"), fill("Phone", "4155550101"),
      fill("Parent", "Zq Parent"), fill("Start", "1/2/2026"), save, created, nav("/lightning/o/Zq_Acct__c/new"), fill("Annual Revenue", "1500000"), save, created] }, org);
    expect(t).toEqual([
      { object: "Zq_Acct__c", n: 1, values: [{ label: "Zq Name", api: "Name", type: "string", value: "Zq {{uid}}" }, { label: "Phone", api: "Phone", type: "phone", value: "4155550101" }] },
      { object: "Zq_Acct__c", n: 2, values: [{ label: "Annual Revenue", api: "AnnualRevenue", type: "currency", value: "1500000" }] },
    ]);
  });

  it("leaves out a field a flow on the object sets after the save", () => {
    const withFlow = { ...org, flows: [{ label: "Zq f", api: "Zq_f", type: "record-triggered", object: "Zq Acct", effects: ['branch "B": when Name = Zq -> sets Phone = 1, AnnualRevenue = 2'] }] };
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq"), fill("Phone", "4155550101"), save, created] }, withFlow);
    expect(t[0].values.map((v) => v.api)).toEqual(["Name"]);
  });

  it("a form never saved checks nothing", () => {
    expect(typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "x")] }, org)).toEqual([]);
  });
});

describe("sameValue", () => {
  it("reads phones by digits, numbers by value, text without case", () => {
    expect(sameValue("phone", "4155550101", "(415) 555-0101")).toBe(true);
    expect(sameValue("currency", "1,500,000", 1500000)).toBe(true);
    expect(sameValue("currency", "1500000", 150000)).toBe(false);
    expect(sameValue("picklist", "Hot", "hot")).toBe(true);
    expect(sameValue("string", "Zq", null)).toBe(false);
  });
});

describe("apiChecks", () => {
  const typed = [{ object: "Zq_Acct__c", n: 1, values: [{ label: "Zq Name", api: "Name", type: "string", value: "Zq {{uid}}" }] }];
  it("compares the stored value with the typed one, run tokens resolved", async () => {
    const apiGet = vi.fn(async () => ({ records: [{ Name: "Zq ab12cd" }] }));
    const out = await apiChecks(apiGet, typed, { Zq_Acct__c: ["a00zq0000000001AAA"] }, { uid: "ab12cd", phone: "1" });
    expect(out).toEqual([{ object: "Zq_Acct__c", id: "a00zq0000000001AAA", field: "Zq Name", expected: "Zq ab12cd", actual: "Zq ab12cd", ok: true }]);
    expect(decodeURIComponent(String(apiGet.mock.calls[0][0]))).toContain("SELECT Name FROM Zq_Acct__c WHERE Id = 'a00zq0000000001AAA'");
  });

  it("fails, with a reason, when the case never reached its record; never queries a bad id", async () => {
    const apiGet = vi.fn();
    const out = await apiChecks(apiGet, typed, { Zq_Acct__c: ["x' OR Id != '"] }, { uid: "a", phone: "1" });
    expect(out[0]).toMatchObject({ ok: false, note: "the case never reached the record it created" });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("is off unless asked for", () => {
    const was = process.env.SALESFORCE_API_CHECKS_ENABLED;
    delete process.env.SALESFORCE_API_CHECKS_ENABLED;
    expect(apiChecksEnabled()).toBe(false);
    if (was !== undefined) process.env.SALESFORCE_API_CHECKS_ENABLED = was;
  });
});

describe("calculatedChecks", () => {
  it("reads a calculated field the screen checked, on the record the case was on", async () => {
    const { calculatedChecks } = await import("../src/stages/salesforceOracles.js");
    const withCalc = { objects: [{ ...org.objects[0], calculated: [{ label: "Zq Total", api: "Zq_Total__c", type: "Currency" }] }] };
    const check = { id: "a", action: "assert", target: { field: "Zq Total" }, assertion: "text_contains", value: "$5,000.00" } as Step;
    const t = calculatedChecks({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "x"), save,
      nav("/lightning/o/Other/new"), save, nav("${record:Zq_Acct__c:1}"), check] }, withCalc as any);
    expect(t).toEqual([{ object: "Zq_Acct__c", n: 1, values: [{ label: "Zq Total", api: "Zq_Total__c", type: "Currency", value: "$5,000.00" }] }]);
    expect(sameValue("Currency", "$5,000.00", 5000)).toBe(true);
  });
});

describe("typedValues: only confirmed saves", () => {
  it("skips a form whose save the case expects to be refused", () => {
    const refused = { id: "e", action: "assert", target: { text: "Zq: too short" }, assertion: "visible" } as Step;
    expect(typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "AB"), save, refused] }, org)).toEqual([]);
  });
});

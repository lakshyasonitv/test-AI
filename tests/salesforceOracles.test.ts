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

  it("an edit of the record after its create counts: the last value saved is the expected one", () => {
    const edit = { id: "e", action: "click", target: { role: "button", name: "Edit" } } as Step;
    const saved = { id: "w2", action: "assert", target: { text: "was saved" }, assertion: "visible" } as Step;
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Phone", "4155550101"), save, created, edit, fill("Phone", "4155550199"), save, saved] }, org);
    expect(t[0].values.find((v) => v.api === "Phone")?.value).toBe("4155550199");
    // An edit whose save was not confirmed changes nothing.
    const u = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Phone", "4155550101"), save, created, edit, fill("Phone", "4155550199"), save] }, org);
    expect(u[0].values.find((v) => v.api === "Phone")?.value).toBe("4155550101");
  });

  it("an inline pencil's edit counts once its field check confirms it (run 2026-11-13T18-24-42-379Z-c78076e2)", () => {
    const pencil = { id: "e", action: "click", target: { role: "button", name: "Edit Phone" } } as Step;
    const shown = { id: "sf-inline-s2", action: "assert", target: { field: "Phone" }, value: "4155550199", assertion: "text_contains" } as Step;
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Phone", "4155550101"), save, created, pencil, fill("Phone", "4155550199"), save, shown] }, org);
    expect(t[0].values.find((v) => v.api === "Phone")?.value).toBe("4155550199");
  });

  it("a clone is checked as its own record: the original's values, then what the clone form typed", () => {
    const clone = { id: "cl", action: "click", target: { role: "menuitem", name: "Clone" } } as Step;
    const save2 = { id: "s2", action: "click", target: { role: "button", name: "Save" } } as Step;
    const created2 = { id: "w2", action: "assert", target: { text: "was created" }, assertion: "visible" } as Step;
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Base"), fill("Annual Revenue", "5000"), save, created,
      clone, fill("Zq Name", "Zq Copy"), fill("Annual Revenue", "7500"), save2, created2] }, org);
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ object: "Zq_Acct__c", n: 2 });
    expect(t[1].values.map((v) => v.value)).toEqual(["Zq Copy", "7500"]);
    expect(t[0].values.map((v) => v.value)).toEqual(["Zq Base", "5000"]);
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
  it("reads a picklist as its label, the text the case picked (run 2026-11-13T18-45-09-236Z-e01f6e2d)", async () => {
    const tz = [{ object: "Zq_Hours__c", n: 1, values: [{ label: "Zq Zone", api: "Zq_Zone__c", type: "Picklist", value: "(GMT-08:00) Zq Pacific" }] }];
    const apiGet = vi.fn(async () => ({ records: [{ Zq_Zone__c: "(GMT-08:00) Zq Pacific" }] }));
    const out = await apiChecks(apiGet, tz, { Zq_Hours__c: ["a00zq0000000001AAA"] }, { uid: "a", phone: "1" });
    expect(out[0].ok).toBe(true);
    expect(decodeURIComponent(String(apiGet.mock.calls[0][0]))).toContain("SELECT toLabel(Zq_Zone__c) FROM Zq_Hours__c");
  });

  it("fails, with a reason, when the case never reached its record; never queries a bad id", async () => {
    const apiGet = vi.fn();
    const out = await apiChecks(apiGet, typed, { Zq_Acct__c: ["x' OR Id != '"] }, { uid: "a", phone: "1" });
    expect(out[0]).toMatchObject({ ok: false, note: "the case never reached the record it created" });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("fails a value that matches what was typed but is junk: its own label, or a placeholder (run 2026-11-13T15-19-02-592Z-1e01cacf)", async () => {
    const t = (v: string) => [{ object: "Zq_Acct__c", n: 1, values: [{ label: "Zq Name", api: "Name", type: "string", value: v }] }];
    const ids = { Zq_Acct__c: ["a00zq0000000001AAA"] };
    const label = await apiChecks(vi.fn(async () => ({ records: [{ Name: "Zq Name Zqsato" }] })), t("Zq Name Zqsato"), ids, { uid: "a", phone: "1" });
    expect(label[0]).toMatchObject({ ok: false, note: `the field's own label "Zq Name" was saved in its value` });
    const token = await apiChecks(vi.fn(async () => ({ records: [{ Name: "{{yesterday}}" }] })), t("{{yesterday}}"), ids, { uid: "a", phone: "1" });
    expect(token[0]).toMatchObject({ ok: false, note: "a placeholder was saved instead of a value" });
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

describe("caseRunFacts without run tokens", () => {
  it("still returns the created records when the spec typed no token", async () => {
    const { caseRunFacts } = await import("../src/stages/salesforceOracles.js");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const f = join(mkdtempSync(join(tmpdir(), "zq-")), "results.json");
    writeFileSync(f, JSON.stringify({ suites: [{ specs: [{ tests: [{ annotations: [{ type: "sf-created", description: JSON.stringify({ Case: ["500zq0000000001AAA"] }) }] }] }] }] }));
    expect(caseRunFacts(f)).toEqual({ ctx: { uid: "", phone: "" }, created: { Case: ["500zq0000000001AAA"] }, shown: {} });
  });
});

describe("flowRecordChecks", () => {
  const org2 = { objects: [{ api: "Zlead", label: "Zlead", fields: [{ label: "Zind", api: "Industry", type: "picklist" }] }],
    flows: [{ label: "Zq Route", api: "Zq_Route", type: "record-triggered", object: "Zlead", effects: [
      'branch "Hot": when Industry = Tech -> creates a Task "Zq Call" due today + 1, linked to the record by WhoId',
      'branch "Default" (none of the above) -> sets Rating = Cold'] }] };
  const sel = (v: string) => ({ id: "i", action: "select", target: { name: "Zind" }, value: v } as Step);
  const steps = (v: string) => ({ steps: [nav("/lightning/o/Zlead/new"), sel(v), save, created] });
  const now = Date.UTC(2026, 10, 12);

  it("confirms the task on the Hot branch with its due date", async () => {
    const { flowRecordChecks } = await import("../src/stages/salesforceOracles.js");
    const apiGet = vi.fn(async () => ({ records: [{ Id: "00Tzq", ActivityDate: "2026-11-13" }] }));
    const out = await flowRecordChecks(apiGet, steps("Tech"), org2 as any, { Zlead: ["00Qzq0000000001AAA"] }, now);
    expect(out.map((c) => [c.expected, c.actual, c.ok])).toEqual([["exists", "exists", true], ["2026-11-13", "2026-11-13", true]]);
    expect(decodeURIComponent(String(apiGet.mock.calls[0][0]))).toContain("WHERE Subject = 'Zq Call' AND WhoId = '00Qzq0000000001AAA'");
  });

  it("confirms no task on the other branch", async () => {
    const { flowRecordChecks } = await import("../src/stages/salesforceOracles.js");
    const out = await flowRecordChecks(vi.fn(async () => ({ records: [] })), steps("Retail"), org2 as any, { Zlead: ["00Qzq0000000001AAA"] }, now);
    expect(out).toEqual([expect.objectContaining({ expected: "none", actual: "0", ok: true })]);
  });
});

describe("approvalChecks", () => {
  const approvals = [{ label: "Zq Big Deal", object: "Zq_Opp__c" }];
  const click = (name: string) => ({ id: name, action: "click", target: { role: "button", name } } as Step);
  it("expects Approved after Submit then Approve, and reads ProcessInstance", async () => {
    const { approvalChecks } = await import("../src/stages/salesforceOracles.js");
    const apiGet = vi.fn(async () => ({ records: [{ Status: "Approved" }] }));
    const out = await approvalChecks(apiGet, { steps: [click("Submit for Approval"), click("Submit"), click("Approve")] }, approvals, { Zq_Opp__c: ["a01zq0000000001AAA"] });
    expect(out).toEqual([expect.objectContaining({ expected: "Approved", actual: "Approved", ok: true })]);
    expect(decodeURIComponent(String(apiGet.mock.calls[0][0]))).toContain("FROM ProcessInstance WHERE TargetObjectId = 'a01zq0000000001AAA'");
  });
  it("expects Pending after Submit alone, and checks nothing without a submit", async () => {
    const { approvalChecks } = await import("../src/stages/salesforceOracles.js");
    const out = await approvalChecks(vi.fn(async () => ({ records: [{ Status: "Pending" }] })), { steps: [click("Submit for Approval")] }, approvals, { Zq_Opp__c: ["a01zq0000000001AAA"] });
    expect(out[0]).toMatchObject({ expected: "Pending", ok: true });
    expect(await approvalChecks(vi.fn(), { steps: [click("Save")] }, approvals, { Zq_Opp__c: ["a01zq0000000001AAA"] })).toEqual([]);
  });
  it("checks each record once when its object has two processes, named by the one it went through", async () => {
    const { approvalChecks } = await import("../src/stages/salesforceOracles.js");
    const two = [{ label: "Zq Big Deal", object: "Zq_Opp__c" }, { label: "Zq Mega Deal", object: "Zq_Opp__c" }];
    const out = await approvalChecks(vi.fn(async () => ({ records: [{ Status: "Approved", ProcessDefinition: { Name: "Zq Mega Deal" } }] })),
      { steps: [click("Submit for Approval"), click("Submit"), click("Approve")] }, two, { Zq_Opp__c: ["a01zq0000000001AAA"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: "Zq Mega Deal: approval status", ok: true });
  });
  it("expects Removed after a Recall", async () => {
    const { approvalChecks } = await import("../src/stages/salesforceOracles.js");
    const out = await approvalChecks(vi.fn(async () => ({ records: [{ Status: "Removed" }] })), { steps: [click("Submit for Approval"), click("Submit"), click("Recall"), click("Recall")] }, approvals, { Zq_Opp__c: ["a01zq0000000001AAA"] });
    expect(out[0]).toMatchObject({ expected: "Removed", actual: "Removed", ok: true });
  });
});

describe("calculatedChecks with a shown value", () => {
  it("uses the value the spec read off the page for an sf-calc read", async () => {
    const { calculatedChecks } = await import("../src/stages/salesforceOracles.js");
    const withCalc = { objects: [{ ...org.objects[0], calculated: [{ label: "Zq Exp", api: "Zq_Exp__c", type: "Currency" }] }] };
    const read = { id: "sf-calc-a", action: "assert", target: { field: "Zq Exp" }, assertion: "visible" } as Step;
    expect(calculatedChecks({ steps: [nav("/lightning/o/Zq_Acct__c/new"), save, read] }, withCalc as any, { "Zq Exp": "$20,000.00" }))
      .toEqual([{ object: "Zq_Acct__c", n: 1, values: [{ label: "Zq Exp", api: "Zq_Exp__c", type: "Currency", value: "$20,000.00" }] }]);
  });
});

describe("leadConvertChecks", () => {
  const click = (name: string) => ({ id: name, action: "click", target: { role: "button", name } } as Step);
  const lead = { Lead: ["00Qzq0000000001AAA"] };
  it("checks the conversion and what it made: Account by Company, Contact by Last Name, an Opportunity", async () => {
    const { leadConvertChecks } = await import("../src/stages/salesforceOracles.js");
    const apiGet = vi.fn(async () => ({ records: [{ IsConverted: true, Company: "Zq Co", LastName: "Zq Okafor",
      ConvertedAccount: { Name: "Zq Co" }, ConvertedContact: { LastName: "Zq Okafor" }, ConvertedOpportunityId: "006zq0000000001AAA" }] }));
    const out = await leadConvertChecks(apiGet, { steps: [click("Convert"), click("Convert")] }, lead);
    expect(out.map((c) => [c.field, c.ok])).toEqual([["converted", true], ["converted Account name", true], ["converted Contact last name", true], ["converted Opportunity", true]]);
  });
  it("fails a missing Account, and expects no Opportunity when the case ticked Don't create one", async () => {
    const { leadConvertChecks } = await import("../src/stages/salesforceOracles.js");
    const apiGet = vi.fn(async () => ({ records: [{ IsConverted: true, Company: "Zq Co", LastName: "Zq L", ConvertedAccount: null, ConvertedContact: { LastName: "Zq L" }, ConvertedOpportunityId: null }] }));
    const noOpp = { id: "n", action: "check", target: { role: "checkbox", name: "Don't create an opportunity upon conversion" } } as Step;
    const out = await leadConvertChecks(apiGet, { steps: [click("Convert"), noOpp, click("Convert")] }, lead);
    expect(out.find((c) => c.field === "converted Account name")?.ok).toBe(false);
    expect(out.find((c) => c.field === "converted Opportunity")).toMatchObject({ expected: "none", ok: true });
  });
});

describe("a record the case deletes is checked as gone (run 2026-11-13T15-54-10-339Z-babde72e)", () => {
  it("expects it absent from the org instead of reading its fields", async () => {
    const del = (id: string) => ({ id, action: "click", target: { role: "button", name: "Delete" } } as Step);
    const gone = { id: "g", action: "assert", target: { text: "was deleted" }, assertion: "visible" } as Step;
    const t = typedValues({ steps: [nav("/lightning/o/Zq_Acct__c/new"), fill("Zq Name", "Zq Del"), save, created, del("d1"), del("d2"), gone] }, org);
    expect(t[0].deleted).toBe(true);
    const out = await apiChecks(vi.fn(async () => ({ records: [] })), t, { Zq_Acct__c: ["a00zq0000000001AAA"] }, { uid: "a", phone: "1" });
    expect(out).toEqual([{ object: "Zq_Acct__c", id: "a00zq0000000001AAA", field: "deleted", expected: "gone", actual: "gone", ok: true }]);
  });
});

describe("a date-time is read back as the user sees it", () => {
  it("is typed from its sf-dt step, read with FORMAT(), and compared as the same moment", async () => {
    const dtOrg = { objects: [{ api: "ZqAppt", label: "Zq Appt", fields: [{ label: "Zq Due", api: "ZqDue__c", type: "DateTime" }] }] } as any;
    const steps = [
      { id: "n", action: "navigate", target: { url: "/lightning/o/ZqAppt/new" } },
      { id: "sf-dt-a", action: "fill", target: { role: "group", name: "Zq Due" }, value: "{{date:+1:en-US}} 9:00 AM" },
      { id: "s", action: "click", target: { role: "button", name: "Save" } },
      { id: "c", action: "assert", target: { text: "was created" }, assertion: "visible" },
    ] as Step[];
    const t = typedValues({ steps }, dtOrg);
    expect(t[0].values).toEqual([{ label: "Zq Due", api: "ZqDue__c", type: "DateTime", value: "{{date:+1:en-US}} 9:00 AM" }]);
    const apiGet = vi.fn(async () => ({ records: [{ dt0: "11/15/2026, 09:00 AM" }] }));
    const out = await apiChecks(apiGet, [{ object: "ZqAppt", n: 1, values: [{ label: "Zq Due", api: "ZqDue__c", type: "DateTime", value: "11/15/2026 9:00 AM" }] }], { ZqAppt: ["a00zq0000000001AAA"] }, { uid: "a", phone: "1" });
    expect(out[0].ok).toBe(true);
    expect(decodeURIComponent(String(apiGet.mock.calls[0][0]))).toContain("SELECT FORMAT(ZqDue__c) dt0 FROM ZqAppt");
    const wrong = await apiChecks(vi.fn(async () => ({ records: [{ dt0: "11/15/2026 9:30 AM" }] })), [{ object: "ZqAppt", n: 1, values: [{ label: "Zq Due", api: "ZqDue__c", type: "DateTime", value: "11/15/2026 9:00 AM" }] }], { ZqAppt: ["a00zq0000000001AAA"] }, { uid: "a", phone: "1" });
    expect(wrong[0].ok).toBe(false);
  });
});

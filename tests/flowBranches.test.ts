import { describe, it, expect } from "vitest";
import { flowBranches, flowEffects } from "../src/stages/salesforceOrgModel.js";

// Phase B: the org model said only "branches on 1 decision(s)" for a lead-routing flow, so a case could
// not tell which values give Hot, Warm or Cold, nor the Task it creates (TB Lead Qualification Routing).
// Metadata in the Tooling API's JSON shape (Flow.Metadata), Zq names.
const S = (v: string) => ({ stringValue: v });
const routing = {
  start: { connector: { targetReference: "Tier" }, object: "Zlead", triggerType: "RecordAfterSave" },
  decisions: [{
    name: "Tier", label: "Tier",
    defaultConnector: { targetReference: "Set_Cold" }, defaultConnectorLabel: "Zcold",
    rules: [
      { name: "Hot", label: "Zhot", conditionLogic: "and",
        conditions: [
          { leftValueReference: "$Record.AnnualRevenue", operator: "GreaterThanOrEqualTo", rightValue: { numberValue: 1000000 } },
          { leftValueReference: "$Record.Industry", operator: "EqualTo", rightValue: S("Zq Tech") },
        ],
        connector: { targetReference: "Set_Hot" } },
      { name: "Warm", label: "Zwarm", conditionLogic: "and",
        conditions: [{ leftValueReference: "$Record.AnnualRevenue", operator: "GreaterThanOrEqualTo", rightValue: { numberValue: 100000 } }],
        connector: { targetReference: "Set_Warm" } },
    ],
  }],
  recordUpdates: [
    { name: "Set_Hot", inputReference: "$Record", connector: { targetReference: "Call_Task" },
      inputAssignments: [{ field: "Rating", value: S("Zhot") }, { field: "Status", value: S("Zworking") }] },
    { name: "Set_Warm", inputReference: "$Record", inputAssignments: [{ field: "Rating", value: S("Zwarm") }] },
    { name: "Set_Cold", inputReference: "$Record", inputAssignments: [{ field: "Rating", value: S("Zcold") }] },
  ],
  recordCreates: [{ name: "Call_Task", object: "Task", inputAssignments: [{ field: "Subject", value: S("Zq Call the hot lead") }] }],
};

const guard = {
  start: { connector: { targetReference: "Get_Open" }, object: "Zacct", triggerType: "RecordBeforeDelete" },
  recordLookups: [{ name: "Get_Open", object: "Zopp", connector: { targetReference: "Has_Open" },
    filters: [{ field: "AccountId", operator: "EqualTo", value: { elementReference: "$Record.Id" } },
      { field: "IsClosed", operator: "EqualTo", value: { booleanValue: false } }] }],
  decisions: [{ name: "Has_Open", label: "Has Open", defaultConnectorLabel: "Allow",
    rules: [{ name: "Yes", label: "Yes", conditions: [{ leftValueReference: "Get_Open", operator: "IsNull", rightValue: { booleanValue: false } }],
      connector: { targetReference: "Block" } }] }],
  customErrors: [{ name: "Block", customErrorMessages: [{ errorMessage: "Zq: it has open opportunities", isFieldError: false }] }],
};

describe("flowBranches", () => {
  it("one line per branch: its conditions, then the effects on its path, the created record's Subject included", () => {
    expect(flowBranches(routing)).toEqual([
      'branch "Zhot": when AnnualRevenue >= 1000000 and Industry = Zq Tech -> sets Rating = Zhot, Status = Zworking; creates a Task "Zq Call the hot lead"',
      'branch "Zwarm": when AnnualRevenue >= 100000 -> sets Rating = Zwarm',
      'branch "Zcold" (none of the above) -> sets Rating = Zcold',
    ]);
  });

  it("a lookup's null test reads as whether such a record exists, and an error branch names its message", () => {
    expect(flowBranches(guard)).toEqual([
      'branch "Yes": when a Zopp with AccountId = the record\'s Id and IsClosed = false exists -> blocks the save with the error "Zq: it has open opportunities"',
      'branch "Allow" (none of the above) -> does nothing more',
    ]);
  });
});

describe("flowEffects", () => {
  it("lists the branches instead of 'it depends', and a created record's Subject", () => {
    const lines = flowEffects(routing);
    expect(lines).toContain('creates a Task "Zq Call the hot lead"');
    expect(lines.some((l) => l.startsWith('branch "Zhot": when AnnualRevenue >= 1000000'))).toBe(true);
    expect(lines.some((l) => /depends on the record's values/.test(l))).toBe(false);
  });

  it("names a flow's error message even with no decision", () => {
    expect(flowEffects({ customErrors: guard.customErrors })).toContain('can block the save with the error "Zq: it has open opportunities"');
  });
});

// Run 2026-11-10T08-12-42-083Z-1eb7bfea: nine objects filled the 9000-character ceiling and the flows,
// listed last, were cut off: the case writer invented branches the flow does not have.
describe("orgModelForCases keeps the flows when the objects fill the ceiling", () => {
  it("the flows block is outside the objects' ceiling", async () => {
    const { orgModelForCases } = await import("../src/stages/salesforceOrgModel.js");
    const objects = Array.from({ length: 80 }, (_, i) => ({
      api: `Zq_Obj${i}__c`, label: `Zq Obj ${i}`, createable: true,
      fields: Array.from({ length: 30 }, (_, k) => ({ label: `Zq Field ${i}-${k} with a long label`, api: `F${k}`, type: "String", required: k < 3 })),
    }));
    const org = { objects, flows: [{ label: "Zq Routing", api: "Zq_Routing", type: "record-triggered", object: "Zq Obj 0",
      effects: ['branch "Zhot": when Zq Revenue >= 1000000 -> sets Zq Rating = Zhot'] }] } as any;
    const text = orgModelForCases(org);
    expect(text).toContain("(more objects not shown)");
    expect(text).toContain('branch "Zhot": when Zq Revenue >= 1000000');
    expect(text).toContain("ONE case per branch");
  });
});

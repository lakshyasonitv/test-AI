import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { conditionHolds, evalLogic, flowFieldChecks, flowFieldUpdates } from "../src/stages/salesforceFlowChecks.js";
import { generateSpec, SF_SAVED_MATCH_JS } from "../src/stages/generator.js";
import { formatIrStep, parseIrStep } from "../src/stages/stepText.js";
import { extractFn } from "./fixtures/specHelpers.js";
import type { IR } from "../src/schema/ir.js";
import type { SalesforceOrgModel } from "../src/schema/appModel.js";

/**
 * D-78 (SALESFORCE_FLOW_CHECKS_ENABLED): a record-triggered flow's field updates — before-save "fast
 * field updates" included — checked on the SAVED record. Canary names throughout (Zq...); the flow
 * metadata shapes are the Tooling API's (Flow.Metadata: start, assignments, recordUpdates, decisions).
 */

// A before-save flow on Lead: when Rating = Hot, set Zq_Tier__c = Gold and Zq_Hot__c = true, then a
// decision whose branch also sets Zq_Note__c (behind a decision: never checked).
const BEFORE_SAVE = {
  start: {
    object: "Lead",
    filters: [{ field: "Rating", operator: "EqualTo", value: { stringValue: "Hot" } }],
    filterLogic: "and",
    connector: { targetReference: "Set_Tier" },
  },
  assignments: [
    { name: "Set_Tier", assignmentItems: [
      { assignToReference: "$Record.Zq_Tier__c", operator: "Assign", value: { stringValue: "Gold" } },
      { assignToReference: "$Record.Zq_Hot__c", operator: "Assign", value: { booleanValue: true } },
      { assignToReference: "$Record.Zq_Score__c", operator: "Add", value: { numberValue: 10 } },
      { assignToReference: "$Record.Zq_Owner__c", operator: "Assign", value: { elementReference: "$User.Id" } },
    ], connector: { targetReference: "Is_Big" } },
    { name: "Set_Note", assignmentItems: [{ assignToReference: "$Record.Zq_Note__c", operator: "Assign", value: { stringValue: "Big" } }] },
  ],
  decisions: [{ name: "Is_Big", label: "Is it big?", rules: [{ connector: { targetReference: "Set_Note" } }] }],
};

describe("flowFieldUpdates: what a flow sets on its own record, as data", () => {
  it("before-save: fixed values on the path up to the first decision; everything else skipped with why", () => {
    const fu = flowFieldUpdates(BEFORE_SAVE, "RecordBeforeSave")!;
    expect(fu).toMatchObject({ object: "Lead", timing: "before-save", logic: "and",
      conditions: [{ field: "Rating", op: "EqualTo", value: "Hot" }],
      sets: [{ field: "Zq_Tier__c", value: "Gold" }, { field: "Zq_Hot__c", value: "true" }] });
    expect(fu.skipped).toEqual([
      `Zq_Score__c: "Add" changes it relative to its own value`,
      `Zq_Owner__c: set from "$User.Id", not a fixed value`,
      `anything after the decision "Is it big?" depends on the record's values`,
    ]);
  });

  it("after-save: \"update the triggering record\" counts; an update of other records does not", () => {
    const fu = flowFieldUpdates({
      start: { object: "Case", connector: { targetReference: "Upd" } },
      recordUpdates: [
        { name: "Upd", inputReference: "$Record", inputAssignments: [{ field: "Priority", value: { stringValue: "High" } }], connector: { targetReference: "Others" } },
        { name: "Others", object: "Account", filters: [{}], inputAssignments: [{ field: "Rating", value: { stringValue: "Hot" } }] },
      ],
    }, "RecordAfterSave")!;
    expect(fu).toMatchObject({ object: "Case", timing: "after-save", logic: "none", conditions: [], sets: [{ field: "Priority", value: "High" }] });
  });

  it("not record-triggered on save, or no object: nothing", () => {
    expect(flowFieldUpdates(BEFORE_SAVE, "RecordBeforeDelete")).toBeUndefined();
    expect(flowFieldUpdates({ start: {} }, "RecordBeforeSave")).toBeUndefined();
  });

  it("a formula start condition is marked, never guessed at", () => {
    expect(flowFieldUpdates({ start: { object: "Lead", filterFormula: "ISNEW()" } }, "RecordBeforeSave")!.logic).toBe("formula");
  });
});

describe("conditionHolds / evalLogic: three-valued, from the case's own inputs", () => {
  it.each([
    [{ op: "EqualTo", value: "Hot" }, "Hot", false, true],
    [{ op: "EqualTo", value: "Hot" }, "Warm", false, false],
    [{ op: "EqualTo", value: "100" }, "100.0", false, true],
    [{ op: "NotEqualTo", value: "Hot" }, "Warm", false, true],
    [{ op: "NotEqualTo", value: "Hot" }, "Warm", true, undefined],   // a picklist label is not its API value
    [{ op: "GreaterThan", value: "1000" }, "25000", false, true],
    [{ op: "IsNull", value: "false" }, "Acme", false, true],
    [{ op: "IsNull", value: "true" }, "Acme", false, false],
    [{ op: "IsChanged", value: "true" }, "Acme", false, undefined],
    [{ op: "EqualTo", value: "Acme" }, "Acme {{uid}}", false, undefined],
    [{ op: "IsNull", value: "false" }, "Acme {{uid}}", false, true],
    [{ op: "EqualTo", value: "Hot" }, undefined, false, undefined],    // the case does not set it
  ])("%j against %j (picklist %s) -> %s", (c, typed, picklist, want) => {
    expect(conditionHolds(c as any, typed as any, picklist as boolean)).toBe(want);
  });

  it("custom logic, AND/OR/NOT and brackets; unreadable logic is reported, not guessed", () => {
    expect(evalLogic("1 and (2 or 3)", [true, false, true])).toBe(true);
    expect(evalLogic("1 AND NOT 2", [true, true])).toBe(false);
    expect(evalLogic("1 OR 2", [undefined, true])).toBe(true);
    expect(evalLogic("1 AND 2", [undefined, true])).toBeUndefined();
    expect(evalLogic("1 AND 4", [true, true])).toBe("unparsed");
    expect(evalLogic("none", [])).toBe(true);
  });
});

const org = (flowExtra: Partial<NonNullable<SalesforceOrgModel["flows"]>[number]> = {}): SalesforceOrgModel => ({
  validationRulesRead: true,
  objects: [{ api: "Lead", label: "Lead", fields: [
    { label: "Last Name", api: "LastName", type: "String", required: true },
    { label: "Company", api: "Company", type: "String", required: true },
    { label: "Rating", api: "Rating", type: "Picklist", picklist: ["Hot", "Warm", "Cold"] },
    { label: "Zq Tier", api: "Zq_Tier__c", type: "String" },
  ] }],
  flows: [{ label: "Zq Hot Lead", api: "Zq_Hot_Lead", type: "record-triggered", object: "Lead", when: "create",
    fieldUpdates: flowFieldUpdates(BEFORE_SAVE, "RecordBeforeSave"), ...flowExtra }],
});

const saveLead = (rating?: string, extra: IR["steps"] = []): IR => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Lead/new" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Last Name" }, value: "Rao {{uid}}" },
    ...(rating ? [{ id: "s3", action: "select", target: { role: "combobox", name: "Rating" }, value: rating }] : []),
    { id: "s4", action: "click", target: { role: "button", name: "Save" } },
    { id: "sf-outcome", action: "assert", target: { text: "was created" }, assertion: "visible" },
    ...extra,
  ],
}) as IR;

describe("flowFieldChecks: one check per field the flow sets, only when the case meets its conditions", () => {
  it("meets the conditions -> checks the saved record's fields right after the save's outcome", () => {
    const ir = saveLead("Hot", [{ id: "s9", action: "click", target: { role: "tab", name: "Details" } }] as any);
    const notes = flowFieldChecks(ir, org());
    expect(ir.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "sf-outcome", "sf-flow-1", "sf-flow-2", "s9"]);
    expect(ir.steps[5]).toEqual({ id: "sf-flow-1", action: "assert", assertion: "text_equals",
      target: { field: "Zq Tier", recordField: { object: "Lead", n: 1, api: "Zq_Tier__c" } }, value: "Gold" });
    expect(ir.steps[6]).toMatchObject({ target: { field: "Zq_Hot__c", recordField: { api: "Zq_Hot__c" } }, value: "true" });
    expect(notes[0]).toMatch(/^flow "Zq Hot Lead" \(before-save\) on Lead: the case meets its start conditions -> checks the saved record's Zq_Tier__c = "Gold", Zq_Hot__c = "true"; not checked: /);
  });

  it("breaks the conditions -> nothing added, and the note says the flow does not run", () => {
    const ir = saveLead("Warm");
    const notes = flowFieldChecks(ir, org());
    expect(ir.steps.some((s) => s.id.startsWith("sf-flow"))).toBe(false);
    expect(notes).toEqual([`flow "Zq Hot Lead" on Lead: does not run for this case (its start conditions are not met), so nothing is checked`]);
  });

  it("does not set the field a condition reads -> undecided, nothing added, the field named", () => {
    const ir = saveLead();
    expect(flowFieldChecks(ir, org())).toEqual([
      `flow "Zq Hot Lead" on Lead: not checked — whether it runs depends on Rating, which the case does not set to a fixed value`]);
    expect(ir.steps).toHaveLength(4);
  });

  it("no \"was created\" after the save (a refused save) -> nothing added", () => {
    const ir = saveLead("Hot");
    ir.steps.splice(4, 1, { id: "neg", action: "assert", target: { text: "We hit a snag." }, assertion: "visible" });
    expect(flowFieldChecks(ir, org())[0]).toMatch(/not checked — the case does not show this save succeeding/);
    expect(ir.steps.some((s) => s.id.startsWith("sf-flow"))).toBe(false);
  });

  it("the second Lead the case saves is record number 2", () => {
    const ir = saveLead("Hot");
    const again = saveLead("Hot").steps.map((s) => ({ ...s, id: `b-${s.id}` }));
    ir.steps.push(...again);
    flowFieldChecks(ir, org());
    expect(ir.steps.filter((s) => s.target?.recordField).map((s) => s.target!.recordField!.n)).toEqual([1, 1, 2, 2]);
  });

  it("a create form opened by a click makes the record numbers unknowable -> nothing checked", () => {
    const ir = saveLead("Hot");
    ir.steps.splice(1, 0, { id: "c", action: "click", target: { role: "button", name: "New" } });
    expect(flowFieldChecks(ir, org())[0]).toMatch(/opened by a click/);
  });

  it("an update-only flow, a flow on another object, or no org model: untouched", () => {
    for (const o of [org({ when: "update" }), org({ fieldUpdates: { ...flowFieldUpdates(BEFORE_SAVE, "RecordBeforeSave")!, object: "Account" } }), undefined]) {
      const ir = saveLead("Hot");
      expect(flowFieldChecks(ir, o)).toEqual([]);
      expect(ir.steps).toHaveLength(5);
    }
  });
});

describe("the spec reads the saved record (sfSavedField)", () => {
  const ir = saveLead("Hot");
  flowFieldChecks(ir, org());
  const SPEC = generateSpec(ir, "artifacts");

  it("emits one sfSavedField per check, the record tracker it needs, and no page scrolling for it", () => {
    expect(SPEC).toContain(`await sfSavedField(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals");`);
    expect(SPEC).toContain("async function sfSavedField(");
    expect(SPEC).toContain("sfRecordPages = (");        // SF_OPEN_RECORD_HELPER, for the record id
    expect(SPEC).not.toContain("await sfReveal(page, \"Zq Tier\")");
    expect(SPEC).toContain(`"Check the saved Lead record: Zq Tier is 'Gold' (set by a flow)"`);
  });

  it("a spec with no such step is unchanged: no helper is spliced", () => {
    expect(generateSpec(saveLead("Hot"), "artifacts")).not.toMatch(/sfSavedField|sfRecordPages/);
  });

  it("the step editor renders it as a field check and an untouched line keeps the saved-record read", () => {
    const step = ir.steps.find((s) => s.id === "sf-flow-1")!;
    const line = formatIrStep(step);
    expect(line).toBe(`Check that the "Zq Tier" field shows "Gold"`);
    const back = parseIrStep(line, step);
    expect(back.ok && back.step.target).toEqual(step.target);
  });

  it("SF_SAVED_MATCH_JS compares API values: numbers as numbers, booleans by case, multi-select in any order", () => {
    const m = new Function(`return (${SF_SAVED_MATCH_JS});`)();
    expect(m("Gold", "Gold", "equals")).toBe(true);
    expect(m("Silver", "Gold", "equals")).toBe(false);
    expect(m(100, "100.0", "equals")).toBe(true);
    expect(m(true, "true", "equals")).toBe(true);
    expect(m(false, "true", "equals")).toBe(false);
    expect(m("B;A", "A;B", "equals")).toBe(true);
    expect(m(null, "Gold", "equals")).toBe(false);
  });

  // D-19: the emitted helper, EXECUTED, against a local stand-in for the org's REST API.
  describe("executed against a fake org API", () => {
    let server: http.Server;
    let base = "";
    let tier: unknown = "Gold";
    let status = 200;
    const seen: { url: string; auth: string }[] = [];
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(status === 200 ? { Id: "00Qzq0000000001AAA", Zq_Tier__c: tier } : [{ message: "Session expired" }]));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    afterEach(() => { delete process.env.SF_FRONTDOOR_URL; tier = "Gold"; status = 200; seen.length = 0; });

    const TOKEN = "00Dzq!SECRET.token";
    const helper = (created: string | null) => {
      const src = SPEC.slice(SPEC.indexOf("const sfSavedMatch = "), SPEC.indexOf("async function sfSavedField(")) + extractFn(SPEC, "sfSavedField");
      return new Function("sfRecordPages", `${src}\nreturn sfSavedField;`)({ created: () => created });
    };
    const page = { waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) };

    it("passes when the saved field holds the flow's value; reads it with the token in a header only", async () => {
      process.env.SF_FRONTDOOR_URL = `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(TOKEN)}&retURL=%2Flightning`;
      await helper("00Qzq0000000001AAA")(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals");
      expect(seen[0].url).toBe("/services/data/v62.0/sobjects/Lead/00Qzq0000000001AAA?fields=Zq_Tier__c");
      expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it("fails naming what the record holds when the flow did not set it", async () => {
      process.env.SF_FRONTDOOR_URL = `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(TOKEN)}`;
      tier = "Silver";
      await expect(helper("00Qzq0000000001AAA")(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals"))
        .rejects.toThrow(`The saved Lead record's Zq Tier (Zq_Tier__c) is "Silver", not "Gold": the flow that sets it did not run, or set something else.`);
    }, 20_000);

    it("an API refusal says HTTP status and never the token", async () => {
      process.env.SF_FRONTDOOR_URL = `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(TOKEN)}`;
      status = 401;
      const err = await helper("00Qzq0000000001AAA")(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals").catch((e: Error) => e);
      expect(err.message).toBe("Reading the saved Lead record through the org connection failed: HTTP 401.");
      expect(err.message).not.toContain("SECRET");
    });

    it("no org connection, or no record reached: a clear failure, not a pass", async () => {
      await expect(helper("00Qzq0000000001AAA")(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals")).rejects.toThrow(/needs the org connection/);
      process.env.SF_FRONTDOOR_URL = `${base}/secur/frontdoor.jsp?sid=x`;
      await expect(helper(null)(page, "Lead", 1, "Zq_Tier__c", "Zq Tier", "Gold", "equals")).rejects.toThrow(/No Lead record this test created \(number 1\) was reached/);
    }, 20_000);
  });
});

import { describe, it, expect, vi } from "vitest";
import { requestedEventFlows, publishRequestedEvents, seedEnabled } from "../src/stages/salesforceSeed.js";
import { flowEffects } from "../src/stages/salesforceOrgModel.js";

// Phase D seeding: a platform-event flow's event, published once through the API. Canary names (Zq).
const flow = () => ({ label: "Zq Event Make Acct", api: "Zq_Event_Make_Acct", type: "platform-event", event: "Zq_Ping__e",
  effects: ["creates a Account with Name = the triggering record's Note__c"] });
const org = () => ({ objects: [], validationRulesRead: true, flows: [flow(), { label: "Zq Other", api: "Zq_Other", type: "record-triggered" }] });

describe("requestedEventFlows", () => {
  it("finds a flow the request names, or the only one when it says platform event", () => {
    expect(requestedEventFlows(org(), "test the zq event make acct flow").map((f) => f.api)).toEqual(["Zq_Event_Make_Acct"]);
    expect(requestedEventFlows(org(), "check the platform event creates an account")).toHaveLength(1);
    expect(requestedEventFlows(org(), "create an account")).toEqual([]);
  });
});

describe("publishRequestedEvents", () => {
  it("publishes the event's text fields once and writes the value into the flow's lines", async () => {
    const apiGet = vi.fn(async () => ({ fields: [
      { name: "Note__c", type: "string", createable: true, length: 255 },
      { name: "CreatedById", type: "reference", createable: false },
      { name: "Count__c", type: "double", createable: true },
    ] }));
    const apiPost = vi.fn(async () => ({ id: "e00zq", success: true }));
    const o = org();
    const out = await publishRequestedEvents({ apiGet, apiPost }, o as any, "test the Zq Event Make Acct flow", "ab12cd");
    expect(apiPost).toHaveBeenCalledWith("/sobjects/Zq_Ping__e/", { Note__c: "TB Event ab12cd" });
    expect(out).toEqual([{ flow: "Zq Event Make Acct", event: "Zq_Ping__e", values: { Note__c: "TB Event ab12cd" }, id: "e00zq" }]);
    expect(o.flows[0].effects).toEqual([
      expect.stringContaining('ALREADY PUBLISHED this event once before the test, through the API (Zq_Ping__e with Note__c = "TB Event ab12cd"). The case writes NO publish step; it only checks what the flow did. To check it: open /lightning/o/Account/list, type "TB Event ab12cd"'),
      'creates a Account "TB Event ab12cd"',
    ]);
  });

  it("a refused publish is reported and the flow's lines stay as they were", async () => {
    const o = org();
    const out = await publishRequestedEvents({ apiGet: vi.fn(async () => ({ fields: [] })), apiPost: vi.fn(async () => { throw new Error("HTTP 400"); }) },
      o as any, "zq event make acct", "x");
    expect(out[0].error).toBe("HTTP 400");
    expect(o.flows[0].effects).toEqual(flow().effects);
  });

  it("is off unless asked for", () => {
    const was = process.env.SALESFORCE_SEED_ENABLED;
    delete process.env.SALESFORCE_SEED_ENABLED;
    expect(seedEnabled()).toBe(false);
    if (was !== undefined) process.env.SALESFORCE_SEED_ENABLED = was;
  });
});

describe("flowEffects names a record created from the triggering record", () => {
  it("says which field of the trigger names it", () => {
    expect(flowEffects({ recordCreates: [{ object: "Account", inputAssignments: [{ field: "Name", value: { elementReference: "$Record.Note__c" } }] }] }))
      .toEqual(["creates a Account with Name = the triggering record's Note__c"]);
  });
});

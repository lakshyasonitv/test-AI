import { describe, it, expect, vi } from "vitest";
import { requestedEventFlows, publishRequestedEvents, seedEnabled, seedExistingRecords } from "../src/stages/salesforceSeed.js";
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
    expect(out).toEqual([{ flow: "Zq Event Make Acct", event: "Zq_Ping__e", values: { Note__c: "TB Event ab12cd" }, id: "e00zq",
      creates: [{ object: "Account", name: "TB Event ab12cd" }] }]);
    expect(o.flows[0].effects).toEqual([
      expect.stringContaining('ALREADY PUBLISHED this event once before the test, through the API (Zq_Ping__e with Note__c = "TB Event ab12cd"). The case writes NO publish step; it only checks what the flow did. To check it: click the header\'s "Search..." box, type "TB Event ab12cd"'),
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

describe("withoutPublishSteps", () => {
  it("cuts a case at its own publish step when it already searched, else drops only that step", async () => {
    const { withoutPublishSteps } = await import("../src/stages/salesforceSeed.js");
    const searchedFirst = { steps: ["Go to the home page.", "Type \"TB Event x\" in the search box and press Enter.", "Publish the event with Message = x.", "Search again for x."] };
    expect(withoutPublishSteps([searchedFirst])[0].steps).toEqual(searchedFirst.steps.slice(0, 2));
    const publishFirst = { steps: ["Publish the event.", "Search for \"TB Event x\"."] };
    expect(withoutPublishSteps([publishFirst])[0].steps).toEqual(["Search for \"TB Event x\"."]);
    const goThenPublish = { steps: ["Go to the home page.", "Publish the event.", "Search for \"TB Event x\"."] };
    expect(withoutPublishSteps([goThenPublish])[0].steps).toEqual(["Go to the home page.", "Search for \"TB Event x\"."]);
    const none = { steps: ["Search for x."] };
    expect(withoutPublishSteps([none])[0]).toBe(none);
  });
});

describe("seedExistingRecords", () => {
  const model = () => ({ objects: [
    { api: "Zq_Acct__c", label: "Zq Acct", labelPlural: "Zq Accts", fields: [
      { label: "Zq Name", api: "Name", type: "string", required: true },
      { label: "Zq Tier", api: "Tier__c", type: "picklist", required: true, picklist: ["Gold", "Silver"] },
      { label: "Zq Note", api: "Note__c", type: "string" }] },
    { api: "Zq_Kid__c", label: "Zq Kid", fields: [{ label: "Zq Parent", api: "Parent__c", type: "reference", required: true, lookup: "Zq_Acct__c" }] },
  ], validationRulesRead: true } as any);

  it("creates the existing record the request means, marks it viewed, and tells the case writer", async () => {
    const posts: any[] = [];
    const gets: string[] = [];
    const org = model();
    const out = await seedExistingRecords({ apiGet: vi.fn(async (p: string) => { gets.push(decodeURIComponent(p)); return {}; }),
      apiPost: vi.fn(async (p: string, b: unknown) => { posts.push([p, b]); return { id: "a00zq0000000001AAA" }; }) },
      org, "Create a Zq Kid for an existing Zq Acct and verify the link", "ab12cd");
    expect(posts).toEqual([["/sobjects/Zq_Acct__c/", { Name: "TB Seed ab12cd", Tier__c: "Gold" }]]);
    expect(gets[0]).toContain("FOR VIEW");
    expect(out).toEqual([{ object: "Zq_Acct__c", name: "TB Seed ab12cd", id: "a00zq0000000001AAA" }]);
    expect(org.seeded).toEqual([{ object: "Zq_Acct__c", label: "Zq Acct", name: "TB Seed ab12cd" }]);
    const { orgModelForCases } = await import("../src/stages/salesforceOrgModel.js");
    expect(orgModelForCases(org)).toContain('ALREADY CREATED for this test, through the API');
  });

  it("seeds nothing without 'existing', and refuses a record with a required lookup", async () => {
    const apiPost = vi.fn();
    expect(await seedExistingRecords({ apiGet: vi.fn(), apiPost }, model(), "Create a Zq Acct", "x")).toEqual([]);
    const out = await seedExistingRecords({ apiGet: vi.fn(), apiPost }, model(), "Open an existing Zq Kid", "x");
    expect(out[0].error).toMatch(/required lookup Zq Parent/);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  calculatedDefinition, deepDiscoveryEnabled, readDeepFacts, visibilityRulesOf,
} from "../src/stages/salesforceOrgDeep.js";
import { orgModelForCases } from "../src/stages/salesforceOrgModel.js";
import type { SalesforceOrgModel } from "../src/schema/appModel.js";

/**
 * Phase 1, slice 1 (SALESFORCE_DEEP_DISCOVERY_ENABLED). Response shapes copied from what the scratch
 * org returned on 2026-11-03 (FlexiPage Metadata, CustomField summary Metadata, UI API layouts and
 * picklist values), with canary names.
 */
const thing = (): SalesforceOrgModel["objects"][number] => ({
  api: "Zq_Thing__c", label: "Zq Thing", labelPlural: "Zq Things", createable: true,
  fields: [
    { label: "Zq Priority", api: "Zq_Priority__c", type: "Picklist", picklist: ["Low", "High"] },
    { label: "Zq Level", api: "Zq_Level__c", type: "Picklist", picklist: ["Gold", "Silver"] },
    { label: "Zq Partner Code", api: "Zq_Partner_Code__c", type: "String" },
  ],
  calculated: [{ label: "Zq Total", api: "Zq_Total__c", type: "Currency" }],
  recordTypes: [{ name: "Zq Retail", id: "012000000000001AAA", default: true }, { name: "Zq Partner", id: "012000000000002AAA" }],
});
const other = (): SalesforceOrgModel["objects"][number] => ({ api: "Zq_Other__c", label: "Zq Other", fields: [] });

const FLEXI_META = {
  sobjectType: "Zq_Thing__c",
  flexiPageRegions: [
    { itemInstances: [{ componentInstance: null, fieldInstance: { fieldItem: "Record.OwnerId", visibilityRule: null } }] },
    { itemInstances: [{ componentInstance: null, fieldInstance: {
      fieldItem: "Record.Zq_Level__c",
      visibilityRule: { booleanFilter: null, criteria: [{ leftValue: "{!Record.Zq_Priority__c}", operator: "EQUAL", rightValue: "High" }] },
    } }] },
    { itemInstances: [{ fieldInstance: null, componentInstance: {
      componentName: "flexipage:fieldSection",
      componentInstanceProperties: [{ name: "label", value: "Zq Gold Details" }],
      visibilityRule: { booleanFilter: "1 OR 2", criteria: [
        { leftValue: "{!Record.Zq_Level__c}", operator: "EQUAL", rightValue: "Gold" },
        { leftValue: "{!Record.Zq_Priority__c}", operator: "NE", rightValue: "Low" },
      ] },
    } }] },
  ],
};
const SUMMARY_META = { label: "Zq Total", type: "Summary", summaryOperation: "sum", summarizedField: "Zq_Child__c.Amount__c", summaryForeignKey: "Zq_Child__c.Thing__c", formula: null };

const layout = (fields: string[]) => ({ sections: [{ layoutRows: [{ layoutItems: fields.map((f) => ({ layoutComponents: [{ componentType: "Field", apiName: f }] })) }] }] });
const picks = (level: string[]) => ({ picklistFieldValues: {
  Zq_Priority__c: { values: [{ label: "Low" }, { label: "High" }] },
  Zq_Level__c: { values: level.map((l) => ({ label: l })) },
} });

/** A fake org answering the GETs the deep read makes; records every path. */
function fakeOrg() {
  const paths: string[] = [];
  const apiGet = async (p: string) => {
    paths.push(p);
    const q = p.startsWith("/tooling/query?q=") ? decodeURIComponent(p.slice("/tooling/query?q=".length)) : "";
    if (p.includes("layout/Zq_Thing__c") && p.includes("012000000000001AAA")) return layout(["Name", "Zq_Priority__c"]);
    if (p.includes("layout/Zq_Thing__c") && p.includes("012000000000002AAA")) return layout(["Name", "Zq_Priority__c", "Zq_Partner_Code__c"]);
    if (p.includes("picklist-values/012000000000001AAA")) return picks(["Gold", "Silver"]);
    if (p.includes("picklist-values/012000000000002AAA")) return picks(["Silver"]);
    if (q.startsWith("SELECT Id, DeveloperName, EntityDefinitionId FROM FlexiPage")) return { records: [{ Id: "0M0000000000001AAA", DeveloperName: "Zq_Page", EntityDefinitionId: "01I000000000001AAA" }] };
    if (q.includes("FROM FlexiPage WHERE Id = '0M0000000000001AAA'")) return { records: [{ Metadata: FLEXI_META }] };
    if (q.includes("FROM CustomField WHERE DeveloperName = 'Zq_Total'")) return { records: [{ Id: "00N000000000001AAA", TableEnumOrId: "01I000000000001AAA" }] };
    if (q.includes("FROM CustomField WHERE Id = '00N000000000001AAA'")) return { records: [{ Metadata: SUMMARY_META }] };
    throw new Error("404 " + p);
  };
  return { apiGet, paths };
}

afterEach(() => vi.unstubAllEnvs());

describe("Phase 1 deep read", () => {
  it("is off unless SALESFORCE_DEEP_DISCOVERY_ENABLED=true", () => {
    expect(deepDiscoveryEnabled()).toBe(false);
    vi.stubEnv("SALESFORCE_DEEP_DISCOVERY_ENABLED", "true");
    expect(deepDiscoveryEnabled()).toBe(true);
  });

  it("reads a visibility rule as the org's page states it", () => {
    expect(visibilityRulesOf(FLEXI_META, thing())).toEqual([
      { target: "Zq Level", when: "Zq Priority = High" },
      { target: 'section "Zq Gold Details"', when: "Zq Level = Gold or Zq Priority is not Low" },
    ]);
  });

  it("states a roll-up and a formula", () => {
    expect(calculatedDefinition(SUMMARY_META)).toBe("sum of Zq_Child__c.Amount__c");
    expect(calculatedDefinition({ summaryOperation: "count", summaryForeignKey: "Zq_Child__c.Thing__c" })).toBe("count of Zq_Child__c records");
    expect(calculatedDefinition({ formula: "Amount__c *\n Rate__c" })).toBe("= Amount__c * Rate__c");
    expect(calculatedDefinition({})).toBeUndefined();
  });

  it("adds record-type differences, visibility rules and roll-up definitions to the request's object only", async () => {
    const org: SalesforceOrgModel = { objects: [thing(), other()], validationRulesRead: true };
    const { apiGet, paths } = fakeOrg();
    const out = await readDeepFacts(apiGet, org, "Create a Zq Thing and fill each and every field");
    const t = org.objects[0];
    expect(t.recordTypes![1]).toMatchObject({ name: "Zq Partner", onlyFields: ["Zq Partner Code"], picklists: { "Zq Level": ["Silver"] } });
    expect(t.recordTypes![0].onlyFields).toBeUndefined();
    expect(t.visibilityRules).toEqual(visibilityRulesOf(FLEXI_META, t));
    expect(t.calculated![0].definition).toBe("sum of Zq_Child__c.Amount__c");
    expect(org.objects[1]).toEqual(other());
    expect(out).toMatchObject({ objects: 1, calls: paths.length });
  });

  it("reads nothing when the request names no object", async () => {
    const org: SalesforceOrgModel = { objects: [thing()], validationRulesRead: true };
    const { apiGet, paths } = fakeOrg();
    await readDeepFacts(apiGet, org, "check the home page");
    expect(paths).toEqual([]);
    expect(org.objects[0]).toEqual(thing());
  });

  it("puts the facts in the case writer's prompt, the object carrying them first", async () => {
    const org: SalesforceOrgModel = { objects: [other(), thing()], validationRulesRead: true };
    await readDeepFacts(fakeOrg().apiGet, org, "Create a Zq Thing");
    const text = orgModelForCases(org);
    expect(text.indexOf("Zq Things")).toBeLessThan(text.indexOf("Zq Other"));
    expect(text).toContain("Zq Total (Currency) = sum of Zq_Child__c.Amount__c");
    expect(text).toContain("record type Zq Partner differs from the default: only its form shows Zq Partner Code; Zq Level offers Silver");
    expect(text).toContain("shown only when (Dynamic Forms; appears on the page without a reload once the condition holds): Zq Level when Zq Priority = High");
  });

  it("flag off: a model without deep facts gives the same prompt, in the same object order", () => {
    const org: SalesforceOrgModel = { objects: [other(), thing()], validationRulesRead: true };
    const text = orgModelForCases(org);
    expect(text.indexOf("Zq Other")).toBeLessThan(text.indexOf("Zq Things"));
    expect(text).not.toMatch(/differs from the default|shown only when|sum of/);
  });
});

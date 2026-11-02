import { describe, it, expect, afterEach } from "vitest";
import { checkCase, checkSuite, verdictOf, fieldsUsed, regressionChangeCheckEnabled, type OrgNow } from "../src/stages/regressionChangeCheck.js";
import { readOrgForCheck, readSalesforceRelease, type OrgObjectNow } from "../src/stages/salesforceOrgModel.js";
import { IR } from "../src/schema/ir.js";

/**
 * D-73 step 2: compare the org now with what a saved case remembered. One test per row of the
 * design's table, plus its overriding rule: what could not be read is "unknown", never "unchanged".
 * All names are made-up canaries in the shape the org model and UI API use.
 */

const snapshot = {
  host: "zq-dev.scratch.my.salesforce.com",
  validationRulesRead: true,
  release: { label: "Summer '26", version: "62.0" },
  objects: [{
    api: "Zq_Deal__c", label: "Zq Deal",
    fields: [
      { label: "Zq Name", api: "Name", type: "String", required: true },
      { label: "Close Date", api: "Close_Date__c", type: "Date", required: true },
      { label: "Stage", api: "Stage__c", type: "Picklist", required: true, picklist: ["Prospecting", "Closed Won"] },
    ],
    recordTypes: [{ name: "Zq Big", id: "012Zq0000000001AAA" }, { name: "Zq Small", id: "012Zq0000000002AAA" }],
    validationRules: [{ name: "Zq_Rule", condition: "ISBLANK(Name)" }],
  }],
  flows: [{ label: "Zq flow", api: "Zq_Flow", type: "record-triggered", object: "Zq Deal" }],
};

const saved = (over: { steps?: any[]; remembered?: any } = {}): IR => IR.parse({
  meta: {
    feature: "f", title: "Create a Zq Deal", priority: "high", sourcePrompt: "p",
    baseUrl: "https://zq-dev.scratch.lightning.force.com",
    remembered: over.remembered ?? {
      savedFrom: "r1", at: "2026-11-01T00:00:00.000Z", org: snapshot,
      elements: {
        s2: { path: "/lightning/o/Zq_Deal__c/new", matches: 1, sfField: "Zq_Deal__c.Name" },
        s3: { path: "/lightning/o/Zq_Deal__c/new", matches: 1, sfField: "Zq_Deal__c.Close_Date__c" },
      },
    },
  },
  steps: over.steps ?? [
    { id: "auth-0", action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } },
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Deal__c/new?count=1&recordTypeId=012Zq0000000001AAA" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name", css: "input[name=\"Name\"]" }, value: "Zq {{uid}}" },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Close Date" }, value: "{{date:+30:en-US}}" },
    { id: "s4", action: "select", target: { role: "combobox", name: "Stage" }, value: "Prospecting" },
    { id: "s5", action: "click", target: { role: "button", name: "Save" } },
    { id: "s6", action: "assert", target: { text: "was created" }, assertion: "visible" },
  ],
});

/** The org now, starting identical to the snapshot. */
const liveDeal = (): OrgObjectNow => ({
  api: "Zq_Deal__c", label: "Zq Deal",
  fields: {
    Name: { label: "Zq Name", type: "String", required: true },
    Close_Date__c: { label: "Close Date", type: "Date", required: true },
    Stage__c: { label: "Stage", type: "Picklist", required: true },
    Notes__c: { label: "Zq Notes", type: "TextArea", required: false },
  },
  picklists: { Stage__c: ["Prospecting", "Closed Won"] },
  recordTypes: [{ name: "Zq Big", id: "012Zq0000000001AAA" }, { name: "Zq Small", id: "012Zq0000000002AAA" }],
});
const now = (deal: OrgObjectNow | null = liveDeal(), over: Partial<OrgNow> = {}): OrgNow => ({
  objects: { Zq_Deal__c: deal },
  validationRules: { Zq_Deal__c: [{ name: "Zq_Rule", condition: "ISBLANK(Name)" }] },
  flows: [{ api: "Zq_Flow", label: "Zq flow", object: "Zq Deal" }],
  release: { label: "Summer '26", version: "62.0" },
  ...over,
});
const verdict = (n: OrgNow, ir = saved()) => verdictOf(checkCase(ir, n));

describe("regressionChangeCheckEnabled", () => {
  afterEach(() => { delete process.env.REGRESSION_CHANGE_CHECK_ENABLED; });
  it("is off unless asked for", () => {
    expect(regressionChangeCheckEnabled()).toBe(false);
    process.env.REGRESSION_CHANGE_CHECK_ENABLED = "true";
    expect(regressionChangeCheckEnabled()).toBe(true);
  });
});

describe("which org fields a case uses", () => {
  it("the passing run's field binding first, then the step's label against the snapshot", () => {
    expect(fieldsUsed(saved()).map((u) => `${u.stepId}:${u.object}.${u.field}`))
      .toEqual(["s2:Zq_Deal__c.Name", "s3:Zq_Deal__c.Close_Date__c", "s4:Zq_Deal__c.Stage__c"]);
  });
});

describe("the design's table, row by row", () => {
  it("nothing changed: unchanged, no findings", () => {
    expect(checkCase(saved(), now())).toEqual([]);
    expect(verdict(now())).toBe("unchanged");
  });

  it("label renamed, same API name: info, the repair can rebind it", () => {
    const d = liveDeal(); d.fields.Close_Date__c.label = "Expected Close";
    const f = checkCase(saved(), now(d));
    expect(f).toEqual([expect.objectContaining({ severity: "info", field: "Close_Date__c", stepId: "s3" })]);
    expect(f[0].message).toMatch(/"Close Date" is now labelled "Expected Close"/);
    expect(verdictOf(f)).toBe("changed");
  });

  it("the binding survives the rename: a renamed field the step found by its OLD label is still the same field", () => {
    const d = liveDeal(); d.fields.Close_Date__c.label = "Expected Close";
    expect(checkCase(saved(), now(d)).some((x) => x.severity === "blocking")).toBe(false);
  });

  it("field removed: blocking, the case is affected", () => {
    const d = liveDeal(); delete (d.fields as any).Close_Date__c;
    expect(checkCase(saved(), now(d))[0]).toMatchObject({ severity: "blocking", field: "Close_Date__c", stepId: "s3" });
    expect(verdict(now(d))).toBe("affected");
  });

  it("field type changed: blocking", () => {
    const d = liveDeal(); d.fields.Close_Date__c.type = "DateTime";
    expect(checkCase(saved(), now(d))[0]).toMatchObject({ severity: "blocking", message: expect.stringMatching(/from Date to DateTime/) });
  });

  it("a new required field the case does not fill: likely to fail", () => {
    const d = liveDeal(); d.fields.Notes__c.required = true;
    expect(checkCase(saved(), now(d))).toEqual([expect.objectContaining({ severity: "likely-fail", field: "Notes__c" })]);
    expect(verdict(now(d))).toBe("likely-to-fail");
  });

  it("a field that was ALREADY required when the case passed is not news (something else filled it)", () => {
    const snap2 = structuredClone(snapshot) as any;
    snap2.objects[0].fields.push({ label: "Zq Owner", api: "Zq_Owner__c", type: "Reference", required: true });
    const ir = saved({ remembered: { savedFrom: "r1", at: "t", org: snap2 } });
    const d = liveDeal(); d.fields.Zq_Owner__c = { label: "Zq Owner", type: "Reference", required: true };
    expect(checkCase(ir, now(d))).toEqual([]);
  });

  it("a picklist value the case picks is gone: blocking", () => {
    const d = liveDeal(); d.picklists.Stage__c = ["Qualifying", "Closed Won"];
    expect(checkCase(saved(), now(d))[0]).toMatchObject({ severity: "blocking", field: "Stage__c", stepId: "s4" });
  });

  it("the record type the case opens is gone: blocking", () => {
    const d = liveDeal(); d.recordTypes = [{ name: "Zq Small", id: "012Zq0000000002AAA" }];
    expect(checkCase(saved(), now(d))[0]).toMatchObject({ severity: "blocking", stepId: "s1", message: expect.stringMatching(/"Zq Big"/) });
  });

  it("a validation rule or a flow changed: info", () => {
    const f = checkCase(saved(), now(undefined, {
      validationRules: { Zq_Deal__c: [{ name: "Zq_Rule", condition: "ISBLANK(Name)" }, { name: "Zq_New", condition: "x" }] },
      flows: [],
    }));
    expect(f.map((x) => x.severity)).toEqual(["info", "info"]);
    expect(f[0].message).toMatch(/Zq_New/);
    expect(f[1].message).toMatch(/no longer active: Zq_Flow/);
  });

  it("the release changed: one note for the whole suite", () => {
    const r = checkSuite([{ id: "c1", title: "t", ir: saved() }], now(undefined, { release: { label: "Winter '27", version: "63.0" } }), "zq-dev.scratch.my.salesforce.com");
    expect(r.releaseNote).toMatch(/now Winter '27.*saved under Summer '26/);
    expect(r.org?.release?.label).toBe("Winter '27");
    expect(r.cases[0].verdict).toBe("unchanged");
  });
});

describe("unknown, never unchanged", () => {
  it("an object that could not be read", () => {
    expect(checkCase(saved(), now(null))[0]).toMatchObject({ severity: "unknown" });
    expect(verdict(now(null))).toBe("unknown");
  });
  it("validation rules the Tooling API would not give now, or did not give when saved", () => {
    expect(verdict(now(undefined, { validationRules: null }))).toBe("unknown");
    const ir = saved({ remembered: { savedFrom: "r1", at: "t", org: { ...snapshot, validationRulesRead: false } } });
    expect(verdict(now(), ir)).toBe("unknown");
  });
  it("blocking still outranks unknown", () => {
    const d = liveDeal(); delete (d.fields as any).Name;
    expect(verdict(now(d, { validationRules: null }))).toBe("affected");
  });
  it("the whole org unreadable: every Salesforce case is unknown", () => {
    expect(checkSuite([{ id: "c1", title: "t", ir: saved() }], null, null).cases[0].verdict).toBe("unknown");
  });
});

describe("cases the check cannot speak for are listed, never passed", () => {
  it("an ordinary site: not-salesforce; a Salesforce case saved before step 1: no-snapshot", () => {
    const plain = IR.parse({ meta: { feature: "f", title: "Login", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "navigate", target: { url: "/" } }] });
    const old = IR.parse({ ...saved(), meta: { ...saved().meta, remembered: undefined } });
    const r = checkSuite([{ id: "a", title: "Login", ir: plain }, { id: "b", title: "Old", ir: old }], now(), "h");
    expect(r.cases.map((c) => c.verdict)).toEqual(["not-salesforce", "no-snapshot"]);
  });
});

describe("the readers (read-only, no browser)", () => {
  const fakeApi = (fieldCount: number, failObject = false) => async (p: string) => {
    if (p.startsWith("/ui-api/object-info/Zq_Deal__c/picklist-values/")) return { picklistFieldValues: { Stage__c: { values: [{ label: "Prospecting" }] } } };
    if (p.startsWith("/ui-api/object-info/Zq_Deal__c")) {
      if (failObject) throw new Error("HTTP 403");
      const fields: Record<string, unknown> = {};
      for (let i = 0; i < fieldCount; i++) fields[`F${i}__c`] = { apiName: `F${i}__c`, label: `F ${i}`, dataType: "String", createable: true };
      return { label: "Zq Deal", defaultRecordTypeId: "012Zq0000000001AAA", fields, recordTypeInfos: {} };
    }
    if (p.startsWith("/ui-api/layout/")) return { sections: [] };
    if (p.startsWith("/tooling/query")) return { records: [] };
    if (p.startsWith("/query")) return { records: [] };
    return null;
  };
  it("keeps EVERY field (the org model's 40-field cap would make field 41 look removed)", async () => {
    const r = await readOrgForCheck({ apiGet: fakeApi(60) }, ["Zq_Deal__c"]);
    expect(Object.keys(r.objects.Zq_Deal__c!.fields)).toHaveLength(60);
    expect(r.objects.Zq_Deal__c!.picklists.Stage__c).toEqual(["Prospecting"]);
  });
  it("an object it cannot read is null (so: unknown)", async () => {
    const r = await readOrgForCheck({ apiGet: fakeApi(3, true) }, ["Zq_Deal__c"]);
    expect(r.objects.Zq_Deal__c).toBeNull();
  });
  it("the release is the newest version's label", async () => {
    const rel = await readSalesforceRelease({ apiVersions: async () => [
      { label: "Spring '26", version: "61.0" }, { label: "Winter '27", version: "63.0" }, { label: "Summer '26", version: "62.0" }] });
    expect(rel).toEqual({ label: "Winter '27", version: "63.0" });
    expect(await readSalesforceRelease({ apiVersions: async () => { throw new Error("x"); } })).toBeUndefined();
    expect(await readSalesforceRelease({})).toBeUndefined();
  });
});

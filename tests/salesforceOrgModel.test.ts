import { describe, it, expect } from "vitest";
import { readSalesforceOrgModel, orgModelForCases, createFormUrls, flowEffects } from "../src/stages/salesforceOrgModel.js";
import { SalesforceOrgModel, toLiteModel, type AppModel } from "../src/schema/appModel.js";

/**
 * The org model (D-63): what a Salesforce org says about itself through its metadata APIs, read
 * with the org connection. The API is faked at `apiGet` — the shapes are the UI API / Tooling API
 * responses seen on a real org on 2026-10-24. Nothing here is a secret.
 */

function fakeApi(opts: { toolingRefused?: boolean } = {}) {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    "/ui-api/apps/selected?formFactor=Large": {
      label: "Sales",
      navItems: [{ objectApiName: "Lead" }, { objectApiName: null }, { objectApiName: "Opportunity" }, { objectApiName: "Lead" }],
    },
    "/ui-api/object-info/Lead": {
      label: "Lead", labelPlural: "Leads", defaultRecordTypeId: "012000000000000AAA", createable: true,
      fields: {
        LastName: { apiName: "LastName", label: "Last Name", dataType: "String", required: true, createable: true },
        FirstName: { apiName: "FirstName", label: "First Name", dataType: "String", createable: true },
        Company: { apiName: "Company", label: "Company", dataType: "String", required: true, createable: true },
        Status: { apiName: "Status", label: "Lead Status", dataType: "Picklist", required: true, createable: true },
        Email: { apiName: "Email", label: "Email", dataType: "Email", createable: true },
        Partner__c: { apiName: "Partner__c", label: "Partner", dataType: "Reference", createable: true, referenceToInfos: [{ apiName: "Account" }] },
        OwnerId: { apiName: "OwnerId", label: "Owner ID", dataType: "Reference", required: true, createable: true },
        IsConverted: { apiName: "IsConverted", label: "Converted", dataType: "Boolean", createable: false, updateable: false },
      },
    },
    "/ui-api/object-info/Lead/picklist-values/012000000000000AAA": {
      picklistFieldValues: { Status: { values: [{ label: "Open - Not Contacted" }, { label: "Working - Contacted" }] } },
    },
    "/ui-api/list-info/Lead": { lists: [{ label: "All Open Leads" }, { label: "My Leads" }] },
    // Session 102k: the create LAYOUT says a field is required where object-info does not (Lead's
    // Company in run 2026-10-25T05-01-36-627Z-b0d6a138: "Review the following fields: Company").
    "/ui-api/layout/Lead?layoutType=Full&mode=Create&recordTypeId=012000000000000AAA": { sections: [{ layoutRows: [
      { layoutItems: [{ required: true, layoutComponents: [{ componentType: "Field", apiName: "Email" }] }] },
      { layoutItems: [{ required: false, layoutComponents: [{ componentType: "Field", apiName: "Partner__c" }] }] },
      // A compound item (Lead's Name: Salutation, First Name, Last Name) is "required" as a whole:
      // only its parts object-info requires are (run 2026-10-25T06-38-05-099Z-07e036cc filled Salutation).
      { layoutItems: [{ required: true, layoutComponents: [
        { componentType: "Field", apiName: "Salutation" }, { componentType: "Field", apiName: "FirstName" },
        { componentType: "Field", apiName: "LastName" }] }] },
    ] }] },
    // Session 102j: the connected user's locale decides how a typed date is read (testData dates).
    "/chatter/users/me": { id: "005zqcanary" },
    [`/query?q=${encodeURIComponent("SELECT LocaleSidKey FROM User WHERE Id = '005zqcanary'")}`]: { records: [{ LocaleSidKey: "en_GB" }] },
  };
  const apiGet = async (path: string) => {
    calls.push(path);
    if (path.startsWith("/tooling/query")) {
      if (opts.toolingRefused) throw new Error("Salesforce API /tooling/query answered HTTP 403");
      return { records: [{ ValidationName: "Phone_Required", ErrorDisplayField: "Phone", ErrorMessage: "Phone is required for a hot lead", EntityDefinition: { QualifiedApiName: "Lead" } }] };
    }
    if (path in responses) return responses[path];
    throw new Error(`Salesforce API ${path} answered HTTP 404`); // Opportunity: an object that fails
  };
  return { apiGet, calls };
}

describe("readSalesforceOrgModel", () => {
  it("marks a field required when the org's create layout requires it, not only object-info", async () => {
    const { apiGet } = fakeApi();
    const lead = (await readSalesforceOrgModel({ apiGet }))!.objects.find((o) => o.api === "Lead")!;
    expect(lead.fields.find((f) => f.api === "Email")?.required).toBe(true);
    expect(lead.fields.find((f) => f.api === "Partner__c")?.required).toBeUndefined();
    expect(lead.fields.find((f) => f.api === "FirstName")?.required).toBeUndefined();
    expect(lead.fields.find((f) => f.api === "LastName")?.required).toBe(true);
  });

  it("reads the connected user's locale, and leaves it absent when the org does not answer", async () => {
    const { apiGet } = fakeApi();
    expect((await readSalesforceOrgModel({ apiGet }))?.userLocale).toBe("en_GB");
    const { apiGet: noChatter } = fakeApi();
    const quiet = async (path: string) => { if (path.startsWith("/chatter") || path.startsWith("/query")) throw new Error("HTTP 403"); return noChatter(path); };
    expect((await readSalesforceOrgModel({ apiGet: quiet }))?.userLocale).toBeUndefined();
  });

  it("reads the app's objects, their required fields, picklists, lookups, list views and validation rules", async () => {
    const { apiGet, calls } = fakeApi();
    const org = await readSalesforceOrgModel({ apiGet });
    expect(org).not.toBeNull();
    expect(SalesforceOrgModel.safeParse(org).success).toBe(true);
    expect(org!.app).toBe("Sales");
    // Opportunity's object-info failed: left out, the rest still read.
    expect(org!.objects.map((o) => o.api)).toEqual(["Lead"]);
    const lead = org!.objects[0];
    expect(lead.fields.filter((f) => f.required).map((f) => f.label)).toEqual(["Last Name", "Company", "Lead Status", "Email"]);
    expect(lead.fields.find((f) => f.api === "Status")?.picklist).toEqual(["Open - Not Contacted", "Working - Contacted"]);
    expect(lead.fields.find((f) => f.api === "Partner__c")?.lookup).toBe("Account");
    // System fields and fields nobody can set are not test material.
    expect(lead.fields.map((f) => f.api)).not.toContain("OwnerId");
    expect(lead.fields.map((f) => f.api)).not.toContain("IsConverted");
    expect(lead.listViews).toEqual(["All Open Leads", "My Leads"]);
    expect(lead.validationRules).toEqual([{ name: "Phone_Required", field: "Phone", message: "Phone is required for a hot lead" }]);
    expect(org!.validationRulesRead).toBe(true);
    // Read-only: every call is a GET path, and the Tooling query asks only for the app's objects.
    const tooling = decodeURIComponent(calls.find((c) => c.startsWith("/tooling/query"))!);
    expect(tooling).toContain("IN ('Lead')");
  });

  it("says so when validation rules could not be read, instead of implying there are none", async () => {
    const org = await readSalesforceOrgModel({ apiGet: fakeApi({ toolingRefused: true }).apiGet });
    expect(org!.validationRulesRead).toBe(false);
    expect(orgModelForCases(org!)).toContain("could not be read");
  });

  it("returns null when the connection cannot read even the app", async () => {
    expect(await readSalesforceOrgModel({ apiGet: async () => { throw new Error("HTTP 401"); } })).toBeNull();
    expect(await readSalesforceOrgModel({})).toBeNull();
  });
});

describe("readSalesforceOrgModel: the whole org, like a person exploring it", () => {
  // The manual discovery of 2026-10-24 found what the selected app's nav never shows: other apps,
  // custom objects outside any nav (16 on the real-estate org, none in the Sales app), and how many
  // records each object holds. The org says all of it through /ui-api/apps, /sobjects and SOQL.
  function wholeOrgApi() {
    const base = fakeApi();
    const extra: Record<string, unknown> = {
      "/ui-api/apps?formFactor=Large": { apps: [{ label: "Sales", navItems: [] }, { label: "Real Estate DXB", navItems: [] }] },
      "/sobjects": {
        sobjects: [
          { name: "Lead", custom: false, createable: true, queryable: true },
          { name: "Unit__c", custom: true, createable: true, queryable: true },
          // Each distractor fails exactly ONE filter, so every filter is tested on its own.
          { name: "Unit__Share", custom: true, createable: true, queryable: true },
          { name: "Account", custom: false, createable: true, queryable: true },
          { name: "Setting__mdt", custom: true, createable: false, queryable: true },
          { name: "Change__e", custom: true, createable: true, queryable: false },
          { name: "Locked__c", custom: true, createable: false, queryable: true },
          { name: "Hidden__c", custom: true, createable: true, queryable: false },
        ],
      },
      "/ui-api/object-info/Unit__c": {
        label: "Unit", labelPlural: "Units", defaultRecordTypeId: null,
        fields: { Name: { apiName: "Name", label: "Unit Name", dataType: "String", required: true, createable: true } },
      },
      [`/query?q=${encodeURIComponent("SELECT COUNT() FROM Lead")}`]: { totalSize: 13, records: [] },
      [`/query?q=${encodeURIComponent("SELECT COUNT() FROM Unit__c")}`]: { totalSize: 100, records: [] },
    };
    // Every object's describe answers here, so only the /sobjects filters can keep a distractor out
    // (a 404 would hide a broken filter — the D6-D8 mutations survived that way once).
    return async (path: string) => {
      if (path in extra) return extra[path];
      const describe = /^\/ui-api\/object-info\/([^/]+)$/.exec(path);
      if (describe && !["Lead"].includes(describe[1])) {
        return { label: describe[1], fields: { Name: { apiName: "Name", label: "Name", dataType: "String", createable: true } } };
      }
      return base.apiGet(path);
    };
  }

  it("adds every app, the custom objects outside the nav, and record counts", async () => {
    const org = await readSalesforceOrgModel({ apiGet: wholeOrgApi() });
    expect(SalesforceOrgModel.safeParse(org).success).toBe(true);
    expect(org!.apps).toEqual(["Sales", "Real Estate DXB"]);
    // Nav objects first (Lead, Opportunity), then custom objects nobody put in a nav; never a standard
    // object outside the nav, a share, a metadata type or a platform event.
    expect(org!.objects.map((o) => o.api)).toEqual(["Lead", "Opportunity", "Unit__c"]);
    expect(org!.objects.map((o) => o.records)).toEqual([13, undefined, 100]);
    const block = orgModelForCases(org!);
    expect(block).toContain("apps in this org: Sales, Real Estate DXB");
    expect(block).toContain("- Units (object Unit__c, 100 records)");
    expect(block).toContain("- Leads (object Lead, 13 records)");
  });

  it("an object whose count cannot be read simply has no count", async () => {
    const org = await readSalesforceOrgModel({ apiGet: fakeApi().apiGet });
    expect(org!.objects[0].records).toBeUndefined();
    expect(orgModelForCases(org!)).toContain("- Leads (object Lead)\n");
  });
});

describe("orgModelForCases and the lite model", () => {
  it("renders a compact block with the exact labels and values", async () => {
    const block = orgModelForCases((await readSalesforceOrgModel({ apiGet: fakeApi().apiGet }))!);
    expect(block).toContain('for the app "Sales"');
    expect(block).toContain("- Leads (object Lead)");
    expect(block).toContain("required on create: Last Name, Company, Lead Status");
    expect(block).toContain("Lead Status = Open - Not Contacted | Working - Contacted");
    expect(block).toContain("Partner -> Account");
    expect(block).toContain('validation rule Phone_Required (on Phone): "Phone is required for a hot lead"');
    expect(orgModelForCases(undefined)).toBe("");
  });

  it("tells the case writer the run is already signed in, so it writes no login steps", async () => {
    // Run 2026-10-24T07-08-34-372Z-e2fc249c: the case still said "Enter the username / password", which
    // the org connection makes impossible (withoutCredentialEntry then has to drop it).
    const block = orgModelForCases((await readSalesforceOrgModel({ apiGet: fakeApi().apiGet }))!);
    expect(block).toContain("already signed in to this org through its connection");
    expect(block).toContain("write no login, username or password steps");
  });

  it("keeps the org model out of the lite model JSON, and leaves a model without one untouched", () => {
    const base: AppModel = { baseUrl: "https://x", pages: [] } as any;
    expect(toLiteModel(base)).toEqual({ baseUrl: "https://x", pages: [] });
    const withOrg = { ...base, salesforceOrg: { objects: [], validationRulesRead: true } } as AppModel;
    expect("salesforceOrg" in toLiteModel(withOrg)).toBe(false);
  });
});

describe("create forms: the one screen a crawl never opens", () => {
  // Run 2026-10-24T11-34-49-878Z-a7697ccd: every case needed the New Lead form, discovery had never
  // opened it, so "Company" could not ground. Lightning opens an object's create form at
  // /lightning/o/<api>/new (proved on the DE org, 2026-10-24: dialog "New Lead", 28 fields, Save).
  it("remembers which objects can be created, and names each create form's URL", async () => {
    const org = (await readSalesforceOrgModel({ apiGet: fakeApi().apiGet }))!;
    expect(org.objects[0].createable).toBe(true);
    expect(createFormUrls("https://zq.lightning.force.com", org)).toEqual(["https://zq.lightning.force.com/lightning/o/Lead/new"]);
    const block = orgModelForCases(org);
    expect(block).toContain("create form: /lightning/o/Lead/new");
    expect(block).toMatch(/directly by URL/i);
  });

  it("an object the org says is not createable has no create form", () => {
    const org = { objects: [{ api: "Report", label: "Report", fields: [] }, { api: "Case", label: "Case", fields: [], createable: false }], validationRulesRead: true };
    expect(createFormUrls("https://zq.lightning.force.com", org)).toEqual([]);
    expect(orgModelForCases(org)).not.toContain("create form:");
  });
});

describe("validation rules carry their condition, so a negative case can actually trip them", () => {
  // Run 2026-10-24T12-33-54-871Z-d09ba86d: a phone-length case filled only Phone, but that org's rule also
  // read the country, so it could never fire. The Tooling API returns a rule's formula in Metadata, only
  // for a query matching one rule. Made-up canary rule below; no org's real rule.
  function rulesApi(metadataRefused = false) {
    const base = fakeApi();
    const FORMULA = 'Zq_Region__c = "Zqland" && LEN(Phone) <> 7';
    return async (path: string) => {
      if (path.startsWith("/tooling/query")) {
        const q = decodeURIComponent(path);
        if (q.includes("Metadata")) {
          if (metadataRefused) throw new Error("HTTP 400");
          expect(q).toContain("WHERE Id = '03dZQ0000000001AAA'");
          return { records: [{ Metadata: { errorConditionFormula: FORMULA } }] };
        }
        return { records: [{ Id: "03dZQ0000000001AAA", ValidationName: "Zq_Phone_7", ErrorDisplayField: "Phone",
          ErrorMessage: "Zqland phones have 7 digits.", EntityDefinition: { QualifiedApiName: "Lead" } }] };
      }
      return base.apiGet(path);
    };
  }

  it("reads each rule's error condition formula and puts it in the case writer's block", async () => {
    const org = (await readSalesforceOrgModel({ apiGet: rulesApi() }))!;
    expect(SalesforceOrgModel.safeParse(org).success).toBe(true);
    expect(org.objects[0].validationRules).toEqual([{ name: "Zq_Phone_7", field: "Phone",
      message: "Zqland phones have 7 digits.", condition: 'Zq_Region__c = "Zqland" && LEN(Phone) <> 7' }]);
    const block = orgModelForCases(org);
    expect(block).toContain('fires when: Zq_Region__c = "Zqland" && LEN(Phone) <> 7');
    expect(block).toMatch(/make its condition true/i);
  });

  it("a rule whose formula cannot be read keeps its message and simply has no condition", async () => {
    const org = (await readSalesforceOrgModel({ apiGet: rulesApi(true) }))!;
    expect(org.objects[0].validationRules?.[0]).toEqual({ name: "Zq_Phone_7", field: "Phone",
      message: "Zqland phones have 7 digits." });
    expect(orgModelForCases(org)).not.toMatch(/\n\s+fires when: /);
  });
});

describe("recordPageUrls (Session 102: an edit flow needs the record page in the model)", async () => {
  const { recordPageUrls } = await import("../src/stages/salesforceOrgModel.js");
  // Run 2026-10-25T06-38-05-163Z-3a6663ef "create an Account, then edit its Phone" clicked "Edit List"
  // after Save: no record page had been modelled, so the record's own "Edit" was unknown. Canaries.
  const org = { objects: [
    { api: "Zq_Firm__c", label: "Zq Firm", fields: [] },
    { api: "Zq_Deal__c", label: "Zq Deal", fields: [] },
  ] } as any;
  const apiGet = async (path: string) => {
    if (path.includes(encodeURIComponent("FROM Zq_Firm__c"))) return { records: [{ Id: "a01ZQ0000000001AAA" }] };
    if (path.includes(encodeURIComponent("FROM Zq_Deal__c"))) return { records: [] };
    throw new Error("unexpected " + path);
  };

  it("one record page per object the request names, from a real record id", async () => {
    expect(await recordPageUrls("https://zq.example", org, "Edit a Zq Firm's phone and a Zq Deal", apiGet))
      .toEqual(["https://zq.example/lightning/r/Zq_Firm__c/a01ZQ0000000001AAA/view"]);
  });

  it("nothing when the request names no object, or the API refuses", async () => {
    expect(await recordPageUrls("https://zq.example", org, "Check the home page", apiGet)).toEqual([]);
    expect(await recordPageUrls("https://zq.example", org, "Edit a Zq Firm", async () => { throw new Error("HTTP 403"); })).toEqual([]);
  });
});

// Phase A (2026-10-25, scratch org innovation-inspiration-2209): with two Account record types,
// /lightning/o/Account/new opened only the DEFAULT one's form ("New Account: TB Customer", no
// chooser); ?recordTypeId=<id> opened "New Account: TB Partner". A dependent picklist ("TB
// Territory" under "TB Region") offers a value only under its controlling value. Canaries below.
describe("record types and dependent picklists", () => {
  const RT_DEFAULT = "012zq0000000001AAA";
  const RT_OTHER = "012zq0000000002AAA";
  function rtApi() {
    const base = fakeApi();
    return async (path: string) => {
      if (path === "/ui-api/object-info/Lead") {
        const info = structuredClone(await base.apiGet(path)) as any;
        info.recordTypeInfos = {
          "012000000000000AAA": { available: true, master: true, name: "Master", recordTypeId: "012000000000000AAA" },
          [RT_DEFAULT]: { available: true, master: false, name: "Zq Retail", recordTypeId: RT_DEFAULT, defaultRecordTypeMapping: true },
          [RT_OTHER]: { available: true, master: false, name: "Zq Partner", recordTypeId: RT_OTHER, defaultRecordTypeMapping: false },
        };
        info.fields.Zq_Region__c = { apiName: "Zq_Region__c", label: "Zq Region", dataType: "Picklist", createable: true };
        info.fields.Zq_Score__c = { apiName: "Zq_Score__c", label: "Zq Score", dataType: "Currency", calculated: true, createable: false, updateable: false };
        info.fields.Zq_Territory__c = { apiName: "Zq_Territory__c", label: "Zq Territory", dataType: "Picklist", createable: true, controllerName: "Zq_Region__c" };
        // A computed standard field object-info does not flag (Expected Revenue), and a read-only lookup.
        info.fields.ZqExpected = { apiName: "ZqExpected", label: "Zq Expected", dataType: "Currency", createable: false, updateable: false };
        info.fields.ZqAuditUserId = { apiName: "ZqAuditUserId", label: "Zq Audit User", dataType: "Reference", createable: false, updateable: false };
        info.fields.ZqHiddenTotal = { apiName: "ZqHiddenTotal", label: "Zq Hidden Total", dataType: "Currency", createable: false, updateable: false };
        return info;
      }
      if (path.startsWith("/ui-api/layout/Lead?") && path.includes("mode=View")) {
        // The record page shows the computed field under its own label; Zq Hidden Total is on no layout.
        return { sections: [{ layoutRows: [{ layoutItems: [
          { label: "Zq Expected Revenue", layoutComponents: [{ componentType: "Field", apiName: "ZqExpected" }] },
        ] }] }] };
      }
      if (path === "/ui-api/object-info/Lead/picklist-values/012000000000000AAA") {
        const pv = structuredClone(await base.apiGet(path)) as any;
        pv.picklistFieldValues.Zq_Region__c = { values: [{ label: "Zq North", value: "N" }, { label: "Zq South", value: "S" }] };
        pv.picklistFieldValues.Zq_Territory__c = { controllerValues: { N: 0, S: 1 }, values: [
          { label: "Zq North East", value: "NE", validFor: [0] },
          { label: "Zq South West", value: "SW", validFor: [1] },
          { label: "Zq Anywhere", value: "AW", validFor: [0, 1] },
        ] };
        return pv;
      }
      return base.apiGet(path);
    };
  }

  it("reads two or more creatable record types (never Master), and each dependent value's controlling values", async () => {
    const lead = (await readSalesforceOrgModel({ apiGet: rtApi() }))!.objects.find((o) => o.api === "Lead")!;
    expect(lead.recordTypes).toEqual([{ name: "Zq Retail", id: RT_DEFAULT, default: true }, { name: "Zq Partner", id: RT_OTHER }]);
    const territory = lead.fields.find((f) => f.api === "Zq_Territory__c")!;
    expect(territory.controlledBy).toBe("Zq_Region__c");
    expect(territory.validFor).toEqual({ "Zq North East": ["Zq North"], "Zq South West": ["Zq South"], "Zq Anywhere": ["Zq North", "Zq South"] });
    // A formula field is not a form field, but the case writer is told it exists, read-only.
    expect(lead.fields.some((f) => f.api === "Zq_Score__c")).toBe(false);
    expect(lead.calculated).toEqual([
      { label: "Zq Score", api: "Zq_Score__c", type: "Currency" },
      { label: "Zq Expected Revenue", api: "ZqExpected", type: "Currency" },
    ]);
    expect(orgModelForCases((await readSalesforceOrgModel({ apiGet: rtApi() }))!)).toContain("calculated by the org (read-only, on the record page after a save; never filled): Zq Score (Currency)");
    // A field with no controller carries no dependency.
    expect(lead.fields.find((f) => f.api === "Zq_Region__c")!.controlledBy).toBeUndefined();
  });

  it("opens a named record type's own form first, and tells the case writer both", async () => {
    const org = (await readSalesforceOrgModel({ apiGet: rtApi() }))!;
    const urls = createFormUrls("https://zq.lightning.force.com", org, "Create a Zq Partner lead");
    expect(urls[0]).toBe(`https://zq.lightning.force.com/lightning/o/Lead/new?recordTypeId=${RT_OTHER}`);
    expect(urls).toContain("https://zq.lightning.force.com/lightning/o/Lead/new");
    // The default record type's form is the plain one; it is never added twice.
    expect(createFormUrls("https://zq.lightning.force.com", org, "Create a Zq Retail lead")).toEqual(["https://zq.lightning.force.com/lightning/o/Lead/new"]);
    const block = orgModelForCases(org);
    expect(block).toContain(`record types (each has its own create form): Zq Retail (default: /lightning/o/Lead/new), Zq Partner (/lightning/o/Lead/new?recordTypeId=${RT_OTHER})`);
    expect(block).toContain("Zq Territory = Zq North East | Zq South West | Zq Anywhere (depends on Zq Region: Zq North East only when Zq North;");
  });

  it("one record type alone is not listed: it changes nothing a test does", async () => {
    const one = async (path: string) => {
      const r = await rtApi()(path) as any;
      if (path === "/ui-api/object-info/Lead") delete r.recordTypeInfos[RT_OTHER];
      return r;
    };
    expect((await readSalesforceOrgModel({ apiGet: one }))!.objects.find((o) => o.api === "Lead")!.recordTypes).toBeUndefined();
  });
});

// Phase B: active flows, so a case can save a record that meets a record-triggered flow's conditions
// and assert what it does. Shapes as the UI/Tooling API return them; canary names.
describe("active flows: what runs by itself after a save", () => {
  const VERSION = "301zq0000000001AAA";
  function flowApi(flowsRefused = false) {
    const base = fakeApi();
    return async (path: string) => {
      const q = decodeURIComponent(path);
      if (q.includes("FROM FlowDefinitionView")) {
        if (flowsRefused) throw new Error("HTTP 403");
        return { records: [
          { ApiName: "Zq_Screen", Label: "Zq Screen", ProcessType: "Flow", TriggerType: null, ActiveVersionId: null },
          { ApiName: "Zq_Hot_Lead", Label: "Zq Hot Lead", ProcessType: "AutoLaunchedFlow", TriggerType: "RecordAfterSave",
            RecordTriggerType: "Create", TriggerObjectOrEventLabel: "Lead", ActiveVersionId: VERSION },
        ] };
      }
      if (q.includes(`FROM Flow WHERE Id = '${VERSION}'`)) {
        return { records: [{ Metadata: {
          start: { object: "Lead", filters: [{ field: "Rating", operator: "EqualTo", value: { stringValue: "Hot" } }] },
          recordUpdates: [{ inputReference: "$Record", inputAssignments: [{ field: "Zq_Tier__c", value: { stringValue: "Gold" } }] }],
          recordCreates: [{ object: "Task" }],
        } }] };
      }
      return base.apiGet(path);
    };
  }

  it("reads active flows, record-triggered first, with when they run and what they do", async () => {
    const org = (await readSalesforceOrgModel({ apiGet: flowApi() }))!;
    expect(org.flows?.[0]).toEqual({ label: "Zq Hot Lead", api: "Zq_Hot_Lead", type: "record-triggered", object: "Lead", when: "create",
      effects: ["only when Rating = Hot", "sets Zq_Tier__c = Gold", "creates a Task"] });
    expect(org.flows?.[1]).toMatchObject({ api: "Zq_Screen", type: "screen" });
    expect(orgModelForCases(org)).toContain(`- flow "Zq Hot Lead" (record-triggered on Lead, on create): only when Rating = Hot; sets Zq_Tier__c = Gold; creates a Task`);
  });

  it("an org that refuses the query simply has no flows listed", async () => {
    expect((await readSalesforceOrgModel({ apiGet: flowApi(true) }))!.flows).toBeUndefined();
  });

  it("before-save assignments and branches are described too", () => {
    expect(flowEffects({ assignments: [{ assignmentItems: [{ assignToReference: "$Record.Rating", value: { stringValue: "Warm" } }] }],
      decisions: [{}, {}] })).toEqual(["sets Rating = Warm", "branches on 2 decision(s): what it does depends on the record's values"]);
  });
});

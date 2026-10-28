import { describe, it, expect } from "vitest";
import { dropOffObjectCases } from "../src/stages/testCases.js";

/**
 * Session 102: on a second org, run 2026-10-24T20-37-00-424Z-410671c2 ("Check the Lead validation
 * rules when creating a new Lead") wrote a global-search case on the home page, though the case
 * writer's Salesforce guidance says to stay on the requested object. It failed and tested nothing
 * the person asked for. A prompt rule is a preference; this is the check behind it. Canary names.
 */
const org = { objects: [
  { api: "Zq_Lead__c", label: "Zq Lead", labelPlural: "Zq Leads", fields: [] },
  { api: "Zq_Deal__c", label: "Zq Deal", labelPlural: "Zq Deals", fields: [] },
] } as any;
const c = (title: string, targetUrl: string, fromPrompt = false) =>
  ({ title, targetUrl, fromPrompt, steps: ["s"], expected: "e", priority: "high", feature: "f", category: "valid" }) as any;

describe("dropOffObjectCases", () => {
  const cases = [
    c("create", "https://zq.example/lightning/o/Zq_Lead__c/new?count=1", true),
    c("blank", "https://zq.example/lightning/o/Zq_Lead__c/new"),
    c("search", "https://zq.example/lightning/page/home"),
    c("deal", "https://zq.example/lightning/o/Zq_Deal__c/list"),
  ];

  it("keeps only cases on the object the request names", () => {
    const kept = dropOffObjectCases(cases, "Check the Zq Lead validation rules when creating a new Zq Lead", org);
    expect(kept.map((k) => k.title)).toEqual(["create", "blank"]);
  });

  it("changes nothing when the request names no object, or there is no org model", () => {
    expect(dropOffObjectCases(cases, "Test the org", org)).toBe(cases);
    expect(dropOffObjectCases(cases, "Check the Zq Lead form", undefined)).toBe(cases);
  });

  // Code review: "test cases for the Home page" must not read as the Case object. Salesforce labels
  // are capitalised; ordinary words in a request usually are not.
  it("matches object labels case-sensitively, so ordinary words are not objects", () => {
    const withCase = { objects: [...org.objects, { api: "Case", label: "Case", labelPlural: "Cases", fields: [] }] } as any;
    expect(dropOffObjectCases(cases, "Write test cases for the zq lead page", withCase)).toBe(cases);
  });

  it("never drops the primary case, and never leaves nothing", () => {
    const onlyOff = [c("search", "https://zq.example/lightning/page/home", true)];
    expect(dropOffObjectCases(onlyOff, "Check Zq Leads", org)).toBe(onlyOff);
  });
});

describe("objectsNamedIn: the longest name wins (run 2026-10-25T06-38-05-178Z-ebdc2303)", async () => {
  const { objectsNamedIn, createFormUrls } = await import("../src/stages/salesforceOrgModel.js");
  // "Create a new Broker Lead" was run as a plain Lead: both labels matched, and the custom object's
  // create form was 9th in line behind an 8-form cap. Canary names.
  const org = { objects: [
    ...Array.from({ length: 9 }, (_, i) => ({ api: `Zq_${i}__c`, label: `Zq Filler ${i}`, createable: true, fields: [] })),
    { api: "Lead", label: "Lead", labelPlural: "Leads", createable: true, fields: [] },
    { api: "Zq_Broker_Lead__c", label: "Zq Broker Lead", labelPlural: "Zq Broker Leads", createable: true, fields: [] },
  ] } as any;

  it("'Zq Broker Lead' names the custom object only, not also Lead", () => {
    expect(objectsNamedIn("Create a new Zq Broker Lead and verify it is created", org).map((o: any) => o.api)).toEqual(["Zq_Broker_Lead__c"]);
    expect(objectsNamedIn("Create a Lead and a Zq Broker Lead", org).map((o: any) => o.api).sort()).toEqual(["Lead", "Zq_Broker_Lead__c"]);
  });

  it("the requested object's create form is queued first, whatever the cap", () => {
    const urls = createFormUrls("https://zq.example", org, "Create a new Zq Broker Lead");
    expect(urls[0]).toBe("https://zq.example/lightning/o/Zq_Broker_Lead__c/new");
    expect(urls.length).toBeLessThanOrEqual(8);
  });

  it("dropOffObjectCases keeps the custom object's cases and drops plain Lead ones", () => {
    const cs = [c("broker", "https://zq.example/lightning/o/Zq_Broker_Lead__c/new", true), c("lead", "https://zq.example/lightning/o/Lead/new")];
    expect(dropOffObjectCases(cs, "Create a new Zq Broker Lead", org).map((k) => k.title)).toEqual(["broker"]);
  });
});

describe("dropUnrequestedChecklistCases (Salesforce): checklist features the request never asked for", async () => {
  const { dropUnrequestedChecklistCases } = await import("../src/stages/testCases.js");
  // Runs 2026-10-25T10-28-59-626Z (Contact) and -656Z (Lead) were create requests, yet each carried
  // search-checklist cases ("Valid query", "Empty query"...) that failed or truncated.
  const k = (title: string, checklistTitle?: string, fromPrompt = false) =>
    ({ title, checklistTitle, fromPrompt, steps: ["s"], expected: "e", priority: "high", feature: "f", category: "valid" }) as any;
  const cases = [
    k("create", undefined, true), k("blank", "Submit with all required fields empty"),
    k("search ok", "Valid query"), k("search empty", "Empty query"),
  ];

  it("drops search cases from a create request, keeps the generic floor and the primary", () => {
    expect(dropUnrequestedChecklistCases(cases, "Create a new Lead and verify it is created").map((c: any) => c.title))
      .toEqual(["create", "blank"]);
  });

  it("keeps them when the request asks for search", () => {
    expect(dropUnrequestedChecklistCases(cases, "Search Leads and find one by name")).toBe(cases);
  });

  it("never drops the primary, never leaves nothing", () => {
    const only = [k("search primary", "Valid query", true)];
    expect(dropUnrequestedChecklistCases(only, "Create a Lead")).toBe(only);
  });
});

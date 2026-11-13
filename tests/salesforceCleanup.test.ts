import { describe, it, expect, vi } from "vitest";
import { recordsFromResults, cleanupRecords, runStartedAt, cleanupEnabled } from "../src/stages/salesforceCleanup.js";
import { generateSpec } from "../src/stages/generator.js";
import type { IR } from "../src/schema/ir.js";

/**
 * Phase D: a run deletes what it created in the org, and nothing else. The org itself confirms each
 * record (created by the connected user since the run began) before it is deleted. Canary ids/names.
 */

const ME = "005zq0000000001AAA";
const OURS = "001zq0000000001AAA";
const OLD = "001zq0000000002AAA";
const results = (list: string[]) => ({ suites: [{ specs: [{ title: "t", tests: [{ annotations: [
  { type: "run-tokens", description: "{}" }, { type: "sf-records", description: JSON.stringify(list) },
] }] }] }] });

function fakeOrg(opts: { me?: string | null; confirmed?: string[]; queryFails?: boolean; gone?: string[] } = {}) {
  const deleted: string[] = [];
  const queries: string[] = [];
  const apiGet = vi.fn(async (path: string) => {
    if (path === "/chatter/users/me") { if (opts.me === null) throw new Error("HTTP 403"); return { id: opts.me ?? ME }; }
    if (path.startsWith("/query")) {
      if (opts.queryFails) throw new Error("Salesforce API /query answered HTTP 400");
      queries.push(decodeURIComponent(path));
      return { records: (opts.confirmed ?? []).map((Id) => ({ Id })) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const apiDelete = vi.fn(async (path: string) => {
    if (opts.gone?.some((g) => path.endsWith(g))) throw new Error(`Salesforce API DELETE ${path} answered HTTP 404`);
    deleted.push(path);
  });
  return { session: { apiGet, apiDelete }, deleted, queries };
}

describe("recordsFromResults", () => {
  it("reads the record pages a spec reached, and ignores anything else", () => {
    expect(recordsFromResults(results([`Account/${OURS}`, "Lead/00Qzq000000001A", "not a record", "Account/short"])))
      .toEqual([{ object: "Account", id: OURS }, { object: "Lead", id: "00Qzq000000001A" }]);
    expect(recordsFromResults({})).toEqual([]);
  });
});

describe("cleanupRecords", () => {
  const since = new Date("2026-10-26T06:15:41.827Z");

  it("deletes only what the org confirms this user created since the run began", async () => {
    const org = fakeOrg({ confirmed: [OURS] });
    const report = await cleanupRecords(org.session, [{ object: "Account", id: OURS }, { object: "Account", id: OLD }], since);
    expect(org.deleted).toEqual([`/sobjects/Account/${OURS}`]);
    expect(report.deleted).toEqual([{ object: "Account", id: OURS }]);
    expect(report.skipped).toEqual([{ object: "Account", id: OLD }]);
    expect(org.queries[0]).toContain(`CreatedById = '${ME}'`);
    expect(org.queries[0]).toContain("CreatedDate >= 2026-10-26T06:15:41Z");
  });

  it("deletes nothing when the org does not say who is connected, or cannot confirm", async () => {
    const noUser = fakeOrg({ me: null, confirmed: [OURS] });
    const r1 = await cleanupRecords(noUser.session, [{ object: "Account", id: OURS }], since);
    expect(noUser.deleted).toEqual([]);
    expect(r1.reason).toMatch(/nothing was deleted/);
    const noQuery = fakeOrg({ queryFails: true });
    const r2 = await cleanupRecords(noQuery.session, [{ object: "Account", id: OURS }], since);
    expect(noQuery.deleted).toEqual([]);
    expect(r2.failed).toHaveLength(1);
  });

  it("a record already gone (the test deleted it) counts as cleaned, not failed", async () => {
    const org = fakeOrg({ confirmed: [OURS], gone: [OURS] });
    const report = await cleanupRecords(org.session, [{ object: "Account", id: OURS }], since);
    expect(report.deleted).toHaveLength(1);
    expect(report.failed).toHaveLength(0);
  });

  it("an 18-character id matches the 15-character id SOQL may return", async () => {
    const org = fakeOrg({ confirmed: [OURS.slice(0, 15)] });
    await cleanupRecords(org.session, [{ object: "Account", id: OURS }], since);
    expect(org.deleted).toHaveLength(1);
  });
});

describe("cleanup order", () => {
  it("deletes children before parents: objects in the reverse of the order the run reached them", async () => {
    const OPP = "006zq0000000001AAA";
    const { session, deleted } = fakeOrg({ confirmed: [OURS, OPP] });
    await cleanupRecords(session, [{ object: "Account", id: OURS }, { object: "Opportunity", id: OPP }], new Date());
    expect(deleted).toEqual([`/sobjects/Opportunity/${OPP}`, `/sobjects/Account/${OURS}`]);
  });
});

describe("children no page showed", () => {
  it("are found under the run's own Account (same user, since the run began) and deleted before it", async () => {
    const OPP = "006zq0000000009AAA";
    const deleted: string[] = [];
    const queries: string[] = [];
    const apiGet = vi.fn(async (p: string) => {
      if (p === "/chatter/users/me") return { id: ME };
      const q = decodeURIComponent(p);
      queries.push(q);
      if (q.includes("FROM Opportunity WHERE AccountId IN")) return { records: [{ Id: OPP }] };
      if (q.includes("WHERE AccountId IN") || q.includes("WHERE ContactId IN")) return { records: [] };
      return { records: [{ Id: OURS }, { Id: OPP }] };
    });
    const apiDelete = vi.fn(async (p: string) => { deleted.push(p); });
    await cleanupRecords({ apiGet, apiDelete }, [{ object: "Account", id: OURS }], new Date());
    expect(deleted).toEqual([`/sobjects/Opportunity/${OPP}`, `/sobjects/Account/${OURS}`]);
    expect(queries.find((q) => q.includes("FROM Opportunity WHERE AccountId"))).toContain(`CreatedById = '${ME}'`);
  });
});

describe("record pages with no object in the URL", () => {
  it("are named by the create form before them", async () => {
    const { recordPages } = await import("../src/stages/salesforceFrontdoor.js");
    const t = recordPages();
    t.visit("https://x.example/lightning/o/Account/new");
    t.visit("https://x.example/lightning/r/Account/001zq0000000001AAA/view");
    t.visit("https://x.example/lightning/o/Opportunity/new");
    t.visit("https://x.example/lightning/r/006zq0000000001AAA/view");
    expect(t.made()).toEqual({ Account: ["001zq0000000001AAA"], Opportunity: ["006zq0000000001AAA"] });
  });
});

describe("the run's start and the flag", () => {
  it("reads the start from the run id", () => {
    expect(runStartedAt("2026-10-26T06-15-41-827Z-23c2fab6")?.toISOString()).toBe("2026-10-26T06:15:41.827Z");
    expect(runStartedAt("p")).toBeNull();
  });
  it("is off unless asked for", () => {
    const prev = process.env.SALESFORCE_CLEANUP_ENABLED;
    delete process.env.SALESFORCE_CLEANUP_ENABLED;
    try { expect(cleanupEnabled()).toBe(false); } finally { if (prev !== undefined) process.env.SALESFORCE_CLEANUP_ENABLED = prev; }
  });
});

describe("the generated spec notes the record pages it reaches (org-connection specs only)", () => {
  const meta = { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" };
  const fd = generateSpec({ meta, steps: [
    { id: "auth-0", action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } },
    { id: "s1", action: "click", target: { role: "button", name: "Save", css: "#save" } },
  ] } as unknown as IR);
  const plain = generateSpec({ meta, steps: [{ id: "s1", action: "click", target: { role: "button", name: "Save", css: "#save" } }] } as unknown as IR);

  it("adds the capture to an org-connection spec and nowhere else", () => {
    expect(fd).toContain('annotations.push({ type: "sf-records"');
    expect(plain).not.toContain("sf-records");
  });

  it("its pattern takes the object and id from a record page URL, and nothing else", () => {
    const src = /const m = (\/.+\/)\.exec\(frame\.url\(\)\);/.exec(fd)?.[1];
    expect(src).toBeTruthy();
    const re = new Function(`return ${src};`)() as RegExp;
    const hit = re.exec(`https://zq.lightning.force.com/lightning/r/Account/${OURS}/view`);
    expect(hit?.slice(1, 3)).toEqual(["Account", OURS]);
    expect(re.exec("https://zq.lightning.force.com/lightning/o/Account/list")).toBeNull();
  });
});

describe("custom children and seeded records", () => {
  it("finds a custom child from the parent's describe and deletes it first", async () => {
    const KID = "a01zq0000000001AAA";
    const deleted: string[] = [];
    const apiGet = vi.fn(async (p: string) => {
      if (p === "/chatter/users/me") return { id: ME };
      if (p === "/sobjects/Account/describe") return { childRelationships: [
        { childSObject: "Zq_Thing__c", field: "Account__c", cascadeDelete: false },
        { childSObject: "Zq_Gone__c", field: "Account__c", cascadeDelete: true },
      ] };
      const q = decodeURIComponent(p);
      if (q.includes("FROM Zq_Thing__c WHERE Account__c IN")) return { records: [{ Id: KID }] };
      if (q.includes(" IN (") && !q.includes("WHERE Id IN")) return { records: [] };
      return { records: [{ Id: OURS }, { Id: KID }] };
    });
    await cleanupRecords({ apiGet, apiDelete: vi.fn(async (p: string) => { deleted.push(p); }) }, [{ object: "Account", id: OURS }], new Date());
    expect(deleted).toEqual([`/sobjects/Zq_Thing__c/${KID}`, `/sobjects/Account/${OURS}`]);
    expect(apiGet.mock.calls.some(([p]) => decodeURIComponent(String(p)).includes("Zq_Gone__c"))).toBe(false);
  });

  it("deletes what a published event's flow made, by its run-unique TB Event name only", async () => {
    const { cleanupSeeded } = await import("../src/stages/salesforceCleanup.js");
    const deleted: string[] = [];
    const apiGet = vi.fn(async () => ({ records: [{ Id: OURS }] }));
    const r = await cleanupSeeded({ apiGet, apiDelete: vi.fn(async (p: string) => { deleted.push(p); }) },
      [{ object: "Account", name: "TB Event ab12cd" }, { object: "Account", name: "Acme Corp" }], new Date());
    expect(deleted).toEqual([`/sobjects/Account/${OURS}`]);
    expect(r.deleted).toHaveLength(1);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe("what a screen flow made", () => {
  it("is named by the values the case typed with the run's code, in the object the flow creates", async () => {
    const { screenFlowMade } = await import("../src/stages/salesforceCleanup.js");
    const flows = [{ api: "Zq_Screen", type: "screen", effects: ["creates a Contact"] }, { api: "Zq_Other", type: "record-triggered", effects: ["creates a Task"] }];
    const steps = [{ action: "navigate", target: { url: "https://x.example/flow/Zq_Screen" } },
      { action: "fill", target: { name: "First" }, value: "Zq First" },
      { action: "fill", target: { name: "Last" }, value: "ZqLast {{uid}}" }];
    expect(screenFlowMade(steps, flows, { uid: "ab12cd" })).toEqual([{ object: "Contact", name: "ZqLast ab12cd" }]);
    expect(screenFlowMade([{ action: "fill", value: "ZqLast {{uid}}" }], flows, { uid: "x" })).toEqual([]);
  });

  it("deletes only this user's records made since the run began, by that name", async () => {
    const { cleanupByTypedName } = await import("../src/stages/salesforceCleanup.js");
    const queries: string[] = [];
    const deleted: string[] = [];
    const apiGet = vi.fn(async (p: string) => {
      if (p === "/chatter/users/me") return { id: ME };
      queries.push(decodeURIComponent(p));
      return { records: [{ Id: "003zq0000000001AAA" }] };
    });
    const r = await cleanupByTypedName({ apiGet, apiDelete: vi.fn(async (p: string) => { deleted.push(p); }) }, [{ object: "Contact", name: "ZqLast ab12cd" }], new Date());
    expect(r.deleted).toHaveLength(1);
    expect(queries[0]).toContain("Name LIKE '%ZqLast ab12cd%'");
    expect(queries[0]).toContain(`CreatedById = '${ME}'`);
  });
});

describe("a converted Lead", () => {
  it("also deletes the Opportunity, Contact and Account it became, before the Lead", async () => {
    const LEAD = "00Qzq0000000001AAA", ACC = "001zq0000000009AAA", CON = "003zq0000000009AAA", OPP = "006zq0000000009AAA";
    const deleted: string[] = [];
    const apiGet = vi.fn(async (p: string) => {
      if (p === "/chatter/users/me") return { id: ME };
      const q = decodeURIComponent(p);
      if (q.includes("ConvertedAccountId")) return { records: [{ ConvertedAccountId: ACC, ConvertedContactId: CON, ConvertedOpportunityId: OPP }] };
      if (q.includes("WHERE Id IN")) return { records: [{ Id: LEAD }, { Id: ACC }, { Id: CON }, { Id: OPP }] };
      return { records: [] };
    });
    await cleanupRecords({ apiGet, apiDelete: vi.fn(async (p: string) => { deleted.push(p); }) }, [{ object: "Lead", id: LEAD }], new Date());
    expect(deleted).toEqual([`/sobjects/Opportunity/${OPP}`, `/sobjects/Contact/${CON}`, `/sobjects/Account/${ACC}`, `/sobjects/Lead/${LEAD}`]);
  });
});

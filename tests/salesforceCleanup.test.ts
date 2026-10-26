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

import { describe, it, expect } from "vitest";
import { orgSetupFingerprint } from "../src/stages/salesforceOrgModel.js";
import { orgCacheKey, orgDiscoveryCacheEnabled } from "../src/stages/hybridDiscovery.js";
import type { SalesforceOrgModel } from "../src/schema/appModel.js";
import { noteOrgDiscoverySaved, savedOrgDiscoveries } from "../src/kb/cache.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * An org-connection discovery is reused only while the org's setup is unchanged. Record counts move
 * with every run and must not count as a change; a rule, a field or a page layout edit must.
 * Canary org and names.
 */

const org = (over: Partial<SalesforceOrgModel["objects"][number]> = {}): SalesforceOrgModel => ({
  app: "Zq Sales",
  objects: [
    { api: "Account", label: "Account", labelPlural: "Accounts", createable: true, records: 4, fields: [], ...over },
    { api: "Lead", label: "Lead", labelPlural: "Leads", createable: true, records: 9, fields: [] },
  ],
  validationRulesRead: true,
});

const tooling = (stamps: Record<string, string | null>) => async (path: string) => {
  const q = decodeURIComponent(path);
  const type = /FROM (\w+)/.exec(q)?.[1] ?? "";
  if (!(type in stamps)) throw new Error(`unexpected ${q}`);
  const s = stamps[type];
  if (s === null) throw new Error("HTTP 403");
  return { records: [{ LastModifiedDate: s }] };
};
const SAME = {
  FlexiPage: "2026-10-25T10:00:00.000+0000", Layout: "2026-10-20T10:00:00.000+0000",
  LightningComponentBundle: "2026-10-01T10:00:00.000+0000", AuraDefinitionBundle: "2026-09-01T10:00:00.000+0000",
};

describe("orgSetupFingerprint", () => {
  it("does not change when only record counts move", async () => {
    const a = await orgSetupFingerprint(org(), tooling(SAME));
    const b = await orgSetupFingerprint(org({ records: 40 }), tooling(SAME));
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it("changes with a validation rule, a field, or a Lightning page / layout edit", async () => {
    const base = await orgSetupFingerprint(org(), tooling(SAME));
    const rule = await orgSetupFingerprint(org({ validationRules: [{ name: "Zq_Rule", message: "Zq needed" }] }), tooling(SAME));
    const field = await orgSetupFingerprint(org({ fields: [{ api: "Zq__c", label: "Zq", type: "string", required: false }] as any }), tooling(SAME));
    const page = await orgSetupFingerprint(org(), tooling({ ...SAME, FlexiPage: "2026-10-26T09:00:00.000+0000" }));
    const layout = await orgSetupFingerprint(org(), tooling({ ...SAME, Layout: "2026-10-26T09:00:00.000+0000" }));
    const lwc = await orgSetupFingerprint(org(), tooling({ ...SAME, LightningComponentBundle: "2026-10-26T09:00:00.000+0000" }));
    const aura = await orgSetupFingerprint(org(), tooling({ ...SAME, AuraDefinitionBundle: "2026-10-26T09:00:00.000+0000" }));
    expect(new Set([base, rule, field, page, layout, lwc, aura]).size).toBe(7);
  });

  it("is null when the Tooling API refuses, so nothing is reused on an unproven 'unchanged'", async () => {
    expect(await orgSetupFingerprint(org(), tooling({ ...SAME, Layout: null }))).toBeNull();
  });
});

describe("orgCacheKey", () => {
  const host = "zq-dev-ed.my.salesforce.com";
  const url = "https://zq-dev-ed.my.salesforce.com";
  it("is the same for the same org, setup and named objects; differs when the request names another object", () => {
    const k1 = orgCacheKey(host, url, "fp1", org(), "Create an Account with a name");
    const k2 = orgCacheKey(host, url, "fp1", org(), "Edit an Account phone");
    const k3 = orgCacheKey(host, url, "fp1", org(), "Create a Lead");
    const k4 = orgCacheKey(host, url, "fp2", org(), "Create an Account with a name");
    const k5 = orgCacheKey("zq-other.my.salesforce.com", url, "fp1", org(), "Create an Account with a name");
    expect(k2).toBe(k1);
    expect(new Set([k1, k3, k4, k5]).size).toBe(4);
  });

  it("is off unless asked for", () => {
    const prev = process.env.SALESFORCE_DISCOVERY_CACHE_ENABLED;
    delete process.env.SALESFORCE_DISCOVERY_CACHE_ENABLED;
    try { expect(orgDiscoveryCacheEnabled()).toBe(false); } finally { if (prev !== undefined) process.env.SALESFORCE_DISCOVERY_CACHE_ENABLED = prev; }
  });
});

describe("the saved-discovery list the run screen shows", () => {
  const host = "zq-canary-index.my.salesforce.com";
  const file = path.join("runs", "_cache", "appmodels", "sf-org-saved.json");
  const dropCanary = () => {
    if (!existsSync(file)) return;
    const index = JSON.parse(readFileSync(file, "utf8"));
    delete index[host];
    writeFileSync(file, JSON.stringify(index, null, 2));
  };

  it("lists each saved request shape once, newest first, and only within the ceiling", () => {
    try {
      noteOrgDiscoverySaved(host, ["Account"]);
      noteOrgDiscoverySaved(host, ["Opportunity", "Account"]);
      noteOrgDiscoverySaved(host, ["Account"]);
      const saved = savedOrgDiscoveries(host, 60_000);
      expect(saved.map((s) => s.objects.join(","))).toEqual(["Account", "Opportunity,Account"]);
      expect(savedOrgDiscoveries(host, -1)).toEqual([]);
      expect(savedOrgDiscoveries("zq-never-saved.my.salesforce.com", 60_000)).toEqual([]);
    } finally { dropCanary(); }
  });
});

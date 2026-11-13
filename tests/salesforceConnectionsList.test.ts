import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The run screen's connections list: who each saved connection signs in as, forget, always a login page.
// Canary values only (fixtures rule).
const dir = mkdtempSync(path.join(tmpdir(), "zq-conns-"));
process.env.SALESFORCE_CONNECTION_LABELS_FILE = path.join(dir, "labels.json");
const oauth = await import("../src/server/salesforceOAuth.js");

const CFG = { clientId: "zqcanary-client-id", clientSecret: "zqcanary-client-secret", callbackUrl: "http://localhost:3001/api/salesforce/callback" };
const ORG_URL = "https://zqcanary-dev-ed.scratch.my.salesforce.com";
const noStore = { client: null, file: null } as const;

async function connect(orgId: string | null, username: string) {
  const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId, userId: "zq-user" }, CFG);
  if ("error" in started) throw new Error(started.error);
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const fetchImpl = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => url.endsWith("/userinfo")
      ? { preferred_username: username, name: `Zq ${username}` }
      : { access_token: "zqcanaryaccesstoken", refresh_token: "zqcanaryrefresh", instance_url: ORG_URL },
  }));
  return { done: await oauth.completeAuthorization("zqcanary-code", state, CFG, fetchImpl as any, noStore), started };
}

describe("the connections list", () => {
  beforeEach(() => oauth.resetSalesforceOAuthForTests());

  it("always asks Salesforce for a login page", () => {
    const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
    expect("authorizeUrl" in started && new URL(started.authorizeUrl).searchParams.get("prompt")).toBe("login");
  });

  it("names who signed in, lists only the caller's organisation, and forgets one", async () => {
    const a = await connect("org-a", "zq.main@example.com");
    const b = await connect("org-a", "zq.manager@example.com");
    await connect("org-b", "zq.other@example.com");
    expect(a.done.username).toBe("zq.main@example.com");
    const listed = await oauth.listConnections("org-a", noStore);
    expect(listed.map((c) => c.username).sort()).toEqual(["zq.main@example.com", "zq.manager@example.com"]);
    expect(JSON.stringify(listed)).not.toContain("zqcanaryaccesstoken");
    expect(await oauth.forgetConnection(b.done.connectionId, "org-b", noStore)).toBe(false);
    expect(await oauth.forgetConnection(b.done.connectionId, "org-a", { ...noStore, fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any })).toBe(true);
    expect((await oauth.listConnections("org-a", noStore)).map((c) => c.username)).toEqual(["zq.main@example.com"]);
  });
});

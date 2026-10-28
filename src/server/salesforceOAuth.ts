import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isFrontdoorRef, type FrontdoorSession } from "../stages/salesforceFrontdoor.js";
import { rememberRunSecretStrings } from "../runSecrets.js";
import { currentRunId } from "../runContext.js";
import { getServiceClient } from "../db.js";
import { custodyFromEnv, decryptSecret, encryptSecret, type KeyCustody } from "./secretStore.js";

/**
 * Salesforce org connections over OAuth 2.0 (D-63). SALESFORCE_OAUTH_ENABLED, default off.
 *
 * The person signs in on Salesforce's own page (so MFA, SSO and passkeys are Salesforce's job, not
 * ours), Salesforce redirects to /api/salesforce/callback with a one-time code, and this module
 * trades it for an access token + refresh token. Runs then sign their browsers in through
 * `frontdoor.jsp` (salesforceFrontdoor.ts) instead of typing a password.
 *
 * Stage 1 scope, as agreed on 2026-10-24:
 *  - Web-server flow with PKCE (S256) AND the client secret. The flow is the same for a Connected
 *    App and an External Client App; what differs is REACH (Session 102): a Connected App is
 *    available to users of any org once created, a Local External Client App only to its own org
 *    (a Packaged one needs a managed package). So for "connect any org", register a Connected App.
 *  - Scratch orgs, sandboxes and Developer Edition orgs by default, decided from the host
 *    (`.scratch.` / `.sandbox.` / `.develop.`) — on the host the person typed AND on the
 *    `instance_url` Salesforce returns, because frontdoor uses the latter. Production orgs too
 *    with SALESFORCE_PRODUCTION_ORGS_ENABLED.
 *  - Tokens live in process memory, and — with LLM_KEY_FILE set — the refresh token is also stored
 *    encrypted (salesforce_connections) so a restart keeps the connection (restoreConnection).
 *  - A connection belongs to the Testbench organisation (and user) that started it, and a run may
 *    only use a connection of its own organisation. With AUTH_ENABLED off that is the synthetic
 *    local owner on both sides, so the check still runs (CLAUDE.md rule 7).
 *
 * Nothing here logs a token, a code, a verifier or a frontdoor URL.
 */

export function salesforceOAuthEnabled(): boolean {
  return process.env.SALESFORCE_OAUTH_ENABLED === "true";
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** The OAuth app's Consumer Key and Secret and the callback, or null when not configured. */
export function oauthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const clientId = env.SALESFORCE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.SALESFORCE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const callbackUrl = env.SALESFORCE_OAUTH_CALLBACK_URL?.trim()
    || `http://localhost:${env.PORT || 3000}/api/salesforce/callback`;
  return { clientId, clientSecret, callbackUrl };
}

/** The origin the callback page may post its result to: Testbench's own, from the callback URL. */
export function appOrigin(cfg: OAuthConfig | null = oauthConfig()): string | null {
  try { return cfg ? new URL(cfg.callbackUrl).origin : null; } catch { return null; }
}

/**
 * The orgs Stage 1 connects. "developer" is a Developer Edition org (`.develop.` partition): a free,
 * standalone org that holds no customer data — added 2026-10-24 at the user's request, so the
 * External Client App created in their own Developer Edition org can be tested where it lives.
 */
export type TestOrgKind = "scratch" | "sandbox" | "developer" | "production";

/** SALESFORCE_PRODUCTION_ORGS_ENABLED (default off): connect production orgs too. A run creates
 *  records and clicks Save in whatever org it is given, so this is a deliberate, server-wide choice. */
export function productionOrgsEnabled(): boolean {
  return process.env.SALESFORCE_PRODUCTION_ORGS_ENABLED === "true";
}

function isSalesforceHost(host: string): boolean {
  const h = host.toLowerCase();
  // `.salesforce-setup.com` is Setup's own domain (<org>.my.salesforce-setup.com): the same org.
  return h.endsWith(".salesforce.com") || h.endsWith(".force.com") || h.endsWith(".salesforce-setup.com");
}

/** "scratch" / "sandbox" / "developer" from a Salesforce host, or null for anything else
 *  (production included). Decided by the host's partition label only. */
export function testOrgKind(host: string): TestOrgKind | null {
  const h = host.toLowerCase();
  if (!isSalesforceHost(h)) return null;
  if (h.includes(".scratch.")) return "scratch";
  if (h.includes(".sandbox.")) return "sandbox";
  if (h.includes(".develop.")) return "developer";
  // A plain My Domain host (acme.my.salesforce.com / acme.lightning.force.com) is production.
  if (productionOrgsEnabled() && /^[^.]+\.(my\.salesforce\.com|lightning\.force\.com|my\.salesforce-setup\.com)$/.test(h)) return "production";
  return null;
}

/** The org's My Domain name — the first label of any of its hosts (`acme--uat` in
 *  `acme--uat.sandbox.my.salesforce.com` and `acme--uat.sandbox.lightning.force.com`). */
export function myDomainName(host: string): string {
  return host.toLowerCase().split(".")[0] ?? "";
}

/** Two hosts of the SAME test org: same My Domain name and same partition (scratch / sandbox). */
export function sameTestOrg(a: string, b: string): boolean {
  return myDomainName(a) === myDomainName(b) && testOrgKind(a) !== null && testOrgKind(a) === testOrgKind(b);
}

/**
 * Where to authorise: the org's own My Domain login host, from whatever org URL the person typed.
 * A Lightning URL of the org is mapped to its My Domain. Never login.salesforce.com: the org's own
 * host is what identifies the org, and a Local External Client App authorises there only.
 */
export function loginOriginFor(orgUrl: string): { origin: string; kind: TestOrgKind } | { error: string } {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(orgUrl.trim()) ? orgUrl.trim() : `https://${orgUrl.trim()}`);
  } catch {
    return { error: "That is not a URL. Paste the org's address, e.g. https://acme--uat.sandbox.my.salesforce.com." };
  }
  // The org's Lightning and Setup hosts map to its My Domain, where it authorises.
  const host = u.hostname.toLowerCase()
    .replace(/\.lightning\.force\.com$/, ".my.salesforce.com")
    .replace(/\.my\.salesforce-setup\.com$/, ".my.salesforce.com");
  if (!isSalesforceHost(host)) {
    return { error: `${host} is not a Salesforce address. Connect an org by its My Domain URL, e.g. https://acme--uat.sandbox.my.salesforce.com.` };
  }
  if (!host.endsWith(".my.salesforce.com")) {
    return { error: `${host} is not an org's own address. Use the org's My Domain URL (it ends in .my.salesforce.com), not login.salesforce.com or test.salesforce.com.` };
  }
  const kind = testOrgKind(host);
  if (!kind) {
    return { error: `${host} is not a scratch org, a sandbox or a Developer Edition org. Only addresses with .scratch., .sandbox. or .develop. in them connect unless the server sets SALESFORCE_PRODUCTION_ORGS_ENABLED=true.` };
  }
  return { origin: `https://${host}`, kind };
}

interface Pending {
  verifier: string;
  loginOrigin: string;
  orgId: string | null;
  userId: string | null;
  createdAt: number;
}

interface Connection {
  id: string;
  orgId: string | null;
  userId: string | null;
  loginOrigin: string;
  instanceUrl: string;
  kind: TestOrgKind;
  accessToken: string;
  refreshToken?: string;
  tokenAt: number;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long a connection is kept in memory at all. */
const CONNECTION_TTL_MS = 12 * 60 * 60 * 1000;
/** Refresh before minting once the access token is older than this. Salesforce's default session
 *  timeout is two hours; refreshing at one leaves a long run room to finish. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

const pending = new Map<string, Pending>();
const connections = new Map<string, Connection>();

function sweep(now = Date.now()): void {
  for (const [k, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(k);
  for (const [k, c] of connections) if (now - c.createdAt > CONNECTION_TTL_MS) connections.delete(k);
}

/** Start a connection: the authorise URL to open in a popup, or a sentence saying why not. */
export function startAuthorization(
  input: { orgUrl: string; orgId: string | null; userId: string | null },
  cfg: OAuthConfig | null = oauthConfig(),
): { authorizeUrl: string } | { error: string } {
  if (!cfg) {
    return { error: "Salesforce org connections are not configured on this server: SALESFORCE_OAUTH_CLIENT_ID and SALESFORCE_OAUTH_CLIENT_SECRET are missing." };
  }
  const where = loginOriginFor(input.orgUrl);
  if ("error" in where) return where;
  sweep();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, loginOrigin: where.origin, orgId: input.orgId, userId: input.userId, createdAt: Date.now() });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    scope: "api web refresh_token",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { authorizeUrl: `${where.origin}/services/oauth2/authorize?${q.toString()}` };
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

async function tokenRequest(loginOrigin: string, body: Record<string, string>, fetchImpl: FetchLike): Promise<any> {
  const res = await fetchImpl(`${loginOrigin}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || typeof json?.access_token !== "string") {
    // Salesforce's own error words only — never echo the request, which holds the secret and code.
    const why = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    const err = new Error(`Salesforce refused the token request: ${String(why).slice(0, 200)}`) as Error & { refused?: boolean };
    // An OAuth refusal (revoked, expired or rotated-away refresh token) is final; a 5xx is not.
    err.refused = res.status >= 400 && res.status < 500 && typeof json?.error === "string";
    throw err;
  }
  return json;
}

/** The instance Salesforce returned must be the SAME test org that was asked for. */
function checkedInstance(instanceUrl: unknown, loginOrigin: string): URL {
  let inst: URL;
  try { inst = new URL(String(instanceUrl)); } catch {
    throw new Error("Salesforce returned no usable instance address; the connection was not kept.");
  }
  if (inst.protocol !== "https:" || !sameTestOrg(inst.hostname, new URL(loginOrigin).hostname)) {
    throw new Error(`Salesforce returned ${inst.hostname}, which is not the test org that was asked for; the connection was not kept.`);
  }
  return inst;
}

/** Finish a connection from the callback's `code` and `state`. One use per state. */
export async function completeAuthorization(
  code: string, state: string,
  cfg: OAuthConfig | null = oauthConfig(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  deps: PersistenceDeps = {},
): Promise<{ connectionId: string; host: string; kind: TestOrgKind; orgId: string | null }> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new Error("This sign-in has expired or was already used. Start the connection again from Testbench.");
  }
  if (!cfg) throw new Error("Salesforce org connections are not configured on this server.");
  if (!code) throw new Error("Salesforce sent no authorisation code.");
  const json = await tokenRequest(p.loginOrigin, {
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.callbackUrl,
    code_verifier: p.verifier,
  }, fetchImpl);
  const inst = checkedInstance(json.instance_url, p.loginOrigin);
  const kind = testOrgKind(inst.hostname)!;
  const id = randomBytes(18).toString("base64url");
  const now = Date.now();
  const c: Connection = {
    id, orgId: p.orgId, userId: p.userId, loginOrigin: p.loginOrigin, instanceUrl: inst.origin, kind,
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
    tokenAt: now, createdAt: now,
  };
  connections.set(id, c);
  await persistConnection(c, deps);
  return { connectionId: id, host: inst.hostname, kind, orgId: p.orgId };
}

/** What a restart must not forget: the storage and the key that seals the refresh token. Both are
 *  optional — without them a connection lives in memory only, as before — and injectable for tests. */
export interface PersistenceDeps {
  client?: ReturnType<typeof getServiceClient>;
  custody?: KeyCustody | null;
  /** The local file store; null turns it off. Default: SALESFORCE_CONNECTIONS_FILE, else off. */
  file?: string | null;
}

/**
 * A local store for the same sealed rows, used when the database cannot hold them: no database, or
 * one whose API cannot see the table (2026-10-25: PGRST205 after the migration was run, so every
 * restart needed the person to click Connect org again). One JSON file, rows keyed by connection
 * id; the refresh token in it is sealed exactly as in the table, with a key held outside it.
 * Off unless SALESFORCE_CONNECTIONS_FILE names the file.
 * ponytail: one file, rewritten whole; a shared store for several server instances is the table.
 */
function connectionsFile(deps: PersistenceDeps): string | null {
  return deps.file === undefined ? (process.env.SALESFORCE_CONNECTIONS_FILE?.trim() || null) : deps.file;
}
function readFileRows(file: string): Record<string, ConnectionRow> {
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, ConnectionRow>; } catch { return {}; }
}
function writeFileRows(file: string, rows: Record<string, ConnectionRow>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 });
}

interface ConnectionRow {
  id: string; organisation_id: string | null; user_id: string | null;
  login_origin: string; instance_url: string; kind: string;
  refresh_ct: string; refresh_iv: string; refresh_tag: string; refresh_custody: string;
}

/** Store the connection so a restart keeps it (Session 102, TD-166). Best effort: a failure is
 *  logged, never thrown — the connection still works in memory for this process. */
async function persistConnection(c: Connection, deps: PersistenceDeps = {}): Promise<void> {
  const client = deps.client === undefined ? getServiceClient() : deps.client;
  const custody = deps.custody === undefined ? custodyFromEnv() : deps.custody;
  const file = connectionsFile(deps);
  if ((!client && !file) || !custody || !c.refreshToken) {
    if (!custody) console.log("[salesforce] connection kept in memory only: set LLM_KEY_FILE so connections survive a restart");
    return;
  }
  try {
    const sealed = encryptSecret(c.refreshToken, custody);
    const row: ConnectionRow = {
      id: c.id, organisation_id: c.orgId, user_id: c.userId,
      login_origin: c.loginOrigin, instance_url: c.instanceUrl, kind: c.kind,
      refresh_ct: sealed.ct, refresh_iv: sealed.iv, refresh_tag: sealed.tag, refresh_custody: sealed.custody,
    };
    let stored = false;
    if (client) {
      const { error } = await client.from("salesforce_connections").upsert(row, { onConflict: "id" });
      if (error) console.error(`[salesforce] could not store the connection: ${error.message}`);
      else stored = true;
    }
    if (!stored && file) {
      writeFileRows(file, { ...readFileRows(file), [c.id]: row });
      console.log("[salesforce] connection stored in the local connections file");
    }
  } catch (err) {
    console.error(`[salesforce] could not store the connection: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * The connection by id, for the organisation that made it — from memory, else restored from
 * storage with a freshly minted access token. Null when unknown, foreign, or its refresh token no
 * longer works (the row is then dropped, and the person connects again).
 */
export async function restoreConnection(
  id: unknown, orgId: string | null,
  deps: PersistenceDeps & { cfg?: OAuthConfig | null; fetchImpl?: FetchLike } = {},
): Promise<Connection | null> {
  const inMemory = connectionFor(id, orgId);
  if (inMemory || typeof id !== "string" || !id) return inMemory;
  const client = deps.client === undefined ? getServiceClient() : deps.client;
  const custody = deps.custody === undefined ? custodyFromEnv() : deps.custody;
  const cfg = deps.cfg === undefined ? oauthConfig() : deps.cfg;
  const file = connectionsFile(deps);
  // Without the app's keys no token can be minted: never hand back a connection with an empty one.
  if ((!client && !file) || !custody || !cfg) return null;
  // Never throws: the callers are request handlers, and a bad row must not hang a request.
  try {
    let row: ConnectionRow | null = null;
    if (client) {
      const { data, error } = await client.from("salesforce_connections").select("*").eq("id", id).maybeSingle();
      if (!error && data) row = data as ConnectionRow;
    }
    if (!row && file) row = readFileRows(file)[id] ?? null;
    if (!row) return null;
    if (row.organisation_id !== orgId) return null;
    const c: Connection = {
      id: row.id, orgId: row.organisation_id, userId: row.user_id, loginOrigin: row.login_origin,
      instanceUrl: row.instance_url, kind: row.kind as TestOrgKind,
      accessToken: "", tokenAt: 0,            // forces a refresh below: no access token is stored
      createdAt: Date.now(),                  // a restored connection gets a fresh 12 h in memory
    };
    c.refreshToken = decryptSecret({ ct: row.refresh_ct, iv: row.refresh_iv, tag: row.refresh_tag, custody: row.refresh_custody }, custody);
    await refreshIfOld(c, cfg, deps.fetchImpl ?? (fetch as unknown as FetchLike), deps);
    connections.set(c.id, c);
    console.log(`[salesforce] org connection restored: ${new URL(c.instanceUrl).hostname} (${c.kind})`);
    return c;
  } catch (err) {
    // Only Salesforce refusing the refresh token is final. A network error, a 5xx, a key file
    // that is missing after a deploy: keep the row, the next request can try again.
    const refused = (err as { refused?: boolean })?.refused === true;
    console.error(`[salesforce] stored connection ${id.slice(0, 6)}... could not be restored${refused ? ", dropping it" : ""}: ${(err as Error)?.message ?? err}`);
    if (refused) {
      if (client) await client.from("salesforce_connections").delete().eq("id", id);
      if (file) { const rows = readFileRows(file); delete rows[id]; writeFileRows(file, rows); }
    }
    return null;
  }
}

/** The connection, only for the organisation that made it; null otherwise (unknown, expired, foreign). */
export function connectionFor(id: unknown, orgId: string | null): Connection | null {
  if (typeof id !== "string" || !id) return null;
  sweep();
  const c = connections.get(id);
  if (!c || c.orgId !== orgId) return null;
  return c;
}

/** True when the run's URL is a host of the connection's own org. */
export function connectionMatchesUrl(c: Connection, runUrl: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(runUrl) ? runUrl : `https://${runUrl}`).hostname;
    return sameTestOrg(host, new URL(c.instanceUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The session a REPLAY of saved cases runs under (Session 102, TD-166). A case saved from an
 * org-connection run signs in through `${env:SF_FRONTDOOR_URL}`, which only a live connection can
 * mint: outside a run there was none, so every such replay failed. Same checks as a fresh run:
 * the connection must be the caller's organisation's, and every case's site must be a host of
 * that org. Cases that never sign in through a connection need nothing and get `session: null`.
 */
export function replaySessionFor(
  cases: ReadonlyArray<{ ir: { meta: { baseUrl?: string }; steps: ReadonlyArray<{ action: string; target?: { url?: string } }> } }>,
  rawConnectionId: unknown, orgId: string | null,
): { session: FrontdoorSession | null } | { code: "sf-connection-required" | "sf-connection-expired" | "sf-connection-wrong-org"; error: string } {
  const signsIn = cases.some((c) => c.ir.steps.some((s) => s.action === "navigate" && isFrontdoorRef(s.target?.url)));
  if (!signsIn) return { session: null };
  if (rawConnectionId === undefined || rawConnectionId === null || rawConnectionId === "") {
    return { code: "sf-connection-required", error: "These saved cases sign in through a Salesforce org connection. Connect the org, then replay." };
  }
  const conn = connectionFor(rawConnectionId, orgId);
  if (!conn) return { code: "sf-connection-expired", error: "That Salesforce org connection is unknown or has expired. Connect the org again." };
  const off = cases.find((c) => !connectionMatchesUrl(conn, c.ir.meta.baseUrl ?? ""));
  if (off) {
    return { code: "sf-connection-wrong-org", error: `"${off.ir.meta.baseUrl}" is not an address of the connected org. Connect the org these cases belong to.` };
  }
  return { session: frontdoorSessionFor(conn) };
}

async function refreshIfOld(c: Connection, cfg: OAuthConfig | null, fetchImpl: FetchLike, deps: PersistenceDeps = {}): Promise<void> {
  if (!c.refreshToken || !cfg || Date.now() - c.tokenAt < REFRESH_AFTER_MS) return;
  const json = await tokenRequest(c.loginOrigin, {
    grant_type: "refresh_token",
    refresh_token: c.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }, fetchImpl);
  checkedInstance(json.instance_url ?? c.instanceUrl, c.loginOrigin);
  c.accessToken = json.access_token;
  c.tokenAt = Date.now();
  // An app with refresh-token rotation hands back a new one; the old one stops working.
  if (typeof json.refresh_token === "string" && json.refresh_token !== c.refreshToken) {
    c.refreshToken = json.refresh_token;
    await persistConnection(c, deps);
  }
}

/** The rail value a run carries (salesforceFrontdoor.ts). `mint` registers what it returns as a
 *  secret of the current run, so the event, state and artifact scrubbers redact it. */
export function frontdoorSessionFor(
  c: Connection,
  deps: { cfg?: OAuthConfig | null; fetchImpl?: FetchLike } = {},
): FrontdoorSession {
  const cfg = deps.cfg === undefined ? oauthConfig() : deps.cfg;
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  return {
    connectionId: c.id,
    instanceHost: new URL(c.instanceUrl).hostname,
    mint: async () => {
      await refreshIfOld(c, cfg, fetchImpl);
      const url = `${c.instanceUrl}/secur/frontdoor.jsp?sid=${encodeURIComponent(c.accessToken)}`
        + `&retURL=${encodeURIComponent("/lightning/page/home")}`;
      const runId = currentRunId();
      if (runId) rememberRunSecretStrings(runId, [url, c.accessToken, encodeURIComponent(c.accessToken)]);
      return url;
    },
    apiGet: async (path: string) => {
      await refreshIfOld(c, cfg, fetchImpl);
      const runId = currentRunId();
      if (runId) rememberRunSecretStrings(runId, [c.accessToken]);
      const res = await fetchImpl(`${c.instanceUrl}/services/data/${SF_API_VERSION}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${c.accessToken}`, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Salesforce API ${path.split("?")[0]} answered HTTP ${res.status}`);
      return res.json();
    },
    apiDelete: async (path: string) => {
      await refreshIfOld(c, cfg, fetchImpl);
      const runId = currentRunId();
      if (runId) rememberRunSecretStrings(runId, [c.accessToken]);
      const res = await fetchImpl(`${c.instanceUrl}/services/data/${SF_API_VERSION}${path}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${c.accessToken}` },
      });
      if (!res.ok) throw new Error(`Salesforce API DELETE ${path.split("?")[0]} answered HTTP ${res.status}`);
    },
  };
}

/** The REST/UI API version the connection reads with. */
export const SF_API_VERSION = "v62.0";

/** Test seam: forget every pending sign-in and connection. */
export function resetSalesforceOAuthForTests(): void {
  pending.clear();
  connections.clear();
}

import { adfToText } from "./adf.js";
import type { JiraConnection, JiraSite } from "./session.js";

/**
 * Jira Cloud calls for Phase 1 (D-63): sign in with OAuth 2.0 (3LO), find the user's site, read
 * one story. Read-only — the only scope requested is `read:jira-work`.
 *
 * Every URL, body and status below is from Atlassian's own documentation (OAuth 2.0 3LO apps page
 * and the REST v3 OpenAPI spec, fetched 2026-10-26) — see DECISIONS.md D-63 for the list. Nothing
 * here logs, returns or throws the access token or the client secret.
 */

export const JIRA_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const JIRA_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const JIRA_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
export const JIRA_API_BASE = "https://api.atlassian.com/ex/jira";
/** Phase 1 only reads. Classic scope: Atlassian recommends classic; granular is still Beta in the spec. */
export const JIRA_SCOPES = ["read:jira-work"] as const;
/** Default cap on the text put into the prompt box — a longer prompt costs more on the AI step. */
export const DEFAULT_JIRA_MAX_PROMPT_CHARS = 4000;

const TIMEOUT_MS = 15_000;
/** Treat the token as expired a minute early so a fetch never starts on a token about to die. */
const EXPIRY_MARGIN_MS = 60_000;

export function jiraEnabled(): boolean {
  return process.env.JIRA_ENABLED === "true";
}

export interface JiraConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

/** The default callback, matching the URL registered in the Atlassian console for local use. */
export function defaultRedirectUrl(): string {
  return `http://localhost:${process.env.PORT ?? 3000}/api/jira/callback`;
}

/** The app's settings, or the NAMES of the ones missing (never a value). */
export function jiraConfig(): { config: JiraConfig } | { missing: string[] } {
  const clientId = process.env.JIRA_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.JIRA_CLIENT_SECRET?.trim() ?? "";
  const missing = [
    ...(clientId ? [] : ["JIRA_CLIENT_ID"]),
    ...(clientSecret ? [] : ["JIRA_CLIENT_SECRET"]),
  ];
  if (missing.length) return { missing };
  return { config: { clientId, clientSecret, redirectUrl: process.env.JIRA_REDIRECT_URL?.trim() || defaultRedirectUrl() } };
}

export function maxPromptChars(): number {
  const n = Number(process.env.JIRA_MAX_PROMPT_CHARS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_JIRA_MAX_PROMPT_CHARS;
}

/** A failure with a sentence fit to show the user, and the status our route should answer with. */
export class JiraError extends Error {
  constructor(message: string, readonly status: number, readonly signedOut = false) {
    super(message);
    this.name = "JiraError";
  }
}

/** The Atlassian sign-in page for this `state`. */
export function authorizeUrl(config: JiraConfig, state: string): string {
  const q = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.clientId,
    scope: JIRA_SCOPES.join(" "),
    redirect_uri: config.redirectUrl,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${JIRA_AUTHORIZE_URL}?${q.toString()}`;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new JiraError("Couldn't reach Jira. Check the internet connection and try again.", 502);
  }
}

/** Swap the callback's `code` for a token, then find which Jira site(s) it can read. */
export async function connect(config: JiraConfig, code: string, now = Date.now()): Promise<JiraConnection> {
  const res = await call(JIRA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUrl,
    }),
  });
  if (!res.ok) {
    // 401/403 here is almost always a wrong client id/secret or a callback URL that doesn't match
    // the console exactly. The response body is not echoed: it can carry the code we just sent.
    throw new JiraError(
      `Jira didn't accept the sign-in (${res.status}). Check JIRA_CLIENT_ID, JIRA_CLIENT_SECRET and that the callback URL in the Atlassian console is exactly ${config.redirectUrl}.`,
      502,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new JiraError("Jira's sign-in reply had no access token.", 502);
  }
  const expiresIn = Number(body.expires_in);
  const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000) - EXPIRY_MARGIN_MS;

  const sites = await readableSites(body.access_token);
  if (!sites.length) {
    throw new JiraError("This Atlassian account has no Jira site that Testbench is allowed to read.", 403);
  }
  return { accessToken: body.access_token, expiresAt, sites };
}

/**
 * The Jira sites this token can read. The endpoint lists every Atlassian product the user granted;
 * Atlassian says to tell them apart by their scopes, so a site counts only if it carries ours.
 */
async function readableSites(token: string): Promise<JiraSite[]> {
  const res = await call(JIRA_RESOURCES_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new JiraError(`Couldn't list your Jira sites (${res.status}).`, 502);
  const list = (await res.json().catch(() => [])) as unknown;
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.id === "string" && Array.isArray(r.scopes) && r.scopes.includes("read:jira-work"))
    .map((r) => ({ id: r.id as string, name: String(r.name ?? ""), url: String(r.url ?? "") }));
}

/** A Jira issue key from what the user typed: `tbs-1`, `TBS-1`, or a pasted `…/browse/TBS-1` link. */
export function parseIssueKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const m = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(s) ?? /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]|$)/.exec(s);
  return m ? m[1].toUpperCase() : null;
}

export interface JiraStory {
  key: string;
  title: string;
  /** What goes into the prompt box: the title, a blank line, then the description as plain text. */
  promptText: string;
  /** True when `promptText` was cut to `maxPromptChars()`. */
  truncated: boolean;
  /** The story in Jira, for a "view in Jira" link. */
  link: string;
  siteName: string;
}

/** Read one story: only `summary` and `description` are requested (the default is every field). */
export async function fetchStory(conn: JiraConnection, site: JiraSite, key: string, limit = maxPromptChars()): Promise<JiraStory> {
  const url = `${JIRA_API_BASE}/${encodeURIComponent(site.id)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;
  const res = await call(url, { headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: "application/json" } });
  if (res.status === 401) throw new JiraError("Your Jira sign-in has expired. Click \"Connect Jira\" again.", 401, true);
  if (res.status === 404) {
    // Jira answers 404 both for "no such issue" and "you may not see it" — it does not say which.
    throw new JiraError(`${key} wasn't found on ${site.name || "this Jira site"}, or your Jira account can't see it.`, 404);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After"));
    throw new JiraError(`Jira is busy right now. Try again${Number.isFinite(wait) && wait > 0 ? ` in ${wait} seconds` : " shortly"}.`, 429);
  }
  if (!res.ok) throw new JiraError(`Jira returned an error (${res.status}) for ${key}.`, 502);

  const body = (await res.json().catch(() => ({}))) as { key?: unknown; fields?: { summary?: unknown; description?: unknown } };
  const title = typeof body.fields?.summary === "string" ? body.fields.summary.trim() : "";
  const description = adfToText(body.fields?.description);
  const full = [title, description].filter(Boolean).join("\n\n");
  if (!full) throw new JiraError(`${key} has no title or description to test from.`, 422);
  const truncated = full.length > limit;
  const realKey = typeof body.key === "string" && body.key ? body.key : key;
  return {
    key: realKey,
    title,
    promptText: truncated ? full.slice(0, limit).trimEnd() : full,
    truncated,
    link: site.url ? `${site.url.replace(/\/+$/, "")}/browse/${encodeURIComponent(realKey)}` : "",
    siteName: site.name,
  };
}

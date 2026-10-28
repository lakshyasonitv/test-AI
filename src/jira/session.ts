import { randomBytes } from "node:crypto";

/**
 * Jira connections, in process memory only (D-71).
 *
 * Two maps, both lost on restart by design:
 *   - pending sign-ins: the one-time `state` value sent to Atlassian -> which user asked, and when.
 *   - connections: user id -> their access token and the Jira site(s) it can reach.
 *
 * Why memory: the access token is a credential to the user's Jira. Atlassian's security
 * requirements for 3LO apps say OAuth secrets must be stored encrypted and never in logs; keeping
 * the token only in this process means it never reaches disk, the database, a log line or a run
 * artifact at all (the same rule platform rule 5 sets for site credentials). The cost, agreed with
 * the user: a server restart, or the token expiring, means clicking "Connect Jira" again. We never
 * ask for `offline_access`, so there is no refresh token to keep either.
 *
 * Why `state` is bound to a user here rather than to a cookie: this app's own sign-in travels in an
 * `Authorization` header that a browser redirect back from Atlassian cannot carry. So the callback
 * is identified by `state` alone — 32 random bytes, used once, expiring in 10 minutes, and filed
 * under the user who asked for it (Atlassian: "unique state parameters … associated with the
 * user's session … cryptographically strong").
 */

export const STATE_TTL_MS = 10 * 60_000;
/** A ceiling on pending sign-ins so an abandoned-popup loop cannot grow memory without bound. */
const MAX_PENDING = 1000;

export interface JiraSite {
  /** Atlassian's cloudId — the `{cloudid}` in api.atlassian.com/ex/jira/{cloudid}/… */
  id: string;
  name: string;
  url: string;
}

export interface JiraConnection {
  accessToken: string;
  /** Epoch ms after which the token is treated as gone. */
  expiresAt: number;
  sites: JiraSite[];
}

const pending = new Map<string, { userId: string; createdAt: number }>();
const connections = new Map<string, JiraConnection>();

function prune(now: number): void {
  for (const [state, p] of pending) if (now - p.createdAt > STATE_TTL_MS) pending.delete(state);
}

/** Start a sign-in for `userId`: returns the one-time `state` to send to Atlassian. */
export function beginSignIn(userId: string, now = Date.now()): string {
  prune(now);
  if (pending.size >= MAX_PENDING) {
    // Oldest first: Map iteration order is insertion order.
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  const state = randomBytes(32).toString("base64url");
  pending.set(state, { userId, createdAt: now });
  return state;
}

/**
 * Redeem a `state` from the callback: the user it belongs to, or null if it is unknown, expired or
 * already used. Deleted on first look either way, so a replayed callback can never redeem it again.
 */
export function finishSignIn(state: unknown, now = Date.now()): string | null {
  if (typeof state !== "string" || !state) return null;
  const p = pending.get(state);
  pending.delete(state);
  if (!p || now - p.createdAt > STATE_TTL_MS) return null;
  return p.userId;
}

export function saveConnection(userId: string, conn: JiraConnection): void {
  connections.set(userId, conn);
}

/** This user's live connection, or null (never connected, disconnected, restarted, or expired). */
export function getConnection(userId: string, now = Date.now()): JiraConnection | null {
  const c = connections.get(userId);
  if (!c) return null;
  if (now >= c.expiresAt) {
    connections.delete(userId);
    return null;
  }
  return c;
}

export function dropConnection(userId: string): void {
  connections.delete(userId);
}

/** Tests only. */
export function _resetJiraSessions(): void {
  pending.clear();
  connections.clear();
}

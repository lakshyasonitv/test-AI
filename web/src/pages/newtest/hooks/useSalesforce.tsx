import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { call, jsonPost, store } from "../shared";

/**
 * The Salesforce part of New test, ported from public/app.js (D-50, D-63, Phase C, discovery
 * cache): "This URL is a Salesforce org", the "Sign in as" card (connected users of the org in the
 * URL box, + Connect a user through Salesforce's own login page, Remove, Clean up), the approver
 * picker and the "Scan the org again" box. The browser only ever holds an opaque connection id;
 * no password or token is typed, kept or stored here.
 *
 * Inline styles are the classic ones (it uses inline styles from the app's tokens, rule 3).
 */

export interface SfConnection {
  id: string; host: string; kind?: string; username?: string; name?: string; expired?: boolean;
}
interface SavedScan { objects: string[]; savedAt: string }

export const SF_SECTION: CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)",
};

/** The org part of a Salesforce host ("acme--uat" of acme--uat.sandbox.my.salesforce.com). */
const sfOrgKey = (host: string) => String(host || "").toLowerCase().split(".")[0].replace(/--c$/, "");

export function sfInitials(c: SfConnection): string {
  const words = String(c.name || c.username || "?").replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

export const agoText = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/** This org's connections: one usable row per user (newest), the rest as clean-up candidates. */
function split(conns: SfConnection[], host: string) {
  if (!host) return { users: [] as SfConnection[], stale: [] as SfConnection[], pending: 0 };
  const users: SfConnection[] = [], stale: SfConnection[] = [];
  let pending = 0;
  for (const c of conns.filter((x) => sfOrgKey(x.host) === sfOrgKey(host))) {
    if (c.expired) stale.push(c);
    else if (!c.username) pending++;
    else if (users.some((u) => u.username === c.username)) stale.push(c);
    else users.push(c);
  }
  return { users, stale, pending };
}

export interface SfFlags { targetApp: boolean; oauth: boolean; approvals: boolean; discoveryCache: boolean }

/**
 * All Salesforce state for the page. `hostOf` is the org host the URL box points at ("" while the
 * URL is empty or half-typed); `absoluteUrl` is what Connect sends to /api/salesforce/oauth/start.
 */
export function useSalesforce(flags: SfFlags, urlValue: string, absoluteUrl: string) {
  const [targetChecked, setTargetChecked] = useState(false);
  const [conns, setConns] = useState<SfConnection[]>([]);
  const [connId, setConnId] = useState<string | null>(null);
  const [approverId, setApproverIdState] = useState<string | null>(() => store.get("sfApprover") || null);
  const [status, setStatus] = useState("");
  const [freshDiscovery, setFreshDiscoveryState] = useState(() => store.get("sfFreshDiscovery") !== "false");
  const [savedScans, setSavedScans] = useState<SavedScan[] | null>(null);
  const loadGen = useRef(0);
  const connIdRef = useRef(connId);
  connIdRef.current = connId;

  let host = "";
  try { host = urlValue.trim() ? new URL(absoluteUrl).hostname : ""; } catch { /* half-typed URL */ }
  const { users, stale, pending } = split(conns, host);
  const conn = connId ? conns.find((c) => c.id === connId) ?? null : null;

  const setApprover = useCallback((id: string | null) => {
    setApproverIdState(id || null);
    store.set("sfApprover", id || null);
  }, []);

  const load = useCallback(async (selectId?: string) => {
    const gen = ++loadGen.current;
    let list: SfConnection[] = [];
    try {
      const body = await call<{ connections?: SfConnection[] }>("/api/salesforce/connections");
      list = Array.isArray(body?.connections) ? body.connections : [];
    } catch { list = []; }
    if (gen !== loadGen.current) return;
    if (selectId) { store.set("sfRunAs", selectId); setConnId(null); }
    setApproverIdState((a) => {
      if (a && !list.some((c) => c.id === a)) { store.set("sfApprover", null); return null; }
      return a;
    });
    setConns(list);
    // Older connections have no name yet: look each up once (the server keeps the answer).
    for (const c of list.filter((x) => !x.username && !x.expired)) {
      let patch: Partial<SfConnection>;
      try { patch = await call<Partial<SfConnection>>(`/api/salesforce/connections/${encodeURIComponent(c.id)}/identify`, { method: "POST" }); }
      catch { patch = { expired: true }; }
      if (gen !== loadGen.current) return;
      setConns((cur) => cur.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
    }
  }, []);

  useEffect(() => { if (flags.oauth && flags.targetApp) void load(); }, [flags.oauth, flags.targetApp, load]);

  // Who the run signs in as: the remembered choice when it belongs to this org, else the newest
  // user. A user for this org ticks the Salesforce box (classic paintSfConnections).
  const usersKey = users.map((u) => u.id).join(",");
  useEffect(() => {
    if (!flags.oauth || !flags.targetApp) return;
    const want = connId || store.get("sfRunAs");
    const chosen = users.find((c) => c.id === want) ?? users[0] ?? null;
    if (chosen) {
      if (chosen.id !== connId) setConnId(chosen.id);
      store.set("sfRunAs", chosen.id);
      setTargetChecked(true);
    } else if (connId) setConnId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usersKey, connId, flags.oauth, flags.targetApp]);

  useEffect(() => { if (approverId && approverId === connId) setApprover(null); }, [approverId, connId, setApprover]);

  // What is saved for the connected org (discovery cache).
  useEffect(() => {
    if (!flags.discoveryCache || !flags.oauth) return;
    let alive = true;
    setSavedScans(null);
    if (connId) {
      call<{ saved?: SavedScan[] }>(`/api/salesforce/discovery-cache?connectionId=${encodeURIComponent(connId)}`)
        .then((d) => { if (alive && d) setSavedScans(Array.isArray(d.saved) ? d.saved : []); })
        .catch(() => { /* leave it unread */ });
    }
    return () => { alive = false; };
  }, [connId, flags.discoveryCache, flags.oauth]);

  // The OAuth popup ends on /api/salesforce/callback, which posts to THIS origin only.
  useEffect(() => {
    if (!flags.oauth || !flags.targetApp) return;
    const on = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as { type?: string; error?: string; connectionId?: string } | null;
      if (!d || d.type !== "sf-oauth") return;
      if (d.error) { setStatus(d.error); return; }
      // The run keeps signing in as whoever it signed in as; with nobody chosen yet, the new user is.
      void load(connIdRef.current ? undefined : d.connectionId);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [flags.oauth, flags.targetApp, load]);
  const pick = (c: SfConnection) => { setConnId(c.id); store.set("sfRunAs", c.id); };

  const forget = async (list: SfConnection[], question: string) => {
    if (!confirm(question)) return;
    for (const c of list) {
      await call(`/api/salesforce/connections/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => null);
      if (connIdRef.current === c.id) { setConnId(null); connIdRef.current = null; store.set("sfRunAs", null); }
      if (approverId === c.id) setApprover(null);
    }
    void load();
  };

  const connect = async () => {
    if (!urlValue.trim()) { setStatus("Type the org's URL in the box above first."); return; }
    // Opened synchronously, inside the click, so a popup blocker lets it through.
    const popup = window.open("about:blank", "sfConnect", "width=520,height=720");
    setStatus("Opening Salesforce sign-in…");
    try {
      const body = await call<{ authorizeUrl?: string }>("/api/salesforce/oauth/start", jsonPost({ url: absoluteUrl }));
      if (!body?.authorizeUrl) throw new Error("Server didn't return a sign-in address");
      const win = popup && !popup.closed ? popup : window.open(body.authorizeUrl, "sfConnect", "width=520,height=720");
      if (!win) {
        setStatus("The sign-in window was blocked. Allow pop-ups for this site, then click “+ Connect a user” again.");
        return;
      }
      if (win === popup) popup.location.href = body.authorizeUrl;
      setStatus("Sign in as the user to add, in the Salesforce window that opened…");
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const setFreshDiscovery = (on: boolean) => { setFreshDiscoveryState(on); store.set("sfFreshDiscovery", String(on)); };

  /** TD-166: the server forgot the connection (it restarted), so stop showing "Connected". */
  const expired = () => {
    setConnId(null);
    setStatus("That user's connection has expired: connect the user again, or pick another.");
    void load();
  };

  return {
    flags, targetChecked, setTargetChecked, conn, connId, approverId, setApprover, status, host, users, stale,
    pending, freshDiscovery, setFreshDiscovery, savedScans, pick, forget, connect, expired,
  };
}

export type SfState = ReturnType<typeof useSalesforce>;

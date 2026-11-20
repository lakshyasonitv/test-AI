import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { call, jsonPost, store } from "./shared";

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

const SF_SECTION: CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)",
};

/** The org part of a Salesforce host ("acme--uat" of acme--uat.sandbox.my.salesforce.com). */
const sfOrgKey = (host: string) => String(host || "").toLowerCase().split(".")[0].replace(/--c$/, "");

function sfInitials(c: SfConnection): string {
  const words = String(c.name || c.username || "?").replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

const agoText = (iso: string) => {
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

/** The "This URL is a Salesforce org" box, then (OAuth on) the "Sign in as" card. */
export function SalesforceControls({ sf }: { sf: SfState }) {
  if (!sf.flags.targetApp) return null;
  return (
    <>
      <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
        <input type="checkbox" className="lib-check" id="targetAppSalesforce" checked={sf.targetChecked}
          onChange={(e) => sf.setTargetChecked(e.target.checked)} /> This URL is a Salesforce org
      </label>
      {sf.flags.oauth && <SignInCard sf={sf} />}
    </>
  );
}

function SignInCard({ sf }: { sf: SfState }) {
  const { users, stale, pending, conn, host } = sf;
  const note = (text: string) => (
    <div style={{ padding: 12, border: "1px dashed var(--line)", borderRadius: "var(--r-md)", color: "var(--text-2)",
      fontSize: 12, textAlign: "center", lineHeight: 1.45 }}>{text}</div>
  );
  const others = users.filter((c) => c.id !== conn?.id);

  return (
    <div style={{ margin: "10px 0 0 26px", padding: "14px 16px", border: "1px solid var(--line)", borderRadius: "var(--r-lg)",
      background: "var(--surface)", display: sf.targetChecked ? "flex" : "none", flexDirection: "column", gap: 10,
      fontSize: 13, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 240px" }}>
          <div style={SF_SECTION}>Sign in as</div>
          <div style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.45 }}>
            Pick the Salesforce user this run logs in as. Users connect once on Salesforce's own login page, so no password is ever typed.
          </div>
        </div>
        <button type="button" className="dl-btn dl-btn-inline" style={{ whiteSpace: "nowrap" }}
          title="Opens Salesforce's login page for the org in the URL box. Sign in as the user to add"
          onClick={() => void sf.connect()}>+ Connect a user</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45 }}>{sf.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {!host && note("Type the org's URL above to see the users connected to it.")}
        {host && !users.length && note(pending ? "Checking the saved connections…"
          : "No user is connected to this org yet. Click “+ Connect a user” and sign in on Salesforce's page. "
            + "Without one, the run asks for a username and password.")}
        {host && users.map((c) => {
          const on = c.id === conn?.id;
          const isApprover = sf.flags.approvals && c.id === sf.approverId;
          const badge = (text: string, strong: boolean) => (
            <span style={{ flex: "none", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)",
              ...(strong ? { background: "var(--accent)", color: "#fff" } : { background: "var(--surface-3)", color: "var(--accent-deep)" }) }}>{text}</span>
          );
          return (
            <div key={c.id} role="radio" aria-checked={on} tabIndex={0}
              title={on ? "The run signs in as this user" : "Click to make the run sign in as this user"}
              onClick={() => { if (!on) sf.pick(c); }}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!on) sf.pick(c); } }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: "var(--r-md)", cursor: "pointer",
                border: `1px solid ${on ? "var(--accent)" : "var(--line-soft)"}`, background: on ? "var(--surface-2)" : "var(--surface)" }}>
              <span style={{ flex: "none", width: 14, height: 14, borderRadius: "50%", boxSizing: "border-box",
                border: on ? "4px solid var(--accent)" : "1.5px solid var(--line)" }} />
              <span style={{ flex: "none", width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center",
                fontSize: 11, fontWeight: 600, background: "var(--surface-3)", color: "var(--accent-deep)" }}>{sfInitials(c)}</span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name || c.username}</span>
                <span style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.username}</span>
              </div>
              {on && badge("Runs as", true)}
              {isApprover && badge("Approver", false)}
              <button type="button" title="Remove this user's connection here and revoke its access at Salesforce"
                style={{ flex: "none", background: "none", border: 0, padding: "4px 6px", fontSize: 12, color: "var(--muted)", cursor: "pointer", textDecoration: "underline" }}
                onClick={(e) => {
                  e.stopPropagation();
                  void sf.forget([c], `Remove ${c.name || c.username}? Runs can no longer sign in as this user until it is connected again.`);
                }}>Remove</button>
            </div>
          );
        })}

        {host && sf.flags.approvals && conn && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }}>
            <div style={SF_SECTION}>Approver (second user)</div>
            {!others.length ? (
              <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45 }}>
                For approval tests, connect a second user (the one who approves). The run switches to them partway through.
              </div>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <select className="field-select" style={{ maxWidth: "100%" }}
                  value={others.some((c) => c.id === sf.approverId) ? sf.approverId ?? "" : ""}
                  onChange={(e) => sf.setApprover(e.target.value)}>
                  <option value="">Nobody: the run uses one user</option>
                  {others.map((c) => <option key={c.id} value={c.id}>{`${c.name || c.username} (${c.username})`}</option>)}
                </select>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>Approves or rejects when the test asks for it.</span>
              </label>
            )}
          </div>
        )}

        {host && (stale.length > 0 || (pending > 0 && users.length > 0)) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
            {pending > 0 && users.length > 0 && <span>Checking other saved connections…</span>}
            {stale.length > 0 && (
              <>
                <span>{`${stale.length} old or expired connection${stale.length === 1 ? "" : "s"} hidden.`}</span>
                <button type="button"
                  style={{ background: "none", border: 0, padding: 0, fontSize: 12, color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => void sf.forget(stale,
                    `Remove ${stale.length} old or expired connection${stale.length === 1 ? "" : "s"} for this org? The users listed above stay connected.`)}>
                  Clean up
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {sf.flags.discoveryCache && <OrgScan sf={sf} />}
    </div>
  );
}

function OrgScan({ sf }: { sf: SfState }) {
  let text = "";
  if (sf.savedScans !== null) {
    if (!sf.savedScans.length) text = "No saved scan for this org yet. The first run scans it and saves the result.";
    else {
      const list = sf.savedScans.map((s) => `${s.objects.length ? s.objects.join(" + ") : "general"} (${agoText(s.savedAt)})`).join(", ");
      text = sf.freshDiscovery
        ? `Saved scans: ${list}. Ticked, so this run scans afresh. Untick to reuse a saved scan and start in seconds.`
        : `Saved scans: ${list}. This run reuses one when it covers the same objects and the org's setup hasn't changed; otherwise it scans again.`;
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }}>
      <div style={SF_SECTION}>Org scan</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" className="lib-check" id="sfFreshDiscovery" checked={sf.freshDiscovery}
          onChange={(e) => sf.setFreshDiscovery(e.target.checked)} /> Scan the org again
        <span style={{ color: "var(--muted)", fontSize: 12 }}>about 8 minutes</span>
      </label>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45, marginLeft: 26 }}>{text}</div>
    </div>
  );
}

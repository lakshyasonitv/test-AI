import { useEffect, useRef, useState } from "react";
import { call } from "./shared";

/**
 * Jira, Phase 1 (D-71), ported from public/app.js: "Connect Jira", then type a story key and its
 * title + description fill the prompt box. The Jira token never reaches the browser: the server
 * keeps it and only says whether this user is connected. Rendered OUTSIDE the run form, so Enter
 * in the key box fetches the story and never starts a run.
 */
interface Site { id: string; name?: string; url?: string }
interface Status { connected?: boolean; sites?: Site[]; configured?: boolean; missing?: string[] }
interface Story { promptText: string; key: string; link?: string; truncated?: boolean }

export function JiraRow({ setPrompt }: { setPrompt: (v: string) => void }) {
  const [connected, setConnected] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState<{ text: string; link?: string } | null>(null);
  const poll = useRef<number | null>(null);
  const siteRef = useRef(siteId);
  siteRef.current = siteId;

  const refresh = async (): Promise<boolean> => {
    try {
      const s = await call<Status>("/api/jira/status");
      const list = Array.isArray(s.sites) ? s.sites : [];
      setConnected(!!s.connected);
      setSites(list);
      if (!list.some((x) => x.id === siteRef.current)) setSiteId(list[0]?.id ?? "");
      if (s.configured === false) setNotice(`Jira isn't set up on this server yet: ${(s.missing || []).join(", ")} not set.`);
      return !!s.connected;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  useEffect(() => {
    void refresh();
    return () => { if (poll.current != null) clearInterval(poll.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    if (busy) return;
    setNotice(""); setNote(null);
    // Opened NOW, inside the click, so a pop-up blocker allows it.
    const popup = window.open("about:blank", "testbench-jira", "width=620,height=760");
    if (!popup) { setNotice("Your browser blocked the Jira window. Allow pop-ups for this site and click Connect Jira again."); return; }
    try {
      const { authorizeUrl } = await call<{ authorizeUrl: string }>("/api/jira/connect", { method: "POST" });
      popup.location.href = authorizeUrl;
    } catch (err) {
      popup.close();
      setNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    setNote({ text: "Finish in the Jira window…" });
    // The server learns of the sign-in, not this page: ask every 2s, for at most 10 minutes.
    if (poll.current != null) clearInterval(poll.current);
    const started = Date.now();
    poll.current = window.setInterval(async () => {
      const done = await refresh();
      if (done || Date.now() - started > 10 * 60_000) {
        if (poll.current != null) clearInterval(poll.current);
        poll.current = null;
        setNote(done ? null : { text: "The Jira sign-in wasn't finished. Click Connect Jira to try again." });
      }
    }, 2000);
  };

  const fetchStory = async () => {
    if (busy) return;
    const k = key.trim();
    setNotice(""); setNote(null);
    if (!k) { setNotice("Type a story key first, like TBS-1."); return; }
    setBusy(true);
    try {
      const q = sites.length > 1 && siteId ? `?site=${encodeURIComponent(siteId)}` : "";
      const story = await call<Story>(`/api/jira/issue/${encodeURIComponent(k)}${q}`);
      setPrompt(story.promptText);
      setNote({
        text: `Prompt filled from ${story.key}${story.truncated ? " (long story — only the first part was used)" : ""}. Check it, add the URL, then Run.`,
        link: /^https:\/\//.test(story.link || "") ? story.link : undefined,
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setBusy(false);
      await refresh(); // a rejected sign-in comes back as "Connect Jira"
      return;
    }
    setBusy(false);
  };

  const disconnect = async () => {
    try { await call("/api/jira/disconnect", { method: "POST" }); } catch { /* forgotten on restart anyway */ }
    setConnected(false); setSites([]); setNote(null); setNotice("");
  };

  return (
    <div className="panel" style={{ padding: "var(--sp-3) var(--sp-4)", marginBottom: "var(--sp-3)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        {!connected ? (
          <>
            <button type="button" className="composer-save-btn" disabled={busy} onClick={() => void connect()}>Connect Jira</button>
            <span className="field-label">Start a test from a Jira story</span>
          </>
        ) : (
          <>
            <span className="field-label">Jira connected: {sites.map((x) => x.name || x.url).join(", ")}</span>
            {sites.length > 1 && (
              <select className="cd-line-input" style={{ flex: "none", width: "auto" }} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {sites.map((x) => <option key={x.id} value={x.id}>{x.name || x.url}</option>)}
              </select>
            )}
            <input type="text" className="cd-line-input" style={{ flex: "none", width: 200 }} placeholder="Story key, e.g. TBS-1"
              autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fetchStory(); } }} />
            <button type="button" className="composer-save-btn" disabled={busy} onClick={() => void fetchStory()}>{busy ? "Fetching…" : "Fetch story"}</button>
            <button type="button" className="case-selection-link" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
          </>
        )}
      </div>
      {note && (
        <p className="field-label" style={{ marginTop: "var(--sp-2)" }}>
          {note.text}
          {note.link && <> <a href={note.link} target="_blank" rel="noopener noreferrer">Open in Jira</a></>}
        </p>
      )}
      {notice && <p className="team-error" role="alert" style={{ marginTop: "var(--sp-2)" }}>{notice}</p>}
    </div>
  );
}

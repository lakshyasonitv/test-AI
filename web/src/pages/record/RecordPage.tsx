import { useEffect, useRef, useState } from "react";
import { api, type Project, type Suite } from "../../lib/api";
import { ErrorNote } from "../../components/ui";
import { LiveScreen } from "./components/LiveScreen";
import { StepsPanel } from "./components/StepsPanel";
import {
  getState, saveRecording, sendInput, setCheckMode, startRecording, stopRecording, undoStep, type RecState,
} from "./recorderApi";
import "./record.css";

/**
 * Record a flow (#/record/<projectId>, RECORDER_ENABLED): a live browser on the server, shown here.
 * The person uses the site; each action is recorded as a step naming the element that was actually
 * used. Save turns the steps into a new case (v1) in this project. No AI is involved anywhere.
 */
export function RecordPage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [startUrl, setStartUrl] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<RecState | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [address, setAddress] = useState("");
  const saved = useRef(false);

  useEffect(() => {
    api<{ projects?: Project[] }>("/api/projects").then((d) => {
      const p = d.projects?.find((x) => x.id === projectId) ?? null;
      setProject(p);
      if (p?.baseUrl) setStartUrl(p.baseUrl);
    }).catch(() => {});
    api<{ suites?: Suite[] }>(`/api/suites?projectId=${encodeURIComponent(projectId)}`)
      .then((d) => setSuites((d.suites ?? []).filter((s) => s.projectId === projectId))).catch(() => {});
  }, [projectId]);

  const take = (s: RecState) => {
    setState(s);
    setAddress((a) => (document.activeElement?.id === "rxRecAddress" ? a : s.url));
    if (s.notices.length) setNotes((n) => [...s.notices, ...n].slice(0, 6));
  };

  // Steps and notices refresh once a second (typing in progress shows up this way too).
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const t = setInterval(() => { getState(id).then((s) => { if (alive) take(s); }).catch((e) => { if (alive) setError(String(e.message ?? e)); }); }, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  // Leaving the page closes the browser on the server (unless it was saved, which already did).
  useEffect(() => () => { if (id && !saved.current) void stopRecording(id); }, [id]);
  useEffect(() => {
    if (!id) return;
    const bye = () => { if (!saved.current) void stopRecording(id); };
    window.addEventListener("beforeunload", bye);
    return () => window.removeEventListener("beforeunload", bye);
  }, [id]);

  const start = async () => {
    setBusy(true); setError("");
    try {
      const { recordingId } = await startRecording(projectId, startUrl);
      setId(recordingId);
      take(await getState(recordingId));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const act = async (fn: () => Promise<RecState>) => {
    try { take(await fn()); } catch (e) { setError((e as Error).message); }
  };

  const save = async () => {
    if (!id || !state) return;
    setBusy(true); setError("");
    const steps = state.steps.filter((s) => !removed.has(s.id)).map((s) => edits[s.id] ?? s.text);
    try {
      const c = await saveRecording(id, { title, suiteId: suiteId || undefined, steps });
      saved.current = true;
      location.hash = `#/projects/${encodeURIComponent(c.projectId)}/cases/${encodeURIComponent(c.id)}`;
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const cancel = async () => {
    if (id) await stopRecording(id);
    saved.current = true;
    location.hash = `#/projects/${encodeURIComponent(projectId)}`;
  };

  const head = (
    <div>
      <a className="dl-btn-inline" href={`#/projects/${encodeURIComponent(projectId)}`}>← {project?.name ?? "Project"}</a>
      <div className="eyebrow" style={{ marginTop: 12 }}>RECORD A FLOW</div>
      <h1 className="page-head-title">Show it once, save it as a test</h1>
      <p className="tagline">Use the site below the way a person would. Every click and every box you type into becomes a step. No AI is used.</p>
    </div>
  );

  if (!id) {
    return (
      <div className="wide">
        {head}
        <div className="panel" style={{ padding: 16, marginTop: 12 }}>
          <label className="field" style={{ display: "block" }}>
            <span className="field-label">Start at</span>
            <input className="project-form-input" style={{ width: "100%" }} value={startUrl} placeholder="https://example.com/login"
              onChange={(e) => setStartUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void start(); }} />
          </label>
          <p className="tagline" style={{ margin: "10px 0" }}>
            A browser opens on the server. Passwords you type are never stored: a password box is saved as <code>{"${env:TEST_PASSWORD}"}</code>.
          </p>
          <button type="button" className="run-btn" disabled={busy || !startUrl.trim()} onClick={() => void start()}>
            {busy ? "Opening…" : "● Start recording"}
          </button>
          {error && <ErrorNote error={error} />}
        </div>
      </div>
    );
  }

  return (
    <div className="wide">
      {head}
      <div className="rx-rec">
        <div>
          <div className="rx-rec-bar">
            <button type="button" className="dl-btn-inline" title="Back" onClick={() => void act(() => sendInput(id, [{ type: "back" }]))}>←</button>
            <input id="rxRecAddress" className="project-form-input" value={address} spellCheck={false}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void act(() => sendInput(id, [{ type: "navigate", url: address }])); }} />
            <button type="button" className="dl-btn-inline" onClick={() => void act(() => sendInput(id, [{ type: "navigate", url: address }]))}>Go</button>
          </div>
          <LiveScreen id={id} checkMode={!!state?.checkMode} onState={take} />
          {state?.pendingSelect && (
            <div className="panel" style={{ padding: 12, marginTop: 8 }}>
              <div className="field-label">Choose an option</div>
              <div className="rx-rec-select">
                {state.pendingSelect.options.map((o) => (
                  <button type="button" key={o.value} className="dl-btn-inline"
                    onClick={() => void act(() => sendInput(id, [{ type: "select", value: o.value }]))}>{o.label || o.value || "(empty)"}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rx-rec-side">
          <div className="panel" style={{ padding: 14 }}>
            <div className="rx-rec-row">
              <label className="field-label" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" className="lib-check" checked={!!state?.checkMode}
                  onChange={(e) => void act(() => setCheckMode(id, e.target.checked))} />
                Check mode
              </label>
              <span className="tagline" style={{ margin: 0 }}>Click something to check it is shown, instead of clicking it.</span>
            </div>
          </div>

          <div className="panel" style={{ padding: 14 }}>
            <div className="rx-rec-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Steps</h2>
              <button type="button" className="dl-btn-inline" onClick={() => void act(() => undoStep(id))}>Undo last</button>
            </div>
            <StepsPanel steps={state?.steps ?? []} edits={edits} removed={removed}
              onEdit={(sid, text) => setEdits((e) => ({ ...e, [sid]: text }))}
              onRemove={(sid) => setRemoved((r) => new Set(r).add(sid))} />
            {notes.length > 0 && <ul className="rx-rec-notes" style={{ marginTop: 10 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>

          <div className="panel" style={{ padding: 14 }}>
            <label className="field" style={{ display: "block" }}>
              <span className="field-label">Test name</span>
              <input className="project-form-input" style={{ width: "100%" }} value={title} placeholder="e.g. Learner opens a course"
                onChange={(e) => setTitle(e.target.value)} />
            </label>
            {suites.length > 0 && (
              <label className="field" style={{ display: "block", marginTop: 8 }}>
                <span className="field-label">Add to suite (optional)</span>
                <select className="team-select" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                  <option value="">No suite</option>
                  {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <div className="rx-rec-row" style={{ marginTop: 12 }}>
              <button type="button" className="run-btn" disabled={busy || !state?.steps.length} onClick={() => void save()}>
                {busy ? "Saving…" : "Save as test case"}
              </button>
              <button type="button" className="dl-btn-inline" onClick={() => void cancel()}>Cancel</button>
            </div>
            {error && <ErrorNote error={error} />}
          </div>
        </div>
      </div>
    </div>
  );
}

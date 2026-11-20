import { useEffect, useRef, useState } from "react";
import { api, type Project, type Suite } from "../../../lib/api";
import { Busy } from "./Icon";

/** Same panel for a suite card ({runId, caseId, title}) and the single run ("case-0"). Same POST. */
export function SaveCasePanel({ runId, caseId, title }: { runId: string; caseId: string; title: string }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; projects: Project[]; suites: Suite[] }>({ loading: true, projects: [], suites: [] });
  const [projectId, setProjectId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string; caseId?: string; projectId?: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ projects?: Project[] }>("/api/projects").then((r) => r.projects ?? []),
      api<{ suites?: Suite[] }>("/api/suites").then((r) => r.suites ?? []),
    ]).then(([projects, suites]) => {
      if (!alive) return;
      setState({ loading: false, projects, suites });
      setProjectId(projects[0]?.id ?? "");
    }).catch((err) => alive && setState({ loading: false, error: err instanceof Error ? err.message : String(err), projects: [], suites: [] }));
    return () => { alive = false; };
  }, []);

  if (state.loading) return <div className="case-save-panel"><p className="hrow-meta"><Busy text="Loading projects…" /></p></div>;
  if (state.error) return <div className="case-save-panel"><p className="team-error">{state.error}</p></div>;
  if (!state.projects.length) return <div className="case-save-panel"><p className="team-error">You're not in any project yet, so there's nowhere to save this.</p></div>;

  // Only suites of the chosen project: the server refuses a cross-project pair.
  const suitesHere = state.suites.filter((s) => s.projectId === projectId);
  const effectiveSuite = suiteId && suiteId !== "__new" && !suitesHere.some((s) => s.id === suiteId) ? "" : suiteId;

  const createSuite = async () => {
    const name = newName.trim();
    if (!name) { nameRef.current?.focus(); return; }
    setCreating(true);
    try {
      const created = await api<Suite>("/api/suites", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, name }),
      });
      setState((s) => ({ ...s, suites: [...s.suites, created] }));
      setSuiteId(created.id);
      setNewName("");
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<{ id: string }>(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, ...(effectiveSuite ? { suiteId: effectiveSuite } : {}) }),
      });
      setFeedback({ ok: true, text: "Saved.", caseId: saved.id, projectId });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      // Re-enabled on success too, so saving into the wrong project can be retried.
      setSaving(false);
    }
  };

  return (
    <div className="case-save-panel">
      <div className="case-save-form">
        <label className="field">
          <span className="field-label">Project</span>
          <select className="team-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Suite</span>
          <select className="team-select" value={effectiveSuite} onChange={(e) => setSuiteId(e.target.value)}>
            <option value="">Choose a suite…</option>
            {suitesHere.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new">+ New suite</option>
          </select>
        </label>
        <div className="field" hidden={effectiveSuite !== "__new"}>
          <input ref={nameRef} type="text" className="team-select" placeholder="Suite name" aria-label="Name for the new suite"
            value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="dl-btn-inline" disabled={creating} onClick={createSuite}>Create</button>
        </div>
        <button type="button" className="dl-btn" disabled={saving || !effectiveSuite || effectiveSuite === "__new"} onClick={save}>Save to library</button>
      </div>
      <p className="hrow-meta">Saved cases re-run with no AI calls at all.</p>
      <div>
        {feedback && (feedback.ok
          ? <p className="team-ok">Saved. <a href={`#/projects/${encodeURIComponent(feedback.projectId!)}/cases/${encodeURIComponent(feedback.caseId!)}`}>Open the case</a></p>
          : <p className="team-error">{feedback.text}</p>)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ suite results

import { useState, type KeyboardEvent } from "react";
import { api } from "../../lib/api";
import { ErrorNote, Loading, useLoad } from "../../components/ui";
import { displayUrl, JSON_HEADERS, loadLibrary, matcher, plural, runsFor, shortProjectName } from "../../lib/library";
import { canManageProjects, roleAtLeast, useMe } from "../../lib/useMe";
import "../../styles/library.css";

/**
 * All projects — the classic Projects screen's list (app.js drawProjectList): project cards with
 * case / suite / run counts, a search box (name, address or a suite's name), and + New project
 * (admin+, POST /api/projects) which lands in the new project. With no database the list is recent
 * runs grouped by address, read-only. Wrapped in #view-projects so theme.css styles it exactly as
 * the classic screen.
 */
export function ProjectsPage() {
  const me = useMe();
  const { data, error, loading } = useLoad("projects", loadLibrary);
  const [form, setForm] = useState<{ name: string; url: string; error: string } | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const body = () => {
    if (loading) return <Loading />;
    if (error) return <ErrorNote error={error} />;
    const { projects, suites, runs, unavailable } = data!;
    const canManage = canManageProjects(me, unavailable);
    const needsAccess = me.required && me.role && !roleAtLeast(me.role, "admin");
    const suitesOf = (id: string) => suites.filter((s) => s.projectId === id);
    const match = matcher(q.trim());
    const shown = projects.filter((p) => !q.trim() || match([p.name, p.baseUrl, ...suitesOf(p.id).map((s) => s.name)].filter(Boolean).join(" ")));
    const emptyMsg = needsAccess
      ? "You're not in any project yet. Ask an admin to add you to one."
      : canManage ? "No projects yet. Use New project to add one." : "No projects yet.";

    const save = async () => {
      if (!form || busy) return;
      const name = form.name.trim();
      if (!name) { setForm({ ...form, error: "Give the project a name." }); return; }
      setBusy(true);
      try {
        const created = await api<{ id?: string }>("/api/projects", {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, baseUrl: form.url.trim() }),
        });
        setForm(null);
        // Land in the new project, where "+ New suite" is the obvious next step.
        if (created?.id) location.hash = "#/projects/" + encodeURIComponent(created.id);
      } catch (e) {
        setForm({ ...form, error: e instanceof Error ? e.message : String(e) });
      } finally { setBusy(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForm(null);
      else if (e.key === "Enter") { e.preventDefault(); void save(); }
    };

    return (
      <>
        <div data-dash="head">
          <div>
            <div className="eyebrow">PROJECTS</div>
            <h1 className="page-head-title">Projects</h1>
            <p className="tagline">Every site you test, with its saved suites and cases.</p>
          </div>
          <div data-dash="actions">
            {canManage && <button type="button" className="run-btn" onClick={() => setForm({ name: "", url: "", error: "" })}>+ New project</button>}
          </div>
        </div>
        {unavailable && <div className="hrow-meta">This server has no database, so there are no saved projects. These are your recent runs grouped by address.</div>}
        {form && (
          <div data-dash="card">
            <div data-dash="card-head"><h2>New project</h2></div>
            <div data-dash="form">
              <input type="text" className="project-form-input" placeholder="Project name" aria-label="Project name" autoFocus
                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={onKey} />
              <input type="text" className="project-form-input" placeholder="Base URL (optional)" aria-label="Base URL, optional"
                value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} onKeyDown={onKey} />
              <button type="button" className="run-btn" disabled={busy} onClick={save}>Create</button>
              <button type="button" className="dl-btn" onClick={() => setForm(null)}>Cancel</button>
            </div>
            {form.error && <div className="suite-new-err">{form.error}</div>}
          </div>
        )}
        {projects.length > 1 && (
          <div data-dash="search">
            <input type="search" className="project-form-input" data-pv-search autoComplete="off"
              placeholder="Search projects by name, address or suite" aria-label="Search projects"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); } }} />
            <span className="hrow-meta" data-pv-search-count aria-live="polite">
              {!q.trim() ? "" : shown.length ? plural(shown.length, "project") : "Nothing matches"}
            </span>
          </div>
        )}
        {projects.length ? (
          <>
            <div data-dash="pgrid">
              {shown.map((p) => {
                const cases = typeof p.caseCount === "number" ? p.caseCount : 0;
                const runCount = typeof p.runCount === "number" ? p.runCount : runsFor(p, runs).length;
                const chips = [
                  unavailable ? "" : plural(cases, "case"),
                  unavailable ? "" : plural(suitesOf(p.id).length, "suite"),
                  plural(runCount, unavailable ? "recent run" : "run"),
                ].filter(Boolean);
                return (
                  <a key={p.id} data-dash="pcard" href={`#/projects/${encodeURIComponent(p.id)}`} title={p.name}>
                    <h2>{shortProjectName(p.name)}</h2>
                    <div data-dash="mono">{displayUrl(p.baseUrl || p.name) || "No base URL"}</div>
                    <div data-dash="chips">{chips.map((c) => <span key={c} className="case-badge badge-pending">{c}</span>)}</div>
                  </a>
                );
              })}
            </div>
            {q.trim() && !shown.length && (
              <div data-dash="card"><div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>No project matches.</div></div>
            )}
          </>
        ) : (
          <div data-dash="card"><div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>{emptyMsg}</div></div>
        )}
      </>
    );
  };

  return <section id="view-projects" className="rx-lib-view"><div className="wide">{body()}</div></section>;
}

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, classic, type CaseRow, type Suite } from "../api";
import { ErrorNote, Loading, useLoad } from "../ui";
import {
  caseHash, confirmProjectDelete, JSON_HEADERS, loadLibrary, matcher, plural, runsFor,
  runStatusKey, runStatusText, shortProjectName, type LibProject,
} from "./lib/library";
import { canAuthorSuites, canDeleteSuites, canManageProjects, useMe, type Me } from "./lib/useMe";
import "./Library.css";

/**
 * One project — the classic Projects screen's project page (app.js drawOneProject +
 * bindProjectsView + applyProjectSearch + renderProjectMembers), ported whole:
 *   Edit / Delete project (admin+; PATCH, and DELETE behind the deletion-impact + type-the-name gate),
 *   Suites with + New suite (POST, lands in the new suite), inline Rename (PATCH) and Delete (DELETE),
 *   Not in a suite (unfiled cases), Who can see this project (members, platform model only),
 *   Recent runs, and the search box that also looks inside each suite's cases.
 * One inline form open at a time; Enter saves, Escape cancels — as in the classic screen.
 */
type Form =
  | { mode: "project-edit"; name: string; url: string; error: string }
  | { mode: "suite-new"; name: string; error: string }
  | { mode: "suite-rename"; id: string; name: string; error: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectPage({ projectId }: { projectId: string }) {
  const me = useMe();
  const [ver, setVer] = useState(0);
  const { data, error, loading } = useLoad(`project:${projectId}:${ver}`, loadLibrary);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<{ msg: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  // suiteId -> its cases, fetched once per suite on the first search of this visit (D-82).
  const [suiteCases, setSuiteCases] = useState<Map<string, CaseRow[] | "loading">>(new Map());

  useEffect(() => { setForm(null); setQ(""); setSuiteCases(new Map()); setNote(null); }, [projectId]);

  const suites = data ? data.suites.filter((s) => s.projectId === projectId) : [];
  const query = q.trim();

  // Fetch each suite's cases the first time a query is typed.
  useEffect(() => {
    if (!query || !data || data.unavailable) return;
    for (const s of suites) {
      if (suiteCases.has(s.id)) continue;
      setSuiteCases((m) => new Map(m).set(s.id, "loading"));
      fetchSuiteCases(s.id).then((cases) => setSuiteCases((m) => new Map(m).set(s.id, cases)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, data]);

  if (loading) return <Wrap><Loading /></Wrap>;
  if (error) return <Wrap><ErrorNote error={error} /></Wrap>;
  const { projects, unfiled: allUnfiled, runs: allRuns, unavailable } = data!;
  const back = <div><a className="dl-btn-inline" href="#/projects">&larr; All projects</a></div>;
  const p = projects.find((x) => x.id === projectId);
  if (!p) {
    return (
      <Wrap>
        {back}
        <div data-dash="card"><div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>This project doesn't exist, or you can't see it.</div></div>
      </Wrap>
    );
  }

  const canManage = canManageProjects(me, unavailable);
  const canAuthor = canAuthorSuites(me, unavailable);
  const canDelete = canDeleteSuites(me, unavailable);
  const unfiled = allUnfiled.filter((c) => c.projectId === p.id);
  const runs = runsFor(p, allRuns);
  const cases = typeof p.caseCount === "number" ? p.caseCount : 0;
  const runCount = typeof p.runCount === "number" ? p.runCount : runs.length;
  const say = (msg: string, isError = false) => setNote({ msg, error: isError });
  const refresh = () => setVer((v) => v + 1);
  const fail = (e: unknown) => setForm((f) => (f ? { ...f, error: errText(e) } : f));

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  // ------------------------------------------------------------------ actions (bindProjectsView)
  const saveProject = () => run(async () => {
    if (form?.mode !== "project-edit") return;
    const name = form.name.trim();
    if (!name) { setForm({ ...form, error: "Give the project a name." }); return; }
    try {
      // baseUrl is sent even when blank — that is how a URL gets cleared.
      await api(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name, baseUrl: form.url.trim() }),
      });
      setForm(null);
      say("Project updated.");
      refresh();
    } catch (e) { fail(e); }
  });
  const deleteProject = () => run(async () => {
    if (!canManage) return;
    if (!(await confirmProjectDelete(p))) return;
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      location.hash = "#/projects";
    } catch (e) { say(errText(e), true); }
  });
  const createSuite = () => run(async () => {
    if (form?.mode !== "suite-new") return;
    const name = form.name.trim();
    if (!name) { setForm({ ...form, error: "Give the suite a name." }); return; }
    try {
      const created = await api<{ id: string }>("/api/suites", {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ projectId: p.id, name }),
      });
      setForm(null);
      // Land in the new (empty) suite: adding cases is the next step.
      location.hash = "#/suite/" + encodeURIComponent(created.id);
    } catch (e) { fail(e); }
  });
  const renameSuite = () => run(async () => {
    if (form?.mode !== "suite-rename") return;
    const name = form.name.trim();
    if (!name) { setForm({ ...form, error: "Give the suite a name." }); return; }
    const current = suites.find((x) => x.id === form.id);
    if (current && name === current.name) { setForm(null); return; }
    try {
      await api(`/api/suites/${encodeURIComponent(form.id)}`, {
        method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }),
      });
      setForm(null);
      say("Suite renamed.");
      refresh();
    } catch (e) { fail(e); }
  });
  const deleteSuite = (s: Suite) => run(async () => {
    if (!confirm(`Delete the suite "${s.name}"? The cases themselves are kept.`)) return;
    try {
      await api(`/api/suites/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (form?.mode === "suite-rename" && form.id === s.id) setForm(null);
      say("Suite deleted — its cases were kept.");
      refresh();
    } catch (e) { say(errText(e), true); }
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { setForm(null); return; }
    if (e.key !== "Enter" || !form) return;
    e.preventDefault();
    if (form.mode === "project-edit") void saveProject();
    else if (form.mode === "suite-new") void createSuite();
    else void renameSuite();
  };
  const formErr = form?.error ? <div className="suite-new-err">{form.error}</div> : null;
  const empty = (t: string) => <div className="tree-empty" style={{ padding: "22px 16px", textAlign: "center" }}>{t}</div>;

  // ------------------------------------------------------------------ search (applyProjectSearch)
  const match = matcher(query);
  const searching = !!query && !unavailable && suites.some((s) => suiteCases.get(s.id) === "loading" || !suiteCases.has(s.id));
  const suiteView = suites.map((s) => {
    const sc = suiteCases.get(s.id);
    const hits = query && Array.isArray(sc) ? sc.filter((c) => match(`${c.title || ""} ${c.feature || ""}`)) : [];
    return { s, hits, show: !query || match(s.name || "") || hits.length > 0 };
  });
  const unfiledView = unfiled.filter((c) => !query || match(`${c.title || ""} ${c.feature || ""}`));
  const runsView = runs.slice(0, 8).filter((r) => !query || match(r.prompt || ""));
  const nSuites = query ? suiteView.filter((x) => x.show).length : 0;
  const nCases = suiteView.reduce((n, x) => n + x.hits.length, 0) + (query ? unfiledView.length : 0);
  const nRuns = query ? runsView.length : 0;
  const countText = !query ? ""
    : searching ? "Searching inside the suites…"
    : nSuites + nCases + nRuns === 0 ? "Nothing matches"
    : [unavailable ? "" : plural(nSuites, "suite"), unavailable ? "" : plural(nCases, "case"), plural(nRuns, "run")].filter(Boolean).join(" · ");

  const summary = unavailable
    ? plural(runCount, "recent run")
    : `${plural(cases, "saved case")} · ${plural(suites.length, "suite")} · ${plural(runCount, "run")}`;

  const nameInput = (label: string) => form && form.mode !== "project-edit" && (
    <input type="text" className="suite-new-input" placeholder="Suite name" aria-label={label} autoFocus
      style={{ flex: 1, minWidth: 0 }} value={form.name}
      onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={onKey} />
  );

  return (
    <Wrap>
      {back}
      <div data-dash="head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">PROJECT</div>
          <h1 className="page-head-title" title={p.name}>{shortProjectName(p.name)}</h1>
          <p className="tagline">{summary}</p>
          {p.baseUrl && <div data-dash="mono">{p.baseUrl}</div>}
        </div>
        <div data-dash="actions">
          {canManage && <button type="button" className="dl-btn"
            onClick={() => setForm({ mode: "project-edit", name: p.name || "", url: p.baseUrl || "", error: "" })}>Edit</button>}
          {canManage && <button type="button" className="dl-btn hrow-del" disabled={busy} onClick={deleteProject}>Delete</button>}
          {/* The composer (New test) is not in this app yet: the classic one, unprefilled. */}
          <a className="run-btn" href={classic("#/")}>+ New test here</a>
        </div>
      </div>
      {note && <p className={note.error ? "team-error" : "team-ok"}>{note.msg}</p>}
      {form?.mode === "project-edit" && (
        <div data-dash="card">
          <div data-dash="card-head"><h2>Edit project</h2></div>
          <div data-dash="form">
            <input type="text" className="project-form-input" placeholder="Project name" aria-label="Project name" autoFocus
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={onKey} />
            <input type="text" className="project-form-input" placeholder="Base URL (optional)" aria-label="Base URL, optional"
              value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} onKeyDown={onKey} />
            <button type="button" className="run-btn" disabled={busy} onClick={saveProject}>Save</button>
            <button type="button" className="dl-btn" onClick={() => setForm(null)}>Cancel</button>
          </div>
          {formErr}
        </div>
      )}
      <div data-dash="search">
        <input type="search" className="project-form-input" data-pv-search autoComplete="off"
          placeholder={unavailable ? "Search recent runs in this project" : "Search suites, cases and runs in this project"}
          aria-label="Search this project" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); } }} />
        <span className="hrow-meta" data-pv-search-count aria-live="polite">{countText}</span>
      </div>

      <div data-dash="row">
        {!unavailable && (
          <div data-dash="card">
            <div data-dash="card-head"><h2>Suites</h2>
              {canAuthor && <button type="button" className="dl-btn-inline" onClick={() => setForm({ mode: "suite-new", name: "", error: "" })}>+ New suite</button>}
            </div>
            {form?.mode === "suite-new" && (
              <>
                <div className="hrow">
                  {nameInput("Name for the new suite")}
                  <div className="hrow-actions">
                    <button type="button" className="dl-btn-inline" disabled={busy} onClick={createSuite}>Add</button>
                    <button type="button" className="dl-btn-inline" onClick={() => setForm(null)}>Cancel</button>
                  </div>
                </div>
                {formErr}
              </>
            )}
            {!suites.length && form?.mode !== "suite-new" && empty("No suites in this project yet.")}
            {suiteView.map(({ s, hits, show }) => (form?.mode === "suite-rename" && form.id === s.id ? (
              <div key={s.id}>
                <div className="hrow">
                  {nameInput("New name for this suite")}
                  <div className="hrow-actions">
                    <button type="button" className="dl-btn-inline" disabled={busy} onClick={renameSuite}>Save</button>
                    <button type="button" className="dl-btn-inline" onClick={() => setForm(null)}>Cancel</button>
                  </div>
                </div>
                {formErr}
              </div>
            ) : show && (
              <div key={s.id}>
                <div className="hrow">
                  <div className="hrow-main">
                    <div className="hrow-label">{s.name || "(unnamed suite)"}</div>
                    <div className="hrow-meta">{plural(Number(s.caseCount) || 0, "case")}</div>
                  </div>
                  <div className="hrow-actions">
                    <a className="dl-btn-inline" href={`#/suite/${encodeURIComponent(s.id)}`}>Open</a>
                    {canAuthor && <button type="button" className="dl-btn-inline"
                      onClick={() => setForm({ mode: "suite-rename", id: s.id, name: s.name || "", error: "" })}>Rename</button>}
                    {canDelete && <button type="button" className="dl-btn-inline hrow-del" disabled={busy} onClick={() => deleteSuite(s)}>Delete</button>}
                  </div>
                </div>
                {hits.length > 0 && (
                  <div data-pv-hits={s.id}>
                    {hits.map((c) => (
                      <div className="hrow" data-pv-hit key={c.id}>
                        <div className="hrow-main">
                          <div className="hrow-label">{c.title || "(untitled case)"}</div>
                          <div className="hrow-meta">{c.feature ? `${c.feature} · in this suite` : "in this suite"}</div>
                        </div>
                        <div className="hrow-actions"><a className="dl-btn-inline" href={caseHash(p.id, c.id)}>Open</a></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )))}
            {query && suites.length > 0 && !searching && !suiteView.some((x) => x.show) && empty("No suite or case in a suite matches.")}
          </div>
        )}
        {!unavailable && (
          <div data-dash="card">
            <div data-dash="card-head"><h2>Not in a suite</h2></div>
            {!unfiled.length && empty("Every saved case here is in a suite.")}
            {unfiledView.map((c) => (
              <div className="hrow" key={c.id}>
                <div className="hrow-main">
                  <div className="hrow-label">{c.title}</div>
                  <div className="hrow-meta">{`${c.feature ? `${c.feature} · ` : ""}v${c.currentVersion}`}</div>
                </div>
                <div className="hrow-actions"><a className="dl-btn-inline" href={caseHash(p.id, c.id)}>Open</a></div>
              </div>
            ))}
            {query && unfiled.length > 0 && !unfiledView.length && empty("No case here matches.")}
          </div>
        )}
      </div>

      {me.platformModel && !unavailable && canManage && <MembersCard project={p} me={me} />}

      <div data-dash="card">
        <div data-dash="card-head"><h2>Recent runs</h2><a className="dl-btn-inline" href="#/history">See all</a></div>
        <div className="hrow-meta" style={{ margin: "-6px 0 6px" }}>From your {allRuns.length} most recent runs, the same list as History.</div>
        {!runs.length && empty("No recent runs at this address.")}
        {runsView.map((r) => (
          <div className="hrow" key={r.runId}>
            <span className={`case-badge badge-${runStatusKey(r.status)}`}>{runStatusText(r.status)}</span>
            <div className="hrow-main">
              <div className="hrow-label">{r.prompt || "(no prompt)"}</div>
              <div className="hrow-meta">{r.startedAt ? new Date(r.startedAt).toLocaleString() : ""}</div>
            </div>
            <div className="hrow-actions">{r.artifactsAvailable === false ? null : <a className="dl-btn-inline" href={`#/run/${encodeURIComponent(r.runId)}`}>View</a>}</div>
          </div>
        ))}
        {query && runs.length > 0 && !runsView.length && empty("No recent run here matches.")}
      </div>
    </Wrap>
  );
}

/** theme.css styles the Projects screen's data-dash layout under #view-projects; reuse it as is. */
function Wrap({ children }: { children: ReactNode }) {
  return <section id="view-projects" className="rx-lib-view"><div className="wide">{children}</div></section>;
}

function fetchSuiteCases(id: string): Promise<CaseRow[]> {
  return api<{ cases?: CaseRow[] }>(`/api/suites/${encodeURIComponent(id)}/cases`)
    .then((d) => (Array.isArray(d?.cases) ? d.cases : [])).catch(() => []);
}

/**
 * D-84 "Who can see this project" (app.js renderProjectMembers): testers and viewers in the
 * project, Remove for each, and an "+ Add person…" picker of the organisation's testers/viewers
 * not yet in it. Owners see every project, so they are left out of both lists.
 */
interface Member { userId: string; email?: string | null; role?: string }
function MembersCard({ project, me }: { project: LibProject; me: Me }) {
  const [ver, setVer] = useState(0);
  const [err, setErr] = useState("");
  const pid = encodeURIComponent(project.id);
  const { data } = useLoad(`members:${project.id}:${me.organisationId}:${ver}`, async () => {
    if (!me.organisationId) return null;
    const [m, o] = await Promise.all([
      api<{ members?: Member[] }>(`/api/projects/${pid}/members`).catch(() => null),
      api<{ members?: Member[] }>(`/api/organisations/${encodeURIComponent(me.organisationId)}/members`).catch(() => null),
    ]);
    return { inProject: Array.isArray(m?.members) ? m!.members! : [], people: Array.isArray(o?.members) ? o!.members! : [] };
  });
  // Classic draws nothing inside the card without an organisation (its loading text just stays).
  if (!me.organisationId) return null;

  const change = async (fn: () => Promise<unknown>) => {
    setErr("");
    try { await fn(); } catch (e) { setErr(errText(e) || "That didn't work."); }
    setVer((v) => v + 1);
  };

  let content: ReactNode = <div className="tree-empty" style={{ padding: "12px 4px" }}><Loading /></div>;
  if (data) {
    const { inProject, people } = data;
    const inIds = new Set(inProject.map((m) => m.userId));
    const roleOf = new Map(people.map((m) => [m.userId, m.role]));
    const addable = people.filter((m) => !inIds.has(m.userId) && (m.role === "tester" || m.role === "viewer"));
    const listed = inProject.filter((m) => roleOf.get(m.userId) !== "owner");
    content = (
      <>
        {listed.length ? listed.map((m) => (
          <div className="hrow" key={m.userId}>
            <div className="hrow-main"><div className="hrow-label">{m.email || "(unknown address)"}</div>
              <div className="hrow-meta">{roleOf.get(m.userId) || ""}</div></div>
            <div className="hrow-actions">
              <button type="button" className="dl-btn-inline hrow-del"
                onClick={() => change(() => api(`/api/projects/${pid}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" }))}>Remove</button>
            </div>
          </div>
        )) : <div className="hrow-meta" style={{ padding: "6px 0" }}>No testers or viewers yet. Owners see every project.</div>}
        {addable.length > 0 && (
          <select className="team-select" aria-label="Give this project to someone" style={{ marginTop: 8 }} value=""
            onChange={(e) => {
              const userId = e.target.value;
              if (userId) void change(() => api(`/api/projects/${pid}/members`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ userId }) }));
            }}>
            <option value="">+ Add person…</option>
            {addable.map((m) => <option key={m.userId} value={m.userId}>{`${m.email || "(unknown)"} · ${m.role}`}</option>)}
          </select>
        )}
        {err && <p className="team-error">{err}</p>}
      </>
    );
  }
  return (
    <div data-dash="card">
      <div data-dash="card-head"><h2>Who can see this project</h2></div>
      <div>{content}</div>
    </div>
  );
}

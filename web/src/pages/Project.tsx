import { api, formatWhen, type CaseRow, type Project, type Suite } from "../api";
import { Badge, Empty, ErrorNote, Loading, useLoad } from "../ui";

/** One project: its suites, and its saved cases that are in no suite yet. */
export function ProjectPage({ projectId }: { projectId: string }) {
  const q = encodeURIComponent(projectId);
  const { data, error, loading } = useLoad(`project:${projectId}`, async () => {
    const [projects, suites, unfiled] = await Promise.all([
      api<{ projects: Project[] }>("/api/projects"),
      api<{ suites: Suite[] }>(`/api/suites?projectId=${q}`),
      api<{ cases: CaseRow[] }>(`/api/cases?projectId=${q}&unfiled=1`).catch(() => ({ cases: [] as CaseRow[] })),
    ]);
    return { project: projects.projects.find((p) => p.id === projectId), suites: suites.suites, unfiled: unfiled.cases };
  });

  if (loading) return <div className="wide"><Loading /></div>;
  if (error) return <div className="wide"><ErrorNote error={error} /></div>;
  const { project, suites = [], unfiled = [] } = data ?? {};
  return (
    <div className="wide">
      <a className="dl-btn-inline" href="#/projects">← All projects</a>
      <div className="eyebrow" style={{ marginTop: 12 }}>PROJECT</div>
      <h1 className="page-head-title">{project?.name ?? "Project"}</h1>
      {project && <p className="tagline">{project.caseCount} saved cases · {suites.length} suites · {project.runCount} runs<br /><code>{project.baseUrl}</code></p>}

      <div className="rx-cols">
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Suites</span></div>
          {!suites.length && <Empty>No suites yet.</Empty>}
          {suites.map((s) => (
            <div className="hrow" key={s.id}>
              <div className="hrow-main">
                <div className="hrow-label">{s.name}</div>
                <div className="hrow-meta">{s.caseCount} case{s.caseCount === 1 ? "" : "s"}</div>
              </div>
              <div className="hrow-actions"><a className="dl-btn-inline" href={`#/suite/${encodeURIComponent(s.id)}`}>Open</a></div>
            </div>
          ))}
        </div>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Not in a suite</span></div>
          {!unfiled.length && <Empty>Every saved case is in a suite.</Empty>}
          {unfiled.map((c) => (
            <div className="hrow" key={c.id}>
              <Badge status={c.lastRunStatus} />
              <div className="hrow-main">
                <div className="hrow-label">{c.title}</div>
                <div className="hrow-meta">{c.feature ?? ""} · v{c.currentVersion}{c.lastRunAt ? ` · last run ${formatWhen(c.lastRunAt)}` : ""}</div>
              </div>
              <div className="hrow-actions"><a className="dl-btn-inline" href={`#/projects/${q}/cases/${encodeURIComponent(c.id)}`}>Open</a></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

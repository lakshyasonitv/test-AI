import { api, type Project } from "../api";
import { Empty, ErrorNote, Loading, useLoad } from "../ui";

/** All projects (GET /api/projects), as cards linking to each project. */
export function ProjectsPage() {
  const { data, error, loading } = useLoad("projects", () => api<{ projects: Project[] }>("/api/projects"));
  return (
    <div className="wide">
      <div className="eyebrow">PROJECTS</div>
      <h1 className="page-head-title">Projects</h1>
      <p className="tagline">Every site you test, with its saved suites and cases.</p>
      {loading && <Loading />}
      {!!error && <ErrorNote error={error} />}
      {data && !data.projects.length && <Empty>No projects yet. Start a test from the classic UI's New test page.</Empty>}
      {data && (
        <div className="rx-grid">
          {data.projects.map((p) => (
            <a key={p.id} className="panel rx-card" href={`#/projects/${encodeURIComponent(p.id)}`}>
              <div className="hrow-label">{p.name}</div>
              <div className="hrow-meta">{p.baseUrl}</div>
              <div className="hrow-meta">{p.caseCount} cases · {p.runCount} runs</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

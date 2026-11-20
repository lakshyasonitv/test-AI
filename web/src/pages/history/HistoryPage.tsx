import { api, classic, formatWhen, type RunSummary } from "../../lib/api";
import { Badge, Empty, ErrorNote, Loading, useLoad } from "../../components/ui";

/** The 20 most recent runs (GET /api/runs). Opening a run goes to the classic Run page for now. */
export function HistoryPage() {
  const { data, error, loading } = useLoad("history", () => api<RunSummary[]>("/api/runs"));
  return (
    <div className="wide">
      <div className="eyebrow">RESULTS HISTORY</div>
      <h1 className="page-head-title">Your 20 most recent runs</h1>
      {loading && <Loading />}
      {!!error && <ErrorNote error={error} />}
      {data && !data.length && <Empty>No runs yet.</Empty>}
      {data && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          {data.map((r) => (
            <div className="hrow" key={r.runId}>
              <Badge status={r.status} />
              <div className="hrow-main">
                <div className="hrow-label">{(r.prompt ?? "").split("\n")[0].slice(0, 120) || r.runId}</div>
                <div className="hrow-meta">
                  {r.suite ? `${r.suite.passed}/${r.suite.total} passed · ` : ""}{formatWhen(r.startedAt)}{r.url ? ` · ${r.url}` : ""}
                </div>
              </div>
              <div className="hrow-actions"><a className="dl-btn-inline" href={classic(`#/run/${r.runId}`)}>View</a></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

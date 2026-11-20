import { formatWhen, type CaseDetail, type CaseRun } from "../../../lib/api";
import { Empty } from "../../../components/ui";
import { RunRow } from "./RunRow";

export function RunsTab({ detail, runs, caseId, currentVersion }: { detail: CaseDetail; runs: CaseRun[]; caseId: string; currentVersion: number }) {
  // The case version a run executed: the newest version saved at or before the run started.
  const versionAt = (ranAt: string | null): number | null => {
    const t = ranAt ? Date.parse(ranAt) : NaN;
    if (!Number.isFinite(t)) return null;
    let best: number | null = null;
    for (const v of detail.versions) {
      const s = v.savedAt ? Date.parse(v.savedAt) : NaN;
      if (Number.isFinite(s) && s <= t && (best == null || v.version > best)) best = v.version;
    }
    return best;
  };
  return (
    <div className="cd-cols">
      <div className="cd-left" style={{ flex: "1 1 320px" }}>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Previous runs</span></div>
          {!runs.length && <Empty>No runs recorded for this case yet. Run history is indexed from the first replay after the
            case library shipped, so older runs will not appear here.</Empty>}
          {runs.map((r) => <RunRow key={`${r.runId}:${r.caseIndex}`} run={r} version={versionAt(r.ranAt)} />)}
        </div>
      </div>
      <div className="cd-right" style={{ flex: "1 1 300px" }}>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Versions</span></div>
          {!detail.versions.length && <Empty>No version history yet.</Empty>}
          {detail.versions.map((v) => (
            <div className="hrow" key={v.version}>
              <span className="case-badge badge-pending">v{v.version}</span>
              <div className="hrow-main">
                <div className="hrow-label">{v.changeNote || "No note"}</div>
                <div className="hrow-meta">{formatWhen(v.savedAt)}</div>
              </div>
              <div className="hrow-actions">
                {v.version === currentVersion
                  ? <span className="hrow-meta">current</span>
                  : <a className="dl-btn-inline" href={`#/compare/${encodeURIComponent(caseId)}?from=${v.version}&to=${currentVersion}`}>Compare with current</a>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

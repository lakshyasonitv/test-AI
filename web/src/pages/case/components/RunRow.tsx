import { useEffect, useState } from "react";
import { finalShotForRun, formatWhen, type CaseRun } from "../../../lib/api";
import { Badge, Shot } from "../../../components/ui";

export function RunRow({ run, version }: { run: CaseRun; version: number | null }) {
  const [shot, setShot] = useState("");
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let alive = true;
    // The report is built from the run's files, so it is offered only while they still exist.
    fetch(`/runs/${encodeURIComponent(run.runId)}/${run.resultPath}/05-result.json`, { method: "HEAD" })
      .then((x) => alive && setExists(x.ok)).catch(() => {});
    finalShotForRun(run).then((s) => alive && setShot(s)).catch(() => {});
    return () => { alive = false; };
  }, [run]);
  const id = encodeURIComponent(run.runId);
  return (
    <div className="hrow">
      <Badge status={run.status} />
      <div className="hrow-main">
        <div className="hrow-label">{formatWhen(run.ranAt) || run.runId}{version ? ` · v${version}` : ""}</div>
        <div className="hrow-meta">{run.runId} · {run.resultPath}</div>
        {shot && <Shot src={shot} label={`${formatWhen(run.ranAt) || run.runId} · final screenshot`} maxWidth={240} />}
      </div>
      <div className="hrow-actions">
        <a className="dl-btn-inline" href={`#/run/${id}`}>Open run</a>
        {exists && <a className="dl-btn-inline" href={`/api/runs/${id}/report.pdf?view=1`} target="_blank" rel="noopener">Report (PDF)</a>}
        {exists && <a className="dl-btn-inline" href={`/api/runs/${id}/report.xlsx`} download={`test-report-${run.runId}${version ? `-v${version}` : ""}.xlsx`}>Report (Excel)</a>}
      </div>
    </div>
  );
}

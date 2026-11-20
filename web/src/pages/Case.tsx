import { useEffect, useState } from "react";
import { api, classic, finalShotForRun, formatWhen, type CaseDetail, type CaseRun, type CaseSteps } from "../api";
import { Badge, Empty, ErrorNote, Loading, Shot, useLoad } from "../ui";

/**
 * A saved case, read-only for now: its steps in plain English, the latest result with its photo,
 * and every run with its case version and PDF/Excel report. Editing steps, asking for a rewrite,
 * duplicating and deleting stay in the classic UI (link at the top).
 */
export function CasePage({ caseId }: { caseId: string }) {
  const q = encodeURIComponent(caseId);
  const { data, error, loading } = useLoad(`case:${caseId}`, async () => {
    const [detail, steps, runs] = await Promise.all([
      api<CaseDetail>(`/api/cases/${q}`),
      api<CaseSteps>(`/api/cases/${q}/steps`),
      api<{ runs: CaseRun[] }>(`/api/cases/${q}/runs`).catch(() => ({ runs: [] as CaseRun[] })),
    ]);
    return { detail, steps, runs: runs.runs };
  });
  const [tab, setTab] = useState<"steps" | "runs">("steps");

  if (loading) return <div className="wide"><Loading /></div>;
  if (error) return <div className="wide"><ErrorNote error={error} /></div>;
  const { detail, steps, runs } = data!;

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
    <div className="wide">
      <a className="dl-btn-inline" href={`#/projects/${encodeURIComponent(detail.projectId)}`}>← Project</a>
      <div className="meta" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Badge status={detail.lastRunStatus} />
        <span className="hrow-meta">v{detail.currentVersion} · {detail.versions.length} versions</span>
      </div>
      <h1 className="page-head-title">{detail.title}</h1>
      {detail.ir?.meta?.sourcePrompt && <p className="tagline">{detail.ir.meta.sourcePrompt}</p>}
      <div className="lib-toolbar">
        <a className="dl-btn-inline" href={classic(`#/projects/${detail.projectId}/cases/${caseId}`)}>Edit in classic UI</a>
        <span className="lib-toolbar-gap" />
        <button type="button" className={`dl-btn-inline${tab === "steps" ? " active" : ""}`} onClick={() => setTab("steps")}>Steps</button>
        <button type="button" className={`dl-btn-inline${tab === "runs" ? " active" : ""}`} onClick={() => setTab("runs")}>Runs &amp; versions</button>
      </div>

      {tab === "steps" ? (
        <div className="rx-cols">
          <div className="panel">
            <div className="cd-card-head">Steps</div>
            <ol className="rx-steps">
              {steps.steps.map((s) => <li key={s.id}>{s.text}</li>)}
            </ol>
            {steps.expected && <><div className="cd-card-head" style={{ marginTop: 12 }}>Expected outcome</div><p className="hrow-meta">{steps.expected}</p></>}
          </div>
          <LatestResult runs={runs} />
        </div>
      ) : (
        <div className="rx-cols">
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Previous runs</span></div>
            {!runs.length && <Empty>No runs recorded for this case yet.</Empty>}
            {runs.map((r) => <RunRow key={r.runId} run={r} version={versionAt(r.ranAt)} />)}
          </div>
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Versions</span></div>
            {detail.versions.map((v) => (
              <div className="hrow" key={v.version}>
                <span className="case-badge badge-pending">v{v.version}</span>
                <div className="hrow-main">
                  <div className="hrow-label">{v.changeNote || "No note"}</div>
                  <div className="hrow-meta">{formatWhen(v.savedAt)}</div>
                </div>
                <div className="hrow-actions">
                  {v.version === detail.currentVersion
                    ? <span className="hrow-meta">current</span>
                    : <a className="dl-btn-inline" href={classic(`#/compare/${caseId}?from=${v.version}&to=${detail.currentVersion}`)}>Compare with current</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The newest run whose screenshot still exists (up to 5 back), labelled when it is an older one. */
function LatestResult({ runs }: { runs: CaseRun[] }) {
  const [state, setState] = useState<{ shot: string; run: CaseRun | null; done: boolean }>({ shot: "", run: null, done: false });
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const r of runs.slice(0, 5)) {
        const shot = await finalShotForRun(r).catch(() => "");
        if (shot) { if (alive) setState({ shot, run: r, done: true }); return; }
      }
      if (alive) setState({ shot: "", run: null, done: true });
    })();
    return () => { alive = false; };
  }, [runs]);
  const last = runs[0];
  return (
    <div className="panel">
      <div className="cd-card-head">Latest result</div>
      {last ? (
        <div className="hrow-meta" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Badge status={last.status} /> {formatWhen(last.ranAt)} · {last.runId}
        </div>
      ) : <p className="hrow-meta">Never run</p>}
      {!state.done && last && <Loading text="Loading screenshot…" />}
      {state.done && state.shot && state.run && (
        <>
          <Shot src={state.shot} label="final screenshot" maxWidth={520} />
          {state.run !== last && <p className="hrow-meta" style={{ margin: "6px 0 0" }}>The latest run's screenshot was not kept; this one is from {formatWhen(state.run.ranAt)}.</p>}
        </>
      )}
      {state.done && !state.shot && last && (
        <div className="cd-shot"><span className="cd-shot-label">No screenshot kept for this run (it ran before screenshots were stored). Run the case again to get one.</span></div>
      )}
    </div>
  );
}

function RunRow({ run, version }: { run: CaseRun; version: number | null }) {
  const [shot, setShot] = useState("");
  useEffect(() => { finalShotForRun(run).then(setShot).catch(() => {}); }, [run]);
  const id = encodeURIComponent(run.runId);
  return (
    <div className="hrow">
      <Badge status={run.status} />
      <div className="hrow-main">
        <div className="hrow-label">{formatWhen(run.ranAt) || run.runId}{version ? ` · v${version}` : ""}</div>
        <div className="hrow-meta">{run.runId} · {run.resultPath}</div>
        {shot && <Shot src={shot} label={`${formatWhen(run.ranAt)} · final screenshot`} maxWidth={240} />}
      </div>
      <div className="hrow-actions">
        <a className="dl-btn-inline" href={classic(`#/run/${run.runId}`)}>Open run</a>
        {shot && <a className="dl-btn-inline" href={`/api/runs/${id}/report.pdf?view=1`} target="_blank" rel="noopener">Report (PDF)</a>}
        {shot && <a className="dl-btn-inline" href={`/api/runs/${id}/report.xlsx`} download={`test-report-${run.runId}${version ? `-v${version}` : ""}.xlsx`}>Report (Excel)</a>}
      </div>
    </div>
  );
}

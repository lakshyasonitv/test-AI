import { useEffect, useState } from "react";
import { finalShotForRun, formatWhen, type CaseRun } from "../../../lib/api";
import { Badge, Loading, Shot } from "../../../components/ui";

/** The newest run whose screenshot still exists (up to 5 back), labelled when it is an older one. */
export function LatestResult({ runs, status, lastRunAt, version }: { runs: CaseRun[]; status?: string | null; lastRunAt?: string | null; version: number }) {
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
  const label = state.run && state.run === last
    ? `case ${state.run.caseIndex} · final screenshot`
    : `from an earlier run, ${state.run?.ranAt ? formatWhen(state.run.ranAt) : state.run?.runId} · final screenshot`;
  return (
    <div className="cd-card">
      <div className="cd-card-head">Latest result</div>
      <div className="cd-meta">
        <Badge status={status} />
        <span className="hrow-meta">{last
          ? `${last.ranAt ? formatWhen(last.ranAt) : ""} · v${version} · ${last.runId}`
          : lastRunAt ? formatWhen(lastRunAt) : "Never run"}</span>
      </div>
      {!last && <div className="cd-shot"><span className="cd-shot-label">no screenshot yet</span></div>}
      {last && !state.done && <Loading text="Loading screenshot…" />}
      {last && state.done && state.shot && state.run && (
        <>
          <Shot src={state.shot} label={label} maxWidth={520} />
          {state.run !== last && <p className="hrow-meta" style={{ margin: "6px 0 0" }}>
            The latest run's screenshot was not kept; this one is from {state.run.ranAt ? formatWhen(state.run.ranAt) : state.run.runId}.</p>}
        </>
      )}
      {last && state.done && !state.shot && (
        <div className="cd-shot"><span className="cd-shot-label">No screenshot kept for this run (it ran before screenshots were stored). Run the case again to get one.</span></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ runs & versions

import { useEffect, useState } from "react";
import { api, classic, formatWhen, type CaseRow, type Suite, type SuiteOverview } from "../api";
import { Badge, Empty, ErrorNote, Loading, Shot, useLoad } from "../ui";

/**
 * A saved suite: its cases in order, each with its latest photo, Run all / Run one, and the
 * suite's previous runs with their PDF and Excel reports. Photos and previous runs come from ONE
 * call (/api/suites/:id/overview). Editing the suite (add, remove, reorder, rename, delete) is
 * still in the classic UI for now.
 */
export function SuitePage({ suiteId }: { suiteId: string }) {
  const q = encodeURIComponent(suiteId);
  const { data, error, loading } = useLoad(`suite:${suiteId}`, async () => {
    const [suites, cases] = await Promise.all([
      api<{ suites: Suite[] }>("/api/suites"),
      api<{ cases: CaseRow[] }>(`/api/suites/${q}/cases`),
    ]);
    const suite = suites.suites.find((s) => s.id === suiteId);
    if (!suite) throw new Error("That suite no longer exists, or you don't have access to it.");
    return { suite, cases: cases.cases };
  });
  const [overview, setOverview] = useState<SuiteOverview | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    setOverview(null);
    api<SuiteOverview>(`/api/suites/${q}/overview`).then(setOverview).catch(() => setOverview({ cases: [], runs: [] }));
  }, [q]);

  if (loading) return <div className="wide"><Loading /></div>;
  if (error) return <div className="wide"><ErrorNote error={error} /></div>;
  const { suite, cases } = data!;
  const lastRun = new Map((overview?.cases ?? []).map((c) => [c.caseId, c.lastRun]));

  const replay = async (body: object, label: string) => {
    try {
      const { runId } = await api<{ runId: string }>("/api/replay", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, label }),
      });
      setNote("Replaying — this costs nothing, the steps are already saved. Opening the run…");
      location.href = classic(`#/run/${runId}`);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="wide">
      <div className="eyebrow">TEST SUITE</div>
      <h1 className="page-head-title">{suite.name}</h1>
      <p className="tagline">{cases.length} case{cases.length === 1 ? "" : "s"} — they run in the order below. Re-running a saved suite makes no AI calls at all.</p>
      <div className="lib-toolbar">
        <a className="dl-btn-inline" href={classic(`#/suite/${q}`)}>Edit in classic UI</a>
        <span className="lib-toolbar-gap" />
        <button type="button" className="run-btn lib-run-all" disabled={!cases.length}
          onClick={() => replay({ suiteId }, `Replayed suite "${suite.name}"`)}>▸ Run all</button>
      </div>
      {note && <p className="team-ok">{note}</p>}

      <div className="panel">
        {!cases.length && <Empty>No cases in this suite yet.</Empty>}
        {cases.map((c, i) => {
          const run = lastRun.get(c.id);
          return (
            <div className="hrow lib-row" key={c.id}>
              <span className="lib-pos">{i + 1}</span>
              <Badge status={c.lastRunStatus} />
              <div className="hrow-main">
                <div className="hrow-label">{c.title}</div>
                <div className="hrow-meta">v{c.currentVersion}{c.feature ? ` · ${c.feature}` : ""}{c.lastRunAt ? ` · last run ${formatWhen(c.lastRunAt)}` : ""}</div>
                {run?.screenshotUrl && <Shot src={run.screenshotUrl} label={`${c.title} · ${formatWhen(run.ranAt)} · final screenshot`} maxWidth={200} />}
              </div>
              <div className="hrow-actions">
                <a className="dl-btn-inline" href={`#/projects/${encodeURIComponent(c.projectId)}/cases/${encodeURIComponent(c.id)}`}>Open</a>
                <button type="button" className="dl-btn-inline" onClick={() => replay({ caseIds: [c.id] }, `Replayed "${c.title}"`)}>▸ Run</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden", marginTop: 16 }}>
        <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Previous runs</span></div>
        {!overview && <Loading />}
        {overview && !overview.runs.length && <Empty>No runs of this suite yet. Use ▸ Run all, then its report appears here.</Empty>}
        {overview?.runs.map((r) => {
          const ok = r.passed === r.total;
          const id = encodeURIComponent(r.runId);
          return (
            <div className="hrow" key={r.runId}>
              <Badge status={ok ? "passed" : "failed"} />
              <div className="hrow-main">
                <div className="hrow-label">{formatWhen(r.ranAt) || r.runId}</div>
                <div className="hrow-meta">{r.passed}/{r.total} passed · {r.runId}</div>
              </div>
              <div className="hrow-actions">
                <a className="dl-btn-inline" href={classic(`#/run/${r.runId}`)}>Open run</a>
                <a className="dl-btn-inline" href={`/api/runs/${id}/report.pdf?view=1`} target="_blank" rel="noopener">Report (PDF)</a>
                <a className="dl-btn-inline" href={`/api/runs/${id}/report.xlsx`} download={`test-report-${r.runId}.xlsx`}>Report (Excel)</a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

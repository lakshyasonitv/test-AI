import { useEffect, useState } from "react";
import { api, finalShotForRun, formatWhen, type CaseRow, type CaseRun, type Suite, type SuiteOverview } from "../../lib/api";
import { Badge, Empty, ErrorNote, Loading, Shot, useLoad } from "../../components/ui";
import { caseHash, JSON_HEADERS } from "../../lib/library";
import { canAuthor as canAuthorFor, canDelete as canDeleteFor, useMe } from "../../lib/useMe";
import { AddCasesPanel } from "./components/AddCasesPanel";
import "../../styles/library.css";

/**
 * A saved suite — the classic UI's renderSuiteView, ported whole: its cases in order with their
 * latest photo; + Add cases (grouped by title), Remove, ↑/↓ (PATCH /order), Rename (PATCH),
 * Delete suite (DELETE); Run all / Run N selected / Run one (POST /api/replay); and the suite's
 * previous runs with their PDF and Excel reports. Same routes, bodies, confirm texts and role gates
 * (canAuthor = tester+, canDelete = admin+, both open when sign-in is off).
 */
type Shots = Map<string, { src: string; when: string }>;
type PrevRun = SuiteOverview["runs"][number];

export function SuitePage({ suiteId }: { suiteId: string }) {
  const q = encodeURIComponent(suiteId);
  const me = useMe();
  const [ver, setVer] = useState(0);
  const { data, error, loading } = useLoad(`suite:${suiteId}:${ver}`, async () => {
    const suites = (await api<{ suites?: Suite[] }>("/api/suites")).suites ?? [];
    const suite = suites.find((s) => s.id === suiteId);
    if (!suite) throw new Error("That suite no longer exists, or you don't have access to it.");
    const cases = (await api<{ cases?: CaseRow[] }>(`/api/suites/${q}/cases`)).cases ?? [];
    return { suite, cases };
  });
  const [shots, setShots] = useState<Shots>(new Map());
  const [prevRuns, setPrevRuns] = useState<PrevRun[] | null>(null);
  const [feedback, setFeedback] = useState<{ msg: string; error: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = () => { setSelected(new Set()); setAdding(false); setVer((v) => v + 1); };

  // Photos and previous runs: one /overview call; if it fails, the classic per-case fallback.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    const { cases } = data;
    setShots(new Map());
    setPrevRuns(null);
    (async () => {
      if (!cases.length) { setPrevRuns([]); return; }
      let overview: SuiteOverview | null = null;
      try { overview = await api<SuiteOverview>(`/api/suites/${q}/overview`); } catch { /* fall back */ }
      if (!alive) return;
      if (overview && Array.isArray(overview.cases)) {
        const m: Shots = new Map();
        for (const x of overview.cases) {
          if (x.lastRun?.screenshotUrl) m.set(x.caseId, { src: x.lastRun.screenshotUrl, when: x.lastRun.ranAt ? formatWhen(x.lastRun.ranAt) : x.lastRun.runId });
        }
        setShots(m);
        setPrevRuns(overview.runs ?? []);
        return;
      }
      cases.forEach(async (c) => {
        try {
          const last = ((await api<{ runs?: CaseRun[] }>(`/api/cases/${encodeURIComponent(c.id)}/runs?limit=1`)).runs ?? [])[0];
          if (!last) return;
          const src = await finalShotForRun(last);
          if (src && alive) setShots((prev) => new Map(prev).set(c.id, { src, when: last.ranAt ? formatWhen(last.ranAt) : last.runId }));
        } catch { /* no image */ }
      });
      const rows = await suiteRunsFallback(suiteId, cases);
      if (alive) setPrevRuns(rows);
    })();
    return () => { alive = false; };
  }, [data, q, suiteId]);

  if (loading) return <div className="wide"><Loading /></div>;
  if (error) return <div className="wide"><ErrorNote error={error} /></div>;
  const { suite, cases } = data!;
  // The `!required ||` half is not decoration — see app.js renderSuiteView (CLAUDE.md rule 7).
  const canAuthor = canAuthorFor(me);
  const canDelete = canDeleteFor(me);

  const say = (msg: string, isError = false) => setFeedback({ msg, error: isError });

  const startReplay = async (selection: object, label: string) => {
    try {
      const { runId } = await api<{ runId: string }>("/api/replay", {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...selection, label }),
      });
      say("Replaying — this costs nothing, the steps are already saved.");
      location.hash = "#/run/" + runId;
    } catch (e) { say(e instanceof Error ? e.message : String(e), true); }
  };

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { say(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  };

  const rename = () => act(async () => {
    const name = prompt("Rename this suite", suite.name);
    if (!name || name === suite.name) return;
    await api(`/api/suites/${q}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
    reload();
  });
  const deleteSuite = () => act(async () => {
    if (!confirm(`Delete the suite "${suite.name}"? The cases themselves are kept.`)) return;
    await api(`/api/suites/${q}`, { method: "DELETE" });
    // Classic lands on "#/" (its New test page); in this app that page is not built, so land on
    // the suite's project, where the deletion is visible.
    location.hash = `#/projects/${encodeURIComponent(suite.projectId)}`;
  });
  const remove = (caseId: string) => act(async () => {
    await api(`/api/suites/${q}/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
    reload();
  });
  const move = (caseId: string, dir: -1 | 1) => act(async () => {
    const ids = cases.map((c) => c.id);
    const i = ids.indexOf(caseId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api(`/api/suites/${q}/order`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ caseIds: ids }) });
    reload();
  });

  // Selection in suite order, as the classic UI reads it off the rows.
  const selectedIds = cases.filter((c) => selected.has(c.id)).map((c) => c.id);
  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  return (
    <div className="wide">
      <div>
        <div className="eyebrow">TEST SUITE</div>
        <h1 className="page-head-title">{suite.name}</h1>
        <p className="tagline">{cases.length} case{cases.length === 1 ? "" : "s"} — they run in the order below. Re-running a saved suite makes no AI calls at all.</p>
      </div>
      <div className="lib-toolbar">
        {canAuthor && <button type="button" className="dl-btn-inline" onClick={() => setAdding(true)}>+ Add cases</button>}
        {canAuthor && <button type="button" className="dl-btn-inline" disabled={busy} onClick={rename}>Rename suite</button>}
        {canDelete && <button type="button" className="dl-btn-inline" disabled={busy} onClick={deleteSuite}>Delete suite</button>}
        <span className="lib-toolbar-gap" />
        {canAuthor && (
          <>
            <button type="button" className="dl-btn-inline" disabled={selectedIds.length === 0}
              onClick={() => startReplay({ suiteId, caseIds: selectedIds },
                `Replayed ${selectedIds.length} case${selectedIds.length === 1 ? "" : "s"} from "${suite.name}"`)}>
              ▸ Run {selectedIds.length} selected
            </button>
            <button type="button" className="run-btn lib-run-all" disabled={cases.length === 0}
              onClick={() => { if (cases.length) void startReplay({ suiteId }, `Replayed suite "${suite.name}"`); }}>▸ Run all</button>
          </>
        )}
      </div>
      <div>{feedback && <p className={feedback.error ? "team-error" : "team-ok"}>{feedback.msg}</p>}</div>
      {adding && <AddCasesPanel suite={suite} cases={cases} onClose={() => setAdding(false)}
        onAdded={(n) => { say(`Added ${n} case${n === 1 ? "" : "s"}.`); reload(); }} />}

      <div className="panel">
        {!cases.length && (
          <Empty>
            {canAuthor
              ? <>No cases in this suite yet. Use <b>+ Add cases</b> above to file saved ones here, or <b>Save case</b> on a finished run's result to make a new one.</>
              : "No cases in this suite yet."}
          </Empty>
        )}
        {cases.map((c, i) => {
          const shot = shots.get(c.id);
          return (
            <div className="hrow lib-row" key={c.id}>
              {canAuthor && <input type="checkbox" className="lib-check" aria-label={`Select ${c.title}`}
                checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />}
              <span className="lib-pos">{i + 1}</span>
              <Badge status={c.lastRunStatus} />
              <div className="hrow-main">
                <div className="hrow-label">{c.title}</div>
                <div className="hrow-meta">v{c.currentVersion}{c.feature ? ` · ${c.feature}` : ""}{c.lastRunAt ? ` · last run ${formatWhen(c.lastRunAt)}` : ""}</div>
                {shot && <Shot src={shot.src} label={`${c.title} · ${shot.when} · final screenshot`} maxWidth={200} />}
              </div>
              <div className="hrow-actions">
                {canAuthor && <button type="button" className="dl-btn-inline" title="Move up" disabled={i === 0 || busy} onClick={() => move(c.id, -1)}>↑</button>}
                {canAuthor && <button type="button" className="dl-btn-inline" title="Move down" disabled={i === cases.length - 1 || busy} onClick={() => move(c.id, 1)}>↓</button>}
                <a className="dl-btn-inline" href={caseHash(suite.projectId || c.projectId, c.id)}>Open</a>
                {canAuthor && <button type="button" className="dl-btn-inline" onClick={() => startReplay({ caseIds: [c.id] }, `Replayed "${c.title}"`)}>▸ Run</button>}
                {canAuthor && <button type="button" className="dl-btn-inline" disabled={busy} onClick={() => remove(c.id)}>Remove</button>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel" style={{ padding: 0, overflow: "hidden", marginTop: 16 }}>
        <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Previous runs</span></div>
        {!prevRuns && <Loading />}
        {prevRuns && !prevRuns.length && <Empty>No runs of this suite yet. Use ▸ Run all, then its report appears here.</Empty>}
        {prevRuns?.map((r) => {
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
                <a className="dl-btn-inline" href={`#/run/${id}`}>Open run</a>
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

/**
 * app.js paintSuiteRuns: the previous-runs list when /overview is unavailable — each case's runs,
 * grouped by run, kept when the run's 00-input.json says it was this suite.
 */
async function suiteRunsFallback(suiteId: string, cases: CaseRow[]): Promise<PrevRun[]> {
  const byRun = new Map<string, { runId: string; ranAt: string | null; results: (string | null)[] }>();
  await Promise.all(cases.map(async (c) => {
    let runs: CaseRun[] = [];
    try { runs = (await api<{ runs?: CaseRun[] }>(`/api/cases/${encodeURIComponent(c.id)}/runs?limit=50`)).runs ?? []; } catch { /* skip */ }
    for (const r of runs) {
      const e = byRun.get(r.runId) ?? { runId: r.runId, ranAt: r.ranAt, results: [] };
      if (r.ranAt && (!e.ranAt || r.ranAt < e.ranAt)) e.ranAt = r.ranAt;
      e.results.push(r.status);
      byRun.set(r.runId, e);
    }
  }));
  const candidates = [...byRun.values()].sort((a, b) => String(b.ranAt).localeCompare(String(a.ranAt))).slice(0, 60);
  const judged = await Promise.all(candidates.map(async (e) => {
    const input = await fetch(`/runs/${encodeURIComponent(e.runId)}/00-input.json`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!input) return null;
    const total = Number(input.caseCount) || e.results.length;
    const mine = input.suiteId
      ? input.suiteId === suiteId
      : e.results.length === total && total === cases.length && total >= 2;
    return mine ? { runId: e.runId, ranAt: e.ranAt, total, passed: e.results.filter((s) => s === "passed").length } : null;
  }));
  return judged.filter((x): x is PrevRun => !!x).slice(0, 15);
}

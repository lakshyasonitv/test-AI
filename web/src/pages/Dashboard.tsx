import type { CSSProperties, ReactNode } from "react";
import { api, type Project, type RunSummary, type Suite } from "../api";
import { useLoad } from "../ui";

/**
 * The dashboard (classic: renderDashboardView in public/app.js, D-79). Read-only: the same three
 * GETs the classic page makes (/api/runs, /api/suites, /api/projects), each falling back to an
 * empty list on any error, exactly as the classic page does. Layout and charts are styled by the
 * classic theme.css through data-dash attributes, which are scoped to #view-dashboard, so the page
 * is wrapped in an element with that id (not the .view class, which style.css hides). The classic
 * dashboard has no role-based hiding, so neither does this one.
 */

// ---- run status vocabulary: the classic RUN_STATUS / statusKey / statusText ----
const RUN_STATUS: Record<string, { key: string; label: string }> = {
  passed: { key: "passed", label: "Passed" },
  failed: { key: "failed", label: "Failed" },
  blocked: { key: "blocked", label: "Blocked" },
  error: { key: "blocked", label: "Couldn't run" },
  truncated: { key: "unconfirmed", label: "Unconfirmed" },
  truncated_no_assertion: { key: "unconfirmed", label: "Unconfirmed" },
  incomplete: { key: "unconfirmed", label: "Unconfirmed" },
  no_cases_selected: { key: "blocked", label: "Nothing selected" },
  running: { key: "running", label: "Running" },
  pending: { key: "pending", label: "Queued" },
  draft: { key: "draft", label: "Not run yet" },
};
const statusKey = (s?: string): string => (RUN_STATUS[s ?? ""] ?? RUN_STATUS.pending).key;
const statusText = (s?: string): string => (RUN_STATUS[s ?? ""] ?? { label: s ?? "" }).label;

// ---- the few icons the dashboard uses, same paths as public/icons.js ----
const ICONS: Record<string, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  loader: <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />,
  "file-text": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
};
function Icon({ name, size = 16, cls = "" }: { name: string; size?: number; cls?: string }) {
  return (
    <svg className={`icon ${cls}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// Verdict colours stay the app's own (green passed, red failed); everything else is chrome.
const C_PASS = "var(--done-dot)", C_FAIL = "var(--failed-dot)", C_OTHER = "#c9ced8";
const cvar = (c: string): CSSProperties => ({ "--c": c } as CSSProperties);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type AnyRun = RunSummary & { artifactsAvailable?: boolean };

/** The classic asList: a bare array, or the array under `key`, else []. */
function asList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? (v as T[]) : [];
}

function Head() {
  return (
    <div data-dash="head">
      <div>
        <div className="eyebrow">DASHBOARD</div>
        <h1 className="page-head-title">Welcome back</h1>
        <p className="tagline">Your recent runs and saved suites at a glance.</p>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <section id="view-dashboard"><div className="wide">{children}</div></section>;
}

function EmptyCell({ text }: { text: string }) {
  return <div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>{text}</div>;
}

function Kpi({ ico, label, value, chip, chipClass }: { ico: string; label: string; value: number; chip: string; chipClass: string }) {
  return (
    <div data-dash="card">
      <div data-dash="card-head"><span data-dash="ico"><Icon name={ico} size={15} /></span><h2>{label}</h2></div>
      <div data-dash="big-row">
        <span data-dash="big">{String(value)}</span>
        {chip ? <span className={`case-badge ${chipClass}`}>{chip}</span> : null}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data, loading } = useLoad("dashboard", async () => {
    const [rawRuns, rawSuites, rawProjects] = await Promise.all([
      api<unknown>("/api/runs").catch(() => []),
      api<unknown>("/api/suites").catch(() => ({})),
      api<unknown>("/api/projects").catch(() => ({})),
    ]);
    return {
      runs: asList<AnyRun>(rawRuns, "runs"),
      suites: asList<Suite>(rawSuites, "suites"),
      projects: asList<Project>(rawProjects, "projects"),
    };
  });

  if (loading || !data) {
    return (
      <Shell>
        <Head />
        <div className="tree-empty" style={{ padding: "24px 4px" }}>
          <span className="ai-busy" role="status"><Icon name="loader" size={14} cls="ai-spin" /><span>Loading…</span></span>
        </div>
      </Shell>
    );
  }

  const { runs, suites, projects } = data;
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  // Counted over the runs /api/runs returns (the most recent ones), and said so on screen.
  const keyOf = (r: AnyRun) => statusKey(r.status);
  const passed = runs.filter((r) => keyOf(r) === "passed").length;
  const failed = runs.filter((r) => keyOf(r) === "failed").length;
  const other = runs.length - passed - failed;
  const finished = runs.filter((r) => !["running", "pending", "draft"].includes(keyOf(r))).length;
  const rate = finished ? Math.round((passed / finished) * 100) : null;
  const savedCases = projects.reduce((n, p) => n + (Number(p.caseCount) || 0), 0);

  // ---- runs by day: a stacked bar per calendar day, the 7 days up to the newest run ----
  const DAY = 86400000;
  const dayKey = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dated = runs.filter((r) => Number.isFinite(Number(r.startedAt)));
  const lastDay = dated.length ? Math.max(...dated.map((r) => dayKey(Number(r.startedAt)))) : dayKey(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => lastDay - (6 - i) * DAY).map((d) => {
    const inDay = dated.filter((r) => dayKey(Number(r.startedAt)) === d);
    return {
      d,
      p: inDay.filter((r) => keyOf(r) === "passed").length,
      f: inDay.filter((r) => keyOf(r) === "failed").length,
      o: inDay.filter((r) => !["passed", "failed"].includes(keyOf(r))).length,
    };
  });
  const maxDay = Math.max(1, ...days.map((x) => x.p + x.f + x.o));
  const W = 560, H = 190, base = 160, top = 14, slot = W / 7, bw = Math.min(42, slot * 0.5);
  const scale = (n: number) => (n / maxDay) * (base - top);
  const bars = days.map((x, i) => {
    const cx = slot * i + slot / 2, x0 = cx - bw / 2;
    let y = base;
    const seg = (n: number, color: string) => {
      if (!n) return null;
      const h = scale(n); y -= h;
      return <rect x={x0.toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)} height={Math.max(h - 2, 2).toFixed(1)} rx="5" fill={color} />;
    };
    const total = x.p + x.f + x.o;
    const label = new Date(x.d).toLocaleDateString(undefined, { weekday: "short" });
    const isLast = i === 6;
    const segs = <>{seg(x.p, C_PASS)}{seg(x.f, C_FAIL)}{seg(x.o, C_OTHER)}</>;
    return (
      <g key={x.d}>
        <rect x={x0.toFixed(1)} y={top} width={bw.toFixed(1)} height={base - top} rx="6" fill="var(--surface-2)" />
        {segs}
        {total ? <text x={cx.toFixed(1)} y={(y - 6).toFixed(1)} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">{total}</text> : null}
        <text x={cx.toFixed(1)} y={base + 20} textAnchor="middle" fontSize="11" fill={isLast ? "var(--text)" : "var(--muted)"} fontWeight={isLast ? 700 : 400}>{label}</text>
      </g>
    );
  });
  // The card's own totals cover ONLY the 7 days drawn, so the number always matches the bars.
  const win = days.reduce((a, x) => ({ p: a.p + x.p, f: a.f + x.f, o: a.o + x.o }), { p: 0, f: 0, o: 0 });
  const inWindow = win.p + win.f + win.o;

  // ---- results split: a donut of passed / failed / other ----
  const R = 54, CIRC = 2 * Math.PI * R;
  let offset = 0;
  const arc = (n: number, color: string) => {
    if (!n || !runs.length) return null;
    const len = (n / runs.length) * CIRC;
    const el = <circle cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="16"
      strokeDasharray={`${len.toFixed(2)} ${(CIRC - len).toFixed(2)}`} strokeDashoffset={(-offset).toFixed(2)} transform="rotate(-90 70 70)" />;
    offset += len;
    return el;
  };
  const arcs = <>{arc(passed, C_PASS)}{arc(failed, C_FAIL)}{arc(other, C_OTHER)}</>;

  // ---- tables ----
  const runRow = (r: AnyRun, i: number) => {
    const st = keyOf(r);
    // Short form ("10 Nov, 12:39") so the test name keeps the room; History shows the full one.
    const when = r.startedAt
      ? new Date(r.startedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "";
    const gone = r.artifactsAvailable === false;
    const total = r.suite ? Number(r.suite.total) || 0 : 0;
    const ok = r.suite ? Number(r.suite.passed) || 0 : 0;
    return (
      <tr key={r.runId ?? i}>
        <td><span className={`case-badge badge-${st}`}>{statusText(r.status)}</span></td>
        <td data-dash="grow"><span data-dash="clip" title={r.prompt || ""}>{r.prompt || "(no prompt)"}</span></td>
        <td data-dash="hide-sm">
          {total
            ? <span data-dash="bar"><span><i style={{ "--w": `${Math.round((ok / total) * 100)}%` } as CSSProperties} /></span><span data-dash="muted">{ok}/{total}</span></span>
            : <span data-dash="muted">—</span>}
        </td>
        <td data-dash="hide-sm"><span data-dash="muted">{when}</span></td>
        <td style={{ textAlign: "right" }}>{gone ? null : <a className="dl-btn-inline" href={`#/run/${encodeURIComponent(r.runId)}`}>View</a>}</td>
      </tr>
    );
  };
  const suiteRow = (s: Suite) => (
    <tr key={s.id}>
      <td data-dash="grow">
        <span data-dash="clip">{s.name || "(unnamed suite)"}</span>
        <span data-dash="muted">{projectName.get(s.projectId) || ""}</span>
      </td>
      <td><span data-dash="muted">{plural(Number(s.caseCount) || 0, "case")}</span></td>
      <td style={{ textAlign: "right" }}><a className="dl-btn-inline" href={`#/suite/${encodeURIComponent(s.id)}`}>Open</a></td>
    </tr>
  );
  const topSuites = [...suites].sort((a, b) => (Number(b.caseCount) || 0) - (Number(a.caseCount) || 0)).slice(0, 8);

  return (
    <Shell>
      <Head />
      <div className="hrow-meta" style={{ margin: "-6px 0 -4px" }}>
        {runs.length
          ? `Run counts below are from your ${runs.length} most recent runs, the same list as History. Saved cases are all of them.`
          : "No runs yet. Saved cases are all of them."}
      </div>
      <div data-dash="kpis">
        <Kpi ico="clock" label="Recent runs" value={runs.length} chip={runs.length ? `last ${runs.length}` : "none yet"} chipClass="badge-pending" />
        <Kpi ico="check" label="Passed" value={passed} chip={rate === null ? "" : `${rate}% pass rate`} chipClass="badge-passed" />
        <Kpi ico="x" label="Failed" value={failed} chip={runs.length ? `of ${runs.length}` : ""} chipClass="badge-failed" />
        <Kpi ico="file-text" label="Saved cases" value={savedCases} chip={`in ${plural(projects.length, "project")}`} chipClass="badge-pending" />
      </div>

      <div data-dash="row" data-wide="">
        <div data-dash="card">
          <div data-dash="card-head"><span data-dash="ico"><Icon name="list" size={15} /></span><h2>Runs by day</h2>
            <span className="case-badge badge-pending">{dated.length ? "7 days up to the latest run" : "no runs yet"}</span></div>
          <div data-dash="big-row"><span data-dash="big">{inWindow}</span><span data-dash="muted">{`${win.p} passed · ${win.f} failed${win.o ? ` · ${win.o} other` : ""}`}</span></div>
          <div data-dash="sub" style={{ margin: "0 0 4px" }}>{`${inWindow} of your ${runs.length} most recent runs fall in these 7 days.`}</div>
          <svg data-dash="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Runs per day over 7 days: ${days.map((x) => x.p + x.f + x.o).join(", ")}`}>{bars}</svg>
          <div data-dash="legend" style={{ margin: "6px 0 0" }}>
            <div style={cvar(C_PASS)}><small>Passed</small></div><div style={cvar(C_FAIL)}><small>Failed</small></div><div style={cvar(C_OTHER)}><small>Other</small></div>
          </div>
        </div>

        <div data-dash="card">
          <div data-dash="card-head"><span data-dash="ico"><Icon name="check" size={15} /></span><h2>Results split</h2></div>
          <div data-dash="legend">
            <div style={cvar(C_PASS)}><small>Passed</small><b>{passed}</b></div>
            <div style={cvar(C_FAIL)}><small>Failed</small><b>{failed}</b></div>
            <div style={cvar(C_OTHER)}><small>Other</small><b>{other}</b></div>
          </div>
          <svg data-dash="chart" viewBox="0 0 140 140" style={{ maxWidth: 190, margin: "0 auto" }} role="img" aria-label={`${passed} passed, ${failed} failed, ${other} other`}>
            <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="16" />
            {arcs}
            <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--text)">{rate === null ? "—" : `${rate}%`}</text>
            <text x="70" y="86" textAnchor="middle" fontSize="9" fill="var(--muted)">pass rate</text>
          </svg>
        </div>
      </div>

      <div data-dash="row">
        <div data-dash="card">
          <div data-dash="card-head"><span data-dash="ico"><Icon name="clock" size={15} /></span><h2>Recent runs</h2>
            <a className="dl-btn-inline" href="#/history">See all</a></div>
          {runs.length ? (
            <div data-dash="scroll"><table data-dash="table">
              <thead><tr><th>Status</th><th>Test</th><th data-dash="hide-sm">Result</th><th data-dash="hide-sm">When</th><th></th></tr></thead>
              <tbody>{runs.slice(0, 6).map(runRow)}</tbody>
            </table></div>
          ) : <EmptyCell text="No runs yet. Start one with New test." />}
        </div>
        <div data-dash="card">
          <div data-dash="card-head"><span data-dash="ico"><Icon name="file-text" size={15} /></span><h2>Saved suites</h2>
            <span className="case-badge badge-pending">{plural(suites.length, "suite")}</span></div>
          {topSuites.length ? (
            <div data-dash="scroll"><table data-dash="table">
              <thead><tr><th>Suite · project</th><th>Cases</th><th></th></tr></thead>
              <tbody>{topSuites.map(suiteRow)}</tbody>
            </table></div>
          ) : <EmptyCell text="No saved suites yet. Save a case from a run to start one." />}
        </div>
      </div>
    </Shell>
  );
}

import { useLoad, Loading } from "../../components/ui";
import { acctJson } from "../../lib/session";

/**
 * Compare two versions of a saved case (#/compare/<caseId>?from=&to=) — app.js renderCompareView:
 * the same three requests, the same plain-English step lines, the same LCS diff and markup.
 */

interface Step {
  action?: string; value?: string; assertion?: string;
  target?: { name?: string; label?: string; text?: string; placeholder?: string; url?: string; css?: string };
}
interface Version { version: number; changeNote?: string; ir: { steps: Step[] } }
interface CaseHead { title: string; projectId?: string | null; currentVersion: number }

/** app.js stepText, without the leading "N. " (Compare strips it). */
function stepLine(step: Step): string {
  const t = step.target ?? {};
  const what = t.name || t.label || t.text || t.placeholder || t.url || t.css || "";
  const verb = ({
    navigate: "Go to", click: "Click", fill: "Fill", select: "Select",
    check: "Check", press: "Press", wait: "Wait for", assert: "Assert",
  } as Record<string, string>)[step.action ?? ""] ?? step.action;
  const value = step.value ? ` with "${step.value}"` : "";
  const assertion = step.assertion ? ` (${step.assertion.replace(/_/g, " ")})` : "";
  return `${verb}${what ? ` ${what}` : ""}${value}${assertion}`;
}

type Line = { t: string; k: "same" | "added" | "removed" };

/** Longest-common-subsequence diff over step lines, so an inserted step shifts nothing after it. */
function diffSteps(a: string[], b: string[]): { left: Line[]; right: Line[] } {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left: Line[] = [], right: Line[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { left.push({ t: a[i], k: "same" }); right.push({ t: b[j], k: "same" }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { left.push({ t: a[i], k: "removed" }); i++; }
    else { right.push({ t: b[j], k: "added" }); j++; }
  }
  while (i < n) left.push({ t: a[i++], k: "removed" });
  while (j < m) right.push({ t: b[j++], k: "added" });
  return { left, right };
}

const caseHash = (projectId: string | null | undefined, caseId: string): string =>
  projectId
    ? `#/projects/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}`
    : `#/case/${encodeURIComponent(caseId)}`;

export function CompareView({ caseId, from, to }: { caseId: string; from?: string | number | null; to?: string | number | null }) {
  const q = encodeURIComponent(caseId);
  const { data, error, loading } = useLoad(`compare:${caseId}:${from ?? ""}:${to ?? ""}`, async () => {
    const c = await acctJson<CaseHead>(`/api/cases/${q}`);
    const fromV = Number(from) || 1;
    const toV = Number(to) || c.currentVersion;
    const [A, B] = await Promise.all([
      acctJson<Version>(`/api/cases/${q}/versions/${fromV}`),
      acctJson<Version>(`/api/cases/${q}/versions/${toV}`),
    ]);
    return { c, A, B };
  });

  if (loading) return <div className="wide" id="compareViewBody"><Loading /></div>;
  if (error || !data) {
    return (
      <div className="wide" id="compareViewBody">
        <div className="tree-empty" style={{ padding: "36px 16px", textAlign: "center" }}>
          {error instanceof Error ? error.message : String(error ?? "")}
        </div>
      </div>
    );
  }

  const { c, A, B } = data;
  const { left, right } = diffSteps((A.ir.steps ?? []).map(stepLine), (B.ir.steps ?? []).map(stepLine));
  const added = right.filter((r) => r.k === "added").length;
  const removed = left.filter((r) => r.k === "removed").length;

  const col = (label: number, note: string | undefined, side: Line[]) => (
    <div className="cmp-col">
      <div className="cmp-col-head">
        <span className="case-badge badge-pending">v{label}</span>
        <span className="hrow-meta">{note || ""}</span>
      </div>
      <div className="cmp-steps">
        {side.map((s, i) => <div key={i} className={`cmp-step cmp-${s.k}`}>{s.t}</div>)}
      </div>
    </div>
  );

  return (
    <div className="wide" id="compareViewBody">
      <div>
        <div className="eyebrow">COMPARE VERSIONS</div>
        <h1 className="page-head-title">{c.title}</h1>
        <p className="tagline">
          {added} step{added === 1 ? "" : "s"} added, {removed} removed between v{A.version} and v{B.version}.
        </p>
      </div>
      <div className="lib-toolbar">
        <button type="button" className="dl-btn-inline" data-act="back"
          onClick={() => { location.hash = caseHash(c.projectId, caseId); }}>Back to case</button>
      </div>
      <div className="cmp-grid">
        {col(A.version, A.changeNote, left)}
        {col(B.version, B.changeNote, right)}
      </div>
    </div>
  );
}

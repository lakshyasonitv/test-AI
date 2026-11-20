import { useEffect, useState, type MouseEvent } from "react";
import { api, formatWhen, type CaseDetail, type CaseRun } from "../../../lib/api";
import { Loading } from "../../../components/ui";
import { OverridePanel } from "./OverridePanel";

interface ScriptDoc { spec?: string; source?: string; version?: number }

/**
 * The Script tab (app.js paintScriptTab). The script belongs to the CASE: GET /api/cases/:id/script
 * returns the stored spec for the current version or regenerates it with the pure generator
 * (TD-68). A run's own generated.spec.ts is only a secondary download link.
 *
 * The override panel is not in the classic UI. It is drawn only when GET
 * /api/script-override/warning answers (SCRIPT_OVERRIDE_ENABLED on), shows the server's own warning
 * text, and sends PUT /api/cases/:id/script-override exactly as the route documents it.
 */
export function ScriptTab({ detail, runs, canAuthor, currentVersion, onChanged }: {
  detail: CaseDetail; runs: CaseRun[]; canAuthor: boolean; currentVersion: number; onChanged: () => void;
}) {
  const caseId = detail.id;
  const q = encodeURIComponent(caseId);
  const [state, setState] = useState<{ loading: boolean; doc: ScriptDoc | null; error: string; runSpecUrl: string }>(
    { loading: true, doc: null, error: "", runSpecUrl: "" });
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let doc: ScriptDoc | null = null;
      let error = "";
      try { doc = await api<ScriptDoc>(`/api/cases/${q}/script`); } catch (err) { error = (err as Error).message; }
      let runSpecUrl = "";
      if (doc?.spec) {
        const candidates = runs.map((r) => `/runs/${encodeURIComponent(r.runId)}/${r.resultPath}/generated.spec.ts`);
        if (detail.sourceRunId && !runs.some((r) => r.runId === detail.sourceRunId)) {
          candidates.push(`/runs/${encodeURIComponent(detail.sourceRunId)}/generated.spec.ts`);
        }
        for (const url of candidates) {
          const ok = await fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
          if (ok) { runSpecUrl = url; break; }
        }
      }
      if (alive) setState({ loading: false, doc, error, runSpecUrl });
    })();
    api<{ warning: string }>("/api/script-override/warning")
      .then((w) => alive && setWarning(w.warning || ""))
      .catch(() => alive && setWarning(null));
    return () => { alive = false; };
  }, [q, runs, detail.sourceRunId, currentVersion, detail.scriptOverridden]);

  if (state.loading) return <div className="panel"><Loading /></div>;
  const { doc, error, runSpecUrl } = state;
  if (!doc || !doc.spec) {
    return (
      <div className="panel"><div className="tree-empty" style={{ padding: "34px 16px", textAlign: "center" }}>
        {error || "This case has no readable test plan, so no script could be produced."}
      </div></div>
    );
  }
  const spec = doc.spec;
  const last = runs[0];
  const provenance = doc.source === "stored" ? `Saved with v${doc.version}.` : `Generated from the steps of v${doc.version}.`;

  // A Blob, not an href to the route: the endpoint answers JSON.
  const download = (e: MouseEvent) => {
    e.preventDefault();
    const url = URL.createObjectURL(new Blob([spec], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${detail.title || "test"}.spec.ts`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <>
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div className="cd-script-head">
          <span className="cd-script-name">generated.spec.ts</span>
          <a className="dl-btn-inline" href="#" download={`${detail.title}.spec.ts`} onClick={download}>Download .spec.ts</a>
        </div>
        <pre className="cd-script-body">{spec}</pre>
        <div className="cd-script-foot">
          {provenance} Edit the steps and press Save to cut a new version.
          {runSpecUrl && <> {/* `download`, not a new tab: Express serves .ts as video/mp2t. */}
            <a className="dl-btn-inline" href={runSpecUrl} download={`${detail.title} (as run).spec.ts`}>
              download the spec from the last run{last && last.ranAt ? ` (${formatWhen(last.ranAt)})` : ""}
            </a></>}
        </div>
      </div>
      {warning !== null && canAuthor && (
        <OverridePanel caseId={caseId} spec={spec} warning={warning} overridden={!!detail.scriptOverridden}
          currentVersion={currentVersion} onChanged={onChanged} />
      )}
    </>
  );
}

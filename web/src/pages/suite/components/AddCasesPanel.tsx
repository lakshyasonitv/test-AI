import { useState } from "react";
import { api, formatWhen, type CaseRow, type Suite } from "../../../lib/api";
import { ErrorNote, Loading, useLoad } from "../../../components/ui";
import { JSON_HEADERS } from "../../../lib/library";
import { Chevron } from "./Chevron";

/**
 * Pick saved cases from this project and file them into this suite (app.js openAddPanel). Only
 * cases NOT already in it; identical titles collapse behind one toggle row; Add posts each id in
 * order, sequentially, so they land in the order picked.
 */
export function AddCasesPanel({ suite, cases, onClose, onAdded }: {
  suite: Suite; cases: CaseRow[]; onClose: () => void; onAdded: (n: number) => void;
}) {
  const { data: pool, error, loading } = useLoad(`suite-add:${suite.id}:${cases.length}`, async () => {
    const all = (await api<{ cases?: CaseRow[] }>(`/api/cases?projectId=${encodeURIComponent(suite.projectId)}`)).cases ?? [];
    const already = new Set(cases.map((c) => c.id));
    return all.filter((c) => !already.has(c.id));
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (loading) return <div className="case-save-panel"><Loading text="Loading cases…" /></div>;
  if (error) return <div className="case-save-panel"><ErrorNote error={error} /></div>;
  if (!pool!.length) {
    return (
      <div className="case-save-panel">
        <p className="hrow-meta">Every saved case in this project is already in this suite. Save another from a finished run to add more.</p>
        <button type="button" className="dl-btn-inline" onClick={onClose}>Close</button>
      </div>
    );
  }

  const byTitle = new Map<string, CaseRow[]>();
  for (const c of pool!) {
    if (!byTitle.has(c.title)) byTitle.set(c.title, []);
    byTitle.get(c.title)!.push(c);
  }
  const n = picked.size;
  const flip = (set: Set<string>, id: string, on: boolean) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; };

  const row = (c: CaseRow) => (
    <label className="suite-add-row" key={c.id}>
      <input type="checkbox" className="lib-check" value={c.id} checked={picked.has(c.id)}
        onChange={(e) => setPicked((p) => flip(p, c.id, e.target.checked))} />
      <span className="hrow-label">{c.title}</span>
      <span className="hrow-meta">v{c.currentVersion}{c.feature ? ` · ${c.feature}` : ""}{c.updatedAt ? ` · saved ${formatWhen(c.updatedAt)}` : ""}</span>
    </label>
  );

  const confirm = async () => {
    // Picked order = pool order, as the classic panel reads the checked boxes top to bottom.
    const ids = pool!.filter((c) => picked.has(c.id)).map((c) => c.id);
    setBusy(true); setErr("");
    try {
      for (const caseId of ids) {
        await api(`/api/suites/${encodeURIComponent(suite.id)}/cases`, {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ caseId }),
        });
      }
      onAdded(ids.length);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="case-save-panel">
      <div className="lib-steps-head">Add saved cases to “{suite.name}”</div>
      <div className="suite-add-list">
        {[...byTitle.entries()].map(([title, members]) => members.length === 1 ? row(members[0]) : (
          <div key={`grp:${title}`}>
            <div className="suite-add-row">
              <button type="button" className="dl-btn-inline" title={`${members.length} saved copies of this title`}
                aria-expanded={open.has(title)} onClick={() => setOpen((o) => flip(o, title, !o.has(title)))}>
                <Chevron down={open.has(title)} />
              </button>
              <span className="hrow-label">{title}</span>
              <span className="hrow-meta">{members.length} saved copies</span>
            </div>
            {open.has(title) && <div>{members.map(row)}</div>}
          </div>
        ))}
      </div>
      <div className="step-edit-actions">
        <button type="button" className="dl-btn-inline" onClick={onClose}>Cancel</button>
        <span className="lib-toolbar-gap" />
        <button type="button" className="run-btn lib-run-all" disabled={n === 0 || busy} onClick={confirm}>Add {n} case{n === 1 ? "" : "s"}</button>
      </div>
      {err && <p className="team-error">{err}</p>}
    </div>
  );
}

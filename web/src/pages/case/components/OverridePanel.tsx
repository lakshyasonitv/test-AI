import { useState } from "react";
import { postJson, toast } from "../lib";

export function OverridePanel({ caseId, spec, warning, overridden, currentVersion, onChanged }: {
  caseId: string; spec: string; warning: string; overridden: boolean; currentVersion: number; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [script, setScript] = useState(spec);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const url = `/api/cases/${encodeURIComponent(caseId)}/script-override`;

  const send = async (body: object, done: string) => {
    setBusy(true); setErr("");
    try {
      await postJson(url, { ...body, expectedVersion: currentVersion }, "PUT");
      toast(done);
      setOpen(false); setAck(false);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="cd-card rx-case-override">
      <div className="cd-card-head">Script override</div>
      {err && <p className="team-error">{err}</p>}
      {overridden ? (
        <>
          <p className="hrow-meta">A hand-written script replaces this case's generated one. Removing it makes the steps what runs again.</p>
          <button type="button" className="dl-btn-inline" disabled={busy}
            onClick={() => void send({ script: null, changeNote: "Removed script override" }, "Override removed.")}>Remove override</button>
        </>
      ) : !open ? (
        <button type="button" className="dl-btn-inline" onClick={() => { setScript(spec); setOpen(true); }}>Replace with a hand-written script…</button>
      ) : (
        <>
          <p className="team-error">{warning}</p>
          <textarea className="cd-ask-text rx-case-override-text" value={script} spellCheck={false}
            onChange={(e) => setScript(e.target.value)} aria-label="Override script" />
          <label className="hrow-meta rx-case-override-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand this script is not grounded.
          </label>
          <div className="cd-proposal-actions">
            <button type="button" className="dl-btn-inline" disabled={!ack || busy || !script.trim()}
              onClick={() => void send({ script, changeNote: "Script override", confirm: true }, "Override saved.")}>Save override</button>
            <button type="button" className="dl-btn-inline" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

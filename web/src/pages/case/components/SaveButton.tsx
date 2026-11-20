

import { Spin } from "./Spin";
import { Editor } from "../types";

/** The Save button's label states the cost on the control that spends it (app.js refreshCaseSaveAffordance). */
export function SaveButton({ ed, dirty, onSave }: { ed: Editor; dirty: boolean; onSave: () => void }) {
  if (ed.saving) {
    return <button type="button" className="dl-btn-inline cd-save ai-busy" disabled><Spin /> Saving…</button>;
  }
  const verb = ed.justSaved ? "Save again" : "Save";
  const est = ed.estimate;
  let label: string;
  if (!dirty) label = ed.justSaved ? "Saved ✓" : "Save";
  else if (ed.estimateError || !est || est.instant) label = verb;
  else label = `${verb} — re-checks ${est.stepsToVerify} ${est.stepsToVerify === 1 ? "step" : "steps"} (~${est.estimatedSeconds}s)`;
  return <button type="button" className="dl-btn-inline cd-save" disabled={!dirty || !!ed.job} onClick={onSave}>{label}</button>;
}

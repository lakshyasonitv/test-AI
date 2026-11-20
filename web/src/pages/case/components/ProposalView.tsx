import { diffSteps, type Proposal } from "../lib";

export function ProposalView({ p, onAnswer }: { p: Proposal; onAnswer: (apply: boolean) => void }) {
  const { left, right } = diffSteps(p.before ?? [], p.steps ?? []);
  const rows: { k: "del" | "add" | "same"; t: string }[] = [];
  left.forEach((l) => { if (l.k === "removed") rows.push({ k: "del", t: l.t }); });
  right.forEach((r) => rows.push({ k: r.k === "added" ? "add" : "same", t: r.t }));
  // A translation and a rewrite deserve different scrutiny, so the heading says which this is.
  const translated = Array.isArray(p.translatedIndexes);
  return (
    <div className="cd-proposal">
      <p className="cd-proposal-note">{translated
        ? `Re-worded line${p.translatedIndexes!.length === 1 ? "" : "s"} ${p.translatedIndexes!.map((i) => i + 1).join(", ")} — the rest is untouched.`
        : "Proposed change"}</p>
      {p.note && <p className="cd-proposal-note">{p.note}</p>}
      <div className="cd-diff">
        {rows.map((r, i) => <div key={i} className={`cd-diff-line cd-diff-${r.k}`}>{r.t}</div>)}
      </div>
      <div className="cd-proposal-actions">
        <button type="button" className="dl-btn-inline" onClick={() => onAnswer(true)}>Apply to editor</button>
        <button type="button" className="dl-btn-inline" onClick={() => onAnswer(false)}>Discard</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ latest result

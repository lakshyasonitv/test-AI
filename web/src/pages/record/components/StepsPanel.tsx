/**
 * The recorded steps, editable before saving. An edited line is sent as text and read back by the
 * server's real step parser onto what was recorded, so an untouched line keeps its observed target.
 */
export function StepsPanel({ steps, edits, removed, onEdit, onRemove }: {
  steps: { id: string; text: string }[];
  edits: Record<string, string>;
  removed: Set<string>;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const shown = steps.filter((s) => !removed.has(s.id));
  if (shown.length === 0) return <p className="tagline">Nothing recorded yet.</p>;
  return (
    <ol className="rx-rec-steps">
      {shown.map((s) => (
        <li key={s.id}>
          <input className="cd-line-input" value={edits[s.id] ?? s.text} spellCheck={false}
            onChange={(e) => onEdit(s.id, e.target.value)} aria-label={`Step ${s.id}`} />
          <button type="button" className="dl-btn-inline" title="Remove this step" onClick={() => onRemove(s.id)}>×</button>
        </li>
      ))}
    </ol>
  );
}

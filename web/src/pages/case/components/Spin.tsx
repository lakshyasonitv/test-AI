
/** The rotating loader the AI buttons use (`.ai-busy` lays it out, `.ai-spin` turns it). */
export function Spin({ size = 13 }: { size?: number }) {
  return (
    <svg className="ai-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
    </svg>
  );
}


export function Chevron({ down }: { down: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={down ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

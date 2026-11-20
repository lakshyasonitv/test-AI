import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

/** app.js toast(): the classic `.toast` element, shown for 3.2 s. */
export function useToast(): [(message: string) => void, ReactElement] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = useCallback((m: string) => {
    setMessage(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 3200);
  }, []);
  const el = (
    <div className={`toast${message ? "" : " hidden"}`} role="status" aria-live="polite">{message ?? ""}</div>
  );
  return [show, el];
}

/** The icons.js glyphs the Settings cards use (same paths, stroke style). */
const PATHS: Record<string, ReactElement> = {
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  key: <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
};
export function Icon({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}

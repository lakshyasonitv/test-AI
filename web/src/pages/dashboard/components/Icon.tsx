
import { ICONS } from "./iconPaths";

export function Icon({ name, size = 16, cls = "" }: { name: string; size?: number; cls?: string }) {
  return (
    <svg className={`icon ${cls}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

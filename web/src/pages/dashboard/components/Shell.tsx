import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return <section id="view-dashboard"><div className="wide">{children}</div></section>;
}

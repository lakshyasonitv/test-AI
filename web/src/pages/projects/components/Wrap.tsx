import { type ReactNode } from "react";

/** theme.css styles the Projects screen's data-dash layout under #view-projects; reuse it as is. */
export function Wrap({ children }: { children: ReactNode }) {
  return <section id="view-projects" className="rx-lib-view"><div className="wide">{children}</div></section>;
}

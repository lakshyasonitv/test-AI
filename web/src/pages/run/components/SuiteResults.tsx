import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { CaseCard } from "./CaseCard";
import { SuiteSummary } from "../types";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The suite results area of the Run page (public/app.js renderSuiteResults / renderCaseCard /
 * loadCaseDetails / openSaveCasePanel / the screenshot modal), plus the save panel the single-run
 * "Save to library" slot shares.
 */

// ------------------------------------------------------------------ screenshot modal

export function SuiteResults({ suite, runId, prompt, usageLine, canSave, onZoom }: {
  suite: SuiteSummary; runId: string; prompt: string; usageLine: ReactNode; canSave: boolean;
  onZoom: (src: string, label: string) => void;
}) {
  const [gridOpen, setGridOpen] = useState(false);
  const withShots = suite.cases.filter((c) => c.screenshotUrl);
  const firstOpenRef = useRef<HTMLDivElement>(null);
  const firstOpenIdx = suite.cases.findIndex((c) => c.status === "failed" || c.status === "blocked");

  // Scroll only the first auto-expanded (failed/blocked) card into view.
  useEffect(() => { firstOpenRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, []);

  return (
    <section className="suite-results">
      <div className="suite-summary-header">
        {prompt && <p className="case-narrative-line"><b>You asked:</b> {prompt}</p>}
        <div className="suite-summary-stats">
          <span className="suite-stat">{suite.total} checks</span>
          <span className="suite-stat suite-stat-passed"><Icon name="check" size={13} /> {suite.passed} passed</span>
          <span className="suite-stat suite-stat-failed"><Icon name="x" size={13} /> {suite.failed} failed</span>
          {!!suite.truncated && <span className="suite-stat suite-stat-truncated"><Icon name="alert-triangle" size={13} /> {suite.truncated} partial</span>}
          {!!suite.truncated_no_assertion && <span className="suite-stat suite-stat-partial"><Icon name="minus-circle" size={13} /> {suite.truncated_no_assertion} unconfirmed</span>}
          {!!suite.blocked && <span className="suite-stat suite-stat-blocked"><Icon name="slash-circle" size={13} /> {suite.blocked} blocked</span>}
        </div>
        {usageLine}
      </div>
      {withShots.length > 0 && (
        <button className="screenshot-toggle" type="button" onClick={() => setGridOpen((o) => !o)}>
          {gridOpen ? <><Icon name="chevron-down" size={14} /> Hide screenshots</> : <><Icon name="image" size={14} /> View all screenshots</>}
        </button>
      )}
      {withShots.length > 0 && gridOpen && (
        <div className="screenshot-grid">
          {withShots.map((c, i) => {
            const badge = c.status === "passed" ? "badge-passed" : c.status === "failed" ? "badge-failed" : "badge-pending";
            return (
              <div className="screenshot-tile" key={c.caseId ?? i}>
                <img src={c.screenshotUrl} alt={`Case ${i + 1}`} loading="lazy" />
                <span className={`screenshot-tile-label ${badge}`}>{c.title}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="suite-case-list">
        {suite.cases.map((c, i) => (
          <CaseCard key={c.caseId ?? i} c={c} index={i} runId={runId} suite={suite} canSave={canSave} onZoom={onZoom}
            cardRef={i === firstOpenIdx ? firstOpenRef : undefined} />
        ))}
      </div>
    </section>
  );
}

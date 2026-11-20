import { CATEGORY_REASON } from "../text";

export function DiagnosisBlock({ diagnosis }: { diagnosis: any }) {
  const whatWrong = diagnosis.explanation || "The test hit a problem it couldn't get past.";
  const why = CATEGORY_REASON[diagnosis.category] || CATEGORY_REASON.other;
  const bullets: string[] = diagnosis.suggestedFix
    ? [diagnosis.suggestedFix, "Run the whole test again — if this was a timing hiccup (a slow page, a flaky request), it may pass next time."]
    : ["Try re-running with a more specific prompt, or check if the site has changed since the last discovery."];
  return (
    <div className="case-diagnosis-block">
      <div className="diag-card">
        <div className="diag-card-header">
          <span className="diag-badge">What happened</span>
          <h4>{whatWrong}</h4>
        </div>
        <div className="diag-card-body">
          <div className="diag-item"><p className="diag-text"><b>Why it happened:</b> {why}</p></div>
          <div className="diag-item diag-fix-box">
            <span className="diag-label fix-label">💡 What you can do</span>
            <ul className="diag-fix-list">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
          <details className="diag-tech-details">
            <summary>Technical details (for developers)</summary>
            <code>Category: {diagnosis.category || "unknown"} · Failing step: {diagnosis.failingStepId || "unknown"}</code>
          </details>
        </div>
      </div>
    </div>
  );
}

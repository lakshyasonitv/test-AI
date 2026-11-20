
/** What a failed case says for itself with no model call (classic renderCaseErrorBlock, TD-80). */
export function CaseErrorBlock({ c, screenshotUrl }: { c: any; screenshotUrl: string }) {
  if (c.status !== "failed" && c.status !== "blocked") return null;
  if (!c.error && c.failedStep === undefined) return null;
  const where = c.failedStep !== undefined
    ? `Step ${c.failedStep}${c.failedStepTitle ? ` — ${c.failedStepTitle}` : ""}`
    : "The test stopped here";
  return (
    <div className="diag-card">
      <div className="diag-card-header">
        <span className="diag-badge">Where it stopped</span>
        <h4>{where}</h4>
      </div>
      <div className="diag-card-body">
        {c.error && <div className="diag-item"><p className="diag-text">{c.error}</p></div>}
        {screenshotUrl && <div className="diag-item"><p className="diag-text"><a href={screenshotUrl} target="_blank" rel="noopener noreferrer">Screenshot at the point it stopped</a></p></div>}
        {c.errorDetail && c.errorDetail !== c.error && (
          <details className="diag-tech-details">
            <summary>Full error (for developers)</summary>
            <code>{c.errorDetail}</code>
          </details>
        )}
      </div>
    </div>
  );
}

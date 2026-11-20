import { enterpriseDiagnostic, type RunModel } from "../model";

/** #diagnosis: the enterprise card on a finished run, else the failure_analysis line. */
export function Diagnosis({ m }: { m: RunModel }) {
  const t = m.terminal;
  const card = t ? enterpriseDiagnostic(t.data, t.stage, t.error) : null;
  if (card === "clear") return null;
  if (!card) return m.diagnosisText ? <div id="diagnosis">{m.diagnosisText}</div> : null;
  return (
    <div id="diagnosis">
      <div className="diag-card">
        <div className="diag-card-header">
          <span className="diag-badge">What happened</span>
          <h4>{card.headline}</h4>
        </div>
        <div className="diag-card-body">
          <div className="diag-item"><p className="diag-text">{card.description}</p></div>
          {card.fixPrompt && (
            <div className="diag-item diag-fix-box">
              <span className="diag-label fix-label">💡 Try this next time</span>
              <pre className="diag-fix-code">{card.fixPrompt}</pre>
            </div>
          )}
          {card.techDetails && (
            <details className="diag-tech-details">
              <summary>Technical details (for developers)</summary>
              <code>{card.techDetails}</code>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

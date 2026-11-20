import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PRO_STORY_OFFER, ProState } from "../hooks/usePro";

/** The Pro block, OUTSIDE the run form so nothing in it can submit a run by pressing Enter. */
export function ProBlock({ pro }: { pro: ProState }) {
  const input = useRef<HTMLInputElement>(null);
  const [focusLast, setFocusLast] = useState(false);
  const rulesHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusLast) return;
    setFocusLast(false);
    rulesHost.current?.querySelector<HTMLTextAreaElement>(`[data-pro-rule="${pro.draftRules.length - 1}"]`)?.focus();
  }, [focusLast, pro.draftRules.length]);

  const fileLine = pro.busy ? "Reading the document…"
    : pro.fileName ? `Using “${pro.fileName}”. Upload another to replace it.` : "PDF, Word (.docx) or Markdown — one document.";
  const noEnter = (e: KeyboardEvent) => { if (e.key === "Enter") e.preventDefault(); };

  return (
    <div>
      <div className="panel" style={{ padding: "var(--sp-4)", marginTop: "var(--sp-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <button type="button" className="composer-save-btn" disabled={pro.busy}
            onClick={() => { if (!pro.busy) input.current?.click(); }}>Upload requirements</button>
          <span className="field-label">{fileLine}</span>
          <input ref={input} type="file" accept=".pdf,.docx,.md,.markdown,.txt" style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files && e.target.files[0];
              e.target.value = ""; // choosing the same file again must fire `change` again
              if (file) void pro.upload(file);
            }} />
        </div>
        <div>
          {pro.notice && <p className="team-error" role="alert" style={{ marginTop: "var(--sp-3)" }}>{pro.notice}</p>}
          {pro.storyNote && <p className="field-label" style={{ marginTop: "var(--sp-2)" }}>{pro.storyNote}</p>}
          {pro.storyNote && pro.storyPrompt && pro.storyNote === PRO_STORY_OFFER && (
            <button type="button" className="composer-save-btn" onClick={() => pro.fillPrompt(pro.storyPrompt)}>
              Use the requirements as the prompt
            </button>
          )}
        </div>
      </div>

      {pro.spec && pro.confirmed && (
        <div className="panel" style={{ padding: "var(--sp-3) var(--sp-4)", marginTop: "var(--sp-3)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <span className="field-label" style={{ flex: 1 }}>
            {(() => {
              const n = pro.confirmed.rules.length, a = (pro.confirmed.answers ?? []).length;
              return `Confirmed: ${n} rule${n === 1 ? "" : "s"} and ${a} answer${a === 1 ? "" : "s"} will steer the next run.`;
            })()}
          </span>
          <button type="button" className="composer-save-btn" onClick={() => { pro.setConfirmed(null); pro.setStoryNote(""); }}>Edit</button>
        </div>
      )}

      {pro.spec && !pro.confirmed && (
        <>
          <div className="cd-cols" style={{ marginTop: "var(--sp-3)" }}>
            <div className="cd-left">
              <div className="cd-card">
                <div className="cd-card-head">What I understood</div>
                <div className="cd-lines" ref={rulesHost}>
                  {pro.draftRules.length ? pro.draftRules.map((r, i) => (
                    <div className="cd-line" style={{ alignItems: "flex-start" }} key={i}>
                      <textarea className="cd-ask-text" style={{ minHeight: 0, resize: "vertical" }} rows={2} data-pro-rule={i}
                        maxLength={500} aria-label={`Rule ${i + 1}`} value={r} onKeyDown={noEnter}
                        onChange={(e) => { const v = e.target.value; pro.setDraftRules((d) => d.map((x, j) => (j === i ? v : x))); }} />
                      <button type="button" className="cd-line-btn cd-line-del" aria-label={`Remove rule ${i + 1}`} title="Remove this rule"
                        onClick={() => pro.setDraftRules((d) => d.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  )) : <p className="field-label" style={{ margin: 0 }}>The document gave no testable rules. Add your own below.</p>}
                </div>
                <button type="button" className="cd-add" onClick={() => { pro.setDraftRules((d) => [...d, ""]); setFocusLast(true); }}>+ add</button>
              </div>
            </div>
            <div className="cd-right">
              <div className="cd-card">
                <div className="cd-card-head">Needs your answer</div>
                {pro.spec.unresolved.length ? pro.spec.unresolved.map((q, i) => (
                  <div style={{ marginBottom: "var(--sp-3)" }} key={i}>
                    <label className="field-label" htmlFor={`proAnswer${i}`} style={{ display: "block", marginBottom: 4 }}>{q}</label>
                    <input type="text" id={`proAnswer${i}`} className="cd-line-input" style={{ width: "100%" }} maxLength={1000}
                      value={pro.draftAnswers[i] || ""} placeholder="Optional — leave blank to skip" onKeyDown={noEnter}
                      onChange={(e) => { const v = e.target.value; pro.setDraftAnswers((d) => { const n = [...d]; n[i] = v; return n; }); }} />
                  </div>
                )) : <p className="field-label" style={{ margin: 0 }}>The document left nothing open — there are no questions.</p>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--sp-3)" }}>
            <button type="button" className="composer-save-btn" onClick={() => void pro.confirmSpec()}>Continue</button>
          </div>
        </>
      )}

      {pro.warnings.length > 0 && (
        <div className="panel" style={{ marginTop: "var(--sp-3)" }}>
          <h2>Warnings</h2>
          <div className="suite-add-list" style={{ margin: 0, padding: "var(--sp-2)" }} aria-live="polite">
            {pro.warnings.map((w) => (
              <div className="suite-add-row" style={{ cursor: "default", fontSize: ".78rem", lineHeight: 1.5 }} key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

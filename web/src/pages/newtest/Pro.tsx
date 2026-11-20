import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { call, jsonPost } from "./shared";

/**
 * Pro document intake (SPEC_INTAKE_ENABLED), ported from public/app.js: upload ONE requirements
 * document (POST /api/spec/upload), correct the rules and answer the open questions on one
 * two-column screen, Continue (POST /api/spec/confirm); the confirmed spec rides along as
 * `options.spec` when the run starts. The spec lives in memory only, as in the classic UI.
 */

const PRO_MB = 1024 * 1024;
/** Mirrors SPEC_BYTE_LIMITS in src/stages/specIntake.ts (the server enforces the same limits). */
const PRO_LIMITS = { pdf: 10 * PRO_MB, docx: 10 * PRO_MB, md: 2 * PRO_MB };
const PRO_NOUN = { pdf: "PDFs", docx: "Word documents", md: "Markdown files" };
const PRO_FAILED = "That document couldn't be summarised just now. Try uploading it again.";
const PRO_STORY_FILLED = "The prompt box was filled from your requirements. Check it, then Run.";
const PRO_STORY_OFFER = "Your typed prompt is kept. The run will test what it says, alongside the requirements.";

type Format = keyof typeof PRO_LIMITS;
function proFormatOf(name: string): Format | null {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (ext === "md" || ext === "markdown" || ext === "txt") return "md";
  return null;
}
const proMb = (bytes: number) => `${Math.round((bytes / PRO_MB) * 10) / 10} MB`;

interface Spec { rules: string[]; unresolved: string[]; answers?: { question: string; answer: string }[]; [k: string]: unknown }

/**
 * Runs this browser started in Pro mode -> the warnings intake already gave, so a run page can
 * start its warnings panel with them (the classic `proRuns`). In memory only, like the classic UI.
 */
export const proRunWarnings = new Map<string, { warnings: string[]; done: boolean }>();

export function usePro(prompt: string, setPrompt: (v: string) => void) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [draftRules, setDraftRules] = useState<string[]>([]);
  const [draftAnswers, setDraftAnswers] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<Spec | null>(null);
  const [notice, setNotice] = useState("");
  const [storyPrompt, setStoryPrompt] = useState("");
  const [storyNote, setStoryNote] = useState("");
  const storyFilled = useRef("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileName0 = useRef<string | null>(null);
  fileName0.current = fileName;

  const warn = (text: string) => setWarnings((w) => (text && !w.includes(text) ? [...w, text] : w));

  const fillPrompt = (text: string) => {
    if (!text) return;
    setPrompt(text);
    storyFilled.current = text;
    setStoryNote(PRO_STORY_FILLED);
  };

  const upload = async (file: File) => {
    setNotice("");
    const format = proFormatOf(file.name);
    if (file.size === 0) { warn("That file is empty."); return; }
    if (format && file.size > PRO_LIMITS[format]) {
      warn(`That file is ${proMb(file.size)}. ${PRO_NOUN[format]} can be up to ${proMb(PRO_LIMITS[format])}.`);
      return;
    }
    setBusy(true);
    try {
      // Always octet-stream: the server reads the format from the bytes and the extension.
      const body = await call<{ ok?: boolean; spec?: Spec; warnings?: string[] }>(
        `/api/spec/upload?name=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
      for (const w of body?.warnings || []) warn(w);
      if (body?.ok && body.spec) {
        if (fileName0.current && fileName0.current !== file.name) warn(`Replaced “${fileName0.current}” with “${file.name}”.`);
        setFileName(file.name);
        setSpec(body.spec);
        setDraftRules([...body.spec.rules]);
        setDraftAnswers(body.spec.unresolved.map(() => ""));
        setConfirmed(null);
        setStoryPrompt(""); setStoryNote("");
      }
    } catch {
      warn(PRO_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const confirmSpec = async () => {
    if (!spec) return;
    const next: Spec = {
      ...spec,
      rules: draftRules.map((r) => r.trim()).filter(Boolean),
      // An unanswered question is simply ABSENT — never defaulted, never "N/A".
      answers: spec.unresolved.map((q, i) => ({ question: q, answer: (draftAnswers[i] || "").trim() })).filter((a) => a.answer),
    };
    try {
      const body = await call<{ spec: Spec; promptText?: unknown }>("/api/spec/confirm", jsonPost({ spec: next }));
      setConfirmed(body.spec);
      setNotice("");
      const story = typeof body.promptText === "string" ? body.promptText : "";
      setStoryPrompt(story);
      // An EMPTY prompt box (or our own earlier fill) is filled; typed text is never overwritten.
      if (!story) setStoryNote("");
      else if (!prompt.trim() || prompt === storyFilled.current) fillPrompt(story);
      else setStoryNote(PRO_STORY_OFFER);
    } catch {
      warn("Those requirements couldn't be confirmed. Check them and press Continue again.");
    }
  };

  /** null when Pro is off, { spec } when confirmed, false when Pro is on with nothing confirmed. */
  const runOptions = (): { spec: Spec } | null | false => {
    if (!on) return null;
    if (confirmed) return { spec: confirmed };
    setNotice(spec ? "Press Continue to confirm the requirements, or turn Pro off." : "Upload a requirements document, or turn Pro off.");
    return false;
  };

  const toggle = (next: boolean) => { setOn(next); if (!next) setNotice(""); };

  return {
    on, toggle, busy, fileName, spec, draftRules, setDraftRules, draftAnswers, setDraftAnswers, confirmed, setConfirmed,
    notice, storyPrompt, storyNote, setStoryNote, warnings, upload, confirmSpec, runOptions, fillPrompt,
  };
}

export type ProState = ReturnType<typeof usePro>;

/** The "Pro" checkbox inside the run form. */
export function ProToggle({ pro }: { pro: ProState }) {
  return (
    <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
      <input type="checkbox" className="lib-check" id="proToggle" checked={pro.on} onChange={(e) => pro.toggle(e.target.checked)} />
      {" "}Pro — steer the tests with a requirements document
    </label>
  );
}

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

import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Busy, Icon, STATUS_ICON } from "./Icon";
import { authFetch } from "../model";
import { CASE_BADGE, NARRATIVE_LEAD_IN, STATUS_LABEL, runTokensOf } from "../text";
import { SaveCasePanel } from "./SaveCasePanel";

import { CaseErrorBlock } from "./CaseErrorBlock";
import { CaseNarrative } from "./CaseNarrative";
import { DiagnosisBlock } from "./DiagnosisBlock";
import { StepTrail } from "./StepTrail";
import { SuiteSummary } from "../types";
import { Details } from "../types";

export function CaseCard({ c, index, runId, suite, canSave, onZoom, cardRef }: {
  c: any; index: number; runId: string; suite: SuiteSummary; canSave: boolean;
  onZoom: (src: string, label: string) => void; cardRef?: Ref<HTMLDivElement>;
}) {
  const autoExpand = c.status === "failed" || c.status === "blocked";
  const [open, setOpen] = useState(autoExpand);
  const [details, setDetails] = useState<Details | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shotOk, setShotOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);
  const requested = useRef(false);

  const status: string = c.status;
  const statusBadge = CASE_BADGE[status] ?? "badge-pending";
  const whyItMatters = c.whyItMatters || c.intent || c.expected || "";
  const expected = c.expected || "";
  const caseDir = `/runs/${runId}/${c.resultPath}`;
  const screenshotUrl: string = c.screenshotUrl || "";
  const specUrl = `${caseDir}/generated.spec.ts`;
  const irUrl = `${caseDir}/04-ir.json`;
  const resultUrl = `${caseDir}/05-result.json`;
  const reportUrl = `/api/runs/${encodeURIComponent(runId)}/report.html`;
  const traceUrl = `${caseDir}/artifacts`;
  const fileName = `${c.title || "test"}.spec.ts`;

  // Technical details load on first open (lazy) — including for a card that rendered open.
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    let alive = true;
    const dir = `/runs/${runId}/cases/${c.caseId}`;
    const getJson = (url: string) => authFetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    (async () => {
      try {
        const [irRes, spec, diagnosis, results] = await Promise.all([
          getJson(`${dir}/04-ir.json`),
          authFetch(`${dir}/generated.spec.ts`).then((r) => (r.ok ? r.text() : "Not found")),
          status === "failed" ? getJson(`${dir}/06-diagnosis.json`) : Promise.resolve(null),
          getJson(`${dir}/results.json`).then((r) => r ?? getJson(`/runs/${runId}/results.json`)),
        ]);
        const ir = irRes?.ir ?? irRes;
        const own = await getJson(`${dir}/05-result.json`);
        const raw = own?.raw ?? (await getJson(`/runs/${runId}/05-result.json`))?.raw ?? results;
        if (alive) setDetails({ ir, irText: ir ? JSON.stringify(ir, null, 2) : "Not found", spec, diagnosis, results, raw, strict: !own?.raw });
      } catch {
        // Details stay as "Loading…" — non-critical.
      }
    })();
    return () => { alive = false; };
  }, [open, runId, c.caseId, status]);

  const toggle = () => setOpen((o) => !o);
  const onHeaderKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  const zoom = () => onZoom(screenshotUrl, `screenshot for case ${index + 1}`);
  const caseFromSuite = suite.cases.find((x) => x.caseId === c.caseId);
  const tokens = details ? runTokensOf(details.results, details.ir?.meta?.title) : null;

  return (
    <div className={`case-card${open ? " open" : ""}`} data-case-id={c.caseId} data-status={status} ref={cardRef}>
      <div className="case-card-header" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onHeaderKey}>
        <span className={`case-status-icon ${statusBadge}`}><Icon name={STATUS_ICON[status] ?? "circle"} size={16} /></span>
        <span className="case-heading">
          <span className="case-title">{c.title}</span>
          {whyItMatters && <p className="case-intent">{whyItMatters}</p>}
          {expected && expected !== whyItMatters && <p className="case-expected"><span>What should happen:</span> {expected}</p>}
        </span>
        <span className={`case-badge ${statusBadge}`}>{STATUS_LABEL[status] ?? status}</span>
        {c.healed && status === "passed" && (
          <span className="case-badge case-badge-healed"
            title={`This failed on the first attempt; the system automatically found a fix and re-ran it, and it passed.${c.deterministicHeal ? " This fix was found deterministically, without a model call." : ""}`}>
            <Icon name="refresh" size={11} /> Fixed automatically{c.deterministicHeal && <> <Icon name="zap" size={10} /></>}
          </span>
        )}
        {c.deterministicHeal && (
          <span className="case-badge case-badge-deterministic" title="The fix was found by matching the element's structure in the crawled page model — no model call, essentially free.">
            <Icon name="zap" size={10} /> Healed deterministically
          </span>
        )}
        <span className="case-expand-icon"><Icon name="chevron-down" size={14} /></span>
      </div>
      <div className="case-card-body">
        {c.blockedBy && <p className="blocked-note">Couldn't finish: {c.blockedBy}. The screenshot below is where it stopped.</p>}
        <CaseErrorBlock c={c} screenshotUrl={screenshotUrl} />
        {details && <StepTrail c={caseFromSuite} ir={details.ir} status={status} raw={details.raw} tokens={tokens} strict={details.strict} />}
        {details && NARRATIVE_LEAD_IN[status] && caseFromSuite && <CaseNarrative c={caseFromSuite} ir={details.ir} status={status} tokens={tokens} />}
        {details && status === "failed" && details.diagnosis && <DiagnosisBlock diagnosis={details.diagnosis} />}
        {screenshotUrl && shotOk && (
          <figure className="case-screenshot">
            <img src={screenshotUrl} alt={`screenshot for case ${index + 1}`} loading="lazy" tabIndex={0} role="button"
              aria-label="View full-size screenshot" onError={() => setShotOk(false)} onClick={zoom}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoom(); } }} />
            <figcaption>Final state — click to zoom in</figcaption>
          </figure>
        )}
        {c.videoUrl && videoOk && (
          <figure className="case-video">
            {/* keyed by URL: a <video> never re-reads a changed <source> on its own (the classic reload fix) */}
            <video key={c.videoUrl} controls preload="none" poster={screenshotUrl || undefined} onError={() => setVideoOk(false)}>
              <source src={c.videoUrl} type="video/webm" />
            </video>
            <figcaption>Recording of the run — nothing downloads until you press play</figcaption>
          </figure>
        )}
        <div className="case-downloads">
          <a href={specUrl} download={fileName} className="dl-btn"><Icon name="file-text" size={13} /> Download test script</a>
          <a href={reportUrl.replace(/\.html$/, ".pdf")} download={`test-report-${runId}.pdf`} className="dl-btn"><Icon name="file-text" size={13} /> Download report (PDF)</a>
          <a href={reportUrl} download={`test-report-${runId}.html`} className="dl-btn"><Icon name="file-text" size={13} /> Download report (HTML)</a>
          <a href={resultUrl} download="result.json" className="dl-btn"><Icon name="download" size={13} /> Raw result (JSON)</a>
          {canSave && (
            <button type="button" className="dl-btn case-save-btn" onClick={(e) => { e.stopPropagation(); setSaveOpen((o) => !o); }}>
              <Icon name="plus" size={13} /> Save case
            </button>
          )}
        </div>
        {saveOpen && <SaveCasePanel runId={runId} caseId={c.caseId} title={c.title ?? ""} />}
        <details className="case-details">
          <summary><Icon name="code" size={13} /> Technical details (for developers)</summary>
          <div className="case-details-content">
            {c.intent && <><h4>QA reasoning</h4><pre>{c.intent}</pre></>}
            {!!c.llmCalls && <><h4>Cost</h4><pre>{c.llmCalls} AI call(s), {c.llmTokens ?? 0} tokens</pre></>}
            <h4>Step-by-step test plan (JSON) <a href={irUrl} download="ir.json" className="dl-btn dl-btn-inline"><Icon name="download" size={12} /> download</a></h4>
            <pre className="case-ir">{details ? details.irText : <Busy />}</pre>
            <h4>Full test code <a href={specUrl} download={fileName} className="dl-btn dl-btn-inline"><Icon name="download" size={12} /> download</a></h4>
            <pre className="case-spec">{details ? details.spec : <Busy />}</pre>
            <h4>All files (screenshots, trace, video) <a href={traceUrl} className="dl-btn dl-btn-inline" target="_blank" rel="noreferrer"><Icon name="external-link" size={12} /> open</a></h4>
          </div>
        </details>
      </div>
    </div>
  );
}

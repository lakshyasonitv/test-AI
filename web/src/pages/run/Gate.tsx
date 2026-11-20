/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { authFetch, gateDraftKey, type GateRound, type Notice } from "./model";
import { diffSteps } from "./text";

/**
 * The case-selection gate (public/app.js "Case-selection panel"): the run is parked on this round
 * until a person picks cases (POST /api/runs/:id/case-selection {action:"done"}) or refines
 * ({action:"not_satisfied", newPrompt}). Edits and hand-written cases are DRAFTS until then — kept in
 * localStorage under the classic UI's own key (testbench.gate.<runId>.<attempt>), so a reload, or
 * switching between the two UIs mid-round, keeps them. Drafts hold case text only, never secrets.
 *
 * Mounted once per round (keyed by attempt by the parent), which is how the classic panel reloads
 * drafts and drops proposals "only when the round actually changes".
 */

const CASE_POOL_CAP = 5;             // MAX_ACCUMULATED_CASES (fallback; the server's real cap wins)
const MAX_CASE_REGEN_ATTEMPTS = 3;   // MAX_CASE_REGEN_ATTEMPTS

interface CaseFields { title?: string; steps?: string[]; expected?: string; whyItMatters?: string; [k: string]: any }
interface Drafts { edits: Record<string, CaseFields>; added: CaseFields[]; removed: Record<string, boolean>; checked: Record<string, boolean> }
interface Entry { index: number; c: any; isAdded: boolean; isEdited: boolean }
interface Proposal { before: string[]; steps: string[]; note?: string }
interface PageEls { url: string; title?: string; elements: { role: string; name: string }[] }

const emptyDrafts = (): Drafts => ({ edits: {}, added: [], removed: {}, checked: {} });

function loadDrafts(runId: string, attempt: number): Drafts {
  try {
    const raw = localStorage.getItem(gateDraftKey(runId, attempt));
    if (!raw) return emptyDrafts();
    const p = JSON.parse(raw);
    const obj = (v: any) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return { edits: obj(p.edits), added: Array.isArray(p.added) ? p.added : [], removed: obj(p.removed), checked: obj(p.checked) };
  } catch { return emptyDrafts(); }
}

/** Host + path — the classic gatePageKey, itself a copy of src/text.ts pageKey(). */
function gatePageKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, "").toLowerCase() + (u.pathname.replace(/\/+$/, "") || "/");
  } catch { return url; }
}

const GATE_ROLE_GROUPS = [
  { label: "Buttons", roles: ["button", "menuitem", "tab"] },
  { label: "Fields", roles: ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "spinbutton", "slider", "option"] },
  { label: "Links", roles: ["link"] },
  { label: "Headings", roles: ["heading"] },
];

/** Page elements per run, fetched once (classic loadGatePageElements). Silent on failure. */
const pageElementsCache = new Map<string, PageEls[] | null>();

export function GatePanel({ runId, round, notice, setNotice, onDecided }: {
  runId: string;
  round: GateRound;
  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
  onDecided: () => void;
}) {
  const batch = round.batch;
  const n = batch.length;
  const accepted = round.accepted;
  const poolCap = round.poolCap ?? CASE_POOL_CAP;
  const roomLeft = Math.max(0, poolCap - accepted);

  const [drafts, setDrafts] = useState<Drafts>(() => loadDrafts(runId, round.attempt));
  const [proposals, setProposals] = useState<Record<number, Proposal>>({});
  const [openEditors, setOpenEditors] = useState<Record<number, boolean>>({});
  const [askText, setAskText] = useState<Record<number, string>>({});
  const [asking, setAsking] = useState<Record<number, boolean>>({});
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [armed, setArmed] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [pageEls, setPageEls] = useState<PageEls[] | null>(pageElementsCache.get(runId) ?? null);
  const lastStep = useRef<{ index: number; step: number } | null>(null);
  const pendingFocus = useRef<{ sel: string; caret?: number; scroll?: boolean } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const refineRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const firstSave = useRef(true);

  // Persist drafts on every change (not on the initial load — the classic panel writes only edits).
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    try { localStorage.setItem(gateDraftKey(runId, round.attempt), JSON.stringify(drafts)); } catch { /* storage full or blocked */ }
  }, [drafts, runId, round.attempt]);

  // The panel enters the viewport the moment a round is ready for review.
  useEffect(() => { panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, []);

  // The chips fill in a moment after the first paint, if the run has an application model to offer.
  useEffect(() => {
    if (pageElementsCache.has(runId)) return;
    let alive = true;
    authFetch(`/api/runs/${runId}/page-elements`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const pages = body && Array.isArray(body.pages) ? body.pages : null;
        if (pages) pageElementsCache.set(runId, pages);
        if (alive) setPageEls(pages);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [runId]);

  // Focus/caret restore after a structural change (classic repaintCaseList's focus put-back).
  useLayoutEffect(() => {
    const f = pendingFocus.current;
    if (!f || !listRef.current) return;
    pendingFocus.current = null;
    const el = listRef.current.querySelector<HTMLInputElement>(f.sel);
    if (!el) return;
    el.focus();
    if (f.scroll) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (f.caret != null) { try { el.setSelectionRange(f.caret, f.caret); } catch { /* not a text input */ } }
  });

  useEffect(() => { if (refineOpen) refineRef.current?.focus(); }, [refineOpen]);

  // ------------------------------------------------------------------ the list as it stands

  const cases: Entry[] = [];
  batch.forEach((base, i) => {
    if (drafts.removed[i]) return;
    const edit = drafts.edits[i] || {};
    cases.push({ index: i, c: { ...base, ...edit }, isAdded: false, isEdited: Object.keys(edit).length > 0 });
  });
  drafts.added.forEach((a, j) => cases.push({ index: n + j, c: a, isAdded: true, isEdited: false }));

  const isChecked = (e: Entry) => {
    const stored = drafts.checked[e.index];
    return typeof stored === "boolean" ? stored : e.isAdded;
  };
  const checkedIndexes = cases.filter(isChecked).map((e) => e.index);
  const total = accepted + checkedIndexes.length;
  const full = checkedIndexes.length >= roomLeft;

  const stepsIn = (d: Drafts, i: number): string[] => {
    const target = i >= n ? d.added[i - n] : d.edits[i];
    if (target && Array.isArray(target.steps)) return target.steps;
    const base = batch[i];
    return Array.isArray(base?.steps) ? base.steps.slice() : [];
  };
  const stepsFor = (i: number) => stepsIn(drafts, i);

  const update = (fn: (d: Drafts) => void) => setDrafts((prev) => {
    const next: Drafts = structuredClone(prev);
    fn(next);
    return next;
  });
  const editFor = (d: Drafts, i: number): CaseFields | undefined => {
    if (i >= n) return d.added[i - n];
    if (!d.edits[i]) d.edits[i] = {};
    return d.edits[i];
  };
  const setSteps = (i: number, steps: string[]) => update((d) => { const t = editFor(d, i); if (t) t.steps = steps; });

  const showNotice = (text: string) => setNotice({ kind: "notice", text });
  const showError = (text: string) => setNotice({ kind: "error", text });
  const disarm = () => { if (!armed) return; setArmed(false); setNotice(null); };

  // ------------------------------------------------------------------ requests

  const postDecision = async (decision: object): Promise<boolean> => {
    try {
      const res = await authFetch(`/api/runs/${runId}/case-selection`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showError(err.error ?? "Failed to submit case selection");
        return false;
      }
      return true;
    } catch {
      showError("Failed to submit case selection");
      return false;
    }
  };

  /** Only what differs from the model's proposal; an unedited round sends neither field. */
  const editPayload = () => {
    const editedCases: any[] = [];
    Object.keys(drafts.edits).forEach((key) => {
      const i = Number(key);
      const base = batch[i];
      if (!base || drafts.removed[i]) return;
      const edit = drafts.edits[i];
      const patch: any = { index: i };
      const str = (v: any) => (typeof v === "string" ? v.trim() : "");
      if (str(edit.title) && str(edit.title) !== base.title) patch.title = str(edit.title);
      if (Array.isArray(edit.steps)) {
        const steps = edit.steps.map((t) => String(t).trim()).filter(Boolean);
        if (steps.length && steps.join("\n") !== (base.steps || []).join("\n")) patch.steps = steps;
      }
      if (str(edit.expected) && str(edit.expected) !== base.expected) patch.expected = str(edit.expected);
      if (str(edit.whyItMatters) && str(edit.whyItMatters) !== base.whyItMatters) patch.whyItMatters = str(edit.whyItMatters);
      if (Object.keys(patch).length > 1) editedCases.push(patch);
    });
    const addedCases = drafts.added.map((a) => {
      const out: any = {
        title: String(a.title || "").trim(),
        steps: (a.steps || []).map((t) => String(t).trim()).filter(Boolean),
        expected: String(a.expected || "").trim(),
      };
      const why = String(a.whyItMatters || "").trim();
      if (why) out.whyItMatters = why;
      return out;
    });
    const payload: any = {};
    if (editedCases.length) payload.editedCases = editedCases;
    if (addedCases.length) payload.addedCases = addedCases;
    return payload;
  };

  const validationError = (selected: number[]): string | null => {
    const picked = new Set(selected);
    if (picked.size > roomLeft) {
      return `A run holds at most ${poolCap} cases` + (accepted ? ` and ${accepted} are already accepted` : "") +
        ` — untick ${picked.size - roomLeft} to continue.`;
    }
    for (const entry of cases) {
      if (!picked.has(entry.index)) continue;
      const c = entry.c;
      const steps = stepsFor(entry.index).map((t) => String(t).trim()).filter(Boolean);
      if (!String(c.title || "").trim()) return `Case ${entry.index + 1} needs a title.`;
      if (steps.length === 0) return `"${c.title}" needs at least one step.`;
      if (!String(c.expected || "").trim()) return `"${c.title}" needs an expected outcome.`;
    }
    return null;
  };

  // ------------------------------------------------------------------ actions

  const selectAll = () => {
    disarm();
    let room = roomLeft - checkedIndexes.length;
    let skipped = 0;
    const toCheck: number[] = [];
    for (const e of cases) {
      if (isChecked(e)) continue;
      if (room <= 0) { skipped++; continue; }
      room--;
      toCheck.push(e.index);
    }
    update((d) => { toCheck.forEach((i) => { d.checked[i] = true; }); });
    if (skipped) showNotice(`Ticked the first ${poolCap - accepted} — a run holds at most ${poolCap} cases.`);
  };

  const selectNone = () => {
    disarm();
    const primaryWasChecked = cases.some((e) => isChecked(e) && batch[e.index]?.fromPrompt);
    update((d) => { cases.forEach((e) => { d.checked[e.index] = false; }); });
    if (primaryWasChecked) showNotice("Primary case unselected — if you refine again, the next round will generate a new primary case.");
  };

  const onTick = (e: Entry, value: boolean) => {
    disarm();
    if (value && checkedIndexes.length + 1 > roomLeft) {
      showNotice(`You can run at most ${poolCap} cases in one run. Untick one to choose another.`);
      return;
    }
    update((d) => { d.checked[e.index] = value; });
  };

  const runSelected = async () => {
    if (accepted + checkedIndexes.length === 0) return;
    const problem = validationError(checkedIndexes);
    if (problem) return showError(problem);
    const ok = await postDecision({ action: "done", selectedIndexes: checkedIndexes, ...editPayload() });
    if (ok) onDecided();
  };

  const toggleRefine = () => {
    disarm();
    setRefineOpen((o) => !o);
  };

  const submitRefine = async () => {
    const newPrompt = refineText.trim();
    if (!newPrompt) { showError("Describe what should change before refining."); refineRef.current?.focus(); return; }
    const problem = validationError(checkedIndexes);
    if (problem) return showError(problem);
    const unticked = cases.filter((c) => !checkedIndexes.includes(c.index)).length;
    const warning = unticked === 0
      ? "Generate another round of cases?"
      : `Generate another round? ${unticked} case${unticked === 1 ? "" : "s"} you have not ` +
        `ticked will be recorded as rejected, and cannot be offered again in this run.`;
    // First press: say what will happen, in the panel. Second press (now "Yes"): send.
    if (!armed) { setArmed(true); showNotice(warning); confirmRef.current?.focus(); return; }
    setRefineBusy(true);
    const ok = await postDecision({ action: "not_satisfied", selectedIndexes: checkedIndexes, newPrompt, ...editPayload() });
    setRefineBusy(false);
    setArmed(false);
    if (ok) { setNotice(null); onDecided(); }
  };

  const writeOwn = () => {
    update((d) => { d.added.push({ title: "", steps: [""], expected: "", whyItMatters: "" }); });
    pendingFocus.current = { sel: `[data-field="title"][data-index="${n + drafts.added.length}"]`, scroll: true };
  };

  const onField = (i: number, field: string, value: string, step?: number) => {
    update((d) => {
      const t = editFor(d, i);
      if (!t) return;
      if (field === "step") {
        const steps = stepsIn(d, i).slice();
        steps[step!] = value;
        t.steps = steps;
      } else {
        t[field] = value;
      }
    });
  };

  const insertEl = (i: number, name: string) => {
    const list = listRef.current;
    if (!list) return;
    const target = lastStep.current && lastStep.current.index === i
      ? list.querySelector<HTMLInputElement>(`[data-field="step"][data-index="${i}"][data-step="${lastStep.current.step}"]`)
      : null;
    const rows = list.querySelectorAll<HTMLInputElement>(`[data-field="step"][data-index="${i}"]`);
    const input = target || rows[rows.length - 1];
    if (!input) return;
    const k = Number(input.dataset.step);
    const at = input.selectionStart == null ? input.value.length : input.selectionStart;
    const quoted = `"${name}"`;
    onField(i, "step", input.value.slice(0, at) + quoted + input.value.slice(at), k);
    pendingFocus.current = { sel: `[data-field="step"][data-index="${i}"][data-step="${k}"]`, caret: at + quoted.length };
  };

  const removeCase = (i: number) => {
    update((d) => {
      if (i >= n) d.added.splice(i - n, 1);
      else d.removed[i] = true;
      delete d.checked[i];
    });
    setProposals((p) => { const q = { ...p }; delete q[i]; return q; });
  };

  const stepAdd = (i: number) => {
    const steps = [...stepsFor(i), ""];
    setSteps(i, steps);
    pendingFocus.current = { sel: `[data-field="step"][data-index="${i}"][data-step="${steps.length - 1}"]` };
  };
  const stepDel = (i: number, k: number) => { const s = stepsFor(i).slice(); s.splice(k, 1); setSteps(i, s); };
  const stepMove = (i: number, k: number, dir: -1 | 1) => {
    const s = stepsFor(i).slice();
    const to = k + dir;
    if (to < 0 || to >= s.length) return;
    [s[k], s[to]] = [s[to], s[k]];
    setSteps(i, s);
  };

  const ask = async (entry: Entry) => {
    const i = entry.index;
    const instruction = (askText[i] || "").trim();
    if (!instruction) return showError("Say what you would like changed.");
    setAsking((a) => ({ ...a, [i]: true }));
    try {
      const res = await authFetch(`/api/runs/${runId}/case-selection/rewrite`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: entry.c.title, steps: stepsFor(i), instruction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { showError(typeof body.error === "string" ? body.error : "Could not propose a change."); return; }
      setProposals((p) => ({ ...p, [i]: body }));
    } catch {
      showError("Could not propose a change.");
    } finally {
      setAsking((a) => ({ ...a, [i]: false }));
    }
  };

  const applyProposal = (i: number) => {
    const p = proposals[i];
    if (!p) return;
    setSteps(i, p.steps.slice());
    setProposals((q) => { const r = { ...q }; delete r[i]; return r; });
    showNotice("Applied to the editor — nothing is saved until you run or refine this round.");
  };

  // ------------------------------------------------------------------ render

  const pagesFor = (c: any): PageEls[] => {
    if (!pageEls || pageEls.length === 0) return [];
    if (c?.targetUrl) {
      const key = gatePageKey(c.targetUrl);
      const match = pageEls.filter((p) => gatePageKey(p.url) === key);
      if (match.length) return match;
    }
    return pageEls;
  };

  const elementsBlock = (i: number, c: any) => {
    const pages = pagesFor(c);
    if (!pages.length) return null;
    const claimed = new Set(GATE_ROLE_GROUPS.flatMap((g) => g.roles));
    const sections = pages.map((page) => {
      const grouped = GATE_ROLE_GROUPS.map((g) => ({ label: g.label, items: page.elements.filter((e) => g.roles.includes(e.role)) }));
      const other = page.elements.filter((e) => !claimed.has(e.role));
      if (other.length) grouped.push({ label: "Other", items: other });
      const rows = grouped.filter((g) => g.items.length);
      if (!rows.length) return null;
      const label = page.title ? `${page.title} (${page.url})` : page.url;
      return (
        <div key={page.url}>
          {pages.length > 1 && <div className="cd-card-label">{label}</div>}
          {rows.map((g) => (
            <div className="case-suites" key={g.label}>
              <span className="case-suites-label">{g.label}</span>
              {g.items.map((e, x) => (
                <button type="button" className="case-suite-chip" key={x}
                  title={`${e.role} — click to put this wording in the step you are editing`}
                  onClick={(ev) => { ev.preventDefault(); insertEl(i, e.name || ""); }}>{e.name}</button>
              ))}
            </div>
          ))}
        </div>
      );
    }).filter(Boolean);
    if (!sections.length) return null;
    return (
      <div className="cd-card">
        <div className="cd-card-label">What's on this page — click to use the site's own wording</div>
        {sections}
      </div>
    );
  };

  const proposalBlock = (i: number, p: Proposal) => {
    const { left, right } = diffSteps(p.before ?? [], p.steps ?? []);
    const rows: { k: string; t: string }[] = [];
    left.forEach((l) => { if (l.k === "removed") rows.push({ k: "del", t: l.t }); });
    right.forEach((r) => rows.push({ k: r.k === "added" ? "add" : "same", t: r.t }));
    return (
      <div className="cd-proposal">
        <p className="cd-proposal-note">Proposed change — nothing is saved until you approve this round.</p>
        {p.note && <p className="cd-proposal-note">{p.note}</p>}
        <div className="cd-diff">
          {rows.map((r, x) => <div key={x} className={`cd-diff-line cd-diff-${r.k}`}>{r.t}</div>)}
        </div>
        <div className="cd-proposal-actions">
          <button type="button" className="dl-btn-inline" onClick={() => applyProposal(i)}>Apply to editor</button>
          <button type="button" className="dl-btn-inline" onClick={() => setProposals((q) => { const r = { ...q }; delete r[i]; return r; })}>Discard</button>
        </div>
      </div>
    );
  };

  const card = (entry: Entry) => {
    const { index: i, c, isAdded, isEdited } = entry;
    const open = openEditors[i] ?? (isAdded || isEdited);
    const why = c.whyItMatters || c.intent || c.expected || "";
    const expected = c.expected || "";
    const checked = isChecked(entry);
    const disabled = full && !checked;
    const steps = stepsFor(i);
    return (
      <li key={i} data-case={i}>
        <input type="checkbox" id={`case-pick-${i}`} data-index={i} checked={checked} disabled={disabled}
          title={disabled ? `A run holds at most ${poolCap} cases — untick one to choose this one.` : ""}
          onChange={(ev) => onTick(entry, ev.target.checked)} />
        <div className="case-narrative">
          <label htmlFor={`case-pick-${i}`} className="case-label">
            <span className="case-label-row">
              <span className="case-title">{c.title || `Case ${i + 1}`}</span>
              {c.fromPrompt && <span className="case-primary-badge">Primary</span>}
              {isAdded && <span className="case-badge">Your case</span>}
              {isEdited && <span className="case-badge">Edited</span>}
            </span>
            {why && <span className="case-intent">{why}</span>}
            {expected && expected !== why && <span className="case-expected"><b>What should happen:</b> {expected}</span>}
          </label>
          <div className="case-selection-bulk">
            <button type="button" className="case-selection-link" onClick={() => setOpenEditors((o) => ({ ...o, [i]: !open }))}>{open ? "Hide steps" : "Edit steps"}</button>
            <button type="button" className="case-selection-link" onClick={() => removeCase(i)}>Remove case</button>
          </div>
          <div className={`cd-card-inset${open ? "" : " hidden"}`}>
            <div className="cd-card-label">Title</div>
            <input type="text" className="cd-line-input" data-field="title" data-index={i} value={c.title || ""}
              aria-label="Case title" onChange={(ev) => onField(i, "title", ev.target.value)} />

            <div className="cd-card-label">Steps</div>
            <div className="cd-lines">
              {steps.map((text, k) => (
                <div className="cd-line" key={k}>
                  <span className="cd-line-num">{k + 1}</span>
                  <input type="text" className="cd-line-input" data-field="step" data-index={i} data-step={k} value={text}
                    aria-label={`Step ${k + 1}`} onFocus={() => { lastStep.current = { index: i, step: k }; }}
                    onChange={(ev) => onField(i, "step", ev.target.value, k)} />
                  <button type="button" className="cd-line-btn" disabled={k === 0} title="Move up" aria-label={`Move step ${k + 1} up`} onClick={() => stepMove(i, k, -1)}>&uarr;</button>
                  <button type="button" className="cd-line-btn" disabled={k === steps.length - 1} title="Move down" aria-label={`Move step ${k + 1} down`} onClick={() => stepMove(i, k, 1)}>&darr;</button>
                  <button type="button" className="cd-line-del" title="Delete step" aria-label={`Delete step ${k + 1}`} onClick={() => stepDel(i, k)}>&times;</button>
                </div>
              ))}
            </div>
            <button type="button" className="cd-add" onClick={() => stepAdd(i)}>+ Add step</button>

            <div className="cd-card-label">Expected outcome</div>
            <input type="text" className="cd-line-input" data-field="expected" data-index={i} value={c.expected || ""}
              aria-label="Expected outcome" onChange={(ev) => onField(i, "expected", ev.target.value)} />

            <div className="cd-card-label">Why it matters</div>
            <input type="text" className="cd-line-input" data-field="whyItMatters" data-index={i} value={c.whyItMatters || ""}
              aria-label="Why it matters" onChange={(ev) => onField(i, "whyItMatters", ev.target.value)} />
            {elementsBlock(i, c)}
            {round.ai && (
              <div className="cd-card">
                <div className="cd-card-label">Ask for a change</div>
                <textarea className="cd-ask-text" rows={2} placeholder="e.g. also check that the error message is visible"
                  value={askText[i] ?? ""} onChange={(ev) => setAskText((a) => ({ ...a, [i]: ev.target.value }))} />
                <button type="button" className={`cd-ask-btn${asking[i] ? " ai-busy" : ""}`} disabled={!!asking[i]} onClick={() => ask(entry)}>
                  {asking[i] ? <><Icon name="loader" size={13} cls="ai-spin" /> Asking…</> : "Ask for a change"}
                </button>
              </div>
            )}
            <div>{proposals[i] ? proposalBlock(i, proposals[i]) : null}</div>
          </div>
        </div>
      </li>
    );
  };

  const counter = accepted === 0
    ? `Tick the cases you want to run. You can run as few as one — up to ${poolCap} in total.`
    : `${accepted} case${accepted === 1 ? "" : "s"} accepted — enough to run now. ` +
      `${poolCap} is the most this run will hold, not a target.` +
      (accepted >= poolCap ? " The pool is now full, so this is the last round — refining will not offer another." : "");

  return (
    <section id="case-selection-panel" className="case-selection" aria-live="polite" ref={panelRef}>
      <div className="case-selection-head">
        <span className="case-selection-key"><Icon name="list" size={18} /></span>
        <div>
          <div className="case-selection-head-row">
            <h2>Round {round.attempt} — review the test cases</h2>
            <span className="case-action-pill">Action needed</span>
          </div>
          <p className="case-pool-counter">{counter}</p>
        </div>
      </div>
      <ul className="case-selection-list" ref={listRef}>{cases.map(card)}</ul>
      <div className="case-selection-bulk">
        <button type="button" className="case-selection-link" onClick={selectAll}>Select all</button>
        <button type="button" className="case-selection-link" onClick={selectNone}>Select none</button>
        <button type="button" className="case-selection-link" onClick={writeOwn}>+ Write my own case</button>
      </div>
      <div className={`case-refine-input-wrap${refineOpen ? "" : " case-refine-collapsed"}`}>
        <label className="field">
          <span className="field-label">What should change?</span>
          <textarea rows={2} ref={refineRef} value={refineText}
            placeholder="Tell the AI what to change — e.g. add edge cases for expired and already-used codes"
            onChange={(ev) => { setRefineText(ev.target.value); disarm(); }} />
        </label>
        <button type="button" className="case-refine-confirm" ref={confirmRef} disabled={refineBusy} onClick={submitRefine}>
          {armed ? "Yes, generate another round" : "Generate another round"}
        </button>
        {armed && (
          <button type="button" className="case-refine-confirm" style={{ marginLeft: 8 }}
            onClick={() => { disarm(); refineRef.current?.focus(); }}>Cancel</button>
        )}
      </div>
      <p className={`case-notice${notice ? " " + notice.kind : " hidden"}`} role="status">{notice?.text ?? ""}</p>
      <p className="case-regen-note case-done-hint" role="status">
        {total === 0 ? "Nothing is ticked, so there is nothing to run. Tick at least one case above — you do not need to refine." : ""}
      </p>
      <div className="case-selection-final-actions">
        <button type="button" className="case-not-satisfied" aria-expanded={refineOpen} onClick={toggleRefine}>
          {refineOpen ? "Cancel refine" : "Not satisfied — refine"}
        </button>
        <button type="button" disabled={total === 0} onClick={runSelected}>
          {total === 0 ? "Run selected tests" : `Run ${total} test${total === 1 ? "" : "s"}`}
        </button>
      </div>
      <p className="case-regen-note">
        Refine attempts left: {Math.max(0, MAX_CASE_REGEN_ATTEMPTS - round.attempt)} of {MAX_CASE_REGEN_ATTEMPTS}
      </p>
    </section>
  );
}

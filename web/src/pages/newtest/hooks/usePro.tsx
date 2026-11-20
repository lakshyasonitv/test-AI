import { useRef, useState } from "react";
import { call, jsonPost } from "../shared";

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
export const PRO_STORY_OFFER = "Your typed prompt is kept. The run will test what it says, alongside the requirements.";

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

import { useCallback, useEffect, useState } from "react";
import { acctJson, jsonBody } from "../../../lib/session";
import { Feedback } from "../types";
import { LlmConfig } from "../types";

/**
 * app.js renderLlmConfigPanel. The key is write-only: the server returns only `keySet` and a hint,
 * the input is a password field cleared the moment it is sent, and an untouched field never
 * clears a stored key. A 404 (feature off) or 403 draws nothing.
 */
export function LlmConfigPanel({ orgId }: { orgId: string }) {
  const url = `/api/organisations/${encodeURIComponent(orgId)}/llm-config`;
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [modelLite, setModelLite] = useState("");
  const [maxCalls, setMaxCalls] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(async () => {
    try {
      const c = await acctJson<LlmConfig>(url);
      setCfg(c);
      setModel(c.model || "");
      setModelLite(c.modelLite || "");
      setMaxCalls(c.maxCallsPerRun == null ? "" : String(c.maxCallsPerRun));
      setKey("");
      setSaving(false);
      return true;
    } catch {
      setCfg(null);
      return false;
    }
  }, [url]);

  useEffect(() => { void load(); }, [load]);

  if (!cfg) return null;

  const save = async (body: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    try {
      await acctJson(url, jsonBody("PUT", body));
      await load();
      setFeedback({ message: okMsg, isError: false });
    } catch (err) {
      setFeedback({ message: (err instanceof Error && err.message) || "Could not save the configuration.", isError: true });
      setSaving(false);
    }
  };

  const onSave = () => {
    const typed = key.trim();
    const maxRaw = maxCalls.trim();
    const body: Record<string, unknown> = {
      model: model || null,
      modelLite: modelLite || null,
      maxCallsPerRun: maxRaw === "" ? null : Number(maxRaw),
    };
    if (typed) body.apiKey = typed;
    setKey("");
    void save(body, typed ? "Key and model saved. The key is stored encrypted and cannot be shown again." : "Model settings saved.");
  };

  const modelOptions = (
    <>
      <option value="">Use the server's default</option>
      {cfg.availableModels.map((m) => <option key={m} value={m}>{m}</option>)}
    </>
  );

  return (
    <>
      <div style={{ marginTop: 28 }}>
        <div className="eyebrow">AI CONFIGURATION</div>
        <h1 className="page-head-title">This organisation's Gemini key and model</h1>
        <p className="tagline">Runs started by this organisation use the key set here and bill to its own
          quota. Leave it unset to use the server's shared configuration.</p>
      </div>
      <div id="llmFeedback">
        {feedback && <p className={feedback.isError ? "team-error" : "team-ok"}>{feedback.message}</p>}
      </div>
      <div className="panel">
        <div className="team-add">
          <label className="field">
            <span className="field-label">Gemini API key</span>
            {cfg.keySet ? (
              <p className="hrow-meta" id="llmKeyState">Set — <strong>{cfg.keyHint || "••••"}</strong>.
                A stored key is never shown again; you can replace or remove it.</p>
            ) : (
              <p className="hrow-meta" id="llmKeyState">Not set — this organisation uses the server's key.</p>
            )}
            <input id="llmKeyInput" type="password" autoComplete="off" spellCheck={false}
              placeholder={cfg.keySet ? "Enter a new key to replace it" : "Paste this organisation's Gemini API key"}
              disabled={!cfg.custodyConfigured} value={key} onChange={(e) => setKey(e.target.value)} />
            {!cfg.custodyConfigured && (
              <p className="team-error">This server has no encryption key configured (LLM_KEY_FILE), so an
                API key cannot be stored safely. Ask an operator to set one.</p>
            )}
          </label>
          <label className="field" style={{ flex: "0 0 200px" }}>
            <span className="field-label">Model</span>
            <select id="llmModel" className="team-select" value={model} onChange={(e) => setModel(e.target.value)}>{modelOptions}</select>
          </label>
          <label className="field" style={{ flex: "0 0 200px" }}>
            <span className="field-label">Cheap-call model</span>
            <select id="llmModelLite" className="team-select" value={modelLite} onChange={(e) => setModelLite(e.target.value)}>{modelOptions}</select>
          </label>
          <label className="field" style={{ flex: "0 0 150px" }}>
            <span className="field-label">Max LLM calls per run</span>
            <input id="llmMaxCalls" type="number" min={1} placeholder="server default"
              value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} />
          </label>
          <div className="team-add-actions">
            <button type="button" id="llmSaveBtn" className="dl-btn-inline" disabled={saving} onClick={onSave}>Save</button>
            {cfg.keySet && (
              <button type="button" id="llmRemoveKeyBtn" className="dl-btn-inline"
                onClick={() => void save({ apiKey: null }, "Key removed — this organisation now uses the server's key.")}>Remove key</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useState } from "react";
import { getScript } from "../recorderApi";

/**
 * The Playwright script this recording would save as, rebuilt whenever the steps change — by the
 * server's pure generator, the same one every saved case uses (no AI). Logins show only as
 * process.env references.
 */
export function ScriptPanel({ id, stepsKey, title }: { id: string; stepsKey: string; title: string }) {
  const [spec, setSpec] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      getScript(id, title)
        .then((r) => { if (alive) { setSpec(r.spec); setError(""); } })
        .catch((e) => { if (alive) setError((e as Error).message); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [id, stepsKey, title]);

  const copy = () => {
    void navigator.clipboard?.writeText(spec).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div>
      <div className="rx-rec-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <span className="tagline" style={{ margin: 0 }}>Playwright test, generated from the steps.</span>
        <button type="button" className="dl-btn-inline" disabled={!spec} onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      {error ? <p className="team-error">{error}</p> : <pre className="rx-rec-script">{spec || "Building…"}</pre>}
    </div>
  );
}

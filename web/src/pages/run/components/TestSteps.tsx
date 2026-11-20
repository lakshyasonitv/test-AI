import { useEffect, useState } from "react";
import { authFetch } from "../model";
import { readableStep, runTokensOf } from "../text";

/** The "what ran" list: placeholders at once, then the run's own typed values once results.json
 *  says them (only when a step carries a placeholder). */
export function TestSteps({ runId, test, ir }: { runId: string; test: any; ir: any }) {
  const [tokens, setTokens] = useState<any>(null);
  useEffect(() => {
    const hasToken = ir?.steps?.some((s: any) => /\{\{/.test(`${s.value ?? ""}${s.target?.text ?? ""}${s.target?.name ?? ""}`));
    if (!hasToken) return;
    let alive = true;
    authFetch(`/runs/${encodeURIComponent(runId)}/results.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => { const tk = runTokensOf(res, ir.meta?.title); if (tk && alive) setTokens(tk); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runId, ir]);
  const lines: string[] = ir?.steps?.length ? ir.steps.map((s: any) => readableStep(s, tokens)) : (test?.steps ?? []);
  return <ol>{lines.map((s, i) => <li key={i}>{s}</li>)}</ol>;
}

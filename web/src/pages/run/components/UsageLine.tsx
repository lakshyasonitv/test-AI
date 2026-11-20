import { type RunModel } from "../model";
import { fmtTokens } from "../text";

/** What this run cost, from the terminal event's llmUsage (classic renderUsageLine). */
export function UsageLine({ m }: { m: RunModel }) {
  if (m.isReplay) return <div className="hrow-meta">Replayed from saved steps — <b>0 AI calls</b>, no tokens spent.</div>;
  const u = m.usage;
  if (!u || !u.calls) return null;
  const stages = Object.entries<any>(u.byStage ?? {}).sort((a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0));
  const top = stages[0];
  const healCount = m.primaryHeals + m.suiteHeals;
  return (
    <div className="hrow-meta">
      {u.calls} AI call{u.calls === 1 ? "" : "s"} · {fmtTokens(u.totalTokens ?? 0)} tokens
      {healCount > 0 && <> · <b>{healCount} self-heal retr{healCount === 1 ? "y" : "ies"}</b></>}
      {top && <> · most of it in <b>{top[0]}</b> ({top[1].calls} call{top[1].calls === 1 ? "" : "s"}, {fmtTokens(top[1].totalTokens ?? 0)})</>}
      {u.exhausted && <> · <b>budget exhausted</b></>}
    </div>
  );
}

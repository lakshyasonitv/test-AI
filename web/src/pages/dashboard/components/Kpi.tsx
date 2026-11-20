import { Icon } from "./Icon";

export function Kpi({ ico, label, value, chip, chipClass }: { ico: string; label: string; value: number; chip: string; chipClass: string }) {
  return (
    <div data-dash="card">
      <div data-dash="card-head"><span data-dash="ico"><Icon name={ico} size={15} /></span><h2>{label}</h2></div>
      <div data-dash="big-row">
        <span data-dash="big">{String(value)}</span>
        {chip ? <span className={`case-badge ${chipClass}`}>{chip}</span> : null}
      </div>
    </div>
  );
}

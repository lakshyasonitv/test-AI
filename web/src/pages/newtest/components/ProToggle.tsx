import { ProState } from "../hooks/usePro";

/** The "Pro" checkbox inside the run form. */
export function ProToggle({ pro }: { pro: ProState }) {
  return (
    <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
      <input type="checkbox" className="lib-check" id="proToggle" checked={pro.on} onChange={(e) => pro.toggle(e.target.checked)} />
      {" "}Pro — steer the tests with a requirements document
    </label>
  );
}

import { SF_SECTION, agoText, SfState } from "../hooks/useSalesforce";

export function OrgScan({ sf }: { sf: SfState }) {
  let text = "";
  if (sf.savedScans !== null) {
    if (!sf.savedScans.length) text = "No saved scan for this org yet. The first run scans it and saves the result.";
    else {
      const list = sf.savedScans.map((s) => `${s.objects.length ? s.objects.join(" + ") : "general"} (${agoText(s.savedAt)})`).join(", ");
      text = sf.freshDiscovery
        ? `Saved scans: ${list}. Ticked, so this run scans afresh. Untick to reuse a saved scan and start in seconds.`
        : `Saved scans: ${list}. This run reuses one when it covers the same objects and the org's setup hasn't changed; otherwise it scans again.`;
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }}>
      <div style={SF_SECTION}>Org scan</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" className="lib-check" id="sfFreshDiscovery" checked={sf.freshDiscovery}
          onChange={(e) => sf.setFreshDiscovery(e.target.checked)} /> Scan the org again
        <span style={{ color: "var(--muted)", fontSize: 12 }}>about 8 minutes</span>
      </label>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45, marginLeft: 26 }}>{text}</div>
    </div>
  );
}

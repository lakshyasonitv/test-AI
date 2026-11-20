import { SF_SECTION, sfInitials, SfState } from "../hooks/useSalesforce";
import { OrgScan } from "./OrgScan";

export function SignInCard({ sf }: { sf: SfState }) {
  const { users, stale, pending, conn, host } = sf;
  const note = (text: string) => (
    <div style={{ padding: 12, border: "1px dashed var(--line)", borderRadius: "var(--r-md)", color: "var(--text-2)",
      fontSize: 12, textAlign: "center", lineHeight: 1.45 }}>{text}</div>
  );
  const others = users.filter((c) => c.id !== conn?.id);

  return (
    <div style={{ margin: "10px 0 0 26px", padding: "14px 16px", border: "1px solid var(--line)", borderRadius: "var(--r-lg)",
      background: "var(--surface)", display: sf.targetChecked ? "flex" : "none", flexDirection: "column", gap: 10,
      fontSize: 13, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 240px" }}>
          <div style={SF_SECTION}>Sign in as</div>
          <div style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.45 }}>
            Pick the Salesforce user this run logs in as. Users connect once on Salesforce's own login page, so no password is ever typed.
          </div>
        </div>
        <button type="button" className="dl-btn dl-btn-inline" style={{ whiteSpace: "nowrap" }}
          title="Opens Salesforce's login page for the org in the URL box. Sign in as the user to add"
          onClick={() => void sf.connect()}>+ Connect a user</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45 }}>{sf.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {!host && note("Type the org's URL above to see the users connected to it.")}
        {host && !users.length && note(pending ? "Checking the saved connections…"
          : "No user is connected to this org yet. Click “+ Connect a user” and sign in on Salesforce's page. "
            + "Without one, the run asks for a username and password.")}
        {host && users.map((c) => {
          const on = c.id === conn?.id;
          const isApprover = sf.flags.approvals && c.id === sf.approverId;
          const badge = (text: string, strong: boolean) => (
            <span style={{ flex: "none", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: "var(--r-pill)",
              ...(strong ? { background: "var(--accent)", color: "#fff" } : { background: "var(--surface-3)", color: "var(--accent-deep)" }) }}>{text}</span>
          );
          return (
            <div key={c.id} role="radio" aria-checked={on} tabIndex={0}
              title={on ? "The run signs in as this user" : "Click to make the run sign in as this user"}
              onClick={() => { if (!on) sf.pick(c); }}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!on) sf.pick(c); } }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: "var(--r-md)", cursor: "pointer",
                border: `1px solid ${on ? "var(--accent)" : "var(--line-soft)"}`, background: on ? "var(--surface-2)" : "var(--surface)" }}>
              <span style={{ flex: "none", width: 14, height: 14, borderRadius: "50%", boxSizing: "border-box",
                border: on ? "4px solid var(--accent)" : "1.5px solid var(--line)" }} />
              <span style={{ flex: "none", width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center",
                fontSize: 11, fontWeight: 600, background: "var(--surface-3)", color: "var(--accent-deep)" }}>{sfInitials(c)}</span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name || c.username}</span>
                <span style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.username}</span>
              </div>
              {on && badge("Runs as", true)}
              {isApprover && badge("Approver", false)}
              <button type="button" title="Remove this user's connection here and revoke its access at Salesforce"
                style={{ flex: "none", background: "none", border: 0, padding: "4px 6px", fontSize: 12, color: "var(--muted)", cursor: "pointer", textDecoration: "underline" }}
                onClick={(e) => {
                  e.stopPropagation();
                  void sf.forget([c], `Remove ${c.name || c.username}? Runs can no longer sign in as this user until it is connected again.`);
                }}>Remove</button>
            </div>
          );
        })}

        {host && sf.flags.approvals && conn && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }}>
            <div style={SF_SECTION}>Approver (second user)</div>
            {!others.length ? (
              <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.45 }}>
                For approval tests, connect a second user (the one who approves). The run switches to them partway through.
              </div>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <select className="field-select" style={{ maxWidth: "100%" }}
                  value={others.some((c) => c.id === sf.approverId) ? sf.approverId ?? "" : ""}
                  onChange={(e) => sf.setApprover(e.target.value)}>
                  <option value="">Nobody: the run uses one user</option>
                  {others.map((c) => <option key={c.id} value={c.id}>{`${c.name || c.username} (${c.username})`}</option>)}
                </select>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>Approves or rejects when the test asks for it.</span>
              </label>
            )}
          </div>
        )}

        {host && (stale.length > 0 || (pending > 0 && users.length > 0)) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
            {pending > 0 && users.length > 0 && <span>Checking other saved connections…</span>}
            {stale.length > 0 && (
              <>
                <span>{`${stale.length} old or expired connection${stale.length === 1 ? "" : "s"} hidden.`}</span>
                <button type="button"
                  style={{ background: "none", border: 0, padding: 0, fontSize: 12, color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
                  onClick={() => void sf.forget(stale,
                    `Remove ${stale.length} old or expired connection${stale.length === 1 ? "" : "s"} for this org? The users listed above stay connected.`)}>
                  Clean up
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {sf.flags.discoveryCache && <OrgScan sf={sf} />}
    </div>
  );
}
